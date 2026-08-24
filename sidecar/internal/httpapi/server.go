package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	scalargo "github.com/bdpiprava/scalar-go"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/volume"
	"github.com/goccy/go-yaml"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/psviderski/uncloud/pkg/api"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Backend is the narrow, typed subset of Uncloud's client bindings used by the
// HTTP API. *client.Client satisfies this interface, while keeping the HTTP
// handlers easy to test without a running daemon.
type Backend interface {
	ListMachines(context.Context, *api.MachineFilter) ([]api.MachineMember, error)
	InspectMachine(context.Context, string) (api.MachineMember, error)
	RenameMachine(context.Context, string, string) (MachineInfoResponse, error)

	ListServices(context.Context) ([]api.Service, error)
	InspectService(context.Context, string) (api.Service, error)
	RunService(context.Context, api.ServiceSpec) (api.RunServiceResponse, error)
	ServiceLogs(context.Context, string, api.ServiceLogsOptions) (api.Service, <-chan api.ServiceLogEntry, error)
	MachineLogs(context.Context, string, api.ServiceLogsOptions) (<-chan api.ServiceLogEntry, error)
	RemoveService(context.Context, string) error
	StopService(context.Context, string, container.StopOptions) error
	StartService(context.Context, string) error

	ListVolumes(context.Context, *api.VolumeFilter) ([]api.MachineVolume, error)
	CreateVolume(context.Context, string, volume.CreateOptions) (api.MachineVolume, error)
	RemoveVolume(context.Context, string, string, bool) error

	ListImages(context.Context, api.ImageFilter) ([]api.MachineImages, error)
	InspectImage(context.Context, string) ([]api.MachineImage, error)
	GetDomain(context.Context) (string, error)

	DeployCompose(context.Context, DeployComposeRequest) (<-chan DeployComposeEvent, error)
}

// Config controls HTTP-only behavior. Cluster connection setup belongs to the
// standalone command in cmd/sidecar.
type Config struct {
	// AllowedOrigins is a comma-separated list accepted by Fiber's CORS
	// middleware. Leave it empty to disable CORS middleware.
	AllowedOrigins string
}

// Server is the standalone Fiber HTTP API for Uncloud.
type Server struct {
	backend     Backend
	app         *fiber.App
	openapiJSON []byte
	openapiYAML []byte
	scalarHTML  string
}

// New creates a Fiber server backed by Uncloud's typed client bindings.
func New(backend Backend, cfg Config) (*Server, error) {
	if backend == nil {
		return nil, errors.New("HTTP API backend must not be nil")
	}

	spec, err := OpenAPIDocumentJSON()
	if err != nil {
		return nil, fmt.Errorf("marshal OpenAPI document: %w", err)
	}
	specYAML, err := yaml.JSONToYAML(spec)
	if err != nil {
		return nil, fmt.Errorf("convert OpenAPI document to YAML: %w", err)
	}
	scalarHTML, err := scalargo.NewV2(
		scalargo.WithSpecBytes(spec),
		scalargo.WithMetaDataOpts(scalargo.WithTitle("Uncloud API")),
		scalargo.WithDarkMode(),
	)
	if err != nil {
		return nil, fmt.Errorf("render Scalar API reference: %w", err)
	}

	s := &Server{
		backend:     backend,
		openapiJSON: spec,
		openapiYAML: specYAML,
		scalarHTML:  scalarHTML,
	}
	s.app = fiber.New(fiber.Config{
		DisableStartupMessage: true,
		ErrorHandler:          s.errorHandler,
	})
	s.app.Use(recover.New(recover.Config{EnableStackTrace: false}))
	if cfg.AllowedOrigins != "" {
		s.app.Use(cors.New(cors.Config{
			AllowOrigins: cfg.AllowedOrigins,
			AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		}))
	}
	s.registerRoutes()
	return s, nil
}

// App returns the configured Fiber application. It is useful for embedding the
// API in another process and for in-memory HTTP tests.
func (s *Server) App() *fiber.App {
	return s.app
}

