package httpapi

import (
	"encoding/json"
)

// The OpenAPI model is deliberately local and typed. It keeps the public HTTP
// contract independent of protobuf implementation details and lets Scalar use
// the exact same document that clients can fetch from /openapi.json.
type OpenAPIDocument struct {
	OpenAPI    string                     `json:"openapi"`
	Info       OpenAPIInfo                `json:"info"`
	Servers    []OpenAPIServer            `json:"servers,omitempty"`
	Tags       []OpenAPITag               `json:"tags,omitempty"`
	Paths      map[string]OpenAPIPathItem `json:"paths"`
	Components OpenAPIComponents          `json:"components,omitempty"`
}

type OpenAPIInfo struct {
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version"`
}

type OpenAPIServer struct {
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
}

type OpenAPITag struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type OpenAPIPathItem struct {
	Get    *OpenAPIOperation `json:"get,omitempty"`
	Post   *OpenAPIOperation `json:"post,omitempty"`
	Patch  *OpenAPIOperation `json:"patch,omitempty"`
	Delete *OpenAPIOperation `json:"delete,omitempty"`
}

type OpenAPIOperation struct {
	Tags        []string                   `json:"tags,omitempty"`
	Summary     string                     `json:"summary"`
	Description string                     `json:"description,omitempty"`
	OperationID string                     `json:"operationId"`
	Parameters  []OpenAPIParameter         `json:"parameters,omitempty"`
	RequestBody *OpenAPIRequestBody        `json:"requestBody,omitempty"`
	Responses   map[string]OpenAPIResponse `json:"responses"`
}

type OpenAPIParameter struct {
	Name        string        `json:"name"`
	In          string        `json:"in"`
	Description string        `json:"description,omitempty"`
	Required    bool          `json:"required,omitempty"`
	Schema      OpenAPISchema `json:"schema"`
}

type OpenAPIRequestBody struct {
	Description string                      `json:"description,omitempty"`
	Required    bool                        `json:"required,omitempty"`
	Content     map[string]OpenAPIMediaType `json:"content"`
}

type OpenAPIResponse struct {
	Description string                      `json:"description"`
	Content     map[string]OpenAPIMediaType `json:"content,omitempty"`
}

type OpenAPIMediaType struct {
	Schema OpenAPISchema `json:"schema"`
}

type OpenAPIComponents struct {
	Schemas map[string]OpenAPISchema `json:"schemas,omitempty"`
}

type OpenAPISchema struct {
	Ref         string                   `json:"$ref,omitempty"`
	Type        string                   `json:"type,omitempty"`
	Format      string                   `json:"format,omitempty"`
	Description string                   `json:"description,omitempty"`
	Enum        []string                 `json:"enum,omitempty"`
	Required    []string                 `json:"required,omitempty"`
	Properties  map[string]OpenAPISchema `json:"properties,omitempty"`
	Items       *OpenAPISchema           `json:"items,omitempty"`
}

// OpenAPIDocumentJSON returns the complete HTTP contract used by both
// /openapi.json and the Scalar reference page.
func OpenAPIDocumentJSON() ([]byte, error) {
	document := OpenAPIDocument{
		OpenAPI: "3.0.3",
		Info: OpenAPIInfo{
			Title:       "Uncloud API",
			Description: "REST API for managing Uncloud clusters.",
			Version:     "v1",
		},
		Servers: []OpenAPIServer{{URL: "/", Description: "Current Uncloud API server"}},
		Tags: []OpenAPITag{
			{Name: "cluster", Description: "Cluster-level information"},
			{Name: "machines", Description: "Cluster machine management"},
			{Name: "services", Description: "Service deployment and lifecycle"},
			{Name: "volumes", Description: "Docker volume management"},
			{Name: "images", Description: "Docker image inspection"},
		},
		Paths:      openAPIPaths(),
		Components: OpenAPIComponents{Schemas: openAPISchemas()},
	}
	return json.MarshalIndent(document, "", "  ")
}

