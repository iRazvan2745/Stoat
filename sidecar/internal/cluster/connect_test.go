package cluster

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseConnectFlag(t *testing.T) {
	tests := []struct {
		name        string
		value       string
		expected    Spec
		expectedErr string
	}{
		{name: "empty", value: ""},
		{name: "ssh default", value: "root@example.com", expected: Spec{SSH: "root@example.com"}},
		{name: "ssh explicit", value: "ssh://root@example.com:2222", expected: Spec{SSH: "root@example.com:2222"}},
		{name: "ssh go", value: "ssh+go://root@example.com", expected: Spec{SSHGo: "root@example.com"}},
		{name: "ssh cli alias", value: "ssh+cli://root@example.com", expected: Spec{SSH: "root@example.com"}},
		{name: "unix", value: "unix:///run/uncloud/uncloud.sock", expected: Spec{Unix: "/run/uncloud/uncloud.sock"}},
		{
			name:  "tcp",
			value: "tcp://127.0.0.1:51000",
			expected: func() Spec {
				address := netip.MustParseAddrPort("127.0.0.1:51000")
				return Spec{TCP: &address}
			}(),
		},
		{name: "invalid tcp", value: "tcp://127.0.0.1", expectedErr: "parse TCP connection"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actual, err := ParseConnectFlag(test.value)
			if test.expectedErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), test.expectedErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, test.expected, actual)
		})
	}
}

func TestLoadConfigSpecs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte(`
current_context: appa
contexts:
  appa:
    connections:
      - unix: /run/uncloud/uncloud.sock
      - ssh: root@example.com
  other:
    connections:
      - tcp: 127.0.0.1:51000
`), 0o600))

	specs, err := LoadConfigSpecs(path, "")
	require.NoError(t, err)
	require.Len(t, specs, 2)
	assert.Equal(t, "/run/uncloud/uncloud.sock", specs[0].Unix)
	assert.Equal(t, "root@example.com", specs[1].SSH)

	specs, err = LoadConfigSpecs(path, "other")
	require.NoError(t, err)
	require.Len(t, specs, 1)
	require.NotNil(t, specs[0].TCP)
	assert.Equal(t, "127.0.0.1:51000", specs[0].TCP.String())
}

func TestParseSSHDestination(t *testing.T) {
	user, host, port, err := parseSSHDestination("root@example.com:2222")
	require.NoError(t, err)
	assert.Equal(t, "root", user)
	assert.Equal(t, "example.com", host)
	assert.Equal(t, 2222, port)
}
