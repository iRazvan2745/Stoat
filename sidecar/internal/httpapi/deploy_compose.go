package httpapi

import (
	"context"

	"github.com/acarl005/stripansi"
	"github.com/docker/compose/v2/pkg/progress"
	"github.com/psviderski/uncloud/pkg/client/compose"
	deployop "github.com/psviderski/uncloud/pkg/client/deploy/operation"
)

type deployProgressWriter struct {
	ctx    context.Context
	events chan<- DeployComposeEvent
}

func newDeployProgressWriter(ctx context.Context, events chan<- DeployComposeEvent) *deployProgressWriter {
	return &deployProgressWriter{ctx: ctx, events: events}
}

func (w *deployProgressWriter) Start(context.Context) error { return nil }

func (w *deployProgressWriter) Stop() {}

func (w *deployProgressWriter) Event(event progress.Event) {
	_ = emitDeployComposeEvent(w.ctx, w.events, progressComposeEvent(event))
}

func (w *deployProgressWriter) Events(events []progress.Event) {
	for _, event := range events {
		if !emitDeployComposeEvent(w.ctx, w.events, progressComposeEvent(event)) {
			return
		}
	}
}

func (w *deployProgressWriter) TailMsgf(string, ...any) {}

func emitDeployComposeEvent(
	ctx context.Context,
	events chan<- DeployComposeEvent,
	event DeployComposeEvent,
) bool {
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func progressComposeEvent(event progress.Event) DeployComposeEvent {
	return DeployComposeEvent{
		Type:       "progress",
		ID:         stripansi.Strip(event.ID),
		ParentID:   stripansi.Strip(event.ParentID),
		Phase:      progressPhase(event.Status),
		StatusText: event.StatusText,
		Text:       event.Text,
		Percent:    event.Percent,
		Current:    event.Current,
		Total:      event.Total,
	}
}

func progressPhase(status progress.EventStatus) string {
	switch status {
	case progress.Working:
		return "working"
	case progress.Done:
		return "done"
	case progress.Warning:
		return "warning"
	case progress.Error:
		return "error"
	default:
		return "unknown"
	}
}

func planOperationsFromCompose(plan compose.Plan) []DeployComposePlanOperation {
	operations := make([]DeployComposePlanOperation, 0, len(plan.Volumes))
	for _, volumeOp := range plan.Volumes {
		operations = append(operations, DeployComposePlanOperation{
			Action:   "create",
			Resource: "volume",
			Name:     volumeOp.VolumeSpec.DockerVolumeName(),
			Machine:  volumeOp.MachineName,
		})
	}
	for _, servicePlan := range plan.Services {
		operations = append(operations, planOperationsFromOperations(servicePlan.Operations)...)
	}
	return operations
}

func planOperationsFromOperations(ops []deployop.Operation) []DeployComposePlanOperation {
	operations := make([]DeployComposePlanOperation, 0, len(ops))
	for _, op := range ops {
		switch o := op.(type) {
		case *deployop.CreateVolumeOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:   "create",
				Resource: "volume",
				Name:     o.VolumeSpec.DockerVolumeName(),
				Machine:  o.MachineName,
			})
		case *deployop.RunContainerOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:   "run",
				Resource: "container",
				Service:  o.Spec.Name,
				Machine:  o.MachineName,
				Image:    o.Spec.Container.Image,
			})
		case *deployop.ReplaceContainerOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:      "replace",
				Resource:    "container",
				Service:     o.Spec.Name,
				Machine:     o.MachineName,
				Image:       o.Spec.Container.Image,
				ContainerID: o.OldContainer.ShortID(),
				Order:       o.Order,
			})
		case *deployop.StopContainerOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:      "stop",
				Resource:    "container",
				ContainerID: o.ContainerID,
				Machine:     o.MachineName,
			})
		case *deployop.RemoveContainerOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:      "remove",
				Resource:    "container",
				Service:     o.Container.ServiceSpec.Name,
				ContainerID: o.Container.ShortID(),
				Machine:     o.MachineName,
			})
		case *deployop.RunPreDeployOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:   "run",
				Resource: "pre-deploy-hook",
				Service:  o.Spec.Name,
				Machine:  o.MachineName,
				Image:    o.Spec.Container.Image,
			})
		case *deployop.StopPreDeployOperation:
			operations = append(operations, DeployComposePlanOperation{
				Action:      "stop",
				Resource:    "pre-deploy-hook",
				Service:     o.Container.ServiceSpec.Name,
				ContainerID: o.Container.ShortID(),
				Machine:     o.MachineName,
			})
		case *deployop.SequenceOperation:
			operations = append(operations, planOperationsFromOperations(o.Operations)...)
		}
	}
	return operations
}

func runComposeDeployment(
	ctx context.Context,
	cli compose.Client,
	composeDeploy *compose.Deployment,
	events chan<- DeployComposeEvent,
) {
	plan, err := composeDeploy.Plan(ctx)
	if err != nil {
		emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "error", Error: err.Error()})
		return
	}
	if plan.IsEmpty() {
		emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "complete", DeployStatus: "up to date"})
		return
	}

	if !emitDeployComposeEvent(ctx, events, DeployComposeEvent{
		Type:       "plan",
		Operations: planOperationsFromCompose(plan),
	}) {
		return
	}

	deployCtx := progress.WithContextWriter(ctx, newDeployProgressWriter(ctx, events))
	if err := plan.Execute(deployCtx, cli); err != nil {
		emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "error", Error: err.Error()})
		return
	}

	emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "complete", DeployStatus: "deployed"})
}
