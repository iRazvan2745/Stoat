package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.irazz.lol/stoat/sidecar/internal/cluster"
	"git.irazz.lol/stoat/sidecar/internal/httpapi"
	"github.com/spf13/cobra"
)

const (
	defaultConfigPath = "~/.config/uncloud/config.yaml"
	// authTokenEnv holds the bearer token required by the HTTP API. It is an
	// environment variable rather than a flag so that it does not end up in the
	// process list or in shell history.
	authTokenEnv = "SIDECAR_TOKEN"
	// minAuthTokenLength is a floor, not a policy. It only rejects tokens that
	// are obviously not randomly generated.
	minAuthTokenLength = 16
)

type options struct {
	listen         string
	configPath     string
	contextName    string
	connect        string
	allowedOrigins string
	hostService    string
	requestTimeout time.Duration
	execTimeout    time.Duration
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := newCommand().ExecuteContext(ctx); err != nil {
		cobra.CheckErr(err)
	}
}

func newCommand() *cobra.Command {
	opts := options{}
	cmd := &cobra.Command{
		Use:           "sidecar",
		Short:         "REST API and Scalar documentation server for Uncloud.",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd.Context(), opts)
		},
	}
	cmd.Flags().StringVar(&opts.listen, "listen", "127.0.0.1:80", "HTTP listen address.")
	cmd.Flags().StringVar(&opts.configPath, "uncloud-config", defaultConfigPath,
		"Path to the Uncloud configuration file.")
	cmd.Flags().StringVarP(&opts.contextName, "context", "c", "", "Cluster context to use.")
	cmd.Flags().StringVar(&opts.connect, "connect", "",
		"Connect directly using the same format as uc --connect: [ssh://]user@host[:port], ssh+go://user@host[:port], tcp://host:port, or unix:///path/to/uncloud.sock.")
	cmd.Flags().StringVar(&opts.allowedOrigins, "cors-origins", "http://localhost:3000,http://localhost:5173",
		"Comma-separated browser origins allowed by CORS. Use an empty value to disable CORS.")
	cmd.Flags().StringVar(&opts.hostService, "host-service", httpapi.DefaultHostServiceName,
		"Uncloud service name of the global sidecar used for host command execution.")
	cmd.Flags().DurationVar(&opts.requestTimeout, "request-timeout", httpapi.DefaultRequestTimeout,
		"Maximum duration of a request that is neither a command execution nor an event stream.")
	cmd.Flags().DurationVar(&opts.execTimeout, "exec-timeout", httpapi.DefaultExecTimeout,
		"Maximum duration of a container or host command execution.")
	return cmd
}

// authToken reads the bearer token the HTTP API requires. Startup fails without
// it: the API runs commands as root on every cluster machine, so an instance
// without a token is a remote root shell for anyone who can reach it.
func authToken() (string, error) {
	token := os.Getenv(authTokenEnv)
	if token == "" {
		return "", fmt.Errorf(
			"%s is not set: the sidecar API executes privileged commands and refuses to serve without a bearer token",
			authTokenEnv,
		)
	}
	if len(token) < minAuthTokenLength {
		return "", fmt.Errorf("%s must be at least %d characters", authTokenEnv, minAuthTokenLength)
	}
	return token, nil
}

func run(ctx context.Context, opts options) error {
	token, err := authToken()
	if err != nil {
		return err
	}

	specs, err := connectionSpecs(opts)
	if err != nil {
		return err
	}

	clusterClient, err := cluster.Connect(ctx, specs)
	if err != nil {
		return fmt.Errorf("connect to Uncloud cluster: %w", err)
	}
	defer func() { _ = clusterClient.Close() }()

	server, err := httpapi.New(httpapi.NewClientBackendWithHostService(clusterClient, opts.hostService), httpapi.Config{
		AuthToken:      token,
		AllowedOrigins: opts.allowedOrigins,
		MachineID:      os.Getenv("UNCLOUD_MACHINE_ID"),
		RequestTimeout: opts.requestTimeout,
		ExecTimeout:    opts.execTimeout,
	})
	if err != nil {
		return fmt.Errorf("create HTTP API: %w", err)
	}

	listenErr := make(chan error, 1)
	go func() {
		listenErr <- server.App().Listen(opts.listen)
	}()

	select {
	case <-ctx.Done():
		if err := server.App().Shutdown(); err != nil {
			return fmt.Errorf("shut down HTTP API: %w", err)
		}
		return nil
	case err := <-listenErr:
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return fmt.Errorf("serve HTTP API: %w", err)
	}
}

func connectionSpecs(opts options) ([]cluster.Spec, error) {
	direct, err := cluster.ParseConnectFlag(opts.connect)
	if err != nil {
		return nil, err
	}
	if !direct.Empty() {
		if direct.Unix != "" {
			return cluster.UnixSpecs(direct.Unix), nil
		}
		return []cluster.Spec{direct}, nil
	}

	configPath := cluster.ExpandHome(opts.configPath)
	if cluster.Exists(configPath) {
		return cluster.LoadConfigSpecs(configPath, opts.contextName)
	}
	if specs := cluster.ExistingUnixSpecs(); len(specs) > 0 {
		return specs, nil
	}

	return nil, fmt.Errorf("no Uncloud connection found: set --connect, provide %s, or mount %s or %s",
		configPath, cluster.DefaultUncloudSockPath, cluster.LegacyUncloudSockPath)
}
