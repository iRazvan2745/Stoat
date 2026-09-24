package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/acarl005/stripansi"
	composecli "github.com/compose-spec/compose-go/v2/cli"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/psviderski/uncloud/pkg/client"
	"github.com/psviderski/uncloud/pkg/client/compose"
	"github.com/psviderski/uncloud/pkg/client/deploy"
	"golang.org/x/sync/errgroup"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
)

type clientBackend struct {
	*client.Client
	hostServiceName string
}

const DefaultHostServiceName = "sidecar"

// clusterFanoutLimit caps how many per-machine RPCs run at once. Cluster-wide
// endpoints query every machine, and doing that serially makes their latency the
// sum of every machine's timeout.
const clusterFanoutLimit = 8

// NewClientBackendWithHostService adapts *client.Client and configures the
// service used for machine host command execution.
func NewClientBackendWithHostService(cli *client.Client, hostServiceName string) Backend {
	hostServiceName = strings.TrimSpace(hostServiceName)
	if hostServiceName == "" {
		hostServiceName = DefaultHostServiceName
	}
	return &clientBackend{Client: cli, hostServiceName: hostServiceName}
}

func (b *clientBackend) Ready(ctx context.Context) error {
	_, err := b.Client.ListMachines(ctx, nil)
	return err
}

func (b *clientBackend) ClusterDiagnostics(ctx context.Context) (ClusterDiagnosticsResponse, error) {
	members, err := b.Client.ListMachines(ctx, nil)
	if err != nil {
		return ClusterDiagnosticsResponse{}, err
	}

	proxyCtx := b.Client.ProxyMachinesContext(ctx, nil)
	detailsResponse, err := b.Client.MachineClient.InspectMachine(proxyCtx, &emptypb.Empty{})
	if err != nil {
		return ClusterDiagnosticsResponse{}, fmt.Errorf("inspect cluster machines: %w", err)
	}
	detailsByID := make(map[string]map[string]int64, len(detailsResponse.Machines))
	links := make([]ClusterLinkResponse, 0)
	issues := make([]string, 0)
	for _, details := range detailsResponse.Machines {
		if details.Metadata != nil && details.Metadata.Error != "" {
			issues = append(issues, fmt.Sprintf("%s did not respond: %s", details.Metadata.MachineName, details.Metadata.Error))
			continue
		}
		if details.Machine == nil {
			continue
		}
		detailsByID[details.Machine.Id] = details.StoreVersion
		for peerID, stats := range details.Rtts {
			if stats == nil || stats.Median == nil || stats.StdDev == nil {
				continue
			}
			links = append(links, ClusterLinkResponse{
				From: details.Machine.Id, To: peerID,
				MedianMs:      float64(stats.Median.AsDuration()) / float64(time.Millisecond),
				StandardDevMs: float64(stats.StdDev.AsDuration()) / float64(time.Millisecond),
			})
		}
	}

	machines := make([]DiagnosticMachineResponse, 0, len(members))
	daemonVersions := make(map[string]struct{})
	dockerVersions := make(map[string]struct{})
	var baselineStoreVersion map[string]int64
	nativeMembers := members.ToNative()
	wireGuards := b.inspectWireGuard(ctx, nativeMembers)
	for i, member := range nativeMembers {
		diagnostic := DiagnosticMachineResponse{
			ID: member.ID, Name: member.Name, State: member.State,
			DaemonVersion: member.DaemonVersion, DockerVersion: member.DockerVersion,
			StoreVersion: detailsByID[member.ID],
			WireGuard:    wireGuards[i].network,
			Error:        wireGuards[i].err,
		}
		if member.State == "Down" {
			issues = append(issues, fmt.Sprintf("%s is down", member.Name))
		}
		if member.DaemonVersion != "" {
			daemonVersions[member.DaemonVersion] = struct{}{}
		}
		if member.DockerVersion != "" {
			dockerVersions[member.DockerVersion] = struct{}{}
		}
		if baselineStoreVersion == nil {
			baselineStoreVersion = diagnostic.StoreVersion
		} else if !reflect.DeepEqual(baselineStoreVersion, diagnostic.StoreVersion) {
			issues = append(issues, fmt.Sprintf("%s has a different cluster store version", member.Name))
		}
		machines = append(machines, diagnostic)
	}

	versionDrift := len(daemonVersions) > 1 || len(dockerVersions) > 1
	if versionDrift {
		issues = append(issues, "machine daemon or Docker versions differ")
	}
	sort.Slice(links, func(i, j int) bool {
		if links[i].From == links[j].From {
			return links[i].To < links[j].To
		}
		return links[i].From < links[j].From
	})
	sort.Strings(issues)
	status := "healthy"
	if len(issues) > 0 {
		status = "degraded"
	}
	return ClusterDiagnosticsResponse{
		Status: status, Issues: issues, Machines: machines, Links: links, VersionDrift: versionDrift,
	}, nil
}

