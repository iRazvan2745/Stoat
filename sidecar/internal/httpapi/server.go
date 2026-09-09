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
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

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

const (
	maxExecOutputBytes   = 1024 * 1024
	maxRequestBodyBytes  = 8 * 1024 * 1024
	maxComposeFileBytes  = 4 * 1024 * 1024
	uncloudMetricsPort   = 51090
	uncloudMetricsPath   = "/metrics"
	metricsClientTimeout = 5 * time.Second
)

type cappedBuffer struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := b.limit - b.buffer.Len()
	if len(data) > remaining {
		b.truncated = true
	}
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = b.buffer.Write(data)
	}
	return originalLength, nil
}

func (b *cappedBuffer) String() string { return b.buffer.String() }

func (b *cappedBuffer) Truncated() bool { return b.truncated }

// Backend is the narrow, typed subset of Uncloud's client bindings used by the
// HTTP API. *client.Client satisfies this interface, while keeping the HTTP
// handlers easy to test without a running daemon.
type Backend interface {
	Ready(context.Context) error
	ClusterDiagnostics(context.Context) (ClusterDiagnosticsResponse, error)
	ListCaddyConfigs(context.Context) (CaddyConfigsResponse, error)

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
	InspectContainer(context.Context, string, string) (api.MachineServiceContainer, error)
	StartContainer(context.Context, string, string) error
	StopContainer(context.Context, string, string, container.StopOptions) error
	RemoveContainer(context.Context, string, string, container.RemoveOptions) error
	ExecContainer(context.Context, string, string, api.ExecOptions) (int, error)
	ExecMachine(context.Context, string, api.ExecOptions) (int, error)

	ListVolumes(context.Context, *api.VolumeFilter) ([]api.MachineVolume, error)
	CreateVolume(context.Context, string, volume.CreateOptions) (api.MachineVolume, error)
	RemoveVolume(context.Context, string, string, bool) error
	ListVolumeAttachments(context.Context) ([]VolumeAttachmentResponse, error)

	ListImages(context.Context, api.ImageFilter) ([]api.MachineImages, error)
	InspectImage(context.Context, string) ([]api.MachineImage, error)
	InspectRemoteImage(context.Context, string) ([]RemoteImageResponse, error)
	InspectImageUpdate(context.Context, string) ([]ImageUpdateResponse, error)
	GetDomain(context.Context) (string, error)

	DeployCompose(context.Context, DeployComposeRequest) (<-chan DeployComposeEvent, error)
}

// Config controls HTTP-only behavior. Cluster connection setup belongs to the
// standalone command in cmd/sidecar.
type Config struct {
	// AllowedOrigins is a comma-separated list accepted by Fiber's CORS
	// middleware. Leave it empty to disable CORS middleware.
	AllowedOrigins string
	// MachineID identifies the Uncloud machine hosting this sidecar. Global
	// Uncloud services receive this value through UNCLOUD_MACHINE_ID.
	MachineID string
	// MetricsHTTPClient allows the local metrics transport to be replaced in
	// tests. A client with a five-second timeout is used when it is nil.
	MetricsHTTPClient *http.Client
}

