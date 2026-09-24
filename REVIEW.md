# Stoat application review

Review date: 2026-09-20

This review covers the current working tree, including untracked files. The tree was already extensively modified before the review, so all file and line references describe this snapshot rather than a clean Git revision.

## Scope and method

Five parallel review tracks covered:

- Authentication, authorization, tenancy, database integrity, and workflow lifecycle.
- SvelteKit routes, app-specific components, state, forms, navigation, and accessibility.
- Go sidecar, command/Compose execution, SSE behavior, and the TypeScript Uncloud client.
- Build, Docker, migrations, generated artifacts, tests, logging, and deployment configuration.
- Source-level comparison with `~/coding/uptimekit/apps/dash`, using `DESIGN.MD` as the adaptation contract.

Findings below were rechecked against the current source. Subagent suggestions that no longer matched the current tree were discarded. `Confirmed` means the behavior follows directly from source or was reproduced by a command. `Risk` means the source establishes a plausible failure mode but a live concurrency, browser, or multi-machine reproduction is still needed.

## Executive summary

The application compiles and the main architecture is coherent, but it is not production-ready yet. The highest-priority issues are:

1. The production bundle cannot find the monitoring Compose template, so cluster initialization will fail after deployment.
2. Open signup plus unrestricted sidecar URLs creates an authenticated SSRF path from any newly registered account.
3. Ordinary organization members can create and permanently delete clusters.
4. Workflow cancellation and completion race each other, and core state-write failures are swallowed.
5. Fresh Docker deployments do not apply database migrations.
6. The root test command fails before its opt-in PostgreSQL suites can skip.
7. The committed Uncloud OpenAPI document and generated SDK are stale relative to the Go server.
8. Several primary navigation/actions are dead or inert, and the dashboard root is still placeholder content.

## P0 release blocker

### R-01: The production worker cannot load the monitoring template

Status: Confirmed.

Evidence: `packages/workflows/src/initialize-cluster.ts:234-236` reads `../../../internal/monitoring/compose.yaml` relative to `import.meta.url`. The adapter-node bundle preserves that lookup in `apps/web/build/server/chunks/chunks/context.js-Y4hJmIJj.js:9605`, but no `compose.yaml` is included under `apps/web/build`. `apps/web/Dockerfile:15-16` runs that bundle from `/app/apps/web`.

Impact: Every production cluster initialization reaches `readFile` and fails with `ENOENT` before monitoring is deployed.

Potential fix: Import the template as a bundled raw asset, copy it into a documented runtime asset directory during the web build, or inject an explicit absolute template path. Do not resolve a repository-relative path from a bundled chunk.

Regression test: Build the adapter-node artifact in a clean directory without repository source files, invoke the initialization handler with mocked database/sidecar dependencies, and assert that template loading and rendering succeeds.

## P1 security, authorization, and data integrity

### R-02: Any signed-up user can drive server-side requests to an arbitrary host

Status: Confirmed.

Evidence: Email/password signup is open in `packages/auth/src/index.ts:35-39`. The trigger in `packages/db/src/migrations/0007_default_organizations.sql:3-18` makes every new user an organization owner. `packages/api/src/routers/cluster/index.ts:145-166` accepts and persists any non-empty sidecar URL. `packages/uncloud/src/index.ts:218-238` only checks for an absolute HTTP(S) URL. Cluster list/detail and health then issue server-side requests at `packages/api/src/routers/cluster/index.ts:15-22,86-93,137-138,214-217`.

Impact: An attacker can register, point a cluster at loopback, link-local metadata, private services, DNS-rebinding targets, or a hanging endpoint, and make Stoat request the fixed sidecar paths from its server network. Some response data is returned to the caller. A hanging host can also hold list/detail requests open.

Potential fix: Prefer a sidecar enrollment/claim flow instead of trusting a URL. Otherwise canonicalize the URL, reject credentials/fragments/unexpected paths and ports, resolve and reject denied address ranges, disable or revalidate redirects, apply an allowlist or egress policy, add response-size and concurrency limits, add short timeouts, and cap clusters per organization. Restricting creation to admins is necessary but does not remove the self-created-owner attack path.

Regression test: Attempt loopback, IPv6 loopback, link-local, private, encoded-address, DNS-rebinding, and public-to-private redirect targets. Add a server that never returns headers and assert a bounded failure.

### R-03: Organization members can create and permanently delete clusters

Status: Confirmed.

Evidence: `createCluster` and `deleteCluster` use `organizationProcedure` at `packages/api/src/routers/cluster/index.ts:145` and `:179`, which checks membership only (`packages/api/src/index.ts:27-35`). Initialization and cancellation already use `organizationAdminProcedure`, proving an owner/admin boundary exists. Cluster deletion cascades into projects, resources, monitoring state, and deployments through `packages/db/src/schema/index.ts:18-21,44-47,68-71,117-130,143-147`.

Impact: A low-privilege member can register a root-equivalent sidecar connection and irreversibly remove shared organization data.

Potential fix: Use a generic owner/admin procedure for create and delete. Decide whether deletion should be owner-only. Return a `canManageClusters` capability and hide denied controls, but keep the server check authoritative.