func (b *clientBackend) ListCaddyConfigs(ctx context.Context) (CaddyConfigsResponse, error) {
	members, err := b.Client.ListMachines(ctx, nil)
	if err != nil {
		return CaddyConfigsResponse{}, err
	}

	configs := make([]CaddyConfigResponse, len(members))
	group := errgroup.Group{}
	group.SetLimit(clusterFanoutLimit)
	for i, member := range members {
		group.Go(func() error {
			item := CaddyConfigResponse{MachineID: member.Machine.Id, MachineName: member.Machine.Name}
			config, configErr := b.Client.Caddy.GetConfig(
				b.Client.ProxySingleMachineContext(ctx, member.Machine.Id), &emptypb.Empty{},
			)
			if configErr != nil {
				item.Error = configErr.Error()
			} else {
				item.Caddyfile = config.Caddyfile
				digest := sha256.Sum256([]byte(config.Caddyfile))
				item.SHA256 = hex.EncodeToString(digest[:])
				if config.ModifiedAt != nil {
					item.ModifiedAt = config.ModifiedAt.AsTime()
				}
			}
			configs[i] = item
			return nil
		})
	}
	// Per-machine failures are reported per item, so Wait cannot fail.
	_ = group.Wait()

	hashes := make(map[string]struct{})
	for _, config := range configs {
		if config.SHA256 != "" {
			hashes[config.SHA256] = struct{}{}
		}
	}
	return CaddyConfigsResponse{Items: configs, Drift: len(hashes) > 1}, nil
}

// wireGuardResult is one machine's WireGuard status, or the reason it could not
// be read. A machine that fails to answer must not fail the whole endpoint.
type wireGuardResult struct {
	network *WireGuardResponse
	err     string
}

// inspectWireGuard queries every machine concurrently, returning results in the
// same order as members.
func (b *clientBackend) inspectWireGuard(
	ctx context.Context, members []api.MachineMember,
) []wireGuardResult {
	results := make([]wireGuardResult, len(members))
	group := errgroup.Group{}
	group.SetLimit(clusterFanoutLimit)
	for i, member := range members {
		group.Go(func() error {
			wg, err := b.Client.MachineClient.InspectWireGuardNetwork(
				b.Client.ProxySingleMachineContext(ctx, member.ID), &emptypb.Empty{},
			)
			if err != nil {
				results[i] = wireGuardResult{err: err.Error()}
				return nil
			}

			peers := make([]WireGuardPeerResponse, 0, len(wg.Peers))
			for _, peer := range wg.Peers {
				peerResponse := WireGuardPeerResponse{
					Endpoint: peer.Endpoint, ReceiveBytes: peer.ReceiveBytes,
					TransmitBytes: peer.TransmitBytes, AllowedIPs: peer.AllowedIps,
				}
				if peer.LastHandshakeTime != nil {
					peerResponse.LastHandshakeAt = peer.LastHandshakeTime.AsTime()
				}
				peers = append(peers, peerResponse)
			}
			results[i] = wireGuardResult{network: &WireGuardResponse{
				InterfaceName: wg.InterfaceName, ListenPort: wg.ListenPort, Peers: peers,
			}}
			return nil
		})
	}
	// Per-machine failures are reported per result, so Wait cannot fail.
	_ = group.Wait()
	return results
}

func (b *clientBackend) InspectRemoteImage(ctx context.Context, id string) ([]RemoteImageResponse, error) {
	remoteID := id
	if isDockerImageID(id) {
		// Uncloud's registry inspection API expects a repository reference, but the
		// image routes also accept Docker image IDs. Resolve the latter through the
		// local image metadata before making the registry request.
		localImages, err := b.Client.InspectImage(b.Client.ProxyMachinesContext(ctx, nil), id)
		if err != nil {
			return nil, err
		}
		remoteID, err = imageRemoteReference(localImages)
		if err != nil {
			return nil, fmt.Errorf("resolve image %q for remote inspection: %w", id, err)
		}
	}

	images, err := b.Client.InspectRemoteImage(ctx, remoteID)
	if err != nil {
		return nil, err
	}
	responses := make([]RemoteImageResponse, 0, len(images))
	for _, machineImage := range images {
		response := RemoteImageResponse{}
		if metadata := machineImage.Metadata; metadata != nil {
			response.MachineID = metadata.MachineId
			response.MachineName = metadata.MachineName
			response.Error = metadata.Error
		}
		if machineImage.Image.Reference != nil {
			response.CanonicalReference = machineImage.Image.Reference.String()
			response.Digest = machineImage.Image.Reference.Digest().String()
		}
		responses = append(responses, response)
	}
	return responses, nil
}