// Server is the standalone Fiber HTTP API for Uncloud.
type Server struct {
	backend       Backend
	app           *fiber.App
	machineID     string
	metricsClient *http.Client
	openapiJSON   []byte
	openapiYAML   []byte
	scalarHTML    string
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

	metricsClient := cfg.MetricsHTTPClient
	if metricsClient == nil {
		metricsClient = &http.Client{Timeout: metricsClientTimeout}
	}

	s := &Server{
		backend:       backend,
		machineID:     strings.TrimSpace(cfg.MachineID),
		metricsClient: metricsClient,
		openapiJSON:   spec,
		openapiYAML:   specYAML,
		scalarHTML:    scalarHTML,
	}
	s.app = fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             maxRequestBodyBytes,
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
	s.app.Get("/readyz", s.ready)
	s.app.Get("/ucinternal/metrics", s.ucInternalMetrics)
	s.app.Get("/openapi.json", s.openapi)
	s.app.Get("/openapi.yaml", s.openapiYAMLDocument)
	s.app.Get("/docs", s.scalar)
	s.app.Get("/docs/*", s.scalar)

	apiGroup := s.app.Group("/api/v1")
	apiGroup.Get("/cluster/domain", s.getDomain)
	apiGroup.Get("/cluster/diagnostics", s.clusterDiagnostics)
	apiGroup.Get("/caddy/configs", s.listCaddyConfigs)

	apiGroup.Get("/machines", s.listMachines)
	apiGroup.Get("/machines/:id", s.inspectMachine)
	apiGroup.Patch("/machines/:id", s.renameMachine)
	apiGroup.Post("/machines/:id/exec", s.execMachine)
	apiGroup.Post("/machines/:id/exec/stream", s.streamMachineExec)

	apiGroup.Get("/services", s.listServices)
	apiGroup.Get("/services/:id", s.inspectService)
	apiGroup.Get("/services/:id/logs", s.serviceLogs)
	apiGroup.Post("/services", s.runService)
	apiGroup.Post("/services/deploy/compose", s.deployCompose)
	apiGroup.Post("/services/:id/start", s.startService)
	apiGroup.Post("/services/:id/stop", s.stopService)
	apiGroup.Get("/services/:id/containers/:container", s.inspectContainer)
	apiGroup.Post("/services/:id/containers/:container/actions", s.containerAction)
	apiGroup.Post("/services/:id/containers/:container/exec", s.execContainer)
	apiGroup.Delete("/services/:id", s.removeService)

	apiGroup.Get("/volumes", s.listVolumes)
	apiGroup.Get("/volumes/attachments", s.listVolumeAttachments)
	apiGroup.Post("/volumes", s.createVolume)
	apiGroup.Delete("/machines/:machine/volumes/:volume", s.removeVolume)

	apiGroup.Get("/images", s.listImages)
	apiGroup.Get("/images/:id", s.inspectImage)
	apiGroup.Get("/images/:id/remote", s.inspectRemoteImage)
	apiGroup.Get("/images/:id/update", s.inspectImageUpdate)

	apiGroup.Get("/machines/:id/logs", s.machineLogs)
}

func (s *Server) health(c *fiber.Ctx) error {
	return c.JSON(StatusResponse{Status: "ok"})
}

func (s *Server) ready(c *fiber.Ctx) error {
	if err := s.backend.Ready(requestContext(c)); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(ReadinessResponse{
			Status: "unavailable", Message: err.Error(),
		})
	}
	return c.JSON(ReadinessResponse{Status: "ready"})
}

func (s *Server) ucInternalMetrics(c *fiber.Ctx) error {
	if s.machineID == "" {
		return writeError(c, fiber.NewError(
			fiber.StatusServiceUnavailable,
			"local Uncloud machine ID is not configured",
		))
	}

	machine, err := s.backend.InspectMachine(requestContext(c), s.machineID)
	if err != nil {
		return writeError(c, fiber.NewError(
			fiber.StatusServiceUnavailable,
			"inspect local Uncloud machine for metrics: "+err.Error(),
		))
	}

	machineIP, err := machineMetricsIP(machine)
	if err != nil {
		return writeError(c, err)
	}

	targetURL := "http://" + net.JoinHostPort(machineIP.String(), strconv.Itoa(uncloudMetricsPort)) + uncloudMetricsPath
	request, err := http.NewRequestWithContext(requestContext(c), http.MethodGet, targetURL, nil)
	if err != nil {
		return writeError(c, fmt.Errorf("create local Uncloud metrics request: %w", err))
	}

	response, err := s.metricsClient.Do(request)
	if err != nil {
		return writeError(c, fiber.NewError(
			fiber.StatusServiceUnavailable,
			"fetch local Uncloud metrics: "+err.Error(),
		))
	}

	contentType := response.Header.Get(fiber.HeaderContentType)
	if contentType == "" {
		contentType = fiber.MIMETextPlain + "; charset=utf-8"
	}
	c.Status(response.StatusCode)
	c.Set(fiber.HeaderContentType, contentType)
	c.Set(fiber.HeaderCacheControl, "no-store")
	// fasthttp takes ownership of the stream and closes the response body
	// after it has copied the metrics to the sidecar response.
	return c.SendStream(response.Body)
}

func machineMetricsIP(machine api.MachineMember) (netip.Addr, error) {
	subnet := machine.Network.Subnet
	if !subnet.IsValid() {
		return netip.Addr{}, fiber.NewError(
			fiber.StatusServiceUnavailable,
			"local Uncloud machine has no valid cluster subnet",
		)
	}

	machineIP := subnet.Masked().Addr().Next()
	if !subnet.Contains(machineIP) {
		return netip.Addr{}, fiber.NewError(
			fiber.StatusServiceUnavailable,
			"local Uncloud machine subnet has no usable machine IP",
		)
	}
	return machineIP, nil
}

func (s *Server) clusterDiagnostics(c *fiber.Ctx) error {
	diagnostics, err := s.backend.ClusterDiagnostics(requestContext(c))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(diagnostics)
}