func openAPIPaths() map[string]OpenAPIPathItem {
	return map[string]OpenAPIPathItem{
		"/healthz": {
			Get: operation("health", "Health check", "health", nil, nil, responses(response("OK", ref("StatusResponse")), false)),
		},
		"/readyz": {
			Get: operation("health", "Uncloud readiness check", "readiness", nil, nil, responses(response("Ready", ref("ReadinessResponse")), false)),
		},
		"/api/v1/cluster/domain": {
			Get: operation("cluster", "Get cluster domain", "getDomain", nil, nil, responses(response("Cluster domain", ref("DomainResponse")), true)),
		},
		"/api/v1/cluster/diagnostics": {
			Get: operation("cluster", "Inspect cluster health", "clusterDiagnostics", nil, nil, responses(response("Cluster diagnostics", ref("ClusterDiagnostics")), true)),
		},
		"/api/v1/caddy/configs": {
			Get: operation("cluster", "List active Caddy configurations", "listCaddyConfigs", nil, nil, responses(response("Caddy configurations and drift status", ref("CaddyConfigs")), true)),
		},
		"/api/v1/machines": {
			Get: operation("machines", "List machines", "listMachines", []OpenAPIParameter{
				queryParameter("available", "Only return machines that are not down.", false, OpenAPISchema{Type: "boolean"}),
				queryParameter("names", "Comma-separated machine names or IDs.", false, OpenAPISchema{Type: "string"}),
			}, nil, responses(response("Machine list", itemResponse("Machine")), true)),
		},
		"/api/v1/machines/{id}": {
			Get:   operation("machines", "Inspect a machine", "inspectMachine", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Machine", ref("Machine")), true)),
			Patch: operation("machines", "Rename a machine", "renameMachine", []OpenAPIParameter{pathParameter("id")}, requestBody("Machine name", "RenameMachineRequest"), responses(response("Updated machine", ref("MachineInfoResponse")), true)),
		},
		"/api/v1/services": {
			Get:  operation("services", "List services", "listServices", nil, nil, responses(response("Service list", itemResponse("Service")), true)),
			Post: operation("services", "Deploy a service", "runService", nil, requestBody("Service specification", "ServiceSpec"), createdResponses(response("Created service", ref("RunServiceResponse")), true)),
		},
		"/api/v1/services/deploy/compose": {
			Post: operation("services", "Deploy services from a Compose file", "deployCompose", nil, requestBody("Base64-encoded Compose file and deployment options", "DeployComposeRequest"), deployStreamResponses(true)),
		},
		"/api/v1/services/{id}": {
			Get:    operation("services", "Inspect a service", "inspectService", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Service", ref("Service")), true)),
			Delete: operation("services", "Remove a service", "removeService", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Operation status", ref("StatusResponse")), true)),
		},
		"/api/v1/services/{id}/logs": {
			Get: operation("services", "Stream service logs", "serviceLogs", logParameters(true), nil, streamResponses(true)),
		},
		"/api/v1/services/{id}/start": {
			Post: operation("services", "Start a service", "startService", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Operation status", ref("StatusResponse")), true)),
		},
		"/api/v1/services/{id}/stop": {
			Post: operation("services", "Stop a service", "stopService", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Operation status", ref("StatusResponse")), true)),
		},
		"/api/v1/services/{id}/containers/{container}": {
			Get: operation("services", "Inspect a service container", "inspectContainer", []OpenAPIParameter{pathParameter("id"), pathParameter("container")}, nil, responses(response("Container", ref("ServiceContainer")), true)),
		},
		"/api/v1/services/{id}/containers/{container}/actions": {
			Post: operation("services", "Control a service container", "containerAction", []OpenAPIParameter{pathParameter("id"), pathParameter("container")}, requestBody("Container action", "ContainerActionRequest"), responses(response("Operation status", ref("StatusResponse")), true)),
		},
		"/api/v1/services/{id}/containers/{container}/exec": {
			Post: operation("services", "Execute a command in a service container", "execContainer", []OpenAPIParameter{pathParameter("id"), pathParameter("container")}, requestBody("Command", "ExecContainerRequest"), responses(response("Command result", ref("ExecContainerResponse")), true)),
		},
		"/api/v1/volumes": {
			Get: operation("volumes", "List volumes", "listVolumes", []OpenAPIParameter{
				queryParameter("driver", "Filter by Docker volume driver.", false, OpenAPISchema{Type: "string"}),
				queryParameter("machines", "Comma-separated machine names or IDs.", false, OpenAPISchema{Type: "string"}),
				queryParameter("names", "Comma-separated volume names.", false, OpenAPISchema{Type: "string"}),
			}, nil, responses(response("Volume list", itemResponse("Volume")), true)),
			Post: operation("volumes", "Create a volume", "createVolume", nil, requestBody("Volume creation request", "CreateVolumeRequest"), createdResponses(response("Created volume", ref("Volume")), true)),
		},
		"/api/v1/volumes/attachments": {
			Get: operation("volumes", "List volume attachments", "listVolumeAttachments", nil, nil, responses(response("Volume attachments", itemResponse("VolumeAttachment")), true)),
		},
		"/api/v1/machines/{machine}/volumes/{volume}": {
			Delete: operation("volumes", "Remove a volume", "removeVolume", []OpenAPIParameter{pathParameter("machine"), pathParameter("volume")}, nil, responses(response("Operation status", ref("StatusResponse")), true)),
		},
		"/api/v1/images": {
			Get: operation("images", "List images", "listImages", []OpenAPIParameter{
				queryParameter("machines", "Comma-separated machine names or IDs.", false, OpenAPISchema{Type: "string"}),
				queryParameter("name", "Image name or wildcard pattern.", false, OpenAPISchema{Type: "string"}),
			}, nil, responses(response("Image list", itemResponse("ImageGroup")), true)),
		},
		"/api/v1/images/{id}": {
			Get: operation("images", "Inspect an image", "inspectImage", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Image inspection list", itemResponse("MachineImage")), true)),
		},
		"/api/v1/images/{id}/remote": {
			Get: operation("images", "Inspect an image in its remote registry", "inspectRemoteImage", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Remote image inspection list", itemResponse("RemoteImage")), true)),
		},
		"/api/v1/images/{id}/update": {
			Get: operation("images", "Check an image for updates", "inspectImageUpdate", []OpenAPIParameter{pathParameter("id")}, nil, responses(response("Image update status per machine", itemResponse("ImageUpdate")), true)),
		},
		"/api/v1/machines/{id}/logs": {
			Get: operation("machines", "Stream machine service logs", "machineLogs", append([]OpenAPIParameter{pathParameter("id"), queryParameter("service", "System service name, such as uncloud or docker.", true, OpenAPISchema{Type: "string"})}, logParameters(false)...), nil, streamResponses(true)),
		},
	}
}

func openAPISchemas() map[string]OpenAPISchema {
	return map[string]OpenAPISchema{
		"ErrorResponse": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"error": {Type: "string"},
			},
			Required: []string{"error"},
		},
		"StatusResponse": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"status": {Type: "string"}},
			Required:   []string{"status"},
		},
		"DomainResponse": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"domain": {Type: "string"}},
			Required:   []string{"domain"},
		},
		"ReadinessResponse": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"status": {Type: "string"}, "message": {Type: "string"}},
			Required:   []string{"status"},
		},
		"ClusterDiagnostics": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"status":       {Type: "string", Enum: []string{"healthy", "degraded"}},
				"issues":       {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"machines":     {Type: "array", Items: refPtr("DiagnosticMachine")},
				"links":        {Type: "array", Items: refPtr("ClusterLink")},
				"versionDrift": {Type: "boolean"},
			},
			Required: []string{"status", "issues", "machines", "links", "versionDrift"},
		},
		"DiagnosticMachine": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"id": {Type: "string"}, "name": {Type: "string"}, "state": {Type: "string"},
				"daemonVersion": {Type: "string"}, "dockerVersion": {Type: "string"},
				"storeVersion": {Type: "object"}, "wireGuard": {Ref: "#/components/schemas/WireGuard"},
				"error": {Type: "string"},
			},
			Required: []string{"id", "name", "state"},
		},
		"ClusterLink": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"from": {Type: "string"}, "to": {Type: "string"},
				"medianMs":      {Type: "number", Format: "double"},
				"standardDevMs": {Type: "number", Format: "double"},
			},
			Required: []string{"from", "to", "medianMs", "standardDevMs"},
		},
		"WireGuard": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"interfaceName": {Type: "string"}, "listenPort": {Type: "integer", Format: "int32"},
				"peers": {Type: "array", Items: refPtr("WireGuardPeer")},
			},
			Required: []string{"interfaceName", "listenPort", "peers"},
		},
		"WireGuardPeer": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"endpoint": {Type: "string"}, "lastHandshakeAt": {Type: "string", Format: "date-time"},
				"receiveBytes": {Type: "integer", Format: "int64"}, "transmitBytes": {Type: "integer", Format: "int64"},
				"allowedIps": {Type: "array", Items: &OpenAPISchema{Type: "string"}},
			},
			Required: []string{"receiveBytes", "transmitBytes", "allowedIps"},
		},
		"CaddyConfig": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"machineId": {Type: "string"}, "machineName": {Type: "string"}, "caddyfile": {Type: "string"},
				"modifiedAt": {Type: "string", Format: "date-time"}, "sha256": {Type: "string"}, "error": {Type: "string"},
			},
			Required: []string{"machineId", "machineName"},
		},
		"CaddyConfigs": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"items": {Type: "array", Items: refPtr("CaddyConfig")}, "drift": {Type: "boolean"},
			}, Required: []string{"items", "drift"},
		},
		"Machine": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"id":            {Type: "string"},
				"name":          {Type: "string"},
				"state":         {Type: "string"},
				"network":       {Ref: "#/components/schemas/MachineNetwork"},
				"publicIp":      {Type: "string"},
				"daemonVersion": {Type: "string"},
				"dockerVersion": {Type: "string"},
				"hostname":      {Type: "string"},
				"arch":          {Type: "string"},
				"osPrettyName":  {Type: "string"},
				"kernelVersion": {Type: "string"},
			},
			Required: []string{"id", "name", "state"},
		},
		"MachineNetwork": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"subnet":       {Type: "string"},
				"managementIp": {Type: "string"},
				"endpoints":    {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"publicKey":    {Type: "string", Format: "byte"},
			},
		},
		"RenameMachineRequest": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"name": {Type: "string"}},
			Required:   []string{"name"},
		},
		"MachineInfoResponse": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"id": {Type: "string"}, "name": {Type: "string"}},
			Required:   []string{"id", "name"},
		},
		"Service": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"id":             {Type: "string"},
				"name":           {Type: "string"},
				"mode":           {Type: "string"},
				"containers":     {Type: "array", Items: refPtr("ServiceContainer")},
				"hookContainers": {Type: "array", Items: refPtr("ServiceContainer")},
			},
			Required: []string{"id", "name", "mode", "containers", "hookContainers"},
		},
		"ServiceContainer": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"machineId":   {Type: "string"},
				"machineName": {Type: "string"},
				"container":   {Type: "object", Description: "Docker inspection and Uncloud service metadata."},
			},
			Required: []string{"machineId", "machineName", "container"},
		},
		"ContainerActionRequest": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"action": {Type: "string", Enum: []string{"start", "stop", "restart", "remove"}},
			}, Required: []string{"action"},
		},
		"ExecContainerRequest": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"command": {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"stdin":   {Type: "string"}, "tty": {Type: "boolean"},
			}, Required: []string{"command"},
		},
		"ExecContainerResponse": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"exitCode": {Type: "integer", Format: "int32"}, "stdout": {Type: "string"}, "stderr": {Type: "string"},
				"truncated": {Type: "boolean"},
			}, Required: []string{"exitCode", "stdout", "stderr", "truncated"},
		},
		"ServiceSpec": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"name":         {Type: "string"},
				"mode":         {Type: "string", Enum: []string{"replicated", "global"}},
				"replicas":     {Type: "integer", Format: "int32"},
				"container":    {Ref: "#/components/schemas/ContainerSpec"},
				"ports":        {Type: "array", Items: refPtr("PortSpec")},
				"volumes":      {Type: "array", Items: refPtr("VolumeSpec")},
				"configs":      {Type: "array", Items: refPtr("ConfigSpec")},
				"placement":    {Type: "object"},
				"updateConfig": {Type: "object"},
				"preDeploy":    {Type: "object"},
				"caddy":        {Type: "object"},
			},
			Required: []string{"container"},
		},
		"ContainerSpec": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"image":        {Type: "string"},
				"command":      {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"entrypoint":   {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"env":          {Type: "object"},
				"volumeMounts": {Type: "array", Items: refPtr("VolumeMount")},
				"privileged":   {Type: "boolean"},
				"tty":          {Type: "boolean"},
				"openStdin":    {Type: "boolean"},
				"pullPolicy":   {Type: "string", Enum: []string{"always", "missing", "never"}},
			},
			Required: []string{"image"},
		},
		"PortSpec": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"hostname":      {Type: "string"},
				"hostIp":        {Type: "string"},
				"hostPrefix":    {Type: "string"},
				"publishedPort": {Type: "integer", Format: "int32"},
				"containerPort": {Type: "integer", Format: "int32"},
				"protocol":      {Type: "string", Enum: []string{"http", "https", "tcp", "udp"}},
				"mode":          {Type: "string", Enum: []string{"ingress", "host"}},
			},
		},
		"VolumeSpec": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"name":          {Type: "string"},
				"type":          {Type: "string", Enum: []string{"bind", "volume", "tmpfs"}},
				"bindOptions":   {Type: "object"},
				"volumeOptions": {Type: "object"},
				"tmpfsOptions":  {Type: "object"},
			},
		},
		"VolumeMount": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"volumeName":    {Type: "string"},
				"containerPath": {Type: "string"},
				"readOnly":      {Type: "boolean"},
			},
		},
		"ConfigSpec": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"name": {Type: "string"}, "content": {Type: "string", Format: "byte"}},
		},
		"RunServiceResponse": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"id": {Type: "string"}, "name": {Type: "string"}},
			Required:   []string{"id", "name"},
		},
		"DeployComposeRequest": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"compose": {Type: "string", Format: "byte", Description: "Base64-encoded Docker Compose file content."},
				"options": {Ref: "#/components/schemas/DeployComposeOptions"},
			},
			Required: []string{"compose"},
		},
		"DeployComposeOptions": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"profiles":   {Type: "array", Items: &OpenAPISchema{Type: "string"}, Description: "Compose profiles to enable."},
				"services":   {Type: "array", Items: &OpenAPISchema{Type: "string"}, Description: "Compose services to deploy. Dependencies are included automatically."},
				"recreate":   {Type: "boolean", Description: "Recreate containers even if their configuration and image haven't changed."},
				"skipHealth": {Type: "boolean", Description: "Skip the monitoring period and health checks after starting new containers."},
			},
		},
		"DeployComposePlanOperation": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"action":      {Type: "string"},
				"resource":    {Type: "string"},
				"name":        {Type: "string"},
				"service":     {Type: "string"},
				"machine":     {Type: "string"},
				"image":       {Type: "string"},
				"containerId": {Type: "string"},
				"order":       {Type: "string"},
			},
			Required: []string{"action", "resource"},
		},
		"DeployComposeEvent": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"type":       {Type: "string", Enum: []string{"plan", "progress", "complete", "error"}},
				"operations": {Type: "array", Items: refPtr("DeployComposePlanOperation")},
				"id":         {Type: "string"},
				"parentId":   {Type: "string"},
				"phase":      {Type: "string", Enum: []string{"working", "done", "warning", "error", "unknown"}},
				"statusText": {Type: "string"},
				"text":       {Type: "string"},
				"percent":    {Type: "integer", Format: "int32"},
				"current":    {Type: "integer", Format: "int64"},
				"total":      {Type: "integer", Format: "int64"},
				"status":     {Type: "string"},
				"error":      {Type: "string"},
			},
			Required: []string{"type"},
		},
		"CreateVolumeRequest": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"machine":    {Type: "string"},
				"name":       {Type: "string"},
				"driver":     {Type: "string"},
				"driverOpts": {Type: "object"},
				"labels":     {Type: "object"},
			},
			Required: []string{"machine", "name"},
		},
		"Volume": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"machineId":   {Type: "string"},
				"machineName": {Type: "string"},
				"volume":      {Type: "object", Description: "Docker volume metadata."},
			},
			Required: []string{"machineId", "machineName", "volume"},
		},
		"VolumeAttachment": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"machineId": {Type: "string"}, "machineName": {Type: "string"}, "volumeName": {Type: "string"},
				"attached": {Type: "boolean"}, "serviceId": {Type: "string"}, "serviceName": {Type: "string"},
				"containerId": {Type: "string"}, "containerName": {Type: "string"}, "destination": {Type: "string"},
			}, Required: []string{"machineId", "machineName", "volumeName", "attached"},
		},
		"ImageGroup": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"metadata":        {Type: "object"},
				"images":          {Type: "array", Items: &OpenAPISchema{Type: "object"}},
				"containerdStore": {Type: "boolean"},
			},
		},
		"MachineImage": {
			Type:       "object",
			Properties: map[string]OpenAPISchema{"metadata": {Type: "object"}, "image": {Type: "object"}},
		},
		"RemoteImage": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"machineId": {Type: "string"}, "machineName": {Type: "string"},
				"canonicalReference": {Type: "string"}, "digest": {Type: "string"}, "error": {Type: "string"},
			},
		},
		"ImageUpdate": {
			Type: "object", Properties: map[string]OpenAPISchema{
				"machineId": {Type: "string"}, "machineName": {Type: "string"}, "imageId": {Type: "string"},
				"localDigests": {Type: "array", Items: &OpenAPISchema{Type: "string"}},
				"remoteDigest": {Type: "string"}, "updateAvailable": {Type: "boolean"}, "error": {Type: "string"},
			}, Required: []string{"localDigests"},
		},
		"LogMetadata": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"serviceId": {Type: "string"}, "serviceName": {Type: "string"},
				"containerId": {Type: "string"}, "machineId": {Type: "string"},
				"machineName": {Type: "string"}, "hook": {Type: "string"},
			},
		},
		"LogEvent": {
			Type: "object",
			Properties: map[string]OpenAPISchema{
				"metadata":  {Ref: "#/components/schemas/LogMetadata"},
				"stream":    {Type: "string", Enum: []string{"stdout", "stderr", "heartbeat", "unknown"}},
				"timestamp": {Type: "string", Format: "date-time"},
				"message":   {Type: "string"},
				"error":     {Type: "string"},
			},
			Required: []string{"stream", "timestamp"},
		},
	}
}