func (s *Server) registerRoutes() {
	s.app.Get("/healthz", s.health)
	s.app.Get("/openapi.json", s.openapi)
	s.app.Get("/openapi.yaml", s.openapiYAMLDocument)
	s.app.Get("/docs", s.scalar)
	s.app.Get("/docs/*", s.scalar)

	apiGroup := s.app.Group("/api/v1")
	apiGroup.Get("/cluster/domain", s.getDomain)

	apiGroup.Get("/machines", s.listMachines)
	apiGroup.Get("/machines/:id", s.inspectMachine)
	apiGroup.Patch("/machines/:id", s.renameMachine)

	apiGroup.Get("/services", s.listServices)
	apiGroup.Get("/services/:id", s.inspectService)
	apiGroup.Get("/services/:id/logs", s.serviceLogs)
	apiGroup.Post("/services", s.runService)
	apiGroup.Post("/services/deploy/compose", s.deployCompose)
	apiGroup.Post("/services/:id/start", s.startService)
	apiGroup.Post("/services/:id/stop", s.stopService)
	apiGroup.Delete("/services/:id", s.removeService)

	apiGroup.Get("/volumes", s.listVolumes)
	apiGroup.Post("/volumes", s.createVolume)
	apiGroup.Delete("/machines/:machine/volumes/:volume", s.removeVolume)

	apiGroup.Get("/images", s.listImages)
	apiGroup.Get("/images/:id", s.inspectImage)

	apiGroup.Get("/machines/:id/logs", s.machineLogs)
}

func (s *Server) health(c *fiber.Ctx) error {
	return c.JSON(StatusResponse{Status: "ok"})
}

func (s *Server) openapi(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	return c.Send(s.openapiJSON)
}

func (s *Server) openapiYAMLDocument(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, "application/yaml; charset=utf-8")
	return c.Send(s.openapiYAML)
}

func (s *Server) scalar(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, fiber.MIMETextHTML+"; charset=utf-8")
	return c.SendString(s.scalarHTML)
}

func (s *Server) getDomain(c *fiber.Ctx) error {
	domain, err := s.backend.GetDomain(requestContext(c))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(DomainResponse{Domain: domain})
}

func (s *Server) listMachines(c *fiber.Ctx) error {
	available, err := parseBoolQuery(c, "available")
	if err != nil {
		return writeError(c, err)
	}
	filter := &api.MachineFilter{
		Available:  available,
		NamesOrIDs: splitQuery(c.Query("names")),
	}
	if len(filter.NamesOrIDs) == 0 {
		filter = &api.MachineFilter{Available: available}
	}

	machines, err := s.backend.ListMachines(requestContext(c), filter)
	if err != nil {
		return writeError(c, err)
	}
	items := make([]MachineResponse, 0, len(machines))
	for _, machine := range machines {
		items = append(items, machineResponse(machine))
	}
	return c.JSON(ItemResponse[MachineResponse]{Items: items})
}

func (s *Server) inspectMachine(c *fiber.Ctx) error {
	machine, err := s.backend.InspectMachine(requestContext(c), c.Params("id"))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(machineResponse(machine))
}

func (s *Server) renameMachine(c *fiber.Ctx) error {
	var request RenameMachineRequest
	if err := decodeJSON(c, &request); err != nil {
		return writeError(c, err)
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "name must not be empty"))
	}

	machine, err := s.backend.RenameMachine(requestContext(c), c.Params("id"), request.Name)
	if err != nil {
		return writeError(c, err)
	}
	if machine.ID == "" && machine.Name == "" {
		return writeError(c, errors.New("Uncloud returned an empty machine response"))
	}
	return c.JSON(machine)
}

func (s *Server) listServices(c *fiber.Ctx) error {
	services, err := s.backend.ListServices(requestContext(c))
	if err != nil {
		return writeError(c, err)
	}
	items := make([]ServiceResponse, 0, len(services))
	for _, service := range services {
		items = append(items, serviceResponse(service))
	}
	return c.JSON(ItemResponse[ServiceResponse]{Items: items})
}

func (s *Server) inspectService(c *fiber.Ctx) error {
	service, err := s.backend.InspectService(requestContext(c), c.Params("id"))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(serviceResponse(service))
}