Regression test: Exercise create/delete as owner, admin, and member and assert that denied deletion leaves every dependent row intact.

### R-04: Cancellation is not terminal and can be overwritten by the worker

Status: Confirmed race in source; live queue interleaving still needs a deterministic test.

Evidence: The API performs best-effort queue cancellation and then marks local rows cancelled/failed at `packages/api/src/routers/cluster/deployments.ts:50-76`. The worker writes cluster `running` before checking deployment cancellation and later writes deployment/cluster `ready` unconditionally at `packages/workflows/src/runtime.ts:34-43,66-69`. `setDeploymentStatus` and `setInitializationStatus` update by ID without an expected prior state or request ID at `packages/db/src/deployments.ts:44-60` and `packages/db/src/initialization.ts:77-96`.

Impact: An acknowledged cancellation can continue deploying the privileged monitoring stack, become `ready`, or leave the cluster stuck at `running`. Deleting the local cluster while an old worker still has credentials can orphan remote infrastructure.

Potential fix: Persist `cancelling`/`cancelled` first, tie every cluster transition to the current deployment/request ID, use compare-and-set predicates with affected-row checks, and recheck currentness before every irreversible remote step and finalization. Do not allow deletion until active cancellation is acknowledged.

Regression test: Barrier the worker immediately before its `running`, remote deploy, and `ready` phases; cancel at each barrier and assert that cancellation remains terminal and no later remote phase runs.

### R-05: Initialization state and deployment history are committed separately

Status: Confirmed.

Evidence: `initializeCluster` first commits the cluster as queued and then inserts the deployment at `packages/api/src/routers/cluster/initialization.ts:93-129`; retry repeats the split at `:131-169`. The outbox scans queued clusters independently at `packages/workflows/src/runtime.ts:156-203`.

Impact: The poller can enqueue work before a deployment row exists, or deployment insertion can fail after the cluster was durably queued. The request may report failure while work runs without logs/history, or a cluster can remain queued and reject safe retry.

Potential fix: Commit the request and deployment row in one database transaction. Prefer using the deployment row itself as the durable outbox record so lifecycle state is not duplicated.

Regression test: Run the outbox behind a barrier between the two writes and inject deployment insertion failure. No job should be visible before both records commit.

### R-06: Core workflow state-write failures are intentionally swallowed

Status: Confirmed.

Evidence: `packages/workflows/src/runtime.ts:38-43,60-69,94-107,190-203` converts lifecycle write and enqueue failures into success/void. Database helpers do not return affected-row checks.

Impact: Remote deployment can succeed while local state remains queued/running, terminal failure can remain unrecorded, and effect-mq can acknowledge work that Stoat cannot reconcile. The outbox only repairs exactly queued rows, not divergent running rows.

Potential fix: Keep narrative log writes best-effort, but propagate lifecycle transition failures so the queue retries. Make transitions compare-and-set and fail on zero affected rows. Finalize cluster and deployment together where possible.

Regression test: Fail each state write independently after a successful mocked deploy and verify that the job is retried and converges both records.

### R-07: Better Auth organization deletion bypasses cluster/job lifecycle guards

Status: Confirmed.

Evidence: `packages/auth/src/index.ts:39` enables `organization()` with default deletion behavior. Better Auth 1.7.3 exposes deletion unless `disableOrganizationDeletion` is set (`packages/auth/node_modules/better-auth/dist/plugins/organization/routes/crud-org.mjs:237-290`). Organization deletion cascades clusters, while effect-mq jobs have no organization/cluster foreign key.

Impact: An owner can delete an organization while initialization is active. The worker can continue with already loaded credentials, mutate remote services, then silently update zero deleted rows, leaving orphan infrastructure.

Potential fix: Set `disableOrganizationDeletion: true` until coordinated deletion exists, or add a `beforeDeleteOrganization` flow that moves clusters to deleting, cancels and awaits all jobs, cleans remote resources, and only then deletes the organization.

Regression test: Block initialization before a remote call and attempt organization deletion; it must be rejected or cancellation must be acknowledged before cascade deletion.

### R-08: Fresh Docker deployments never run database migrations

Status: Confirmed.

Evidence: Migration scripts exist in `packages/db/package.json:17-21`, but `package.json:28`, `docker-compose.yml:20-35`, and `apps/web/Dockerfile:16` only build/start PostgreSQL and Node. PostgreSQL health does not mean the schema exists.

Impact: A fresh volume starts a healthy database and web process with no auth, application, deployment, or queue tables.

Potential fix: Add a one-shot migration service/deployment job, guard concurrent migrators with an advisory lock, and make web readiness depend on successful migration.

Regression test: Start from an empty database using only the documented deployment command and assert all migrations and required tables exist before the web process becomes ready.

### R-09: Fatal worker failure leaves HTTP healthy and jobs permanently unprocessed

Status: Confirmed.

Evidence: `apps/web/src/lib/worker.server.ts:30-35` sets the process-global started flag before launch. `:57-59` only logs a rejected worker layer and never resets/restarts/exits. Docker health checks only `/` at `docker-compose.yml:23-34`.

Impact: A queue schema or connection failure can kill the worker while the web process remains healthy and the outbox keeps accumulating work.

