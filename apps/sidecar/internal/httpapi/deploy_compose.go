package httpapi

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/acarl005/stripansi"
	"github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/compose/v2/pkg/progress"
	"github.com/psviderski/uncloud/pkg/client/compose"
	deployop "github.com/psviderski/uncloud/pkg/client/deploy/operation"
)

type deployProgressWriter struct {
	emit func(DeployComposeEvent) bool
}

func newDeployProgressWriter(ctx context.Context, events chan<- DeployComposeEvent) *deployProgressWriter {
	return &deployProgressWriter{emit: newDeployComposeEmitter(ctx, events, stripansi.Strip)}
}

func (w *deployProgressWriter) Start(context.Context) error { return nil }

func (w *deployProgressWriter) Stop() {}

func (w *deployProgressWriter) Event(event progress.Event) {
	w.emit(progressComposeEvent(event))
}

func (w *deployProgressWriter) Events(events []progress.Event) {
	for _, event := range events {
		if !w.emit(progressComposeEvent(event)) {
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
	if ctx.Err() != nil {
		return false
	}
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

// newDeployRedactor snapshots values after secret resolution, including partially
// resolved environments on failure. It never re-reads files or re-runs commands.
func newDeployRedactor(project *types.Project) func(string) string {
	values := make(map[string]struct{})
	add := func(value string) {
		value = stripansi.Strip(value)
		if value != "" {
			values[value] = struct{}{}
		}
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			values[trimmed] = struct{}{}
		}
	}
	// Ambient process values (e.g. PWD=/ or SHLVL=1) must not corrupt diagnostics.
	add(project.Environment["SIDECAR_TOKEN"])
	for _, service := range project.Services {
		for _, value := range service.Environment {
			if value != nil {
				add(*value)
			}
		}
	}
	var commandErrors []string
	for name, secret := range project.Secrets {
		add(secret.Content)
		if secret.Environment != "" {
			add(project.Environment[secret.Environment])
		}
		if secret.Driver == "exec" {
			commandErrors = append(commandErrors, stripansi.Strip(fmt.Sprintf("get the value of secret '%s': ", name)))
		}
	}
	ordered := make([]string, 0, len(values))
	for value := range values {
		ordered = append(ordered, value)
	}
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	pairs := make([]string, 0, len(ordered)*2)
	for _, value := range ordered {
		pairs = append(pairs, value, "[REDACTED]")
	}
	replacer := strings.NewReplacer(pairs...)
	return func(text string) string {
		text = stripansi.Strip(text)
		// Uncloud includes the command and arbitrary stderr in these errors.
		// Neither is safe to retain, even if no secret was successfully resolved.
		for _, prefix := range commandErrors {
			if before, _, found := strings.Cut(text, prefix); found {
				text = before + prefix + "secret command failed (details withheld)"
				break
			}
		}
		// ponytail: exact/trimmed values only; encoded or fragmented output needs source-aware redaction.
		return replacer.Replace(text)
	}
}

// Preserve error identity/status for HTTP handling, but expose only safe text.
type redactedDeployError struct {
	cause error
	text  string
}

func (e redactedDeployError) Error() string { return e.text }
func (e redactedDeployError) Unwrap() error { return e.cause }

func newDeployComposeEmitter(
	ctx context.Context,
	events chan<- DeployComposeEvent,
	redact func(string) string,
) func(DeployComposeEvent) bool {
	return func(event DeployComposeEvent) bool {
		// Type and Phase are fixed protocol enums, not upstream text.
		event.ID = redact(event.ID)
		event.ParentID = redact(event.ParentID)
		event.StatusText = redact(event.StatusText)
		event.Text = redact(event.Text)
		event.DeployStatus = redact(event.DeployStatus)
		event.Error = redact(event.Error)
		// Copy the slice so redaction cannot mutate the caller's plan data.
		event.Operations = append([]DeployComposePlanOperation(nil), event.Operations...)
		for i := range event.Operations {
			op := &event.Operations[i]
			op.Action = redact(op.Action)
			op.Resource = redact(op.Resource)
			op.Name = redact(op.Name)
			op.Service = redact(op.Service)
			op.Machine = redact(op.Machine)
			op.Image = redact(op.Image)
			op.ContainerID = redact(op.ContainerID)
			op.Order = redact(op.Order)
		}
		return emitDeployComposeEvent(ctx, events, event)
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
	emit := newDeployComposeEmitter(ctx, events, newDeployRedactor(composeDeploy.Project))
	plan, err := composeDeploy.Plan(ctx)
	if err != nil {
		emit(DeployComposeEvent{Type: "error", Error: err.Error()})
		return
	}
	if plan.IsEmpty() {
		emit(DeployComposeEvent{Type: "complete", DeployStatus: "up to date"})
		return
	}

	if !emit(DeployComposeEvent{
		Type:       "plan",
		Operations: planOperationsFromCompose(plan),
	}) {
		return
	}

	deployCtx := progress.WithContextWriter(ctx, &deployProgressWriter{emit: emit})
	if err := plan.Execute(deployCtx, cli); err != nil {
		emit(DeployComposeEvent{Type: "error", Error: err.Error()})
		return
	}

	emit(DeployComposeEvent{Type: "complete", DeployStatus: "deployed"})
}