func isDockerImageID(id string) bool {
	const digestPrefix = "sha256:"

	digest := strings.TrimPrefix(id, digestPrefix)
	if len(digest) != sha256.Size*2 {
		return false
	}

	_, err := hex.DecodeString(digest)
	return err == nil
}

func imageRemoteReference(images []api.MachineImage) (string, error) {
	for _, machineImage := range images {
		if machineImage.Metadata != nil && machineImage.Metadata.Error != "" {
			continue
		}
		for _, repoTag := range machineImage.Image.RepoTags {
			if repoTag != "" && repoTag != "<none>:<none>" {
				return repoTag, nil
			}
		}
	}

	for _, machineImage := range images {
		if machineImage.Metadata != nil && machineImage.Metadata.Error != "" {
			continue
		}
		for _, repoDigest := range machineImage.Image.RepoDigests {
			if repoDigest != "" {
				return repoDigest, nil
			}
		}
	}

	return "", errors.New("image has no repository tag or digest")
}

func (b *clientBackend) InspectImageUpdate(ctx context.Context, id string) ([]ImageUpdateResponse, error) {
	localImages, err := b.Client.InspectImage(ctx, id)
	if err != nil {
		return nil, err
	}
	remoteImages, err := b.InspectRemoteImage(ctx, id)
	if err != nil {
		return nil, err
	}
	return imageUpdateResponses(localImages, remoteImages), nil
}

func imageUpdateResponses(localImages []api.MachineImage, remoteImages []RemoteImageResponse) []ImageUpdateResponse {
	remoteByMachine := make(map[string]RemoteImageResponse, len(remoteImages))
	for _, remote := range remoteImages {
		remoteByMachine[remote.MachineID] = remote
	}
	// A registry lookup that is not machine-scoped produces a single result with
	// no machine ID, which applies to every machine. Anything else is matched by
	// machine ID: guessing would report a confident but wrong update status.
	var clusterWide *RemoteImageResponse
	if len(remoteImages) == 1 && remoteImages[0].MachineID == "" {
		clusterWide = &remoteImages[0]
	}

	responses := make([]ImageUpdateResponse, 0, len(localImages))
	for _, local := range localImages {
		response := ImageUpdateResponse{
			ImageID: local.Image.ID, LocalDigests: append([]string(nil), local.Image.RepoDigests...),
		}
		if metadata := local.Metadata; metadata != nil {
			response.MachineID = metadata.MachineId
			response.MachineName = metadata.MachineName
			response.Error = metadata.Error
		}
		remote, found := remoteByMachine[response.MachineID]
		if !found && clusterWide != nil {
			remote = *clusterWide
			found = true
		}
		if found {
			response.RemoteDigest = remote.Digest
			if response.Error == "" {
				response.Error = remote.Error
			}
		}
		if response.RemoteDigest != "" && response.Error == "" {
			updateAvailable := true
			for _, digest := range response.LocalDigests {
				if strings.HasSuffix(digest, "@"+response.RemoteDigest) {
					updateAvailable = false
					break
				}
			}
			response.UpdateAvailable = &updateAvailable
		}
		responses = append(responses, response)
	}
	return responses
}

func (b *clientBackend) ListVolumeAttachments(ctx context.Context) ([]VolumeAttachmentResponse, error) {
	volumes, err := b.Client.ListVolumes(ctx, nil)
	if err != nil {
		return nil, err
	}
	services, err := b.Client.ListServices(ctx)
	if err != nil {
		return nil, err
	}

	attachments := make([]VolumeAttachmentResponse, 0, len(volumes))
	for _, machineVolume := range volumes {
		found := false
		for _, service := range services {
			for _, serviceContainer := range service.Containers {
				if serviceContainer.MachineID != machineVolume.MachineID {
					continue
				}
				for _, mount := range serviceContainer.Container.Mounts {
					if mount.Name != machineVolume.Volume.Name {
						continue
					}
					found = true
					attachments = append(attachments, VolumeAttachmentResponse{
						MachineID: machineVolume.MachineID, MachineName: machineVolume.MachineName,
						VolumeName: machineVolume.Volume.Name, Attached: true,
						ServiceID: service.ID, ServiceName: service.Name,
						ContainerID:   serviceContainer.Container.ID,
						ContainerName: serviceContainer.Container.Name, Destination: mount.Destination,
					})
				}
			}
		}
		if !found {
			attachments = append(attachments, VolumeAttachmentResponse{
				MachineID: machineVolume.MachineID, MachineName: machineVolume.MachineName,
				VolumeName: machineVolume.Volume.Name, Attached: false,
			})
		}
	}
	return attachments, nil
}

func (b *clientBackend) ListMachines(ctx context.Context, filter *api.MachineFilter) ([]api.MachineMember, error) {
	machines, err := b.Client.ListMachines(ctx, filter)
	if err != nil {
		return nil, err
	}
	return machines.ToNative(), nil
}

