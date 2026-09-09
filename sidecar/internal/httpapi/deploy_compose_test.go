package httpapi

import (
	"context"
	"testing"

	"github.com/docker/compose/v2/pkg/progress"
	"github.com/stretchr/testify/assert"
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
}