Potential fix: Supervise with bounded retry or terminate the process so the orchestrator restarts it. Expose worker/database readiness and probe that instead of a public page.

Regression test: Force `Layer.launch` to fail after startup and assert process failure/restart or a readiness failure followed by a successful supervised restart.

### R-10: Sidecar `.env` is sent into its Docker build context

Status: Confirmed.

Evidence: `apps/sidecar/.env` exists and is Git-ignored, but `apps/sidecar/.dockerignore:1-4` does not exclude env files. `apps/sidecar/Dockerfile:8` copies the entire context into the build stage. The sidecar Compose file consumes this file as the root-equivalent bearer credential at `apps/sidecar/docker-compose.yml:9-15`.

Impact: Local or remote BuildKit receives the credential-bearing file and can retain it in intermediate cache/layers, even though it is absent from the final image.

Potential fix: Add `.env` and `.env.*` to the sidecar-specific ignore file, use runtime secrets, restrict local file permissions, and rotate any credential that has already been sent to an untrusted builder/cache.

Regression test: Inspect the build context and exported intermediate stages and assert that no env/credential file is present.

### R-11: The default Docker database is publicly bound with a predictable password

Status: Confirmed configuration risk.

Evidence: `docker-compose.yml:19,40-45` defaults the PostgreSQL password to `password` and maps `5435:5432` on all host interfaces.

Impact: On a network-reachable host, the database is exposed with known credentials.

Potential fix: Require `${POSTGRES_PASSWORD:?required}` and remove the host port in production, or bind it to `127.0.0.1` in a development-only override.

Regression test: `docker compose config` should fail without a password, and the production config should contain no public database binding.

## P2 backend, SDK, and operations

### R-12: One hanging sidecar stalls the entire cluster list

Status: Confirmed.

Evidence: Diagnostics have no signal/deadline at `packages/api/src/routers/cluster/index.ts:15-22`; list waits on all requests through `Promise.all` at `:86-91`. Initialization calls already show the intended `AbortSignal.timeout` pattern at `packages/api/src/routers/cluster/initialization.ts:55-63`.

Potential fix: Apply a short timeout to each diagnostic and retain per-item `null` fallback. Add bounded concurrency for the 100-item page.

Regression test: Mix a responsive and never-responding fake sidecar and assert the list completes within the timeout.

### R-13: Bind-path safeguards compare non-canonical strings

Status: Confirmed.

Evidence: `packages/api/src/routers/cluster/initialization.ts:12-38` compares raw strings. `/var/lib//docker` bypasses the exact reserved-path regex, and differently written paths can pass the separate-storage check before being mounted by `packages/workflows/src/monitoring-compose.ts`.

Potential fix: Normalize with POSIX path semantics before validation, comparison, storage, and use. Prefer a single dedicated allowed root. If symlink resistance is required, resolve on the target host immediately before mounting.

Regression test: Cover duplicate slashes, normalized-equivalent storage paths, reserved descendants, and symlinks escaping the allowed root.

### R-14: Failed initialization cannot be reconfigured

Status: Confirmed.

Evidence: Initial configuration is accepted only from `uninitialized` at `packages/api/src/routers/cluster/initialization.ts:73-116`; retry accepts only a cluster ID and reuses stored configuration at `:131-169`.

Impact: A changed machine or bad storage path forces cluster deletion/recreation, cascading user projects/resources.

Potential fix: Let retry accept and revalidate a replacement configuration, or add an admin reset/reconfigure operation while retaining deployment history.

Regression test: Fail with an unavailable machine, retry with a valid machine/storage pair, and verify the new attempt uses the corrected configuration.

### R-15: Auth-secret rotation makes ready-cluster monitoring credentials unrecoverable

Status: Confirmed.

Evidence: Monitoring encryption derives directly from `BETTER_AUTH_SECRET` in `packages/workflows/src/secrets.ts:3-36`. Connection retrieval returns a null password after decryption failure at `packages/api/src/routers/cluster/initialization.ts:210-229`, but retry is limited to failed clusters and the worker exits early for already initialized clusters at `packages/workflows/src/initialize-cluster.ts:212-216`.

Potential fix: Use a dedicated versioned encryption keyring, and add an admin-only credential rotation workflow that updates the remote credential before atomically replacing the envelope.

Regression test: Initialize with key A, switch to key B, rotate credentials, and verify both the remote service and stored envelope use the new value.

### R-16: Guarded cluster deletion reports success after deleting zero rows

Status: Confirmed race.

Evidence: `packages/api/src/routers/cluster/index.ts:182-212` reads status, deletes with that old status as a predicate, ignores the result, and always returns the ID.

Potential fix: Use `.returning()` and return `CONFLICT` when no row was deleted; ideally collapse the check/delete into one statement or transaction.

Regression test: Change initialization status between select and delete and assert the endpoint does not report success.

### R-17: Resource-to-cluster binding is not enforced for container lookup

Status: Confirmed.

Evidence: `packages/api/src/routers/resources/index.ts:276-313` authorizes `clusterId` and `projectId/resourceId` separately. `resourceMiddleware` proves only organization ownership (`packages/api/src/index.ts:76-112`), not that the project belongs to the supplied cluster.