func operation(
	tag, summary, operationID string,
	parameters []OpenAPIParameter,
	request *OpenAPIRequestBody,
	response map[string]OpenAPIResponse,
) *OpenAPIOperation {
	return &OpenAPIOperation{
		Tags:        []string{tag},
		Summary:     summary,
		OperationID: operationID,
		Parameters:  parameters,
		RequestBody: request,
		Responses:   response,
	}
}

func response(description string, schema OpenAPISchema) OpenAPIResponse {
	return OpenAPIResponse{
		Description: description,
		Content: map[string]OpenAPIMediaType{
			"application/json": {Schema: schema},
		},
	}
}

func responses(success OpenAPIResponse, notFound bool) map[string]OpenAPIResponse {
	return responsesWithStatus("200", success, notFound)
}

func createdResponses(success OpenAPIResponse, notFound bool) map[string]OpenAPIResponse {
	return responsesWithStatus("201", success, notFound)
}

func responsesWithStatus(successCode string, success OpenAPIResponse, notFound bool) map[string]OpenAPIResponse {
	result := map[string]OpenAPIResponse{
		successCode: success,
		"400":       response("Invalid request", ref("ErrorResponse")),
		"500":       response("Internal server error", ref("ErrorResponse")),
	}
	if notFound {
		result["404"] = response("Resource not found", ref("ErrorResponse"))
	}
	return result
}

