# Stoat sidecar

HTTP API and Scalar docs for Uncloud. Stoat talks to this process over `UNCLOUD_API`.

## Run locally

From `sidecar/`:

```bash
go test ./...
go run ./cmd/sidecar
```

The server listens on `127.0.0.1:8080` by default.

- Docs: http://127.0.0.1:8080/docs
- Health: http://127.0.0.1:8080/healthz
- OpenAPI: http://127.0.0.1:8080/openapi.json

Use `--connect`, `--context`, and `--uncloud-config` to select a cluster. Use `--cors-origins` to allow a separately hosted UI.

If `--connect` is omitted, the sidecar reads `~/.config/uncloud/config.yaml`. If that file is missing, it falls back to `/run/uncloud/uncloud.sock`.

## Docker

The image needs the sibling Uncloud checkout at `../../uncloud` (this repo and Uncloud sit next to each other under `coding/`).

```bash
docker compose up -d --build
```

The container mounts `/run/uncloud` and listens on `0.0.0.0:8080`.

## systemd user unit

```bash
go build -o ~/.local/bin/sidecar ./cmd/sidecar
install -Dm644 sidecar.service ~/.config/systemd/user/sidecar.service
systemctl --user daemon-reload
systemctl --user enable --now sidecar.service
```
