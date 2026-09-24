# Anti-Slop Provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Source directory: `skills/install-anti-slop/assets/anti-slop/`
- Installation source: `.agents/skills/install-anti-slop/assets/anti-slop/`, copied using the bundled `scripts/install.mjs` without `--force`.
- Verification: recursive file comparison of the installation source against the source directory at the commit above found no differences.
- Installed generic plugin: `tools/oxlint/anti-slop/index.ts`
- Installed Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`
- Intentional deviations: this provenance file only; plugin source is unchanged.

The nested `vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md` are retained unchanged.

## Repository Configuration

Rules are enabled at error severity in the root `vite.config.ts`, used by `pnpm lint` and `pnpm exec vp check`. All 18 generic rules, the native `oxc/no-accumulating-spread` companion, and all five Effect rules are enabled. Effect is a direct dependency of workspace packages. Effect service import enforcement covers relative project imports, not package aliases.

Both `oxlint` and `@oxlint/plugins` are pinned to `1.81.0`, matching the Oxlint runtime bundled with the repository's Vite+ version. Upgrade them together and recheck Vite+ compatibility.

Agent tooling and this vendored directory are excluded from both Vite+ linting and formatting. Existing ignores are preserved. No application-source cleanup or rule suppression was performed during installation.
