package httpapi

import (
	"context"
	"errors"
	"fmt"

	composecli "github.com/compose-spec/compose-go/v2/cli"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/psviderski/uncloud/pkg/client"
	"github.com/psviderski/uncloud/pkg/client/compose"
	"github.com/psviderski/uncloud/pkg/client/deploy"
)

type clientBackend struct {
	*client.Client
}

// NewClientBackend adapts *client.Client to the HTTP API Backend interface.
func NewClientBackend(cli *client.Client) Backend {
	return &clientBackend{Client: cli}
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

// DeployCompose deploys services from a Compose file, replicating the behaviour
// of 'uc deploy' without the interactive build and confirmation steps.
func (b *clientBackend) DeployCompose(ctx context.Context, req DeployComposeRequest) (<-chan DeployComposeEvent, error) {
	project, err := compose.LoadProjectFromContent(ctx, req.Compose,
		composecli.WithDefaultProfiles(req.Options.Profiles...))
	if err != nil {
		return nil, fmt.Errorf("load compose file: %w", err)
	}

	if len(req.Options.Services) > 0 {
		project, err = project.WithSelectedServices(req.Options.Services)
		if err != nil {
			return nil, fmt.Errorf("select services: %w", err)
		}
	}

	if err := compose.ResolveSecrets(ctx, project); err != nil {
		return nil, fmt.Errorf("resolve secrets: %w", err)
	}

	strategy := &deploy.RollingStrategy{
		ForceRecreate:     req.Options.Recreate,
		SkipHealthMonitor: req.Options.SkipHealth,
	}
	composeDeploy, err := compose.NewDeploymentWithStrategy(ctx, b.Client, project, strategy)
	if err != nil {
		return nil, fmt.Errorf("create compose deployment: %w", err)
	}

	events := make(chan DeployComposeEvent, 16)
	go func() {
		defer close(events)
		runComposeDeployment(ctx, b.Client, composeDeploy, events)
	}()
	return events, nil
}
