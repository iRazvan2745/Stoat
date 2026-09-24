# Stoat design system

Stoat's **resource overview and Variables pages are the primary design reference** for new application work. Match their neutral surfaces, Outfit typography, compact controls, framed work areas, restrained status colors, and inset application shell. The resource screenshot illustrates this language: a narrow runtime list beside a large editor, both inside muted frames with recessed content panels. Reuse the Svelte components in `apps/web/src/lib/components/ui`; do not approximate them with unrelated card styles.

## Reference and source of truth

Local source of truth, in priority order:

- [Resource overview](apps/web/src/routes/(app)/projects/(resource)/[projectId]/[resourceId]/+page.svelte): heading, two-column workspace, container list, frame headers, compose editor, and action placement.
- [Variables page](apps/web/src/routes/(app)/projects/(resource)/[projectId]/[resourceId]/variables/+page.svelte): compact single-editor workspace, inline status, visibility toggle, and save action.
- [Resource layout](apps/web/src/routes/(app)/projects/(resource)/[projectId]/[resourceId]/+layout.svelte): full-width, full-height resource workspace.
- [Application shell](apps/web/src/lib/components/sidebar/app-shell.svelte) and [resource sidebar](apps/web/src/lib/components/sidebar/resource-sidebar.svelte): inset, breadcrumbs, and contextual navigation.
- [Frame primitives](apps/web/src/lib/components/ui/frame) and [code editor](apps/web/src/lib/components/code-editor.svelte): exact surface construction and editor treatment.

UptimeKit's application dashboard in `~/coding/uptimekit` is the system's historical foundation, not an override for these local page patterns. Its public status pages are separately themed. Background references:

- `~/coding/uptimekit/apps/dash/src/styles/base.css`: light/dark tokens, shadows, radius scale, semantic colors.
- `~/coding/uptimekit/apps/dash/src/components/ui/`: component styling and state conventions.
- `~/coding/uptimekit/apps/dash/src/components/auth/sign-in-form.tsx` and `sign-up-form.tsx`: compact, centered authentication layouts with input icons.
- `~/coding/uptimekit/apps/dash/src/app/(dash)/(dashboard)/layout.tsx`: inset shell, bordered content, translucent sticky header.

Local implementation:

- [Theme tokens](apps/web/src/app.css)
- [Theme class](apps/web/src/app.html)
- [UI components](apps/web/src/lib/components/ui)
- [Authentication form](apps/web/src/lib/components/auth/auth-form.svelte)
- [Default application layout](apps/web/src/routes/(app)/+layout.svelte)

Change shared tokens or primitives when changing the system. Keep equivalent controls consistent. Purposeful density overrides such as a zero-padding editor panel or compact variables toolbar are part of the system, not exceptions to eliminate. The UptimeKit repository is a reference; Stoat does not import its React components at runtime. Dimensions below assume a 16px root font size.

## Theme and color

Light tokens live in `:root`; dark overrides live in `.dark`. Stoat currently starts in dark mode through the root HTML class. Removing that class selects the light theme. Keep colors and Tailwind `dark:` variants governed by the same class; never put dark values in a second unconditional `:root` block.

Use semantic Tailwind classes rather than raw colors in page markup:

| Role | Class/token | Light | Dark |
| --- | --- | --- | --- |
| Canvas | `bg-background` | White | Neutral 950 mixed with 5% white |
| Main text | `text-foreground` | Neutral 800 | Neutral 100 |
| Cards, popovers | `bg-card`, `bg-popover` | White | Canvas mixed with 2% white |
| Primary action | `bg-primary` | Neutral 800 | Neutral 100 |
| Primary action text | `text-primary-foreground` | Neutral 50 | Neutral 800 |
| Muted, secondary, hover | `bg-muted`, `bg-secondary`, `bg-accent` | Black at 4% | White at 4% |
| Supporting text | `text-muted-foreground` | Neutral 500 mixed with 10% black | Neutral 500 mixed with 10% white |
| Dividers | `border-border` | Black at 8% | White at 6% |
| Control borders | `border-input` | Black at 10% | White at 8% |
| Focus | `ring-ring` | Neutral 400 | Neutral 500 |
| Sidebar | `bg-sidebar` | Neutral 50 | Neutral 950 mixed with 3% white |

Primary actions are monochrome. Color communicates state:

- `destructive`: red for destructive actions; `destructive-foreground` for inline error text.
- `info`: blue; `success`: emerald; `warning`: amber.
- Semantic foreground variants use 700 shades in light mode and 400 shades in dark mode.
- Operational, degraded, partial-outage, major-outage, maintenance, and unknown status tokens are available for infrastructure health. Pair state color with a readable label or icon.
- Chart series use `chart-1` through `chart-5`; these have separate light/dark values.
- Code surfaces use `code`, `code-foreground`, and `code-highlight`.

Do not use chart or status colors as a new brand accent. Avoid decorative gradients and large colored backgrounds.

Preserve the resource page's surface hierarchy: sidebar/canvas, translucent shell header, muted frame surround (`bg-muted/72`), then bordered inner panel (`bg-background`). Editor panels use `bg-code dark:bg-black/20`. These are deliberately different layers; do not flatten everything to `bg-card` or give every nested region another border. Service logos may keep their recognizable colors without becoming an application accent.

## Typography

Use **Outfit Variable**, already self-hosted through `@fontsource-variable/outfit`, for body text, headings, and controls. Keep the system sans-serif fallbacks. UptimeKit loads Outfit remotely; Stoat retains its local font package.

| Context | Convention |
| --- | --- |
| Auth heading | `text-2xl font-bold tracking-wide` |
| Application page heading | `text-2xl font-semibold` |
| Resource overview frame heading | `text-base font-semibold` (16px) |
| Default FrameTitle | `text-sm font-semibold` (14px) |
| Variables toolbar filename | `text-sm font-medium` (14px) |
| Default CardTitle | `text-lg font-semibold leading-none` (18px) |
| Brand name | `text-lg font-semibold` |
| Auth description | `text-base text-muted-foreground` |
| Body, field labels, supporting text | `text-sm` on desktop |
| Secondary metadata, field hints | `text-xs text-muted-foreground` |
| Code, identifiers | `font-mono` |
| Code editor | System monospace, 13px type, 24px line height |

Use short, direct product copy. A heading and one supporting sentence are usually enough. Avoid marketing taglines, uppercase decorative eyebrows, and ornamental footer copy in account flows.

UptimeKit names Geist Mono but Stoat does not bundle it. Stoat uses an explicit system monospace stack until a dedicated mono font is installed. Do not claim an unloaded font is available.

## Spacing, shape, and elevation

Use the 4px spacing unit with existing half-steps for fine alignment. Typical gaps are 8px between compact controls, 12px in dense workspaces and list rows, 16px within a content group, 24px between overview sections, and 32px between auth content and its account-navigation prompt. Use 4px between a section title and description; the variables subtitle uses 2px. Do not apply a uniform 24px gap to every page.

The base radius is 10px in light mode and 8px in dark mode, matching UptimeKit. Derived radii:

| Token | Formula | Light / dark |
| --- | --- | --- |
| `rounded-sm` | Base − 4px | 6px / 4px |
| `rounded-md` | Base − 2px | 8px / 6px |
| `rounded-lg` | Base | 10px / 8px |
| `rounded-xl` | Base + 4px | 14px / 12px |
| `rounded-2xl` | Base × 1.8 | 18px / 14.4px |

Buttons and inputs use `rounded-lg`; frame surrounds and cards use `rounded-2xl`; inset frame panels use `rounded-xl`. Badges use `rounded-sm`, not pill shapes. Keep the existing primitive's one-pixel inset highlight and subtle shadow. Use the shared shadow scale; do not add large floating shadows to ordinary panels.

## Components

Import from `$lib/components/ui/<component>`. Preserve the underlying accessibility and state handling when adapting appearance.

### Buttons

Use `Button` with its existing variants:

- Default: the main action for the form or section.
- Secondary: filled, low-contrast actions such as Preview compose.
- Outline: secondary actions, including organization switching.
- Ghost: low-emphasis navigation and toolbar actions, including the back button.
- Destructive: destructive actions only.

Default buttons are 36px high on mobile and 32px at `sm` and above. Small buttons are 32px/28px; large buttons are 40px/36px. Coarse pointers retain the primitive's expanded target area. Auth uses a full-width small submit button with a 12px gap above it, matching the reference.