func (b *clientBackend) InspectMachine(ctx context.Context, id string) (api.MachineMember, error) {
	member, err := b.Client.InspectMachine(ctx, id)
	if err != nil {
		return api.MachineMember{}, err
	}
	if member == nil {
		return api.MachineMember{}, api.ErrNotFound
	}
	return api.MachineMembersList{member}.ToNative()[0], nil
}

func (b *clientBackend) RenameMachine(ctx context.Context, id, name string) (MachineInfoResponse, error) {
	machine, err := b.Client.RenameMachine(ctx, id, name)
	if err != nil {
		return MachineInfoResponse{}, err
	}
	if machine == nil {
		return MachineInfoResponse{}, errors.New("Uncloud returned an empty machine response")
	}
	return MachineInfoResponse{ID: machine.Id, Name: machine.Name}, nil
}

func (b *clientBackend) ExecMachine(ctx context.Context, machineID string, opts api.ExecOptions) (int, error) {
	service, err := b.Client.InspectService(ctx, b.hostServiceName)
	if err != nil {
		return -1, status.Errorf(
			codes.Unavailable,
			"inspect host-exec sidecar service %q: %v",
			b.hostServiceName,
			err,
		)
	}

	target, err := findHostExecContainer(service, machineID)
	if err != nil {
		return -1, err
	}

	opts.Command = hostExecCommand(opts.Command)
	exitCode, err := b.Client.ExecContainer(ctx, b.hostServiceName, target.Container.ID, opts)
	if err != nil {
		return exitCode, fmt.Errorf("execute host command on machine %q: %w", machineID, err)
	}
	return exitCode, nil
}

func findHostExecContainer(service api.Service, machineID string) (api.MachineServiceContainer, error) {
	for _, candidate := range service.Containers {
		if candidate.MachineID != machineID {
			continue
		}
		if candidate.Container.State == nil || !candidate.Container.State.Running {
			continue
		}
		// hostExecCommand enters the namespaces of PID 1, which is the host's
		// init only when the container shares the host PID namespace. Without
		// this check a sidecar deployed without 'pid: host' would silently run
		// commands inside its own container while reporting success.
		if !hostPIDNamespace(candidate) {
			return api.MachineServiceContainer{}, status.Errorf(
				codes.FailedPrecondition,
				"host-exec sidecar container on machine %q does not share the host PID namespace; "+
					"deploy service %q with 'pid: host'",
				machineID,
				service.Name,
			)
		}
		return candidate, nil
	}

	return api.MachineServiceContainer{}, status.Errorf(
		codes.Unavailable,
		"host-exec sidecar service %q has no running container on machine %q",
		service.Name,
		machineID,
	)
}

func hostPIDNamespace(serviceContainer api.MachineServiceContainer) bool {
	hostConfig := serviceContainer.Container.HostConfig
	return hostConfig != nil && hostConfig.PidMode.IsHost()
}

func hostExecCommand(command []string) []string {
	const namespaceArgumentCount = 9

	wrapped := make([]string, 0, namespaceArgumentCount+len(command))
	wrapped = append(wrapped, "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--")
	return append(wrapped, command...)
}

// DeployCompose deploys services from a Compose file, replicating the behaviour
// of 'uc deploy' without the interactive build and confirmation steps.
func (b *clientBackend) DeployCompose(
	ctx context.Context, deployment ComposeDeployment,
) (<-chan DeployComposeEvent, error) {
	project, err := compose.LoadProjectFromContent(ctx, deployment.Content,
		composecli.WithDefaultProfiles(deployment.Options.Profiles...))
	if err != nil {
		return nil, redactedDeployError{err, "load compose file: " + stripansi.Strip(err.Error())}
	}

	if len(deployment.Options.Services) > 0 {
		project, err = project.WithSelectedServices(deployment.Options.Services)
		if err != nil {
			return nil, redactedDeployError{err, "select services: " + stripansi.Strip(err.Error())}
		}
	}

	err = compose.ResolveSecrets(ctx, project)
	redact := newDeployRedactor(project)
	if err != nil {
		return nil, redactedDeployError{err, redact("resolve secrets: " + err.Error())}
	}

	strategy := &deploy.RollingStrategy{
		ForceRecreate:     deployment.Options.Recreate,
		SkipHealthMonitor: deployment.Options.SkipHealth,
	}

	composeDeploy, err := compose.NewDeploymentWithStrategy(ctx, b.Client, project, strategy)
	if err != nil {
		return nil, redactedDeployError{err, redact("create compose deployment: " + err.Error())}
	}

	events := make(chan DeployComposeEvent, 16)
	go func() {
		defer close(events)
		runComposeDeployment(ctx, b.Client, composeDeploy, events)
	}()
	return events, nil
}