Impact: A caller can direct resource-derived service lookups to a different cluster in the same organization. Prefix collisions are unlikely but the context is still a confused-deputy boundary.

Potential fix: Load resource, project, and cluster in one tenant-scoped join and require `projects.clusterId === input.clusterId`; better, derive cluster ID server-side from the resource.

Regression test: Combine a resource from cluster A with cluster B and require a rejection before any sidecar call.

### R-18: Deployment logs stop advancing after 2,000 rows

Status: Confirmed.

Evidence: `packages/db/src/deployments.ts:91-100` fetches the oldest rows ascending with `limit(2000)`. `apps/web/src/lib/components/clusters/deployment-dialog.svelte:31-43,199-220` repeatedly polls and renders that same prefix.

Potential fix: Poll incrementally by log ID and append/deduplicate. A less complete alternative is fetch newest-first and reverse for display.

Regression test: Insert 2,001 rows and verify row 2,001 appears on the next poll in correct order.

### R-19: Membership uniqueness is not enforced by the database

Status: Confirmed invariant gap.

Evidence: `packages/db/src/schema/auth.ts:119-135` has individual indexes but no unique `(organization_id,user_id)` constraint. `packages/db/src/organizations.ts:19-29` selects an unordered first duplicate for authorization.

Potential fix: Deduplicate existing rows, add the composite unique constraint, and treat conflicts as an idempotent already-member outcome.

Regression test: Run concurrent membership/invitation acceptance for the same user/org and assert one row and deterministic role changes.

### R-20: Root-equivalent sidecar tokens are stored plaintext

Status: Confirmed hardening gap.

Evidence: `packages/db/src/schema/index.ts:12-17` stores the token as text, while monitoring passwords receive envelope encryption.

Potential fix: Encrypt with a dedicated versioned KMS/keyring and decrypt only immediately before a sidecar call. Add a rotation path.

Regression test: Assert the submitted token is never present in the database and old key versions remain readable during rotation.

### R-21: Lifecycle and ownership invariants are mostly TypeScript-only

Status: Confirmed schema hardening gap.

Evidence: `packages/db/src/schema/index.ts:12-28,60-80,115-166` uses unrestricted text for statuses/types and allows `cluster_monitoring` to reference any cluster, project, and resource independently. Core tenant query columns lack current schema indexes.

Potential fix: Add status/type checks or enums, restore indexes on `clusters.organization_id`, `projects.cluster_id`, and `resources.project_id`, and enforce cross-table ownership with composite keys or a constraint trigger.

Regression test: Attempt invalid statuses and mismatched cluster/project/resource triples and inspect representative query plans.

### R-22: The committed OpenAPI/SDK artifacts are stale

Status: Confirmed by `diff -q packages/uncloud/openapi.json <(go run ./cmd/openapi)`.

Evidence: Generation is manual (`package.json:36`, `packages/uncloud/package.json:18-20`) and root build/tests do not check freshness. Current Go source and committed JSON differ, including public docs/health responses.

Potential fix: Regenerate both files now and add a CI check that runs the Go generator and TypeScript generator, then fails on any diff.

Regression test: Change one Go operation/schema and assert `check-generated` fails until both artifacts are refreshed.

### R-23: The hand-written `ServiceSpec` schema does not match the decoded Go type

Status: Confirmed contract mismatch.

Evidence: `apps/sidecar/internal/httpapi/server.go:596-606,977-994` strictly decodes directly into upstream `api.ServiceSpec`. `apps/sidecar/internal/httpapi/openapi.go:475-505` advertises `tty` and `openStdin`, which are not fields on the pinned Uncloud v0.20.0 container type, and omits accepted fields such as capabilities, healthcheck, init, log driver, resources, sysctls, and user. Map fields are emitted as unconstrained objects.

Potential fix: Either model the full upstream type accurately or define a local safe HTTP DTO and explicitly map only supported fields. Extend the local OpenAPI model to represent `additionalProperties: { type: string }`.

Regression test: Send every documented property through the real decoder and compile fixtures for every intentionally supported field.

### R-24: Namespaced image references do not cross the route boundary reliably

Status: Confirmed source mismatch.

Evidence: Image routes use one Fiber segment at `apps/sidecar/internal/httpapi/server.go:352-355,837-862`. The SDK percent-encodes slash-containing IDs at `packages/uncloud/src/index.ts:158-169`, while Fiber is not configured with `UnescapePath` at `apps/sidecar/internal/httpapi/server.go:226-234`.

Potential fix: Explicitly path-unescape and validate after matching, or move image references to query/body values.

Regression test: Exercise inspect, remote inspect, and update checks with `ghcr.io/org/app:tag` and digest references through the generated client.

### R-25: Compose preflight is detached before streaming and has no overall deadline

Status: Confirmed cancellation gap.

Evidence: `apps/sidecar/internal/httpapi/server.go:637-651,877-889` detaches request cancellation before `DeployCompose`. Preflight parsing, secret resolution, and cluster inspection happen before the event channel is returned at `apps/sidecar/internal/httpapi/client_backend.go:510-547`.