func (s *Server) serviceLogs(c *fiber.Ctx) error {
	opts, err := parseLogsOptions(c)
	if err != nil {
		return writeError(c, err)
	}
	streamContext, cancel := context.WithCancel(requestContext(c))
	_, entries, err := s.backend.ServiceLogs(streamContext, c.Params("id"), opts)
	if err != nil {
		cancel()
		return writeError(c, err)
	}
	if entries == nil {
		cancel()
		return writeError(c, errors.New("Uncloud returned an empty service log stream"))
	}

	c.Set(fiber.HeaderContentType, "text/event-stream")
	c.Set(fiber.HeaderCacheControl, "no-cache")
	requestDone := c.Context().Done()
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer cancel()
		for {
			select {
			case entry, ok := <-entries:
				if !ok {
					return
				}
				if err := writeLogEvent(writer, serviceLogEvent(entry)); err != nil {
					return
				}
			case <-requestDone:
				return
			}
		}
	})
	return nil
}

func (s *Server) machineLogs(c *fiber.Ctx) error {
	opts, err := parseLogsOptions(c)
	if err != nil {
		return writeError(c, err)
	}
	service := strings.TrimSpace(c.Query("service"))
	if service == "" {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "query parameter \"service\" is required"))
	}
	// The path identifies one machine. Do not allow a query filter to broaden
	// this endpoint to a different set of machines.
	opts.Machines = []string{c.Params("id")}

	streamContext, cancel := context.WithCancel(requestContext(c))
	entries, err := s.backend.MachineLogs(streamContext, service, opts)
	if err != nil {
		cancel()
		return writeError(c, err)
	}
	if entries == nil {
		cancel()
		return writeError(c, errors.New("Uncloud returned an empty machine log stream"))
	}

	c.Set(fiber.HeaderContentType, "text/event-stream")
	c.Set(fiber.HeaderCacheControl, "no-cache")
	requestDone := c.Context().Done()
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer cancel()
		for {
			select {
			case entry, ok := <-entries:
				if !ok {
					return
				}
				if err := writeLogEvent(writer, serviceLogEvent(entry)); err != nil {
					return
				}
			case <-requestDone:
				return
			}
		}
	})
	return nil
}

func (s *Server) runService(c *fiber.Ctx) error {
	var spec api.ServiceSpec
	if err := decodeJSON(c, &spec); err != nil {
		return writeError(c, err)
	}

	response, err := s.backend.RunService(requestContext(c), spec)
	if err != nil {
		return writeError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(RunServiceResponse{ID: response.ID, Name: response.Name})
}

// deployCompose deploys services from a base64-encoded Compose file, replicating
// the behaviour of the 'uc deploy' command without the interactive build and
// confirmation steps. Deployment progress is streamed as JSON Server-Sent Events.
func (s *Server) deployCompose(c *fiber.Ctx) error {
	var request DeployComposeRequest
	if err := decodeJSON(c, &request); err != nil {
		return writeError(c, err)
	}
	content, err := base64.StdEncoding.DecodeString(request.Compose)
	if err != nil {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "invalid base64-encoded compose file: "+err.Error()))
	}
	if len(bytes.TrimSpace(content)) == 0 {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "compose file must not be empty"))
	}

	streamContext, cancel := context.WithCancel(requestContext(c))
	events, err := s.backend.DeployCompose(streamContext, DeployComposeRequest{
		Compose: string(content),
		Options: request.Options,
	})
	if err != nil {
		cancel()
		return writeError(c, err)
	}
	if events == nil {
		cancel()
		return writeError(c, errors.New("Uncloud returned an empty compose deployment stream"))
	}

	c.Set(fiber.HeaderContentType, "text/event-stream")
	c.Set(fiber.HeaderCacheControl, "no-cache")
	requestDone := c.Context().Done()
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer cancel()
		for {
			select {
			case event, ok := <-events:
				if !ok {
					return
				}
				if err := writeDeployEvent(writer, event); err != nil {
					return
				}
			case <-requestDone:
				return
			}
		}
	})
	return nil
}

