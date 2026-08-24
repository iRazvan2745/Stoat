package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/volume"
	"github.com/goccy/go-yaml"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeBackend struct {
	machines []api.MachineMember
	services []api.Service
	volumes  []api.MachineVolume
	images   []api.MachineImages
	domain   string

	listMachinesErr   error
	inspectMachineErr error
	renameMachineErr  error
	listServicesErr   error
	inspectServiceErr error
	runServiceErr     error
	removeServiceErr  error
	stopServiceErr    error
	startServiceErr   error
	listVolumesErr    error
	createVolumeErr   error
	removeVolumeErr   error
	listImagesErr     error
	inspectImageErr   error
	domainErr         error

	lastMachineFilter *api.MachineFilter
	lastMachineID     string
	lastMachineName   string
	lastServiceID     string
	lastServiceSpec   api.ServiceSpec
	lastVolumeFilter  *api.VolumeFilter
	lastVolumeMachine string
	lastVolumeOptions volume.CreateOptions
	lastVolumeName    string
	lastImageFilter   api.ImageFilter
	serviceLogOptions api.ServiceLogsOptions
	machineLogUnit    string
	serviceLogsErr    error
	machineLogsErr    error

	deployComposeErr     error
	lastDeployComposeReq DeployComposeRequest
}

func (f *fakeBackend) ListMachines(_ context.Context, filter *api.MachineFilter) ([]api.MachineMember, error) {
	f.lastMachineFilter = filter
	return f.machines, f.listMachinesErr
}

func (f *fakeBackend) InspectMachine(_ context.Context, id string) (api.MachineMember, error) {
	f.lastMachineID = id
	if f.inspectMachineErr != nil {
		return api.MachineMember{}, f.inspectMachineErr
	}
	if len(f.machines) == 0 {
		return api.MachineMember{}, api.ErrNotFound
	}
	return f.machines[0], nil
}

func (f *fakeBackend) RenameMachine(_ context.Context, id, name string) (MachineInfoResponse, error) {
	f.lastMachineID = id
	f.lastMachineName = name
	if f.renameMachineErr != nil {
		return MachineInfoResponse{}, f.renameMachineErr
	}
	return MachineInfoResponse{ID: id, Name: name}, nil
}

func (f *fakeBackend) ListServices(context.Context) ([]api.Service, error) {
	return f.services, f.listServicesErr
}

func (f *fakeBackend) InspectService(_ context.Context, id string) (api.Service, error) {
	f.lastServiceID = id
	if f.inspectServiceErr != nil {
		return api.Service{}, f.inspectServiceErr
	}
	if len(f.services) == 0 {
		return api.Service{}, api.ErrNotFound
	}
	return f.services[0], nil
}

func (f *fakeBackend) RunService(_ context.Context, spec api.ServiceSpec) (api.RunServiceResponse, error) {
	f.lastServiceSpec = spec
	if f.runServiceErr != nil {
		return api.RunServiceResponse{}, f.runServiceErr
	}
	return api.RunServiceResponse{ID: "svc-created", Name: spec.Name}, nil
}

func (f *fakeBackend) ServiceLogs(_ context.Context, _ string, opts api.ServiceLogsOptions) (api.Service, <-chan api.ServiceLogEntry, error) {
	f.serviceLogOptions = opts
	if f.serviceLogsErr != nil {
		return api.Service{}, nil, f.serviceLogsErr
	}
	entries := make(chan api.ServiceLogEntry, 1)
	entries <- api.ServiceLogEntry{
		Metadata: api.ServiceLogEntryMetadata{ServiceID: "svc-1", MachineName: "node-1"},
		LogEntry: api.LogEntry{Stream: api.LogStreamStdout, Timestamp: time.Unix(1, 0).UTC(), Message: []byte("hello\n")},
	}
	close(entries)
	return api.Service{ID: "svc-1"}, entries, nil
}

func (f *fakeBackend) MachineLogs(_ context.Context, unit string, opts api.ServiceLogsOptions) (<-chan api.ServiceLogEntry, error) {
	f.machineLogUnit = unit
	f.serviceLogOptions = opts
	if f.machineLogsErr != nil {
		return nil, f.machineLogsErr
	}
	entries := make(chan api.ServiceLogEntry, 1)
	entries <- api.ServiceLogEntry{LogEntry: api.LogEntry{Stream: api.LogStreamStderr, Message: []byte("warning\n")}}
	close(entries)
	return entries, nil
}

func (f *fakeBackend) RemoveService(_ context.Context, id string) error {
	f.lastServiceID = id
	return f.removeServiceErr
}

