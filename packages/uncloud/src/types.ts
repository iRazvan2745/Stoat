/**
 * Convenience aliases for the generated Uncloud schema components.
 *
 * Import these instead of reaching into `generated/schema` directly, so the
 * generated file stays an implementation detail that can be regenerated freely.
 */
import type { components } from "./generated/schema";

export type Schemas = components["schemas"];

// Cluster
export type CaddyConfig = Schemas["CaddyConfig"];

export type CaddyConfigs = Schemas["CaddyConfigs"];

export type ClusterDiagnostics = Schemas["ClusterDiagnostics"];

export type ClusterLink = Schemas["ClusterLink"];

export type DiagnosticMachine = Schemas["DiagnosticMachine"];

export type DomainResponse = Schemas["DomainResponse"];

export type WireGuard = Schemas["WireGuard"];

export type WireGuardPeer = Schemas["WireGuardPeer"];

// Machines
export type Machine = Schemas["Machine"];

export type MachineNetwork = Schemas["MachineNetwork"];

export type MachineInfoResponse = Schemas["MachineInfoResponse"];

export type MachineExecRequest = Schemas["MachineExecRequest"];

export type MachineExecResponse = Schemas["MachineExecResponse"];

export type RenameMachineRequest = Schemas["RenameMachineRequest"];

// Services
export type Service = Schemas["Service"];

export type ServiceContainer = Schemas["ServiceContainer"];

export type ServiceSpec = Schemas["ServiceSpec"];

export type ContainerSpec = Schemas["ContainerSpec"];

export type ConfigSpec = Schemas["ConfigSpec"];

export type PortSpec = Schemas["PortSpec"];

export type RunServiceResponse = Schemas["RunServiceResponse"];

export type ContainerActionRequest = Schemas["ContainerActionRequest"];

export type ExecContainerRequest = Schemas["ExecContainerRequest"];

export type ExecContainerResponse = Schemas["ExecContainerResponse"];

export type DeployComposeRequest = Schemas["DeployComposeRequest"];

export type DeployComposeOptions = Schemas["DeployComposeOptions"];

export type DeployComposePlanOperation = Schemas["DeployComposePlanOperation"];

// Volumes
export type Volume = Schemas["Volume"];

export type VolumeSpec = Schemas["VolumeSpec"];

export type VolumeMount = Schemas["VolumeMount"];

export type VolumeAttachment = Schemas["VolumeAttachment"];

export type CreateVolumeRequest = Schemas["CreateVolumeRequest"];

// Images
export type ImageGroup = Schemas["ImageGroup"];

export type ImageUpdate = Schemas["ImageUpdate"];

export type MachineImage = Schemas["MachineImage"];

export type RemoteImage = Schemas["RemoteImage"];

// Shared
export type ErrorResponse = Schemas["ErrorResponse"];

export type StatusResponse = Schemas["StatusResponse"];

export type ReadinessResponse = Schemas["ReadinessResponse"];

// Server-Sent Event payloads
export type LogEvent = Schemas["LogEvent"];

export type LogMetadata = Schemas["LogMetadata"];

export type MachineExecEvent = Schemas["MachineExecEvent"];

export type DeployComposeEvent = Schemas["DeployComposeEvent"];