func (s *Server) startService(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := s.backend.StartService(requestContext(c), id); err != nil {
		return writeError(c, err)
	}
	return c.JSON(StatusResponse{Status: "started"})
}

func (s *Server) stopService(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := s.backend.StopService(requestContext(c), id, container.StopOptions{}); err != nil {
		return writeError(c, err)
	}
	return c.JSON(StatusResponse{Status: "stopped"})
}

func (s *Server) removeService(c *fiber.Ctx) error {
	if err := s.backend.RemoveService(requestContext(c), c.Params("id")); err != nil {
		return writeError(c, err)
	}
	return c.JSON(StatusResponse{Status: "removed"})
}

func (s *Server) listVolumes(c *fiber.Ctx) error {
	filter := &api.VolumeFilter{
		Driver:   c.Query("driver"),
		Machines: splitQuery(c.Query("machines")),
		Names:    splitQuery(c.Query("names")),
	}
	volumes, err := s.backend.ListVolumes(requestContext(c), filter)
	if err != nil {
		return writeError(c, err)
	}
	items := make([]VolumeResponse, 0, len(volumes))
	for _, machineVolume := range volumes {
		items = append(items, volumeResponse(machineVolume))
	}
	return c.JSON(ItemResponse[VolumeResponse]{Items: items})
}

func (s *Server) createVolume(c *fiber.Ctx) error {
	var request CreateVolumeRequest
	if err := decodeJSON(c, &request); err != nil {
		return writeError(c, err)
	}
	request.Machine = strings.TrimSpace(request.Machine)
	request.Name = strings.TrimSpace(request.Name)
	if request.Machine == "" || request.Name == "" {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "machine and name are required"))
	}

	machineVolume, err := s.backend.CreateVolume(requestContext(c), request.Machine, volume.CreateOptions{
		Name:       request.Name,
		Driver:     request.Driver,
		DriverOpts: request.DriverOpts,
		Labels:     request.Labels,
	})
	if err != nil {
		return writeError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(volumeResponse(machineVolume))
}

func (s *Server) removeVolume(c *fiber.Ctx) error {
	if err := s.backend.RemoveVolume(
		requestContext(c), c.Params("machine"), c.Params("volume"), false,
	); err != nil {
		return writeError(c, err)
	}
	return c.JSON(StatusResponse{Status: "removed"})
}

func (s *Server) listImages(c *fiber.Ctx) error {
	images, err := s.backend.ListImages(requestContext(c), api.ImageFilter{
		Machines: splitQuery(c.Query("machines")),
		Name:     c.Query("name"),
	})
	if err != nil {
		return writeError(c, err)
	}
	items := make([]ImageGroupResponse, 0, len(images))
	for _, machineImages := range images {
		items = append(items, imageGroupResponse(machineImages))
	}
	return c.JSON(ItemResponse[ImageGroupResponse]{Items: items})
}

func (s *Server) inspectImage(c *fiber.Ctx) error {
	images, err := s.backend.InspectImage(requestContext(c), c.Params("id"))
	if err != nil {
		return writeError(c, err)
	}
	items := make([]MachineImageResponse, 0, len(images))
	for _, machineImage := range images {
		items = append(items, machineImageResponse(machineImage))
	}
	return c.JSON(ItemResponse[MachineImageResponse]{Items: items})
}

func (s *Server) errorHandler(c *fiber.Ctx, err error) error {
	return writeError(c, err)
}

func requestContext(c *fiber.Ctx) context.Context {
	ctx := c.UserContext()
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func decodeJSON[T any](c *fiber.Ctx, target *T) error {
	if len(bytes.TrimSpace(c.Body())) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "request body must not be empty")
	}

	decoder := json.NewDecoder(bytes.NewReader(c.Body()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body: "+err.Error())
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fiber.NewError(fiber.StatusBadRequest, "request body must contain one JSON value")
		}
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body: "+err.Error())
	}
	return nil
}

