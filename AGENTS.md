<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity. And dont fucking remove my jokes you clanker!

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names
- Use valibot if it would be nice

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Remote API Conventions

- Keep server-side remote functions in feature-oriented `.remote.ts` modules under `src/lib/api`
- Use plural resource names for modules, such as `data-sources.remote.ts`, `workspaces.remote.ts`, and `services.remote.ts`
- Name collection reads `listX`, single-resource reads `getX`, live queries or streams `streamX`, and mutations `createX`, `updateX`, or `deleteX`
- Give Valibot schemas descriptive `*Input` names, such as `CreateServiceInput` or `UpdateServiceSettingsInput`
- Use explicit resource identifiers such as `serviceId`, `workspaceId`, and `deploymentId` instead of generic `id` parameters where possible
- Order each remote module as ordinary queries, live queries, then commands; keep related schemas and private helpers in the same feature module
- Authorize remote calls at the beginning of every handler with the appropriate guard from `src/lib/api/guard.ts`
- Import remote functions directly from their feature module; do not add an API barrel file
- Share transport and response handling through non-remote helpers, such as `src/lib/api/cluster/response.ts`, instead of duplicating it in each endpoint module

### `src/lib` Layout

- `api/` contains SvelteKit remote functions and their API-specific guards/helpers; keep remote modules feature-oriented
- `domain/` contains client-safe domain types, schemas, and pure business logic; it must not import from `server/`
- `server/` contains server-only persistence, integrations, orchestration, and domain implementations, grouped by plural feature names such as `data-sources/`, `services/`, and `workspaces/`
- `components/` contains reusable Svelte components; keep feature-specific components in a matching subdirectory, such as `components/services/`
- `shared/` contains cross-cutting code that is safe to use from both client and server, including `shared/ui/`
- `auth/`, `db/`, and `assets/` are dedicated infrastructure and static-asset boundaries
- Route and client code should import shared types and pure logic from `domain/`, never from `server/`; server implementations may depend on `domain/`
- Do not move server-only code into client-safe directories or expose database, credentials, or integration clients through shared modules

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Svelte**

- Use `class` and `for` attributes (not `className` or `htmlFor`)
- Do NOT use `$effect` unless absolutely necessary

### m3-svelte

- Always use TextFieldOutlined in favour of TextField

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `pnpm dlx ultracite fix` before committing to ensure compliance.