Default buttons have 11px horizontal padding and 8px gaps; small buttons use 9px padding and 6px gaps. Text is 16px below `sm`, 14px above. `icon-sm` is 32px square below `sm`, 28px above. Retain the 2px focus ring with 1px offset, 64% disabled opacity, and minimum 44px coarse-pointer hit area. Compose uses default-size actions; Variables uses small actions. Keep toolbar actions beside the section they affect, not in a detached page footer.

Use `loading` for pending actions, preserve focus rings, and prevent repeated submissions. Client-only actions remain disabled until hydration completes.

### Fields

Use `Input` and `Label` for settings forms. Use `InputGroup`, `InputGroupInput`, and `InputGroupAddon` for compact auth fields with leading icons. Default inner input heights are 34px on mobile and 30px on desktop; the enclosing border adds 2px to the outer control. Preserve the input's 3px focus ring and dark `bg-input/32` surface. Configuration documents belong in the shared code editor, not an improvised textarea or a field for each line.

Auth labels may be visually hidden with `sr-only`, but every field must retain a programmatic label. Placeholders are hints, not the accessible name. Set the correct input type and autocomplete value. Associate hints with `aria-describedby`; announce submission errors with `role="alert"`.

Use `text-destructive-foreground` for readable inline error text. Keep errors near the fields or action that caused them. Preserve entered values after an error.

### Frames and cards

**Use Frame for a titled work area with an inset content surface:** editors, runtime lists, and comparable data workspaces. The header belongs on the outer muted surround; the list or editor belongs inside the bordered panel. This intentional two-layer construction is not unnecessary card nesting.

| Part | Construction | Purpose |
| --- | --- | --- |
| `Frame` | `relative flex flex-col rounded-2xl bg-muted/72 p-1` | Muted surround with a 4px inset; no default outer border |
| `FrameHeader` | `flex flex-col px-5 py-4` | 20px horizontal and 16px vertical padding; holds title, description, count, or actions |
| `FrameTitle` | `text-sm font-semibold` | Override to `text-base` for overview sections |
| `FrameDescription` | `text-sm text-muted-foreground` | One short supporting sentence |
| `FramePanel` | `rounded-xl border bg-background bg-clip-padding p-5 shadow-xs/5` | Recessed content surface; 20px padding by default |

Adjacent FramePanels have 4px separation. Use `p-0` for edge-to-edge lists and editors, with clipping or scrolling on the correct content region. Do not add a second wrapper card around the editor. Keep the panel's subtle one-pixel highlight: black at 4% in light mode, white at 6% in dark mode.

Use `Card`, `CardHeader`, and `CardPanel` for a conventional single-surface settings or form section that does not need a framed workspace. Card uses `rounded-2xl border bg-card`, not a muted surround. CardHeader and CardPanel start with 24px padding; the header's bottom padding becomes 16px when followed by a panel, and panel top padding is removed after an unbordered header. Preserve primitive spacing rather than doubling it with extra wrappers. `CardFrame` is a separate card/table composition primitive, not the `Frame` used by the resource pages.

Page headings and authentication content remain unboxed. Do not turn every label, status, or toolbar group into its own card.

### Lists and badges

Use the resource Containers panel as the list recipe. Rows have 12px padding, 12px horizontal gaps, and a single Separator between rows. A 40px muted circular icon well holds a 20px icon. Names are 14px medium with 20px line height; metadata is 12px muted with 20px line height and a 4px top gap. Truncate names and metadata within `min-w-0` regions, leaving room for status. Shortened IDs use monospace.

Status badges remain readable labels, not color-only dots. Healthy uses success styling; unknown uses neutral styling. Default badges are 22px high below `sm` and 18px above, with 14px/12px text. Large badges are 26px/22px with 16px/14px text. Use medium weight, 4px gaps, and `rounded-sm`. Semantic fills are low-opacity (8% light, 16% dark), not saturated blocks. Resource type uses a large secondary badge.

Neither the overview nor Variables is a table. For actual tabular data, reuse the table primitives: 14px text, 40px header, 10px cell padding, dividers, and restrained hover/selected states. Do not impose a fixed body-row height or replace the container list with a table merely to align status labels.

### Code editors

Use [CodeEditor](apps/web/src/lib/components/code-editor.svelte), which provides CodeMirror, line numbers, YAML support, and environment-value masking. Keep its transparent background inside the panel, system monospace 13px text, 24px line height, and 16px vertical content padding. The line-number gutter is transparent with muted numbers and a one-pixel right divider. Use two-space indentation. Syntax colors remain restrained; comments and punctuation are muted, the caret uses primary, and selection uses primary at 25%.