func parseBoolQuery(c *fiber.Ctx, name string) (bool, error) {
	value := c.Query(name)
	if value == "" {
		return false, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("query parameter %q must be true or false", name))
	}
	return parsed, nil
}

func parseLogsOptions(c *fiber.Ctx) (api.ServiceLogsOptions, error) {
	follow, err := parseBoolQuery(c, "follow")
	if err != nil {
		return api.ServiceLogsOptions{}, err
	}

	tail := 0
	if value := c.Query("tail"); value != "" {
		tail, err = strconv.Atoi(value)
		if err != nil || tail < -1 {
			return api.ServiceLogsOptions{}, fiber.NewError(fiber.StatusBadRequest, "query parameter \"tail\" must be an integer greater than or equal to -1")
		}
	}
	return api.ServiceLogsOptions{
		Follow:     follow,
		Tail:       tail,
		Since:      c.Query("since"),
		Until:      c.Query("until"),
		Containers: splitQuery(c.Query("containers")),
		Machines:   splitQuery(c.Query("machines")),
	}, nil
}

func serviceLogEvent(entry api.ServiceLogEntry) LogEventResponse {
	return LogEventResponse{
		Metadata:  logMetadataResponse(entry.Metadata),
		Stream:    logStreamName(entry.Stream),
		Timestamp: entry.Timestamp,
		Message:   string(entry.Message),
		Error:     errorString(entry.Err),
	}
}

func logMetadataResponse(metadata api.ServiceLogEntryMetadata) *LogMetadataResponse {
	return &LogMetadataResponse{
		ServiceID:   metadata.ServiceID,
		ServiceName: metadata.ServiceName,
		ContainerID: metadata.ContainerID,
		MachineID:   metadata.MachineID,
		MachineName: metadata.MachineName,
		Hook:        metadata.Hook,
	}
}

func logStreamName(stream api.LogStreamType) string {
	switch stream {
	case api.LogStreamStdout:
		return "stdout"
	case api.LogStreamStderr:
		return "stderr"
	case api.LogStreamHeartbeat:
		return "heartbeat"
	default:
		return "unknown"
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func writeDeployEvent(writer *bufio.Writer, event DeployComposeEvent) error {
	eventName := event.Type
	if eventName == "" {
		eventName = "message"
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", eventName, data); err != nil {
		return err
	}
	return writer.Flush()
}

func writeLogEvent(writer *bufio.Writer, event LogEventResponse) error {
	eventName := "log"
	if event.Error != "" {
		eventName = "error"
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", eventName, data); err != nil {
		return err
	}
	return writer.Flush()
}

func splitQuery(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func writeError(c *fiber.Ctx, err error) error {
	if err == nil {
		err = errors.New("unknown error")
	}
	statusCode := fiber.StatusInternalServerError
	var fiberErr *fiber.Error
	if errors.As(err, &fiberErr) {
		statusCode = fiberErr.Code
	} else if errors.Is(err, api.ErrNotFound) {
		statusCode = fiber.StatusNotFound
	} else if grpcCode := status.Code(err); grpcCode != codes.Unknown {
		statusCode = grpcStatusCode(grpcCode)
	}
	return c.Status(statusCode).JSON(ErrorResponse{Error: err.Error()})
}

func grpcStatusCode(code codes.Code) int {
	switch code {
	case codes.InvalidArgument:
		return fiber.StatusBadRequest
	case codes.Unauthenticated:
		return fiber.StatusUnauthorized
	case codes.PermissionDenied:
		return fiber.StatusForbidden
	case codes.NotFound:
		return fiber.StatusNotFound
	case codes.AlreadyExists:
		return fiber.StatusConflict
	case codes.FailedPrecondition:
		return fiber.StatusUnprocessableEntity
	case codes.Aborted:
		return fiber.StatusConflict
	case codes.ResourceExhausted:
		return fiber.StatusTooManyRequests
	case codes.Canceled:
		return fiber.StatusRequestTimeout
	case codes.DeadlineExceeded:
		return fiber.StatusGatewayTimeout
	case codes.Unavailable:
		return fiber.StatusServiceUnavailable
	default:
		return fiber.StatusInternalServerError
	}
}
