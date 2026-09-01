# Stoat sidecar

HTTP API and Scalar docs for Uncloud. Stoat connects to this process through configured data sources.

## Run locally

From `sidecar/`:

```bash
go test ./...
go run ./cmd/sidecar
```

The server listens on `127.0.0.1:80` by default.

- Docs: http://127.0.0.1/docs
- Health: http://127.0.0.1/healthz
- OpenAPI: http://127.0.0.1/openapi.json
- Local Uncloud metrics: http://127.0.0.1/ucinternal/metrics

Use `--connect`, `--context`, and `--uncloud-config` to select a cluster. Use `--cors-origins` to allow a separately hosted UI.

If `--connect` is omitted, the sidecar reads `~/.config/uncloud/config.yaml`. If that file is missing, it falls back to `/run/uncloud/uncloud.sock`.

When the sidecar runs as a global Uncloud service, `/ucinternal/metrics` proxies the local daemon's Prometheus endpoint. It uses `UNCLOUD_MACHINE_ID` to resolve the local machine and requests its cluster-network IP on port `51090`; standalone runs without that environment variable return `503` for this endpoint.

## Docker

The image uses Uncloud's published Go module for its typed client bindings, so it only needs this repository.

```bash
docker compose up -d --build
```

This builds without an additional Docker context. The container mounts `/run/uncloud` and listens on `0.0.0.0:80`.

## systemd user unit

```bash
go build -o ~/.local/bin/sidecar ./cmd/sidecar
install -Dm644 sidecar.service ~/.config/systemd/user/sidecar.service
systemctl --user daemon-reload
systemctl --user enable --now sidecar.service
```
