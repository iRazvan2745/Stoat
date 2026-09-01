# Contributing to Stoat

## Development setup

Stoat uses Node.js 24, pnpm 11, Vite+, and a PostgreSQL database.

```sh
pnpm install
cp .env.example .env
docker compose -f compose.dev.yaml up -d
pnpm dev
```

The development database is available at `localhost:5434`. Keep secrets in `.env`; do not commit them.

## Before opening a pull request

Run the same checks used by GitHub Actions:

```sh
vp check --no-fmt
vp test
pnpm run build

(cd sidecar && gofmt -w . && go test ./... && go vet ./...)
```

The sidecar image can be built without an Uncloud checkout:

```sh
docker build -f sidecar/Dockerfile -t stoat-sidecar:test sidecar
```

Use Conventional Commits such as `feat: add service health checks` or `fix: handle missing cluster credentials`. Commit messages are checked by Lefthook and Commitlint.

## Production images

Version tags publish these images to GitHub Container Registry:

- `ghcr.io/irazvan2745/stoat`
- `ghcr.io/irazvan2745/sidecar`

The manual Canary Release workflow also publishes the `canary` tags. The production Compose file expects an Uncloud socket at `/run/uncloud/uncloud.sock`; set `UNCLOUD_SOCKET_GID` if its group is not GID `0`.
