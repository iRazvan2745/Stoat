# Stoat sidecar

HTTP API and Scalar docs for Uncloud. Stoat connects to this process through configured data sources.

## Authentication

Every endpoint except `/healthz` requires a bearer token, read from the `SIDECAR_TOKEN` environment variable. The process refuses to start without one: it executes commands as root on every cluster machine, so an unauthenticated instance is a remote root shell for anyone who can reach the listen address.

```bash
export SIDECAR_TOKEN="$(openssl rand -hex 32)"
curl -H "Authorization: Bearer $SIDECAR_TOKEN" http://127.0.0.1/api/v1/machines
```

The token is an environment variable rather than a flag so it stays out of the process list and shell history. `/healthz` is exempt so container and load balancer probes work without credentials; it reports only that the process is running. `/readyz` talks to the cluster and is therefore authenticated.

This is transport-level authentication only — there are no users, roles, or scopes. Any holder of the token can do everything, including running host commands. Treat it as a root credential and keep the sidecar off any network you do not control.

## Run locally

From `sidecar/`:

```bash
go test ./...
SIDECAR_TOKEN=local-development-token go run ./cmd/sidecar
```

The server listens on `127.0.0.1:80` by default.

- Docs: http://127.0.0.1/docs
- Health: http://127.0.0.1/healthz
- OpenAPI: http://127.0.0.1/openapi.json
- Local Uncloud metrics: http://127.0.0.1/ucinternal/metrics

Use `--connect`, `--context`, and `--uncloud-config` to select a cluster. Use `--cors-origins` to allow a separately hosted UI.

If `--connect` is omitted, the sidecar reads `~/.config/uncloud/config.yaml`. If that file is missing, it falls back to `/run/uncloud/api/uncloud.sock`, then the legacy `/run/uncloud/uncloud.sock`. Passing `--connect unix://` with either well-known path also tries the other, so old and new Uncloud layouts both work.

When the sidecar runs as a global Uncloud service, `/ucinternal/metrics` proxies the local daemon's Prometheus endpoint. It uses `UNCLOUD_MACHINE_ID` to resolve the local machine and requests the machine's first usable cluster IPv4 address on port `51090`; standalone runs without that environment variable return `503` for this endpoint.

## Timeouts

Requests are bounded so a stuck cluster RPC cannot pin a connection forever:

- `--request-timeout` (default 60s) applies to everything that is neither a command execution nor an event stream.
- `--exec-timeout` (default 5m) applies to container and host command execution, which detaches from the request deadline.

Event streams are unbounded by design and instead emit a Server-Sent Event comment every 15 seconds. The heartbeat is load-bearing: fasthttp reports server shutdown but not client disconnects, so an idle stream would otherwise never notice its client is gone and would leak the upstream cluster stream.

## Host command execution

The sidecar exposes two machine-targeted command endpoints:

```text
POST /api/v1/machines/{machineId}/exec
POST /api/v1/machines/{machineId}/exec/stream
```

Both accept a JSON body with an argv-style command, which avoids invoking a shell by default:

```json
{ "command": ["uname", "-a"], "stdin": "optional input" }
```

The first endpoint waits for completion and returns JSON containing `stdout`, `stderr`, and `exitCode`. The streaming endpoint returns Server-Sent Events with `stdout`, `stderr`, `complete`, or `error` events. To intentionally run a shell command, pass `["sh", "-lc", "your command"]` as the command array.

This feature executes with host-root-equivalent privileges on the selected machine. The global sidecar therefore needs `privileged: true`, `pid: host`, the read-only Uncloud socket mount, and the host root mounted at `/host`. The Uncloud service containing the target sidecars is `sidecar` by default; change it with `--host-service` if the service is renamed.

`pid: host` is verified rather than assumed. Execution enters the namespaces of PID 1, which is the host's init only when the container shares the host PID namespace; without it, commands would silently run inside the container while reporting success. A target whose container is not in the host PID namespace is rejected with `422`.

## Docker

The image uses Uncloud's published Go module for its typed client bindings, so it only needs this repository.

```bash
export SIDECAR_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
```

This builds without an additional Docker context. The container mounts `/run/uncloud` (covering both the current `api/uncloud.sock` and the legacy `uncloud.sock`) and listens on `0.0.0.0:80`.

## OpenAPI

The document in `internal/httpapi/openapi.go` is written by hand, and a test compares it against the routes the server registers in both directions, so a new route or a removed path fails the build.

`packages/uncloud` vendors the generated spec. Refresh it from this source rather than from a running server:

```bash
pnpm uc:refresh
```

## systemd user unit

```bash
go build -o ~/.local/bin/sidecar ./cmd/sidecar
install -Dm644 sidecar.service ~/.config/systemd/user/sidecar.service
systemctl --user daemon-reload
systemctl --user enable --now sidecar.service
```

The unit must provide `SIDECAR_TOKEN`, for example through `EnvironmentFile=%h/.config/sidecar/env`.
