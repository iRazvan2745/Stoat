# Stoat

## Project Structure

```
stoat/
├── apps/
│   ├── sidecar/     # Uncloud API layer deployed globally on the servers (Go)
│   └── web/         # Fullstack application (SvelteKit)
├── packages/
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
└── tests/          # TypeScript tests: api, uncloud, workflows, web
```

## Git

Open **Git → Add connection** to connect an account on a Git server, not a specific repository. GitHub (including Enterprise) and Forgejo support account verification and automatic discovery of repositories accessible to the account. Select a connection to see its account identity and available repositories in the dropdown. Only organization owners/admins can add, change, authorize, or remove connections; members can discover repositories and import Compose resources.

The dialog supports access tokens and OAuth applications, including application setup directly in the UI. **Test connection** verifies token credentials and repository discovery without creating a connection. Saving a connection also verifies access; saving an OAuth application only stores its configuration until authorization completes. An account can have zero accessible repositories; check token permissions if repositories are missing. Discovery is capped at 1,000 entries and reports truncation. Push permissions and branch protections are checked by the Git server only when pushing.

Generic Git servers have no standard account/discovery API. Their connections use a server URL and token (or SSH credentials), plus an explicit list of known repository URLs on that server. Testing verifies read access to the first known repository and discovers its default branch. Existing repository-bound connections are migrated to this generic format, preserving their credentials, repository URLs, and Compose bindings.

- Access tokens: GitHub tokens need account/repository metadata access and contents write access to push; classic tokens generally need `repo` for private repositories. Forgejo tokens need account and repository API access. Limit tokens to the repositories you intend to manage. Generic HTTPS supports username and token, or no credentials for public repositories.
- SSH: use `ssh://git@host/owner/repo.git` or `git@host:owner/repo.git`, an unencrypted private key, and verified `known_hosts` entries. Host verification is mandatory; verify fingerprints out of band before trusting a key. Nonstandard SSH ports use the standard `[hostname]:port` host-key alias. SCP-style relative paths are relative to the remote user's home; explicit SSH URL paths are absolute unless prefixed with `/~/`.
- Credentials are encrypted using `BETTER_AUTH_SECRET`, scoped to the organization and connection. Keep that secret stable; rotating it requires re-entering connection credentials. Credentials are never returned by the API.
- The web server needs Git 2.43+ and OpenSSH installed. The web Docker image includes both. Apply the new database migration with `pnpm db:migrate` before using connections.
- Public hosts are permitted. To access a self-hosted server on a private network, explicitly set `STOAT_GIT_ALLOWED_HOSTS=git.internal.example,10.20.30.40` on the web server. Entries are exact hostnames/IPs, not URLs, ports, wildcards, or CIDRs. Loopback, link-local, and metadata endpoints remain blocked. Use network egress policies and container resource limits as additional protection.

When creating a Compose resource, choose a Git account connection, repository, branch, and repository-relative file or directory. Repository and branch selections belong to the resource, not the account. Directories select the first existing file in this order: `compose.yaml`, `compose.yml`, `docker-compose.yml`, `docker-compose.yaml`. Use `.` for the repository root. Existing resources can also connect or change their Git source.

### OAuth Setup

Organization owners/admins can configure OAuth entirely through **Git → Add connection** (or **Edit**) without editing environment variables or restarting Stoat:

1. Select GitHub or Forgejo, enter its HTTPS server URL, and choose **OAuth**.
2. Copy the readonly **OAuth callback URL**. It is available before any application is configured. Setup opens automatically when no application matches; otherwise choose **Set up a new OAuth application**.
3. Follow the registration link to your provider and register an OAuth application once, using the exact callback URL shown. GitHub uses `/settings/applications/new`; Forgejo uses `/user/settings/applications`. For Forgejo, find **Create a new OAuth2 Application**, name it **Stoat**, paste the callback URL as the **Redirect URI**, and enable **Confidential Client**. Use HTTPS for production Stoat installations.
4. Enter the provider's **Client ID** and **Client secret**, then select **Save OAuth application**. Stoat uses the current connection name (or a default application name), provider, and server. The application is scoped to your organization, its secret is encrypted and never returned, and the new application is selected immediately. Other connections can reuse it.
5. Enter a connection name if needed and select **Continue with OAuth** (or **Reconnect with OAuth**). Saving the application does not verify its credentials or connect the account: credentials are verified during the authorization-code exchange, followed by account and repository-access verification before the connection is saved.

Access-token connections work without OAuth app registration. Generic Git has no universal OAuth flow, so it uses tokens/SSH instead. OAuth requests use state bound to the user/session/organization, PKCE, verified callback origins, encrypted credentials, and refresh-token rotation. GitHub requests `repo` and `read:user`; Forgejo's OAuth scope model may grant broader account access, so review its authorization screen.

