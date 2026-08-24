package cluster

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"

	"github.com/goccy/go-yaml"
	"github.com/psviderski/uncloud/pkg/client"
	"github.com/psviderski/uncloud/pkg/client/connector"
)

const DefaultUncloudSockPath = "/run/uncloud/uncloud.sock"

// Spec describes one way to reach an Uncloud machine API.
type Spec struct {
	SSH        string
	SSHGo      string
	SSHKeyFile string
	TCP        *netip.AddrPort
	Unix       string
}

func (s Spec) Empty() bool {
	return s.SSH == "" && s.SSHGo == "" && s.TCP == nil && s.Unix == ""
}

func (s Spec) String() string {
	switch {
	case s.SSH != "":
		return "ssh://" + s.SSH
	case s.SSHGo != "":
		return "ssh+go://" + s.SSHGo
	case s.TCP != nil && s.TCP.IsValid():
		return "tcp://" + s.TCP.String()
	case s.Unix != "":
		return "unix://" + s.Unix
	default:
		return "unknown connection"
	}
}

// ParseConnectFlag parses --connect values in the same formats as uc --connect.
func ParseConnectFlag(value string) (Spec, error) {
	if value == "" {
		return Spec{}, nil
	}

	if after, ok := strings.CutPrefix(value, "tcp://"); ok {
		address, err := netip.ParseAddrPort(after)
		if err != nil {
			return Spec{}, fmt.Errorf("parse TCP connection: %w", err)
		}
		return Spec{TCP: &address}, nil
	}
	if after, ok := strings.CutPrefix(value, "ssh+go://"); ok {
		return Spec{SSHGo: after}, nil
	}
	if after, ok := strings.CutPrefix(value, "ssh+cli://"); ok {
		return Spec{SSH: after}, nil
	}
	if strings.HasPrefix(value, "unix://") {
		return Spec{Unix: strings.TrimPrefix(value, "unix://")}, nil
	}
	return Spec{SSH: strings.TrimPrefix(value, "ssh://")}, nil
}

// Connect opens a cluster client for the first spec that succeeds.
func Connect(ctx context.Context, specs []Spec) (*client.Client, error) {
	if len(specs) == 0 {
		return nil, errors.New("no Uncloud connection specified")
	}

	var lastErr error
	for _, spec := range specs {
		clusterClient, err := connectOne(ctx, spec)
		if err == nil {
			return clusterClient, nil
		}
		lastErr = err
	}
	if len(specs) == 1 {
		return nil, lastErr
	}
	return nil, fmt.Errorf("all %d Uncloud connections failed; last error: %w", len(specs), lastErr)
}

func connectOne(ctx context.Context, spec Spec) (*client.Client, error) {
	switch {
	case spec.TCP != nil && spec.TCP.IsValid():
		return client.New(ctx, connector.NewTCPConnector(*spec.TCP))
	case spec.Unix != "":
		return client.New(ctx, connector.NewUnixConnector(spec.Unix))
	case spec.SSH != "":
		cfg, err := sshConfig(spec.SSH, spec.SSHKeyFile)
		if err != nil {
			return nil, err
		}
		return client.New(ctx, connector.NewSSHCLIConnector(cfg))
	case spec.SSHGo != "":
		cfg, err := sshConfig(spec.SSHGo, spec.SSHKeyFile)
		if err != nil {
			return nil, err
		}
		return client.New(ctx, connector.NewSSHConnector(cfg))
	default:
		return nil, errors.New("connection configuration is invalid")
	}
}

func sshConfig(destination, keyPath string) (*connector.SSHConnectorConfig, error) {
	user, host, port, err := parseSSHDestination(destination)
	if err != nil {
		return nil, fmt.Errorf("parse SSH connection %q: %w", destination, err)
	}
	return &connector.SSHConnectorConfig{
		User:    user,
		Host:    host,
		Port:    port,
		KeyPath: ExpandHome(keyPath),
	}, nil
}

func parseSSHDestination(destination string) (user, host string, port int, err error) {
	host = destination
	if strings.Contains(host, "@") {
		user, host, _ = strings.Cut(host, "@")
	}
	h, p, splitErr := net.SplitHostPort(host)
	if splitErr == nil {
		host = h
		port, err = strconv.Atoi(p)
	}
	return user, host, port, err
}

// ExpandHome expands a leading ~ to the current user's home directory.
func ExpandHome(path string) string {
	if path == "" || path[0] != '~' {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return strings.Replace(path, "~", home, 1)
}

type uncloudConfig struct {
	CurrentContext string                     `yaml:"current_context"`
	Contexts       map[string]*uncloudContext `yaml:"contexts"`
}

type uncloudContext struct {
	Connections []uncloudConnection `yaml:"connections"`
}

type uncloudConnection struct {
	SSH        string          `yaml:"ssh,omitempty"`
	SSHCLI     string          `yaml:"ssh_cli,omitempty"`
	SSHGo      string          `yaml:"ssh_go,omitempty"`
	SSHKeyFile string          `yaml:"ssh_key_file,omitempty"`
	TCP        *netip.AddrPort `yaml:"tcp,omitempty"`
	Unix       string          `yaml:"unix,omitempty"`
}

func (c uncloudConnection) spec() Spec {
	ssh := c.SSH
	if ssh == "" {
		ssh = c.SSHCLI
	}
	return Spec{
		SSH:        ssh,
		SSHGo:      c.SSHGo,
		SSHKeyFile: c.SSHKeyFile,
		TCP:        c.TCP,
		Unix:       c.Unix,
	}
}

// LoadConfigSpecs reads Uncloud cluster connections from a config file.
func LoadConfigSpecs(path, contextName string) ([]Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read Uncloud config: %w", err)
	}

	var cfg uncloudConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse Uncloud config %s: %w", path, err)
	}
	if len(cfg.Contexts) == 0 {
		return nil, fmt.Errorf("no cluster contexts found in the Uncloud config (%s)", path)
	}

	if contextName == "" {
		contextName = cfg.CurrentContext
	}
	if contextName == "" {
		return nil, fmt.Errorf("the current cluster context is not set in the Uncloud config (%s)", path)
	}

	cluster, ok := cfg.Contexts[contextName]
	if !ok || cluster == nil {
		return nil, fmt.Errorf("cluster context %q not found in the Uncloud config (%s)", contextName, path)
	}

	specs := make([]Spec, 0, len(cluster.Connections))
	for _, conn := range cluster.Connections {
		spec := conn.spec()
		if spec.Empty() {
			continue
		}
		specs = append(specs, spec)
	}
	if len(specs) == 0 {
		return nil, fmt.Errorf("no ssh, tcp, or unix connections found for cluster context %q in %s", contextName, path)
	}
	return specs, nil
}

// Exists reports whether path exists.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