func (f *fakeBackend) StopService(_ context.Context, id string, _ container.StopOptions) error {
	f.lastServiceID = id
	return f.stopServiceErr
}

func (f *fakeBackend) StartService(_ context.Context, id string) error {
	f.lastServiceID = id
	return f.startServiceErr
}

func (f *fakeBackend) ListVolumes(_ context.Context, filter *api.VolumeFilter) ([]api.MachineVolume, error) {
	f.lastVolumeFilter = filter
	return f.volumes, f.listVolumesErr
}

func (f *fakeBackend) CreateVolume(_ context.Context, machine string, opts volume.CreateOptions) (api.MachineVolume, error) {
	f.lastVolumeMachine = machine
	f.lastVolumeOptions = opts
	if f.createVolumeErr != nil {
		return api.MachineVolume{}, f.createVolumeErr
	}
	if len(f.volumes) == 0 {
		return api.MachineVolume{MachineID: machine, MachineName: machine, Volume: volume.Volume{Name: opts.Name}}, nil
	}
	return f.volumes[0], nil
}

func (f *fakeBackend) RemoveVolume(_ context.Context, machine, name string, _ bool) error {
	f.lastVolumeMachine = machine
	f.lastVolumeName = name
	return f.removeVolumeErr
}

func (f *fakeBackend) ListImages(_ context.Context, filter api.ImageFilter) ([]api.MachineImages, error) {
	f.lastImageFilter = filter
	return f.images, f.listImagesErr
}

func (f *fakeBackend) InspectImage(context.Context, string) ([]api.MachineImage, error) {
	if f.inspectImageErr != nil {
		return nil, f.inspectImageErr
	}
	return []api.MachineImage{{Image: image.InspectResponse{ID: "sha256:image"}}}, nil
}

func (f *fakeBackend) GetDomain(context.Context) (string, error) {
	return f.domain, f.domainErr
}

func (f *fakeBackend) DeployCompose(_ context.Context, req DeployComposeRequest) (<-chan DeployComposeEvent, error) {
	f.lastDeployComposeReq = req
	if f.deployComposeErr != nil {
		return nil, f.deployComposeErr
	}
	events := make(chan DeployComposeEvent, 3)
	go func() {
		defer close(events)
		events <- DeployComposeEvent{
			Type: "plan",
			Operations: []DeployComposePlanOperation{{
				Action:   "run",
				Resource: "container",
				Service:  "web",
				Machine:  "node-1",
				Image:    "nginx:latest",
			}},
		}
		events <- DeployComposeEvent{
			Type:       "progress",
			ID:         "Container web-abc on node-1",
			Phase:      "working",
			StatusText: "Creating",
		}
		events <- DeployComposeEvent{Type: "complete", DeployStatus: "deployed"}
	}()
	return events, nil
}

func newTestServer(t *testing.T) (*Server, *fakeBackend) {
	t.Helper()
	fake := &fakeBackend{
		machines: []api.MachineMember{testMachine()},
		services: []api.Service{{ID: "svc-1", Name: "web", Mode: api.ServiceModeReplicated}},
		volumes: []api.MachineVolume{{
			MachineID:   "machine-1",
			MachineName: "node-1",
			Volume:      volume.Volume{Name: "data", Driver: "local"},
		}},
		images: []api.MachineImages{{
			Images: []image.Summary{{ID: "sha256:image", RepoTags: []string{"nginx:latest"}}},
		}},
		domain: "example.uncld.dev",
	}
	server, err := New(fake, Config{AllowedOrigins: "http://localhost:3000"})
	require.NoError(t, err)
	return server, fake
}

func testMachine() api.MachineMember {
	return api.MachineMember{
		ID:            "machine-1",
		Name:          "node-1",
		State:         "Up",
		DaemonVersion: "0.16.0",
		DockerVersion: "28.5.0",
		Hostname:      "node-1-host",
		Arch:          "amd64",
		OSPrettyName:  "Test Linux",
		KernelVersion: "6.1.0",
		PublicIP:      netip.MustParseAddr("203.0.113.10"),
		Network: api.MachineNetwork{
			Subnet:       netip.MustParsePrefix("10.210.0.0/24"),
			ManagementIP: netip.MustParseAddr("10.210.0.1"),
			Endpoints:    []netip.AddrPort{netip.MustParseAddrPort("203.0.113.10:51820")},
			PublicKey:    []byte{1, 2, 3},
		},
	}
}

