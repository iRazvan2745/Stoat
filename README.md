# Stoat

Stoat is a SvelteKit control plane for managing Uncloud data sources, workspaces, resources, deployments, and cluster resources.

## Development

Requirements: Vite+ (`vp`), Node.js 24 (minimum 22.22), Go 1.26 for the sidecar, and Docker for PostgreSQL. Vite+ manages the pinned pnpm version.

```sh
vp install
cp .env.example .env
# In .env, set DATABASE_URL=postgres://stoat:stoat@localhost:5434/stoat
# and APP_URL=http://localhost:5173; replace APP_SECRET with a random secret.
# Set ALLOW_SIGNUP=true to create your initial local account.
docker compose -f compose.dev.yaml up -d
vp run db:push
vp dev
```

The development database is published at `localhost:5434`. The default local app URL is `http://localhost:5173`. `vp run dev` uses the optional global `portless` CLI; set `APP_URL` to its origin when using that script. Disable signup again after creating your account if registration should remain closed.

For the sidecar, run it from `sidecar/`:

```sh
go run ./cmd/sidecar
```

It serves the Uncloud API on `127.0.0.1:80`. Use `--connect` to select the Uncloud socket or endpoint used by the local data source.

## Checks

Run the same checks used by GitHub Actions before opening a pull request:

```sh
vp check
vp run check-types
vp test
vp run build

(cd sidecar && go test ./... && go vet ./...)
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