Potential fix: Perform preparation under a bounded request/preflight context, then start execution under a separately cancellable stream context with a hard maximum lifetime.

Regression test: Block during preflight, disconnect before headers, and assert cancellation within the configured deadline.

### R-26: Log stream disconnect can leak upstream Uncloud goroutines

Status: Risk verified in pinned upstream channel code, not reproduced end-to-end.

Evidence: Stoat cancels when the SSE writer exits at `apps/sidecar/internal/httpapi/server.go:930-958`, but Uncloud v0.20.0 log merger paths use blocking channel sends that do not select on context cancellation.

Potential fix: Upgrade/fix upstream so all sends select on `ctx.Done()`. As containment, cancel and bounded-drain after the HTTP writer exits.

Regression test: Close a real TCP log stream under continuous multi-source output and assert all producer/merger goroutines terminate.

### R-27: The SSE parser is unbounded and silently drops malformed terminal events

Status: Confirmed.

Evidence: `packages/uncloud/src/sse.ts:94-126` grows line/event buffers without a limit. `:150-161` skips malformed JSON for every stream type, including deployment/exec terminal events.

Potential fix: Add configurable line/event limits. Use strict validated event parsing for deploy/exec and tolerant parsing only for log tails.

Regression test: Cover oversized frames, malformed deployment completion/error events, wrong JSON shapes, and cancellation during an oversized frame.

### R-28: Sidecar error/status contracts are inconsistent

Status: Confirmed.

Evidence: Invalid service/Compose semantics become generic 500s through `apps/sidecar/internal/httpapi/server.go:596-606,1104-1117`. `/readyz` returns a 503 `ReadinessResponse` at `:364-370`, but the source OpenAPI does not declare that response and `packages/uncloud/src/errors.ts:18-27,51-60` expects `{error}`.

Potential fix: Introduce typed client-input errors mapped to 400, reserve 500 for unexpected faults, and describe per-operation error unions accurately. Normalize unexpected bodies before exposing SDK results.

Regression test: Assert invalid service/Compose input returns 400 and readiness 503 preserves its message through direct and `unwrap` client paths.

### R-29: Docker overrides the externally configured auth URL with localhost

Status: Confirmed.

Evidence: `docker-compose.yml:13-19` loads `apps/web/.env` and then overrides `BETTER_AUTH_URL` with `http://localhost:3001`; Better Auth uses it as base URL and trusted origin at `packages/auth/src/index.ts:35-38`. `CORS_ORIGIN` is not consumed by source.

Potential fix: Parameterize the real external URL and keep localhost in a development override. Remove the unused setting.

Regression test: Render Compose with an external HTTPS URL and assert that exact value reaches the container and auth callbacks.

### R-30: Docker uses a different package-manager major and a non-frozen install

Status: Confirmed.

Evidence: `package.json:53` pins pnpm 12.4.2, while `apps/web/Dockerfile:2,6` installs pnpm 11 and runs a mutable install.

Potential fix: Activate pnpm 12.4.2 through Corepack and use `pnpm install --frozen-lockfile`.

Regression test: Assert the image build uses 12.4.2 and fails when a manifest and lockfile disagree.

### R-31: The advertised workflow migration command has no migration directory

Status: Confirmed.

Evidence: `package.json:24` calls `packages/workflows/package.json:19`, whose config points to `./drizzle` at `packages/workflows/drizzle.config.ts:4-8`; that directory does not exist. The actual queue migration lives in `packages/db/src/migrations/0014_effect_mq.sql`.

Potential fix: Make `@stoat/db` the single migration authority and remove the stale workflow command/config, or commit a real separate migration set.

Regression test: Apply only the documented migration flow to an empty database and assert all `effect_mq_*` tables/indexes exist.

### R-32: Privileged sidecar actions have no durable access/audit record

Status: Confirmed observability gap.

Evidence: The sidecar is explicitly root-equivalent (`apps/sidecar/README.md:5-16`), but middleware setup at `apps/sidecar/internal/httpapi/server.go:226-244` has recovery, CORS, auth, and deadlines only.

Potential fix: Emit one structured audit event per privileged request with request ID, normalized route, target, result, status, and duration. Never log authorization headers, stdin, env values, or Compose bodies.

Regression test: Capture handler logs and verify both presence of safe audit fields and absence of bearer/body secrets.

### R-33: Email accounts have no verification or password recovery flow

Status: Confirmed product/security gap.

Evidence: `packages/auth/src/index.ts:36` only enables email/password. There is no verification sender, `requireEmailVerification`, reset handler, or corresponding web route.

Impact: Anyone can claim an unverified address and immediately gain the SSRF-capable owner account described above; legitimate users cannot recover lost passwords.

Potential fix: Configure verification email and require it before sign-in, add reset email/session revocation, and add login/signup UI links. If this is intentionally local-only, disable public signup and document bootstrap behavior instead.

Regression test: Verify unverified accounts cannot access the app and password reset tokens are single-use, expiring, and revoke sessions as intended.

### R-34: Server-side QueryClient state is process-global

Status: Risk; current cross-request caching behavior needs an SSR concurrency test.

