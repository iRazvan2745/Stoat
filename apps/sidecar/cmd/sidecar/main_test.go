package main

import (
	"strings"
	"testing"

	"git.irazz.lol/stoat/sidecar/internal/cluster"
	"git.irazz.lol/stoat/sidecar/internal/httpapi"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCommandDefaults(t *testing.T) {
	command := newCommand()
	assert.Equal(t, "127.0.0.1:80", command.Flag("listen").Value.String())
	assert.Equal(t, defaultConfigPath, command.Flag("uncloud-config").Value.String())
	assert.Equal(t, "http://localhost:3000,http://localhost:5173", command.Flag("cors-origins").Value.String())
	assert.Equal(t, "sidecar", command.Flag("host-service").Value.String())
	assert.Equal(t, httpapi.DefaultRequestTimeout.String(), command.Flag("request-timeout").Value.String())
	assert.Equal(t, httpapi.DefaultExecTimeout.String(), command.Flag("exec-timeout").Value.String())
}

func TestAuthTokenIsRequired(t *testing.T) {
	t.Setenv(authTokenEnv, "")
	_, err := authToken()
	require.Error(t, err)
	assert.Contains(t, err.Error(), authTokenEnv)

	t.Setenv(authTokenEnv, "too-short")
	_, err = authToken()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "at least")

	valid := strings.Repeat("a", minAuthTokenLength)
	t.Setenv(authTokenEnv, valid)
	token, err := authToken()
	require.NoError(t, err)
	assert.Equal(t, valid, token)
}

func TestConnectionSpecsExpandsDefaultUnixSockets(t *testing.T) {
	specs, err := connectionSpecs(options{connect: "unix://" + cluster.LegacyUncloudSockPath})
	require.NoError(t, err)
	require.Len(t, specs, 2)
	assert.Equal(t, cluster.LegacyUncloudSockPath, specs[0].Unix)
	assert.Equal(t, cluster.DefaultUncloudSockPath, specs[1].Unix)

	specs, err = connectionSpecs(options{connect: "unix://" + cluster.DefaultUncloudSockPath})
	require.NoError(t, err)
	require.Len(t, specs, 2)
	assert.Equal(t, cluster.DefaultUncloudSockPath, specs[0].Unix)
	assert.Equal(t, cluster.LegacyUncloudSockPath, specs[1].Unix)
}

func TestConnectionSpecsKeepsCustomUnixSocket(t *testing.T) {
	specs, err := connectionSpecs(options{connect: "unix:///tmp/custom.sock"})
	require.NoError(t, err)
	require.Len(t, specs, 1)
	assert.Equal(t, "/tmp/custom.sock", specs[0].Unix)
}
