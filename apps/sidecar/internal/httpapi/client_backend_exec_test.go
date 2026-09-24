package httpapi

import (
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestHostExecCommand(t *testing.T) {
	assert.Equal(t,
		[]string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "uname", "-a"},
		hostExecCommand([]string{"uname", "-a"}),
	)
}

func TestFindHostExecContainer(t *testing.T) {
	service := api.Service{
		ID:   "service-id",
		Name: "sidecar",
		Containers: []api.MachineServiceContainer{
			testHostExecContainer("machine-1", false, true),
			testHostExecContainer("machine-2", true, true),
			testHostExecContainer("machine-3", true, false),
		},
	}

	target, err := findHostExecContainer(service, "machine-2")
	require.NoError(t, err)
	assert.Equal(t, "machine-2", target.MachineID)

	_, err = findHostExecContainer(service, "machine-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no running container")

	// nsenter targets PID 1, which is the host's init only when the container
	// shares the host PID namespace.
	_, err = findHostExecContainer(service, "machine-3")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "host PID namespace")
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}

func TestFindHostExecContainerRequiresKnownHostConfig(t *testing.T) {
	unknown := testHostExecContainer("machine-1", true, false)
	unknown.Container.HostConfig = nil
	service := api.Service{Name: "sidecar", Containers: []api.MachineServiceContainer{unknown}}

	_, err := findHostExecContainer(service, "machine-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "host PID namespace")
}

func testHostExecContainer(machineID string, running, hostPID bool) api.MachineServiceContainer {
	pidMode := container.PidMode("")
	if hostPID {
		pidMode = container.PidMode("host")
	}
	return api.MachineServiceContainer{
		MachineID: machineID,
		Container: api.ServiceContainer{
			Container: api.Container{
				InspectResponse: container.InspectResponse{
					ContainerJSONBase: &container.ContainerJSONBase{
						State:      &container.State{Running: running},
						HostConfig: &container.HostConfig{PidMode: pidMode},
					},
				},
			},
		},
	}
}