**Optional legacy global configuration:** existing deployments may still provide `GIT_OAUTH_PROVIDERS` on the web server as a JSON array. These global applications appear alongside organization-scoped UI applications; this variable is not required for UI setup. Never expose client secrets through public environment variables:

```json
[{"id":"github","name":"GitHub","provider":"github","serverUrl":"https://github.com","clientId":"your-client-id","clientSecret":"your-client-secret"}]
```

Legacy entries can also use provider `forgejo` and their server URL. Register the callback URL shown in the UI (`${BETTER_AUTH_URL}/git/oauth/callback`) with each provider. Only changes to this optional environment configuration require a web-server restart.

**Save draft** saves only to Stoat. **Commit & push** explicitly publishes the editor text to the selected branch. **Pull from Git** replaces the local draft after confirmation; **Detach** retains the current Compose text. Pushes reject changed remote revisions and never force-push. After a conflict, retain your edits, reload the remote version, and reconcile before retrying. Commits contain the raw Compose source, not Stoat's generated service-name prefixes.

Repository editing supports UTF-8 text up to 1 MiB per file, up to 10,000 regular files per repository, and bounded/timeout-limited Git operations. Binary files, symlinks, submodules, local filesystem remotes, and unencrypted Git/HTTP transports are not supported. Importing Compose does not upload repository build contexts or resolve relative `env_file`, bind mounts, or other referenced files for deployment.

Run the Git adapter tests with `pnpm exec vp test run tests/api/git.test.ts`.

## Resource Logs

Open **Logs** in a resource's sidebar. **Live** follows up to 20 current deployed services through Uncloud; **Search** queries GreptimeDB with literal text and preset or custom date ranges. Historical search requires initialized cluster monitoring. Deleted/recreated service IDs are not included.

Opening a resource preconnects its log stream in the background. The same bounded buffer and connection survive Overview, Variables, Settings, and Logs navigation; the log UI only renders on the Logs tab. Leaving the resource closes the stream. Pause stops it explicitly, and reconnects keep the previous buffer visible until the new tail arrives. Transport remains SSE: this is a one-way feed, so reusing the connection avoids startup work without a WebSocket upgrade.

The activity chart counts **loaded lines only**: explicit error/warning/success levels and HTTP outcomes, with informational or unclassified output shown as INFO. Click a bar to filter its time interval, or a classification to filter by level; these filters combine. The selected interval stays fixed as logs arrive. Click the selected bar again or **Show all times** to clear it. Live connections replay a bounded recent tail on reconnect; they are not an exactly-once archive. Historical pages are newest first and are not snapshot-isolated from late ingestion or retention changes.

Run the API checks with `pnpm exec vp test run tests/api/resource-logs.test.ts` and the chart checks with `pnpm --dir apps/web exec vp test run src/lib/resource-logs.test.ts`.

## Tests

Run all TypeScript tests with `pnpm test`. Suites live in root `tests/`, grouped by `api`, `uncloud`, `workflows`, and `web`. Web tests retain the SvelteKit test configuration. Go tests stay beside their packages because they exercise private functions; run them with `go -C apps/sidecar test ./...`.

Have Docker (or a Testcontainers-compatible runtime) running before starting the tests. Testcontainers starts one `postgres:18-alpine` container on a random port for the backend test run and stops it afterward. The first run may need to download the PostgreSQL and Testcontainers cleanup images.

All PostgreSQL integration cases run automatically, without opt-in flags or a manually configured database. Each suite creates, migrates, and drops its own database inside the shared container, so suites can run in parallel. Test setup overrides `DATABASE_URL` for the test workers, including workflow queue code; your application database is not used. No manual migrations or live Git provider credentials are needed. A missing container runtime fails the run instead of silently skipping tests.

The suites exercise organization and cluster isolation, revoked memberships, concurrent resource settings updates, initialization request/history rollback, concurrent provisioning, monitoring credential permissions, private service exposure, mount preservation, and upgrades from historical database schemas. Database failure tests use real constraints and transactions rather than mocking successful queries.

Further test priorities are stale/cancelled initialization-worker attempts, authorization revocation on already-open streams, and browser end-to-end login, organization switching, resource editing, and deployment flows. Passing unit and integration tests does not replace those checks.

## Credits

Kudos to the creators, maintainers and contributors of Coolify and Dokploy, these 2 are the inspiration that Stoat is based on. Coolify's way of being more of a PaaS and Dokploy's of being more of a "docker harness". ♥️