An editor FramePanel uses `min-h-0 overflow-hidden bg-code p-0 transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20 dark:bg-black/20`. Focus belongs around the inset panel rather than an extra box inside it. Preserve an accessible editor label.

The shared scroller defaults to a 22rem minimum and 32rem maximum height with internal scrolling. Full-height workspaces override this intentionally: overview at `xl`, Variables at all widths. Use `min-h-0` throughout flex/grid ancestors so the editor scrolls inside its panel instead of stretching the shell. Long code lines scroll within the editor, not the whole page.

### Icons

Stoat keeps its existing Lucide Svelte icon family. UptimeKit also uses Font Awesome; copying that dependency is unnecessary for visual consistency. Use 16–18px icons within controls, a consistent stroke, and `aria-hidden="true"` for decorative icons. Icon-only actions need an accessible name.

## Layout recipes

### Authentication

- One centered column: `max-w-sm`, `min-h-svh`, `p-6 md:p-8`.
- Put Stoat's mark and name inside the column, above the heading.
- Stack brand, heading/description, and compact form with 16px gaps.
- Use icon input groups and a full-width primary submit action.
- Place the login/signup link below the form in muted centered text, with an underlined link.
- No enclosing card, page-level brand header, decorative footer, or unsupported social-login buttons.
- Preserve the existing email/password flow. UptimeKit's SSO lookup is not part of this visual adaptation.
- Forms use `method="POST"` even when handled in the browser.

### Application

Use the shared `AppShell`, `SidebarProvider`, contextual sidebar, and `SidebarInset`. The header is sticky with `z-40`, a minimum height of 64px, `rounded-t-xl`, `bg-popover/80`, `backdrop-blur-lg`, and a bottom border. It has 16px horizontal and 8px vertical padding and may wrap. It contains the sidebar trigger, vertical divider, and contextual breadcrumbs. Resource breadcrumbs are Projects, project name, then resource icon/name. Account actions live in the sidebar footer.

The desktop sidebar is 256px wide. The inset has 16px outer margin with no start margin, rounded-xl corners, and a subtle shadow; collapsed inset margins become 8px. Desktop navigation begins at `md`; mobile uses the existing 288px Sheet. Preserve the primitive's icon-collapse sizing instead of calculating it from the 48px icon-width token alone.

Resource navigation follows this order: organization switcher; project-name group with Back to project; separator; resource-name group with Overview, Variables, Settings; separator; Resources list; footer account menu and version. Standard application navigation may retain Main and Configuration groups, but must not replace this resource context. Navigation items are 32px high with 14px text, 16px icons, and 8px padding/gaps. Active items use a muted sidebar-accent rounded background and medium text, not a colored indicator bar.

The user trigger is a 48px sidebar button with a 32px rounded avatar (24px when collapsed), a two-line name/email block, and up/down chevrons. The popup repeats the identity, separates Settings from a destructive Log out action, aligns to the trigger's end, and uses its width with a 224px minimum and viewport-safe maximum. Allow the menu primitive to flip placement at viewport edges. Menu popups close on selection, on Escape, and on route change, since SPA navigation keeps the layout and its portals mounted. The header sidebar trigger stays disabled until hydration completes, matching other client-only actions. Keep errors visible in the footer and prevent duplicate logout requests. Do not duplicate the account controls in the page header.

Content has 16px horizontal padding and 24px bottom padding. Normal pages use a centered `max-w-7xl`; resource overview and Variables enable `fullWidth` and `fullHeight`, removing that width cap and filling the viewport at `xl`. Settings forms may use a centered `max-w-2xl` column. Keep long organization names truncated in navigation without pushing actions outside the viewport.

### Resource overview

