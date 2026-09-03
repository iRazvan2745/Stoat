package httpapi

import (
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
			testHostExecContainer("machine-1", false),
			testHostExecContainer("machine-2", true),
		},
	}

	target, err := findHostExecContainer(service, "machine-2")
	require.NoError(t, err)
	assert.Equal(t, "machine-2", target.MachineID)

	_, err = findHostExecContainer(service, "machine-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no running container")
}

func testHostExecContainer(machineID string, running bool) api.MachineServiceContainer {
	return api.MachineServiceContainer{
		MachineID: machineID,
		Container: api.ServiceContainer{
			Container: api.Container{
				InspectResponse: container.InspectResponse{
					ContainerJSONBase: &container.ContainerJSONBase{
						State: &container.State{Running: running},
					},
				},
			},
		},
	}
}
