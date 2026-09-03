package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"git.irazz.lol/stoat/sidecar/internal/cluster"
	"git.irazz.lol/stoat/sidecar/internal/httpapi"
	"github.com/spf13/cobra"
)

const defaultConfigPath = "~/.config/uncloud/config.yaml"

type options struct {
	listen         string
	configPath     string
	contextName    string
	connect        string
	allowedOrigins string
	hostService    string
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
	return cmd
}

func run(ctx context.Context, opts options) error {
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
		AllowedOrigins: opts.allowedOrigins,
		MachineID:      os.Getenv("UNCLOUD_MACHINE_ID"),
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
		return []cluster.Spec{direct}, nil
	}

	configPath := cluster.ExpandHome(opts.configPath)
	if cluster.Exists(configPath) {
		return cluster.LoadConfigSpecs(configPath, opts.contextName)
	}
	if cluster.Exists(cluster.DefaultUncloudSockPath) {
		return []cluster.Spec{{Unix: cluster.DefaultUncloudSockPath}}, nil
	}

	return nil, fmt.Errorf("no Uncloud connection found: set --connect, provide %s, or mount %s",
		configPath, cluster.DefaultUncloudSockPath)
}