func (s *Server) listCaddyConfigs(c *fiber.Ctx) error {
	configs, err := s.backend.ListCaddyConfigs(requestContext(c))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(configs)
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
	if len(request.Compose) > base64.StdEncoding.EncodedLen(maxComposeFileBytes) {
		return writeError(c, fiber.NewError(
			fiber.StatusRequestEntityTooLarge,
			"compose file must not exceed 4 MiB",
		))
	}
	content, err := base64.StdEncoding.DecodeString(request.Compose)
	if err != nil {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "invalid base64-encoded compose file: "+err.Error()))
	}
	if len(content) > maxComposeFileBytes {
		return writeError(c, fiber.NewError(
			fiber.StatusRequestEntityTooLarge,
			"compose file must not exceed 4 MiB",
		))
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

func (s *Server) inspectContainer(c *fiber.Ctx) error {
	serviceContainer, err := s.backend.InspectContainer(
		requestContext(c), c.Params("id"), c.Params("container"),
	)
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(ServiceContainerResponse{
		MachineID: serviceContainer.MachineID, MachineName: serviceContainer.MachineName,
		Container: serviceContainer.Container,
	})
}

func (s *Server) containerAction(c *fiber.Ctx) error {
	var request ContainerActionRequest
	if err := decodeJSON(c, &request); err != nil {
		return writeError(c, err)
	}
	serviceID := c.Params("id")
	containerID := c.Params("container")
	ctx := requestContext(c)

	action := strings.ToLower(strings.TrimSpace(request.Action))
	status := ""
	switch action {
	case "start":
		if err := s.backend.StartContainer(ctx, serviceID, containerID); err != nil {
			return writeError(c, err)
		}
		status = "started"
	case "stop":
		if err := s.backend.StopContainer(ctx, serviceID, containerID, container.StopOptions{}); err != nil {
			return writeError(c, err)
		}
		status = "stopped"
	case "restart":
		if err := s.backend.StopContainer(ctx, serviceID, containerID, container.StopOptions{}); err != nil {
			return writeError(c, err)
		}
		if err := s.backend.StartContainer(ctx, serviceID, containerID); err != nil {
			return writeError(c, err)
		}
		status = "restarted"
	case "remove":
		if err := s.backend.RemoveContainer(ctx, serviceID, containerID, container.RemoveOptions{}); err != nil {
			return writeError(c, err)
		}
		status = "removed"
	default:
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "action must be start, stop, restart, or remove"))
	}

	return c.JSON(StatusResponse{Status: status})
}

func (s *Server) execContainer(c *fiber.Ctx) error {
	var request ExecContainerRequest
	if err := decodeJSON(c, &request); err != nil {
		return writeError(c, err)
	}
	if len(request.Command) == 0 {
		return writeError(c, fiber.NewError(fiber.StatusBadRequest, "command must not be empty"))
	}
	for _, argument := range request.Command {
		if strings.ContainsRune(argument, '\x00') {
			return writeError(c, fiber.NewError(fiber.StatusBadRequest, "command arguments must not contain NUL bytes"))
		}
	}

	stdout := &cappedBuffer{limit: maxExecOutputBytes}
	stderr := &cappedBuffer{limit: maxExecOutputBytes}
	exitCode, err := s.backend.ExecContainer(requestContext(c), c.Params("id"), c.Params("container"), api.ExecOptions{
		Command: request.Command, AttachStdin: request.Stdin != "", AttachStdout: true,
		AttachStderr: !request.TTY, Tty: request.TTY, Stdin: strings.NewReader(request.Stdin),
		Stdout: stdout, Stderr: stderr,
	})
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(ExecContainerResponse{
		ExitCode: exitCode, Stdout: stdout.String(), Stderr: stderr.String(),
		Truncated: stdout.Truncated() || stderr.Truncated(),
	})
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

func (s *Server) listVolumeAttachments(c *fiber.Ctx) error {
	attachments, err := s.backend.ListVolumeAttachments(requestContext(c))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(ItemResponse[VolumeAttachmentResponse]{Items: attachments})
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

func (s *Server) inspectRemoteImage(c *fiber.Ctx) error {
	images, err := s.backend.InspectRemoteImage(requestContext(c), c.Params("id"))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(ItemResponse[RemoteImageResponse]{Items: images})
}

func (s *Server) inspectImageUpdate(c *fiber.Ctx) error {
	images, err := s.backend.InspectImageUpdate(requestContext(c), c.Params("id"))
	if err != nil {
		return writeError(c, err)
	}
	return c.JSON(ItemResponse[ImageUpdateResponse]{Items: images})
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