func requestBody(description, schemaName string) *OpenAPIRequestBody {
	return &OpenAPIRequestBody{
		Description: description,
		Required:    true,
		Content: map[string]OpenAPIMediaType{
			"application/json": {Schema: ref(schemaName)},
		},
	}
}

func pathParameter(name string) OpenAPIParameter {
	return OpenAPIParameter{
		Name:     name,
		In:       "path",
		Required: true,
		Schema:   OpenAPISchema{Type: "string"},
	}
}

func queryParameter(name, description string, required bool, schema OpenAPISchema) OpenAPIParameter {
	return OpenAPIParameter{Name: name, In: "query", Description: description, Required: required, Schema: schema}
}

func ref(name string) OpenAPISchema {
	return OpenAPISchema{Ref: "#/components/schemas/" + name}
}

func refPtr(name string) *OpenAPISchema {
	schema := ref(name)
	return &schema
}

func arrayRef(name string) OpenAPISchema {
	return OpenAPISchema{Type: "array", Items: refPtr(name)}
}

func itemResponse(name string) OpenAPISchema {
	return OpenAPISchema{
		Type: "object",
		Properties: map[string]OpenAPISchema{
			"items": arrayRef(name),
		},
		Required: []string{"items"},
	}
}

func logParameters(includeMachines bool) []OpenAPIParameter {
	parameters := []OpenAPIParameter{
		queryParameter("follow", "Keep the connection open for new log entries.", false, OpenAPISchema{Type: "boolean"}),
		queryParameter("tail", "Number of recent lines to return. Use -1 for all lines.", false, OpenAPISchema{Type: "integer", Format: "int32"}),
		queryParameter("since", "Show logs since this Docker timestamp.", false, OpenAPISchema{Type: "string"}),
		queryParameter("until", "Show logs until this Docker timestamp.", false, OpenAPISchema{Type: "string"}),
		queryParameter("containers", "Comma-separated service container names or IDs.", false, OpenAPISchema{Type: "string"}),
	}
	if includeMachines {
		parameters = append(parameters, queryParameter("machines", "Comma-separated machine names or IDs.", false, OpenAPISchema{Type: "string"}))
	}
	return parameters
}

func streamResponses(notFound bool) map[string]OpenAPIResponse {
	result := map[string]OpenAPIResponse{
		"200": streamResponse("Server-Sent log events"),
		"400": response("Invalid request", ref("ErrorResponse")),
		"500": response("Internal server error", ref("ErrorResponse")),
	}
	if notFound {
		result["404"] = response("Resource not found", ref("ErrorResponse"))
	}
	return result
}

func deployStreamResponses(notFound bool) map[string]OpenAPIResponse {
	result := map[string]OpenAPIResponse{
		"200": {
			Description: "Server-Sent deployment events",
			Content: map[string]OpenAPIMediaType{
				"text/event-stream": {Schema: ref("DeployComposeEvent")},
			},
		},
		"400": response("Invalid request", ref("ErrorResponse")),
		"500": response("Internal server error", ref("ErrorResponse")),
	}
	if notFound {
		result["404"] = response("Resource not found", ref("ErrorResponse"))
	}
	return result
}

func streamResponse(description string) OpenAPIResponse {
	return OpenAPIResponse{
		Description: description,
		Content: map[string]OpenAPIMediaType{
			"text/event-stream": {Schema: ref("LogEvent")},
		},
	}
}