Evidence: `apps/web/src/lib/orpc.ts:7-26` exports one module-global `QueryClient`, and `apps/web/src/routes/+layout.svelte:1-12` provides it during SSR. Tenant query keys do not include user/org identity. SvelteKit explicitly warns against shared server state.

Potential fix: Create one QueryClient per server request/render and one singleton only in the browser, then dehydrate/hydrate deliberately.

Regression test: Render the same query concurrently under two organization sessions and assert no cached data or in-flight deduplication crosses requests.

## P2 frontend behavior and accessibility

### R-35: The authenticated home page is unfinished placeholder UI

Status: Confirmed.

Evidence: `apps/web/src/routes/(app)/+page.svelte:1-14` executes a health query but never renders it, displays `Yo, welcome to stoat`, and contains an empty `main`.

Potential fix: Render a real heading and explicit health/loading/error state, or make the first page an actual organization overview. Remove the unused query and empty landmark if no dashboard data is ready.

Regression test: Cover healthy, failed, and loading states and assert one meaningful page heading/landmark.

### R-36: Primary navigation includes a guaranteed 404

Status: Confirmed.

Evidence: `apps/web/src/lib/components/sidebar/sidebar.svelte:73-78` links to `/monitoring`, but no matching route exists.

Potential fix: Remove the link, point it to an existing monitoring/deployment view, or implement the route.

Regression test: Crawl every sidebar link and assert a non-404 application page.

### R-37: Several prominent controls do nothing

Status: Confirmed.

Evidence: Project-card Add resource and Project settings buttons have no handler/link at `apps/web/src/lib/components/projects/project-card.svelte:62-80`. Cluster Initialize has no handler/link at `apps/web/src/routes/(app)/clusters/+page.svelte:231-236`.

Potential fix: Wire the existing resource dialog and cluster detail initialization route, and remove project settings until a route exists.

Regression test: Activate every visible menu/button with pointer and keyboard and assert navigation/dialog behavior.

### R-38: Header titles and breadcrumbs are incomplete

Status: Confirmed.

Evidence: `apps/web/src/lib/components/sidebar/app-shell.svelte:23` recognizes settings/projects/clusters only, so `/deployments` says Home. Resource breadcrumbs at `:87-105` omit Variables and Settings leaf pages.

Potential fix: Resolve breadcrumbs from route segments or page metadata and include every current leaf.

Regression test: Assert the header for every route entry in `apps/web/src/routes`.

### R-39: Prefix-names UI shows the opposite default from backend behavior

Status: Confirmed.

Evidence: `apps/web/src/routes/(app)/projects/(resource)/[projectId]/[resourceId]/settings/+page.svelte:42-47` treats only explicit `true` as enabled. `packages/api/src/compose.ts:22-35` prefixes unless the setting is explicitly `false`.

Potential fix: Make both layers use the same default and migrate/store it explicitly for new resources.

Regression test: Compare UI state and formatted Compose for null, empty, true, and false settings.

### R-40: Compose and `.env` edits are lost without warning

Status: Confirmed.

Evidence: Dirty state exists in the Compose and variables pages (`.../[resourceId]/+page.svelte:49-53`, `.../[resourceId]/variables/+page.svelte:40-43`), but there is no `beforeNavigate` or `beforeunload` guard anywhere in app source.

Potential fix: Install SvelteKit navigation guards while dirty and a document-exit guard; also block route changes during pending save.

Regression test: Attempt sidebar navigation, browser Back, reload, and tab close before/after save.

### R-41: Closing/reopening create dialogs can permit duplicate requests

Status: Confirmed state flaw; requires a delayed request to reproduce.

Evidence: Create dialogs call mutation `.reset()` when opened (`create-cluster-dialog.svelte:27-40`, `create-project-dialog.svelte:38-75`, `create-resource-dialog.svelte:27-38`). Reset does not abort the original network request. The shared X/backdrop/Escape remain available through `ui/dialog/dialog-content.svelte:31-57`.

Potential fix: Prevent all dismissal while pending, or actually abort before reset. Add server-side idempotency for create operations.

Regression test: Defer the first request, close/reopen, and verify a second submit is blocked and the first completion cannot close unrelated UI.

### R-42: Cluster status is color-only and inaccessible

Status: Confirmed.

Evidence: `apps/web/src/routes/(app)/clusters/+page.svelte:194-205` renders only an `aria-hidden` green/red heart and maps every non-healthy state to red.

Potential fix: Render a text badge for healthy/degraded/unavailable/unknown, with color as a secondary cue.

Regression test: Assert each row exposes status through accessible text without inspecting classes/icons.

### R-43: Connection fields are unlabelled and copy failure reports success

Status: Confirmed.

Evidence: `apps/web/src/lib/components/clusters/connection-field.svelte:41-44` does not associate Label and Input. `:24-33` swallows clipboard failure and always sets the success state.

Potential fix: Generate/pass an ID, associate `for`/`id`, set success only after `writeText` resolves, and announce a polite success/error status.

Regression test: Assert accessible names and test resolved/rejected clipboard promises.

### R-44: Shared UI components have reactive and ARIA defects

Status: Confirmed by `svelte-check`.

