package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/compose/v2/pkg/progress"
	"github.com/psviderski/uncloud/pkg/client/compose"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestDeployComposeEventsStopWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events := make(chan DeployComposeEvent, 1)
	events <- DeployComposeEvent{Type: "already-buffered"}
	cancel()

	assert.False(t, emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "dropped"}))

	writer := newDeployProgressWriter(ctx, events)
	writer.Event(progress.Event{ID: "dropped"})
	writer.Events([]progress.Event{{ID: "also-dropped"}})

	assert.Equal(t, DeployComposeEvent{Type: "already-buffered"}, <-events)
	assert.False(t, emitDeployComposeEvent(ctx, events, DeployComposeEvent{Type: "dropped"}),
		"cancellation must also win when the buffer has room")
}

func TestDeployComposeRedactsResolvedValuesAtEmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	file := filepath.Join(t.TempDir(), "credential")
	require.NoError(t, os.WriteFile(file, []byte("resolved-file\n"), 0o600))
	project := &types.Project{
		WorkingDir:  t.TempDir(),
		Environment: types.Mapping{"SOURCE": "resolved-env", "EMPTY": ""},
		Services: types.Services{"app": {Environment: types.Mapping{
			"PLAIN": "resolved", "ENV": "secret://env", "FILE": "secret://file", "EXEC": "secret://exec",
		}.ToMappingWithEquals()}},
		Secrets: types.Secrets{
			"env":     {Environment: "SOURCE"},
			"file":    {File: file},
			"exec":    {Driver: "exec", DriverOpts: map[string]string{"command": "printf resolved-exec"}},
			"content": {Content: "resolved-content"},
		},
	}
	require.NoError(t, compose.ResolveSecrets(ctx, project))
	assert.Equal(t, "resolved-exec", *project.Services["app"].Environment["EXEC"])
	project.Services["app"].Environment["UNSET"] = nil
	redact := newDeployRedactor(project)
	events := make(chan DeployComposeEvent, 4)
	emit := newDeployComposeEmitter(ctx, events, redact)
	writer := newDeployProgressWriter(ctx, events)
	writer.emit = emit
	require.NoError(t, writer.Start(ctx))

	progressEvent := progress.Event{
		ID: "container \x1b[31mresolved-env\x1b[0m", ParentID: "service resolved-file",
		Status: progress.Working, StatusText: "pulling resolved-exec",
		Text: "image resolved-con\x1b[32mtent\x1b[0m", Percent: 50, Current: 1, Total: 2,
	}
	// More than a deployment channel's buffer, with both progress entry points.
	for range 20 {
		writer.Event(progressEvent)
		writer.Events([]progress.Event{progressEvent})
		require.Len(t, events, 2)
		for range 2 {
			assert.Equal(t, DeployComposeEvent{
				Type: "progress", ID: "container [REDACTED]", ParentID: "service [REDACTED]",
				Phase: "working", StatusText: "pulling [REDACTED]", Text: "image [REDACTED]",
				Percent: 50, Current: 1, Total: 2,
			}, <-events)
		}
	}
	writer.Stop()
	require.NoError(t, ctx.Err(), "the progress writer must not cancel the deployment")

	plan := DeployComposeEvent{Type: "plan", Operations: []DeployComposePlanOperation{{
		Action: "\x1b[32mrun\x1b[0m", Resource: "container", Name: "volume resolved-file\n",
		Service: "app resolved-env", Machine: "node resolved-exec", Image: "image:resolved-content",
		ContainerID: "id-resolved-env", Order: "order resolved-file",
	}}}
	require.True(t, emit(plan))
	assert.Equal(t, DeployComposeEvent{Type: "plan", Operations: []DeployComposePlanOperation{{
		Action: "run", Resource: "container", Name: "volume [REDACTED]",
		Service: "app [REDACTED]", Machine: "node [REDACTED]", Image: "image:[REDACTED]",
		ContainerID: "id-[REDACTED]", Order: "order [REDACTED]",
	}}}, <-events)
	assert.Equal(t, "volume resolved-file\n", plan.Operations[0].Name, "do not mutate source data")

	require.True(t, emit(DeployComposeEvent{Type: "error", Error: "\x1b[31mstart failed: resolved-env resolved-file resolved-exec\x1b[0m"}))
	assert.Equal(t, DeployComposeEvent{Type: "error", Error: "start failed: [REDACTED] [REDACTED] [REDACTED]"}, <-events)
	require.True(t, emit(DeployComposeEvent{Type: "complete", DeployStatus: "\x1b[32mdeployed resolved-env\x1b[0m"}))
	assert.Equal(t, DeployComposeEvent{Type: "complete", DeployStatus: "deployed [REDACTED]"}, <-events)

	assert.Equal(t, "resolved-env", newDeployRedactor(&types.Project{})("resolved-env"), "redaction is deployment-scoped")
	serviceRedact := newDeployRedactor(&types.Project{Services: types.Services{"app": {Environment: types.Mapping{
		"SHORT": "x", "ANSI": "\x1b[31mcolored-secret\x1b[0m",
	}.ToMappingWithEquals()}}})
	assert.Equal(t, "[REDACTED]", serviceRedact("x"))
	assert.Equal(t, "[REDACTED]", serviceRedact("colored-secret"))
}

