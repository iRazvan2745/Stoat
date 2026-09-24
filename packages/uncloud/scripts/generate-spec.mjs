#!/usr/bin/env node
// Regenerates the vendored Uncloud OpenAPI spec from the sidecar source.
//
// The spec is committed to the repo on purpose: codegen must never depend on the
// sidecar being reachable, otherwise Docker builds and CI break whenever the
// cluster is down. It is produced by running the sidecar's own generator rather
// than fetching /openapi.json from a deployed instance, so the vendored spec
// cannot lag behind the Go source — and refreshing it needs neither a running
// cluster nor the sidecar's bearer token.
//
//   node scripts/generate-spec.mjs
//
// Requires a Go toolchain. Run `pnpm generate` afterwards and commit the spec
// together with the generated types.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const sidecarDir = join(packageDir, "..", "..", "apps", "sidecar");

const outPath = join(packageDir, "openapi.json");

let stdout;

try {
    ({ stdout } = await execFileAsync("go", ["run", "./cmd/openapi"], {
        cwd: sidecarDir,
        maxBuffer: 32 * 1024 * 1024,
    }));
} catch (error) {
    console.error(`Failed to run the sidecar OpenAPI generator in ${sidecarDir}`);
    console.error(error.stderr || error.message);
    process.exit(1);
}

const spec = JSON.parse(stdout);

if (!spec.openapi || !spec.paths) {
    console.error("Generator output does not look like an OpenAPI document.");
    process.exit(1);
}

// Stable formatting so diffs stay reviewable across refreshes.
await writeFile(outPath, `${JSON.stringify(spec, null, 4)}\n`);

// Hand the result to the repo formatter rather than trying to match its array
// wrapping, so a refresh never leaves the working tree dirty. The binary is
// resolved directly instead of through `pnpm exec`, which would re-run install
// hooks as a side effect.
const oxfmt = join(packageDir, "..", "..", "node_modules", ".bin", "oxfmt");

try {
    await execFileAsync(oxfmt, [outPath]);
} catch (error) {
    console.error(`Failed to format the generated spec with ${oxfmt}`);
    console.error(error.stderr || error.message);
    process.exit(1);
}

const pathCount = Object.keys(spec.paths).length;

const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;

console.log(`Wrote ${outPath}`);

console.log(`  ${spec.info?.title ?? "unknown"} ${spec.info?.version ?? ""}`.trimEnd());

console.log(`  ${pathCount} paths, ${schemaCount} schemas`);

console.log(`\nNext: pnpm --filter @stoat/uncloud generate`);