- Page wrapper: `flex w-full flex-col gap-6 py-6 xl:min-h-0 xl:flex-1 xl:pb-0`.
- Heading: wrapping space-between row with 16px gaps. Left group has a ghost `icon-sm` back button, a 32px resource logo, and a 24px semibold name with 12px gaps. Names may wrap anywhere. Optional description sits 4px below in muted 14px text. Resource-type badge sits at the far right.
- Workspace: `grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0`. Containers spans one column; Docker Compose spans three. At `xl`, both frames span two rows and use `grid-rows-subgrid` to align their headers and panel tops. Preserve the narrow support column and dominant editor, not equal-width cards.
- Containers header: 16px semibold title with a trailing muted 12px tabular count, then a short 14px description. Panel uses zero padding and internal vertical scrolling, capped at 384px below `xl` and uncapped above. Status sits below the name at small widths and in a trailing column from `sm`.
- Compose header: wrapping horizontal row, start-aligned and space-between, with 8px gaps. Title/description remain on the left; inline save status, secondary Preview compose, and primary Save remain on the right. Do not move actions into the editor gutter.
- Both panels stretch with the workspace at `xl`. The editor fills its panel and removes the shared scroller's maximum height. Below `xl`, frames stack with 24px spacing and the page can scroll.
- Preview compose opens a `max-w-4xl` dialog with a readonly monospace Textarea on a rounded-xl code surface, `55vh` height, 192px minimum, and 24px line height. It previews saved configuration, not unsaved editor contents; keep that distinction explicit.

### Variables

Treat Variables as a compact, single-document workspace, not a generic settings form or key/value table.

- Page wrapper: `flex h-[calc(100dvh-7rem)] min-h-112 min-w-0 w-full flex-col gap-3 py-3 xl:h-auto xl:min-h-0 xl:flex-1`. Below `xl`, the workspace is viewport height minus 112px with a 448px minimum. Let short screens scroll rather than clipping controls.
- Heading: ghost `icon-sm` back button, 12px gap, 24px semibold title with tight leading. Resource subtitle is truncated muted 14px text, 2px below the title.
- A single Frame uses `min-h-0 min-w-0 w-full flex-1 overflow-hidden` and fills the remaining space.
- Compact FrameHeader: `flex-row flex-wrap shrink-0 items-center gap-3 px-3 py-2`. This is 12px horizontal and 8px vertical padding, deliberately tighter than the overview header.
- Toolbar hierarchy: `.env` in 14px medium text on the left, flexible inline status in the middle, then small outline Show values / Hide values and small primary Save on the right, separated by 8px. Status wraps without pushing controls offscreen.
- FramePanel is zero-padding, overflow-hidden, and flex-filling. The editor fills the panel at every breakpoint, not only desktop. Keep the shared gutter, code typography, and panel focus treatment.
- Values start hidden and reset to hidden when switching resources. The existing treatment is a 5px visual blur on value decorations, not redaction: values still exist in editor content. Never describe it as secure removal or a permission boundary.
- Preserve dirty edits during refresh. Disable Save when unchanged, pending, or when the loaded resource does not match the route. Show pending, unsaved, saved, and error states inline with `aria-live="polite"`; preserve edits after failures. These behaviors are part of the workspace pattern.

## Motion and responsive behavior

Auth content may use UptimeKit's brief fade and 16px upward entrance over 600ms. Apply it only through `motion-safe:` utilities so reduced-motion users get an immediate render. Other motion should communicate focus, interaction, or state.

Use the existing Tailwind breakpoints. Let auth pages scroll on short screens; do not clip the form to a fixed viewport height. Preserve the sidebar's mobile behavior. Check small screens for horizontal overflow, keyboard focus visibility, and unobstructed primary actions.

## Review checklist

- Shared tokens and components are used consistently.
- Workspaces use muted Frames with inset FramePanels; ordinary forms use Cards only when a single surface is appropriate.
- Frame headers, panel insets, row separators, compact badges, and editor gutters match the resource reference rather than approximate nested cards.
- Overview retains its 1:3 desktop column spans and aligned panel tops; Variables retains its compact single-editor toolbar.
- Editor scrolling stays inside its panel; headings and actions wrap without page-wide overflow. Verify stacked, `xl` full-height, and short-screen layouts.
- Both `.dark` and light rendering work, including focus, error, disabled, and loading states.
- Outfit loads locally; there are no new external font requests.
- Labels, hints, errors, keyboard access, and reduced-motion behavior remain usable.
- Layouts work at 390px mobile and laptop widths without horizontal overflow.
- Authentication, navigation, preview, value visibility, and save actions still work after visual changes; dirty edits and inline feedback are preserved.
- Run `pnpm check-types`, targeted lint, and the web production build for shared styling/component changes; visually inspect the affected pages.