func TestDeployComposeRedactorIgnoresIncidentalProcessEnvironment(t *testing.T) {
	project := &types.Project{
		Environment: types.Mapping{
			"PWD": "/", "SHLVL": "1", "SIDECAR_TOKEN": "sidecar-token", "SECRET_SOURCE": "source-token",
		},
		Secrets: types.Secrets{"credential": {Environment: "SECRET_SOURCE"}},
	}
	const diagnostic = "registry/image failed with exit code 1"
	redact := newDeployRedactor(project)
	assert.Equal(t, diagnostic, redact(diagnostic))
	assert.Equal(t, "credentials: [REDACTED] [REDACTED]", redact("credentials: sidecar-token source-token"))

	project.Secrets["short"] = types.SecretConfig{Environment: "SHLVL"}
	assert.Equal(t, "registry/image failed with exit code [REDACTED]", newDeployRedactor(project)(diagnostic))
	project.Secrets["short"] = types.SecretConfig{Environment: "PWD"}
	assert.Equal(t, "registry[REDACTED]image failed with exit code 1", newDeployRedactor(project)(diagnostic))
}

func TestDeployComposeSecretCommandFailureHidesCommandAndStderr(t *testing.T) {
	project := &types.Project{
		WorkingDir: t.TempDir(),
		Services: types.Services{"app": {Environment: types.Mapping{
			"TOKEN": "secret://vault", "ALREADY_RESOLVED": "previous-secret",
		}.ToMappingWithEquals()}},
		Secrets: types.Secrets{"vault": {Driver: "exec", DriverOpts: map[string]string{
			"command": "sh -c 'printf unknown-sensitive-output >&2; exit 3'",
		}}},
	}
	err := compose.ResolveSecrets(context.Background(), project)
	require.ErrorContains(t, err, "unknown-sensitive-output")
	redact := newDeployRedactor(project)
	want := "resolve secrets: get the value of secret 'vault': secret command failed (details withheld)"
	assert.Equal(t, want, redact("resolve secrets: "+err.Error()))
	assert.Equal(t, "earlier failure: [REDACTED]", redact("earlier failure: previous-secret"))

	// Plan calls ResolveSecrets too; its terminal error must use the same boundary.
	events := make(chan DeployComposeEvent, 1)
	runComposeDeployment(context.Background(), nil, &compose.Deployment{Project: project}, events)
	require.Len(t, events, 1)
	assert.Equal(t, DeployComposeEvent{Type: "error", Error: want}, <-events)
}

func TestDeployComposePlanFailureRedactsResolvedValues(t *testing.T) {
	project := &types.Project{Services: types.Services{"app": {
		Name: "app", PullPolicy: "\x1b[31mprivate-policy\x1b[0m",
		Environment: types.Mapping{"TOKEN": "private-policy"}.ToMappingWithEquals(),
	}}}
	events := make(chan DeployComposeEvent, 1)
	runComposeDeployment(context.Background(), nil, &compose.Deployment{Project: project}, events)
	require.Len(t, events, 1)
	assert.Equal(t, DeployComposeEvent{
		Type: "error", Error: "convert compose service 'app' to service spec: unsupported pull policy: '[REDACTED]'",
	}, <-events)
}

func TestDeployComposeSynchronousErrors(t *testing.T) {
	backend := &clientBackend{}
	_, err := backend.DeployCompose(context.Background(), ComposeDeployment{Content: `
services:
  app:
    image: [invalid]
`})
	require.ErrorContains(t, err, "load compose file:")
	assert.ErrorContains(t, err, "services.app.image must be a string")

	_, err = backend.DeployCompose(context.Background(), ComposeDeployment{Content: `
services:
  app:
    image: nginx
    environment:
      TOKEN: resolved-token
      MISSING: secret://missing-resolved-token
`})
	require.ErrorContains(t, err, "resolve secrets:")
	assert.ErrorContains(t, err, "missing-[REDACTED]")
	assert.NotContains(t, err.Error(), "resolved-token")

	cause := status.Error(codes.Unavailable, "backend resolved-token")
	safe := redactedDeployError{cause, "create compose deployment: backend [REDACTED]"}
	assert.ErrorIs(t, safe, cause)
	assert.Equal(t, codes.Unavailable, status.Code(safe))
	assert.Equal(t, safe.Error(), status.Convert(safe).Message())
}

func TestDeployComposeRedactedWriterUnblocksOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan DeployComposeEvent)
	writer := newDeployProgressWriter(ctx, events)
	writer.emit = newDeployComposeEmitter(ctx, events, newDeployRedactor(&types.Project{}))
	done := make(chan struct{})
	go func() {
		writer.Events([]progress.Event{{ID: "first"}, {ID: "second"}})
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled deployment writer remained blocked")
	}
}