func TestNewRejectsNilBackend(t *testing.T) {
	_, err := New(nil, Config{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "backend must not be nil")
}

func TestHealthOpenAPIScalarAndCORS(t *testing.T) {
	server, _ := newTestServer(t)

	response := doRequest(t, server, http.MethodGet, "/healthz", nil, "http://localhost:3000")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "http://localhost:3000", response.Header.Get("Access-Control-Allow-Origin"))
	assert.JSONEq(t, `{"status":"ok"}`, readBody(t, response))

	response = doRequest(t, server, http.MethodGet, "/openapi.json", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "application/json", response.Header.Get("Content-Type"))
	var document OpenAPIDocument
	require.NoError(t, json.Unmarshal([]byte(readBody(t, response)), &document))
	assert.Equal(t, "3.0.3", document.OpenAPI)
	assert.Equal(t, "Uncloud API", document.Info.Title)

	response = doRequest(t, server, http.MethodGet, "/openapi.yaml", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "application/yaml; charset=utf-8", response.Header.Get("Content-Type"))
	yamlSpec := readBody(t, response)
	assert.Contains(t, yamlSpec, "openapi: 3.0.3")
	assert.Contains(t, yamlSpec, "/api/v1/services")
	yamlJSON, err := yaml.YAMLToJSON([]byte(yamlSpec))
	require.NoError(t, err)
	var yamlDocument OpenAPIDocument
	require.NoError(t, json.Unmarshal(yamlJSON, &yamlDocument))
	assert.Equal(t, document, yamlDocument)

	response = doRequest(t, server, http.MethodGet, "/docs", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	docs := readBody(t, response)
	assert.Contains(t, docs, "Scalar")
	assert.Contains(t, docs, "Uncloud API")
}

func TestAllOpenAPIOperationsAreDocumented(t *testing.T) {
	data, err := OpenAPIDocumentJSON()
	require.NoError(t, err)
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	require.NoError(t, json.Unmarshal(data, &document))

	expected := map[string][]string{
		"/healthz":                                    {"get"},
		"/api/v1/cluster/domain":                      {"get"},
		"/api/v1/machines":                            {"get"},
		"/api/v1/machines/{id}":                       {"get", "patch"},
		"/api/v1/services":                            {"get", "post"},
		"/api/v1/services/deploy/compose":             {"post"},
		"/api/v1/services/{id}":                       {"get", "delete"},
		"/api/v1/services/{id}/logs":                  {"get"},
		"/api/v1/services/{id}/start":                 {"post"},
		"/api/v1/services/{id}/stop":                  {"post"},
		"/api/v1/volumes":                             {"get", "post"},
		"/api/v1/machines/{machine}/volumes/{volume}": {"delete"},
		"/api/v1/images":                              {"get"},
		"/api/v1/images/{id}":                         {"get"},
		"/api/v1/machines/{id}/logs":                  {"get"},
	}
	for path, methods := range expected {
		operations, ok := document.Paths[path]
		require.Truef(t, ok, "missing OpenAPI path %s", path)
		for _, method := range methods {
			assert.Containsf(t, operations, method, "missing OpenAPI operation %s %s", method, path)
		}
	}
}

func TestClusterMachineAndServiceRoutes(t *testing.T) {
	server, fake := newTestServer(t)

	response := doRequest(t, server, http.MethodGet, "/api/v1/cluster/domain", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.JSONEq(t, `{"domain":"example.uncld.dev"}`, readBody(t, response))

	response = doRequest(t, server, http.MethodGet, "/api/v1/machines?available=true&names=machine-1,node-1", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	machines := decodeResponse[ItemResponse[MachineResponse]](t, response)
	require.Len(t, machines.Items, 1)
	assert.Equal(t, "machine-1", machines.Items[0].ID)
	assert.Equal(t, "10.210.0.0/24", machines.Items[0].Network.Subnet)
	assert.Equal(t, "AQID", machines.Items[0].Network.PublicKey)
	require.NotNil(t, fake.lastMachineFilter)
	assert.True(t, fake.lastMachineFilter.Available)
	assert.Equal(t, []string{"machine-1", "node-1"}, fake.lastMachineFilter.NamesOrIDs)

	response = doRequest(t, server, http.MethodGet, "/api/v1/machines/machine-1", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "machine-1", decodeResponse[MachineResponse](t, response).ID)

	response = doRequest(t, server, http.MethodPatch, "/api/v1/machines/machine-1", map[string]string{"name": "renamed"}, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "renamed", decodeResponse[MachineInfoResponse](t, response).Name)
	assert.Equal(t, "renamed", fake.lastMachineName)

	response = doRequest(t, server, http.MethodGet, "/api/v1/services", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	services := decodeResponse[ItemResponse[ServiceResponse]](t, response)
	require.Len(t, services.Items, 1)
	assert.Equal(t, "svc-1", services.Items[0].ID)

	response = doRequest(t, server, http.MethodGet, "/api/v1/services/svc-1", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "svc-1", decodeResponse[ServiceResponse](t, response).ID)

	response = doRequest(t, server, http.MethodGet, "/api/v1/services/svc-1/logs?follow=true&tail=10&containers=web-1&machines=node-1", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Contains(t, readBody(t, response), "event: log")
	assert.Equal(t, 10, fake.serviceLogOptions.Tail)
	assert.True(t, fake.serviceLogOptions.Follow)

	response = doRequest(t, server, http.MethodGet, "/api/v1/machines/node-1/logs?service=uncloud", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Contains(t, readBody(t, response), "warning")
	assert.Equal(t, "uncloud", fake.machineLogUnit)
	assert.Equal(t, []string{"node-1"}, fake.serviceLogOptions.Machines)

	response = doRequest(t, server, http.MethodPost, "/api/v1/services", map[string]any{
		"name":      "api",
		"container": map[string]string{"image": "nginx:latest"},
	}, "")
	assert.Equal(t, http.StatusCreated, response.StatusCode)
	assert.Equal(t, "svc-created", decodeResponse[RunServiceResponse](t, response).ID)
	assert.Equal(t, "nginx:latest", fake.lastServiceSpec.Container.Image)

	composeYAML := "services:\n  web:\n    image: nginx:latest\n"
	response = doRequest(t, server, http.MethodPost, "/api/v1/services/deploy/compose", map[string]any{
		"compose": base64.StdEncoding.EncodeToString([]byte(composeYAML)),
		"options": map[string]any{
			"recreate": true,
		},
	}, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	body := readBody(t, response)
	assert.Contains(t, body, "event: plan")
	assert.Contains(t, body, `"type":"plan"`)
	assert.Contains(t, body, "event: progress")
	assert.Contains(t, body, `"statusText":"Creating"`)
	assert.Contains(t, body, "event: complete")
	assert.Contains(t, body, `"status":"deployed"`)
	assert.Equal(t, composeYAML, fake.lastDeployComposeReq.Compose)
	assert.True(t, fake.lastDeployComposeReq.Options.Recreate)

	for path, expectedStatus := range map[string]string{
		"/api/v1/services/svc-1/start": "started",
		"/api/v1/services/svc-1/stop":  "stopped",
		"/api/v1/services/svc-1":       "removed",
	} {
		method := http.MethodPost
		if expectedStatus == "removed" {
			method = http.MethodDelete
		}
		response = doRequest(t, server, method, path, nil, "")
		assert.Equal(t, http.StatusOK, response.StatusCode)
		assert.Equal(t, expectedStatus, decodeResponse[StatusResponse](t, response).Status)
	}
	assert.Equal(t, "svc-1", fake.lastServiceID)
}

func TestVolumeAndImageRoutes(t *testing.T) {
	server, fake := newTestServer(t)

	response := doRequest(t, server, http.MethodGet, "/api/v1/volumes?driver=local&machines=node-1&names=data,cache", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	volumes := decodeResponse[ItemResponse[VolumeResponse]](t, response)
	require.Len(t, volumes.Items, 1)
	assert.Equal(t, "data", volumes.Items[0].Volume.Name)
	assert.Equal(t, "local", fake.lastVolumeFilter.Driver)
	assert.Equal(t, []string{"node-1"}, fake.lastVolumeFilter.Machines)
	assert.Equal(t, []string{"data", "cache"}, fake.lastVolumeFilter.Names)

	response = doRequest(t, server, http.MethodPost, "/api/v1/volumes", CreateVolumeRequest{
		Machine:    "node-1",
		Name:       "cache",
		Driver:     "local",
		DriverOpts: map[string]string{"type": "tmpfs"},
		Labels:     map[string]string{"app": "api"},
	}, "")
	assert.Equal(t, http.StatusCreated, response.StatusCode)
	assert.Equal(t, "cache", fake.lastVolumeOptions.Name)
	assert.Equal(t, "tmpfs", fake.lastVolumeOptions.DriverOpts["type"])

	response = doRequest(t, server, http.MethodDelete, "/api/v1/machines/node-1/volumes/cache", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, "removed", decodeResponse[StatusResponse](t, response).Status)
	assert.Equal(t, "cache", fake.lastVolumeName)

	response = doRequest(t, server, http.MethodGet, "/api/v1/images?machines=node-1&name=nginx*", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	images := decodeResponse[ItemResponse[ImageGroupResponse]](t, response)
	require.Len(t, images.Items, 1)
	assert.Equal(t, "nginx:latest", images.Items[0].Images[0].RepoTags[0])
	assert.Equal(t, []string{"node-1"}, fake.lastImageFilter.Machines)
	assert.Equal(t, "nginx*", fake.lastImageFilter.Name)

	response = doRequest(t, server, http.MethodGet, "/api/v1/images/sha256:image", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	inspected := decodeResponse[ItemResponse[MachineImageResponse]](t, response)
	require.Len(t, inspected.Items, 1)
	assert.Equal(t, "sha256:image", inspected.Items[0].Image.ID)
}

func TestValidationAndErrorResponses(t *testing.T) {
	server, fake := newTestServer(t)

	response := doRequest(t, server, http.MethodGet, "/api/v1/machines?available=maybe", nil, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)
	assert.Contains(t, decodeResponse[ErrorResponse](t, response).Error, "available")

	response = doRequest(t, server, http.MethodPatch, "/api/v1/machines/machine-1", map[string]string{"unknown": "field"}, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)

	response = doRequest(t, server, http.MethodPatch, "/api/v1/machines/machine-1", map[string]string{}, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)

	response = doRequest(t, server, http.MethodPost, "/api/v1/volumes", map[string]string{"name": "data"}, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)

	response = doRequest(t, server, http.MethodPost, "/api/v1/services/deploy/compose", map[string]string{
		"compose": "not-base64",
	}, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)
	assert.Contains(t, decodeResponse[ErrorResponse](t, response).Error, "base64")

	response = doRequest(t, server, http.MethodGet, "/api/v1/services/svc-1/logs?tail=not-an-integer", nil, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)
	response = doRequest(t, server, http.MethodGet, "/api/v1/machines/node-1/logs", nil, "")
	assert.Equal(t, http.StatusBadRequest, response.StatusCode)

	fake.inspectMachineErr = api.ErrNotFound
	response = doRequest(t, server, http.MethodGet, "/api/v1/machines/missing", nil, "")
	assert.Equal(t, http.StatusNotFound, response.StatusCode)
	fake.inspectMachineErr = nil

	fake.listServicesErr = status.Error(codes.Unavailable, "cluster unavailable")
	response = doRequest(t, server, http.MethodGet, "/api/v1/services", nil, "")
	assert.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
	assert.Contains(t, decodeResponse[ErrorResponse](t, response).Error, "cluster unavailable")
	fake.listServicesErr = nil

	response = doRequest(t, server, http.MethodGet, "/does-not-exist", nil, "")
	assert.Equal(t, http.StatusNotFound, response.StatusCode)
	assert.NotEmpty(t, decodeResponse[ErrorResponse](t, response).Error)
}

func TestGRPCStatusMapping(t *testing.T) {
	tests := []struct {
		code     codes.Code
		expected int
	}{
		{codes.InvalidArgument, http.StatusBadRequest},
		{codes.Unauthenticated, http.StatusUnauthorized},
		{codes.PermissionDenied, http.StatusForbidden},
		{codes.NotFound, http.StatusNotFound},
		{codes.AlreadyExists, http.StatusConflict},
		{codes.FailedPrecondition, http.StatusUnprocessableEntity},
		{codes.Aborted, http.StatusConflict},
		{codes.ResourceExhausted, http.StatusTooManyRequests},
		{codes.Canceled, http.StatusRequestTimeout},
		{codes.DeadlineExceeded, http.StatusGatewayTimeout},
		{codes.Unavailable, http.StatusServiceUnavailable},
		{codes.Internal, http.StatusInternalServerError},
	}
	for _, test := range tests {
		assert.Equal(t, test.expected, grpcStatusCode(test.code), test.code.String())
	}
}

func TestHelpers(t *testing.T) {
	assert.Nil(t, splitQuery(""))
	assert.Equal(t, []string{"one", "two"}, splitQuery(" one, two, "))

	server, _ := newTestServer(t)
	response := doRequest(t, server, http.MethodGet, "/api/v1/machines?available=TRUE", nil, "")
	assert.Equal(t, http.StatusOK, response.StatusCode)
}

func doRequest(t *testing.T, server *Server, method, path string, body any, origin string) *http.Response {
	t.Helper()
	var requestBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(t, err)
		requestBody = strings.NewReader(string(data))
	}
	request := httptest.NewRequest(method, path, requestBody)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	response, err := server.App().Test(request, -1)
	require.NoError(t, err)
	return response
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	return string(body)
}

func decodeResponse[T any](t *testing.T, response *http.Response) T {
	t.Helper()
	var value T
	data := readBody(t, response)
	require.NoError(t, json.Unmarshal([]byte(data), &value), data)
	return value
}
