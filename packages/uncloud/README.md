# @stoat/uncloud

Typed TypeScript client for the [Uncloud](https://uncloud.run) HTTP API exposed by
the sidecar in [`apps/sidecar`](../../apps/sidecar).

Types are generated from the sidecar's OpenAPI spec; the client itself is a thin
layer over `fetch`, plus hand-written helpers for the endpoints that stream
Server-Sent Events.

## Usage

```ts
import { ucClient, unwrap } from "@stoat/uncloud";

const uc = ucClient("http://sidecar.internal", { token: env.SIDECAR_TOKEN });
```

Every endpoint except `/healthz` requires the bearer token; see
[Security](#security). The sidecar URL is a **parameter, not ambient config**, so
one process can talk to many clusters:

```ts
const prod = ucClient(cluster.sidecarUrl, { token: cluster.token });
const staging = ucClient("https://staging.internal:8443", { token: stagingToken });
```

Construction is cheap — a closure and no I/O — so building one per request is fine
and avoids stale URLs. Invalid URLs throw `TypeError` immediately rather than
failing later inside `fetch`.

### Requests

Paths, path params, query params and bodies are all typed from the spec. Every
call returns `{ data, error, response }`:

```ts
const { data, error } = await uc.GET("/api/v1/machines", {
    params: { query: { available: true } },
});
if (error) {
    // error is ErrorResponse -> { error: string }
}
```

Use `unwrap()` when you would rather let failures propagate — for example inside
an oRPC handler, where a thrown error is the natural control flow:

```ts
const service = await unwrap(
    uc.GET("/api/v1/services/{id}", { params: { path: { id: "caddy" } } }),
);
```

`unwrap()` throws `UcApiError` on any non-2xx, carrying `.status`, `.statusText`,
`.url` and the sidecar's own message:

```ts
try {
    await unwrap(uc.POST("/api/v1/volumes", { body: { machine: "hazel", name: "data" } }));
} catch (e) {
    if (e instanceof UcApiError && e.status === 409) {
        // already exists
    }
}
```

### Streaming

Four endpoints respond with `text/event-stream` rather than JSON. They live under
`uc.stream` and yield typed events:

| Method                                              | Yields               | Endpoint                                 |
| --------------------------------------------------- | -------------------- | ---------------------------------------- |
| `stream.serviceLogs(id, opts?)`                     | `LogEvent`           | `GET /api/v1/services/{id}/logs`         |
| `stream.machineLogs(id, opts)`                      | `LogEvent`           | `GET /api/v1/machines/{id}/logs`         |
| `stream.machineExec(id, body, opts?)`               | `MachineExecEvent`   | `POST /api/v1/machines/{id}/exec/stream` |
| `stream.deployCompose(compose, deployOpts?, opts?)` | `DeployComposeEvent` | `POST /api/v1/services/deploy/compose`   |

```ts
for await (const event of uc.stream.serviceLogs("caddy", { follow: true, tail: 100 })) {
    console.log(event.stream, event.message);
}
```

**Always pass an `AbortSignal` when `follow: true`.** Without one the request stays
open indefinitely and the loop never ends:

```ts
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 30_000);

for await (const event of uc.stream.serviceLogs("caddy", {
    follow: true,
    signal: ctl.signal,
})) {
    // ...
}
```

Compose content must be base64-encoded. Use `encodeComposeFile()` rather than
encoding by hand, so non-ASCII content survives:

```ts
import { encodeComposeFile } from "@stoat/uncloud";

for await (const event of uc.stream.deployCompose(
    encodeComposeFile(await readFile("compose.yaml", "utf8")),
    { recreate: true },
)) {
    if (event.type === "progress") console.log(event.percent, event.statusText);
}
```

A failing stream request throws `UcApiError` before yielding anything, so wrap the
loop rather than each iteration.

### Types

Named aliases are re-exported for every schema, so nothing needs to import from
`src/generated/`:

```ts
import type { Machine, Service, LogEvent, ServiceSpec } from "@stoat/uncloud";
```

## Security

Every endpoint except `/healthz` requires a bearer token, which the sidecar reads
from its own `SIDECAR_TOKEN` environment variable. Pass it when constructing the
client:

```ts
const uc = ucClient(sidecarUrl, { token: env.SIDECAR_TOKEN });
```

The token is merged into the client's default headers, so no call site can forget
it. An explicit `Authorization` header in `headers` takes precedence.

Treat the token as a **root credential**. The sidecar has no users, roles, or
scopes, and the API includes `execMachine` and `execContainer`, which run commands
with host-root-equivalent privileges on cluster machines. Anyone holding the token
can do everything.

- Server-side only. Never import this into browser code, and never ship the token
  to a client.
- Never expose it through an unauthenticated route — put it behind
  `protectedProcedure` in `packages/api`.
- Never build exec commands or service specs from unvalidated user input.

## Regenerating from the spec

The spec is **vendored** at `openapi.json` and committed. Codegen must never
depend on the cluster being reachable, or Docker builds and CI break whenever it
is down.

It is generated from the sidecar's own Go source (`apps/sidecar/cmd/openapi`)
rather than fetched from a deployed instance, so the vendored spec cannot lag
behind the server — and refreshing it needs neither a running cluster nor the
bearer token.

When the sidecar API changes:

```bash
pnpm uc:refresh   # from the repo root: regenerate the spec, then the types
```

Or individually, from this directory (requires a Go toolchain):

```bash
pnpm generate-spec
pnpm generate
```

Commit both `openapi.json` and `src/generated/schema.ts`.

### Two things worth knowing

**Spec bugs belong upstream now.** The OpenAPI document lives in this repo at
`apps/sidecar/internal/httpapi/openapi.go`, and a Go test compares it against the
routes the server actually registers in both directions, so a drifting path fails
the build. `scripts/generate-spec.mjs` still supports post-generation patches, but
the list is empty and should stay that way — fix the Go document instead.

**`--empty-objects-unknown` is required.** Seventeen schemas are bare
`{"type": "object"}` with no properties. Without the flag they generate as
`Record<string, never>` — meaning you could not pass `ContainerSpec.env` or read
anything off `Volume.volume`. The flag renders them as `Record<string, unknown>`.

## Layout

| Path                      | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `openapi.json`            | Vendored spec, generated from the Go source.        |
| `src/generated/schema.ts` | Generated types. Never edit by hand.                |
| `src/index.ts`            | `ucClient()`, stream helpers, `encodeComposeFile()` |
| `src/sse.ts`              | SSE reader — the part codegen cannot produce        |
| `src/errors.ts`           | `UcApiError`, `unwrap()`                            |
| `src/types.ts`            | Named aliases over the generated schemas            |

## Tests

The suites live in the repository's `tests/uncloud/` directory. From this package:

```bash
pnpm test
```

`sse.test.ts` covers the hand-written parser: chunk boundaries splitting a line or
a multi-byte character, CRLF, multi-line `data:` payloads, and keep-alive comments.
`client.test.ts` runs the client against a real local HTTP server, so URL building,
query serialisation, error mapping and streaming are all exercised end to end.