Evidence: The checker reports 28 warnings in 15 files. Examples include invalid slider-value ARIA on `role="application"` in `ui/cropper/cropper.svelte:84-100`, and initial-only prop captures in textarea, calendar/range calendar, combobox, places autocomplete, timeline, tree, and stepper components.

Potential fix: Use `$derived` or closures for props intended to react to changes. Give the cropper a role that supports the value attributes or expose a real slider control. Audit whether vendored but unused components should be kept at all.

Regression test: Make `svelte-check` warnings fatal in CI and add focused interaction/a11y tests for retained complex primitives.

## UptimeKit consistency review

The token foundation is strong: `apps/web/src/app.css` closely matches UptimeKit's light/dark colors, status colors, radii, shadows, spacing, Outfit typography, and code tokens. Stoat's Button, Input, InputGroup, Card, Dialog, Menu, Select, Switch, Breadcrumb, Empty, and DataTable are close adaptations. Auth pages also improve on the reference with programmatic labels, correct autocomplete, inline alerts, pending state, and reduced-motion protection.

The following source-level inconsistencies remain.

### D-01: The application shell geometry has drifted globally

Stoat uses a 16px inset and places the border directly on the inset at `apps/web/src/lib/components/ui/sidebar/sidebar-inset.svelte:13-18` and `apps/web/src/lib/components/sidebar/app-shell.svelte:68-125`. UptimeKit uses an 8px inset at `uptimekit/apps/dash/src/components/ui/sidebar.tsx:337-350` and a bordered inner main with a 64px-to-48px collapsing header at `uptimekit/apps/dash/src/app/(dash)/(dashboard)/layout.tsx:16-36`.

Potential fix: Port the UptimeKit `m-2` inset and inner-main/header structure, including the collapsed-height transition and `z-50` header.

### D-02: The written design and live UptimeKit disagree on page typography/density

`DESIGN.MD:60-68,75-89,147` asks for semibold headings and 24px section spacing. Current UptimeKit uses bold, tracking-tight headings and denser `space-y-4` list surfaces. Stoat follows the document in pages such as `projects/+page.svelte:32-42`.

Potential fix: Decide which source wins. For live parity, use `font-bold tracking-tight`, `space-y-4`, and the common UptimeKit `max-w-6xl`; otherwise document the intentional Stoat divergence.

### D-03: Account/organization navigation is incomplete

`DESIGN.MD:19-22,145` names an organization page and account-menu link. Stoat's `user-menu.svelte:68-78` has Settings and Log out only, and no `/organization` route exists. UptimeKit includes both destinations in `app-sidebar.tsx` and its organization route tree.

Potential fix: Add organization settings/navigation or remove the stale requirement from `DESIGN.MD`.

### D-04: Collapsed sidebar items lack UptimeKit tooltips

Stoat sidebar buttons at `sidebar.svelte:109-121,182-211` do not pass `tooltipContent`, although the primitive only renders a tooltip when supplied. UptimeKit passes every item title.

Potential fix: Pass titles for app, project, and resource links.

### D-05: Organization logos are collected but discarded

The create dialog accepts a logo, but `packages/db/src/organizations.ts:5-16` does not select it and `sidebar.svelte:129-145` always shows Boxes. UptimeKit renders active/list organization logos.

Potential fix: Include `organization.logo` in the server projection and render it with the current icon as fallback.

### D-06: Top-level Create actions are smaller than the reference

Stoat uses small buttons at `projects/+page.svelte:38-41` and `clusters/+page.svelte:155-158`; equivalent UptimeKit list actions use default size.

Potential fix: Remove `size="sm"` from primary page actions and retain compact sizes in tables/dialogs.

### D-07: Badge, sidebar-scroll, and tabs primitives drift

Stoat badges omit UptimeKit's `font-mono` (`ui/badge/badgeVariants.ts` vs UptimeKit `ui/badge.tsx:9-38`). Stoat sidebar content lacks UptimeKit's ScrollArea fade (`ui/sidebar/sidebar-content.svelte` vs UptimeKit `ui/sidebar.tsx:410-429`). Stoat default tabs are 34/30px instead of 36/32px (`ui/tabs/segmented-control.ts`).

Potential fix: Align those shared primitives rather than patching individual pages.

### D-08: Initialization uses browser-native radios instead of the matching primitive

`apps/web/src/lib/components/clusters/initialize-cluster-dialog.svelte:407-483` uses native radio inputs even though Stoat has `ui/radio-group` matching UptimeKit.

Potential fix: Replace the radio pairs with `RadioGroup`/`RadioGroupItem` while preserving card labels.

### D-09: Resource editor surfaces override semantic tokens

Compose and variable editors add `dark:bg-black/20` and have action containers without the standard compact `gap-2` at the resource overview and variables page.

Potential fix: Remove the raw dark override and use an explicit flex/gap action group.

### D-10: Cluster action visibility contains contradictory classes

`clusters/+page.svelte:220-230` includes both `md:opacity-0` and `md:opacity-100`, so actions are always visible. UptimeKit hides row actions until hover/focus on desktop.

Potential fix: Keep mobile visibility, use `md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100`, and keep an open-menu state visible.

### D-11: Smaller visual/accessibility deltas

