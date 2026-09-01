# Templates

Service templates live in `/templates`. Each app is a folder named with its **app id** (letters, numbers, dots, underscores, and hyphens).

```
templates/
  postgresql/
    manifest.json
    logo.svg
    versions/
      18/
        compose.yaml
        .env
```

Stoat lists every valid app under this directory in the **Add service → Template** dialog.

## Layout

| Path                                                | Required | Purpose                                                                                          |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `templates/<appid>/manifest.json`                   | yes      | Display name, description, and service type                                                      |
| `templates/<appid>/logo.svg` or `logo.png`          | no       | Icon on the template card. Copy from [svgl.app](https://svgl.app), or set `icon` in the manifest |
| `templates/<appid>/versions/<version>/compose.yaml` | yes      | Compose file deployed for this version (`compose.yml` is also accepted)                          |
| `templates/<appid>/versions/<version>/.env`         | no       | Environment variables seeded onto the service                                                    |

`<appid>` and `<version>` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Versions are sorted newest-first using numeric comparison (`18` > `16`, `1.10` > `1.9`).

Apps with a missing or invalid manifest, or with no version folders, are skipped.

## `manifest.json`

```json
{
    "name": "PostgreSQL",
    "description": "Relational database for apps that need durable SQL storage.",
    "type": "postgresql",
    "icon": "postgresql",
    "tags": ["database"]
}
```

| Field         | Required | Notes                                                                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | yes      | Shown on the template card and used as the default service name                                                                      |
| `description` | yes      | Short summary under the name. Long text is truncated in the picker                                                                   |
| `type`        | yes      | Stored on the created service. Use `compose` for a generic app. Use `postgresql` to get the connection URL panel on the service page |
| `icon`        | no       | [SVGL](https://svgl.app) slug, without `.svg` (for example `postgresql`). Used when `logo.svg` / `logo.png` is missing               |
| `tags`        | no       | Category pills on the template card (`database`, `cache`, `proxy`, …)                                                                |

## Logo

Prefer a local `logo.svg` or `logo.png` under `templates/<appid>/`. Copy brand marks from [svgl.app](https://svgl.app) — search for the product, then save the SVG as `logo.svg`.

If there is no local file, set `"icon"` in the manifest to the SVGL library name. Stoat loads it from `https://api.svgl.app/svg/<icon>.svg`.

## Compose and environment

`compose.yaml` is copied onto the new service as-is (after secret expansion). Do not use `env_file: .env` or a fixed `container_name` — Stoat stores `.env` values as service environment variables and injects them at deploy time.

`.env` uses standard `NAME=value` syntax (quotes, `export`, and comments are supported). Those variables are created on the service so they can be edited under **Environment**.

For PostgreSQL, include `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. The service page builds:

- an **internal** URL at `<compose-service>.internal` (the Uncloud name after the service slug is prefixed)
- an **external** URL only when the compose file publishes a TCP port (`ports` or Uncloud `x-ports`)

## Secret placeholders

Placeholders in `.env` values and in `compose.yaml` are expanded **once**, when the service is created. Each placeholder generates a new value.

| Placeholder  | Result                                                              |
| ------------ | ------------------------------------------------------------------- |
| `{{ UUID }}` | A random UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)              |
| `{{ 32 }}`   | A random 32-character base64 string (`A–Z`, `a–z`, `0–9`, `+`, `/`) |

Spaces inside the braces are optional (`{{UUID}}` and `{{32}}` work). `{{ N }}` accepts any length from 1 to 256.

Example `.env`:

```
POSTGRES_USER=postgres
POSTGRES_PASSWORD={{ 32 }}
POSTGRES_DB=app
API_TOKEN={{ UUID }}
```

Do not reuse the same placeholder when two fields must share a value — each `{{ }}` is generated independently. Put the secret in one environment variable and reference that variable from compose instead.
