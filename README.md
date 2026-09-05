# Stoat

Stoat is a SvelteKit control plane for managing Uncloud data sources, workspaces, services, deployments, and cluster resources.

## Development

Requirements: Node.js 24, pnpm 11, Go 1.26 for the sidecar, and Docker for PostgreSQL.

```sh
pnpm install
cp .env.example .env
docker compose -f compose.dev.yaml up -d
pnpm run db:push
pnpm dev
```

The development database is published at `localhost:5434`. The default local app URL is `http://localhost:5173`.

For the sidecar, run it from `sidecar/`:

```sh
go run ./cmd/sidecar
```

It serves the Uncloud API on `127.0.0.1:80`. Use `--connect` to select the Uncloud socket or endpoint used by the local data source.

## Checks

Run the same checks used by GitHub Actions before opening a pull request:

```sh
vp check --no-fmt
vp test
pnpm run build

(cd sidecar && gofmt -w . && go test ./... && go vet ./...)
docker build -f Dockerfile -t stoat:test .
docker build -f sidecar/Dockerfile -t stoat-sidecar:test sidecar
```

## Git synchronization

Git Sources support two-way synchronization, formatted Compose history, and automatic deployment of every new commit. See [Git synchronization](docs/git-sync.md) for setup, repository layout, and conflict handling.

## Images and releases

GitHub Actions publishes these images to GHCR:

- `ghcr.io/irazvan2745/stoat`
- `ghcr.io/irazvan2745/sidecar`

Pushing a stable `v*` tag creates a GitHub release and publishes semver tags plus `latest`. The **Canary Release** workflow is started manually from the Actions tab, creates an incrementing `vX.Y.Z-canary.N` tag, and publishes `canary` plus versioned image tags.

Both workflows build directly from this repository. The sidecar does not need Docker `additional_contexts` or an Uncloud checkout because it uses Uncloud's published Go module.

## Production Compose

Copy the example environment and set a strong `APP_SECRET` and the public `APP_URL`, then start the stack:

```sh
cp .env.example .env
docker compose up -d
```

The production stack runs Stoat, PostgreSQL, and the sidecar. It expects the host Uncloud socket directory at `/run/uncloud`. The sidecar runs as a privileged global service with the host PID namespace so it can execute commands on selected machines; keep its API on a trusted network. The app and sidecar expose `/healthz` and `/readyz` health checks respectively.