- Signup permits a one-character name while UptimeKit requires two (`auth-form.svelte:63-67`; UptimeKit `sign-up-form.tsx:72-79`).
- Stoat body does not apply the antialiasing class used by UptimeKit.
- The cluster metric strip lacks the intended divider gap.
- The code and deployment log surfaces use raw black overrides instead of semantic code tokens.
- The forced dark default, Lucide icons, and omitted social login are intentional per `DESIGN.MD` and should not be changed solely for parity.

## Tooling, tests, and dependency findings

### T-01: `pnpm test` is broken without `DATABASE_URL`

Status: Reproduced.

The run finished with 159 passing tests but two failed suites and zero tests collected in each. `packages/api/tests/initialization.test.ts:17,39` and `organizations.test.ts:10,15` statically import the cluster router before `describe.skipIf` executes. The import reaches `packages/workflows/src/store.ts:14-22`, which requires `DATABASE_URL` at module evaluation.

Potential fix: Make `PgLive` lazy/injected, or dynamically import workflow runtime inside the operation that needs it. With no database URL, opt-in suites must skip cleanly.

### T-02: PostgreSQL integration and Go tests are not part of one root gate

`package.json:10,35` only runs JavaScript workspace commands. The sidecar has no package.json, both database suites are opt-in, and no GitHub/Forgejo workflow was found.

Potential fix: Add CI that provisions disposable PostgreSQL, runs migrations, enables both suites, runs `go test ./...`, `go vet ./...`, typecheck, lint, build, generated-drift checks, and dependency audit.

### T-03: Generated SvelteKit output is tracked and not ignored

Root `.svelte-kit/**` files are staged/tracked, but `.gitignore:6-14` does not exclude `.svelte-kit`. They contain machine/package-store-specific generated imports and create lint noise.

Potential fix: Ignore `**/.svelte-kit/` and remove generated output from version control.

### T-04: Build/typecheck emit persistent configuration and component warnings

Both commands pass, but repeatedly print `src/env.ts requires the experimental.explicitEnvironmentVariables flag to be set`. Build also repeats reactive-capture warnings. `pnpm lint` exits successfully with nine warnings, including empty component entry files, generated `.svelte-kit` lint, an unused import, and an intentional-but-opaque unused expression at resource settings line 300.

Potential fix: Resolve the Varlock/SvelteKit env integration, exclude generated output, remove empty exports, and make lint/checker warnings fail CI once the baseline is clean.

### T-05: Production dependency audit reports two advisories

`pnpm audit --prod` reports one moderate esbuild dev-server advisory through Better Auth/Drizzle tooling and one low `cookie` validation advisory through SvelteKit dependency paths.

Potential fix: Upgrade/override to patched versions when compatible. The esbuild issue is primarily a development-server exposure risk; still keep dev servers off untrusted networks until patched.

## Validation results

| Command | Result |
| --- | --- |
| `pnpm check-types` | Passed; 0 errors, 28 Svelte warnings in 15 files. |
| `pnpm build` | Passed; production bundle built, with env/reactivity warnings. Bundle inspection confirmed R-01. |
| `pnpm lint` | Passed with 9 warnings. |
| `pnpm test` | Failed overall; 159 tests passed, 2 suites failed during import because `DATABASE_URL` was required before skip. |
| `go test ./...` in `apps/sidecar` | Passed. |
| `go vet ./...` in `apps/sidecar` | Passed. |
| OpenAPI source/artifact diff | Failed; committed `packages/uncloud/openapi.json` differs from the Go generator. |
| `pnpm audit --prod` | 1 moderate and 1 low advisory. |

## Positive findings

- No direct cross-organization IDOR was found in implemented cluster, project, resource, deployment, or monitoring queries; organization scoping is generally present.
- Sidecar bearer comparison is constant-time, request/body limits exist, command arguments avoid an implicit shell, and ordinary non-stream requests have deadlines.
- The Go sidecar test suite is substantial and currently green.
- Compose prefixing has focused unit coverage and handles many reference forms.
- UptimeKit tokens and most core primitives are close adaptations rather than superficial copies.
- Authentication forms have good labels, autocomplete values, pending protection, inline alerts, and reduced-motion handling.
- Cluster credentials are deliberately removed from browser list/detail responses.

## Recommended remediation order

1. Fix R-01, R-02, R-03, R-04, R-05, R-06, R-08, and R-09 before a production deployment.
2. Fix the root test import failure and add a real CI gate with PostgreSQL, Go, generated artifacts, and Docker migration smoke coverage.
3. Repair token storage/build-context handling, organization deletion, and secret-rotation lifecycle.
4. Make the sidecar/OpenAPI/SDK contract one tested source of truth and address streaming cancellation/limits.
5. Remove dead/inert UI, complete the dashboard, align prefix behavior, and add unsaved-change/idempotency protections.
6. Apply UptimeKit parity changes at shared shell/primitives first, then page-level cleanup.

## Review limitations

This was a static source review plus local type, build, lint, unit, Go, generated-diff, and dependency checks. It did not run a browser screenshot comparison, a live PostgreSQL integration suite, a real multi-machine Uncloud cluster, Docker image builds, network SSRF probes, or deterministic effect-mq cancellation races. Those are explicitly called out where they affect confidence.
