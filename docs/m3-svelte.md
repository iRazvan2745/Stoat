# M3 Svelte — Human Guide (for this project)

This project uses [m3-svelte](https://github.com/KTibow/m3-svelte) **7.2.0** (Material Design 3 components for Svelte 5), **patched** via `patches/m3-svelte.patch` (registered in `pnpm-workspace.yaml`) to add the **expressive menus** from the [mrsproutt/m3-svelte `expressive-menus` branch](https://github.com/mrsproutt/m3-svelte/tree/expressive-menus/src/lib/containers).

The patch adds `ExpressiveMenu`, `ExpressiveMenuItem`, `ExpressiveMenuGroup`, `MenuDivider`, `ButtonGroup`, and extends the legacy `Menu` with anchor positioning (`open`, `anchored`, `x`, `y`).

> **Rule of thumb: use the expressive menu family for menus.** The default `Menu`/`MenuItem` are the minimal legacy variants — reach for them only for tiny dropdowns (e.g. inside `SplitButton`).

---

## Setup (already done here)

```bash
pnpm install m3-svelte vite-plugin-functions-mixins @ktibow/iconset-material-symbols -D
```

`vite.config.ts` must include `functionsMixins({ deps: ["m3-svelte"] })` — it compiles m3-svelte's custom CSS syntax (`@apply` mixins, `--translucent()`, `--m3-density()`). Your theme lives in `app.css` (the `:root { ... }` theme snippet).

## Design tokens

| Kind        | Example                                                                       | Where it comes from          |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------- |
| Colors      | `--m3c-primary`, `--m3c-surface-container`, `--m3c-tertiary-container-subtle` | Your theme snippet           |
| Shapes      | `--m3-shape-small`, `--m3-shape-full`                                         | `m3-svelte/etc/styles.css`   |
| Elevation   | `--m3-elevation-1` … `--m3-elevation-5`                                       | `m3-svelte/etc/styles.css`   |
| Type        | `--m3-title-large`, `--m3-label-medium`, …                                    | `m3-svelte/etc/styles.css`   |
| Easing      | `--m3-easing-fast`, `--m3-easing-fast-spatial`                                | `m3-svelte/etc/styles.css`   |
| Config vars | `--m3v-bottom-offset` (snackbar offset), `--m3v-background`                   | Your CSS, read by components |

Mixins (use in your own components too, thanks to the plugin):

```css
@apply --m3-title-large;   /* display|headline|title|body|label × large|medium|small */
@apply --m3-focus-inward;  /* or --m3-focus-none */
--m3-density(3rem);        /* density function */
--translucent(red, 0.38);  /* transparency function */
```

Buttons get press feedback with `class="m3-layer"` (`import "m3-svelte/etc/layer"` if needed).

## Expressive menus

Rich, animated menus with CSS anchor positioning, labels, submenus, groups, dividers, and a "vibrant" tertiary-color mode.

### Menu

```svelte
<script lang="ts">
    import {
        ExpressiveMenu,
        ExpressiveMenuGroup,
        ExpressiveMenuItem,
        MenuDivider,
    } from "m3-svelte";
    import iconEdit from "@ktibow/iconset-material-symbols/edit";
    import iconShare from "@ktibow/iconset-material-symbols/share";
    import iconDelete from "@ktibow/iconset-material-symbols/delete";

    let open = $state(false);
</script>

<button style="anchor-name: --m3-menu-anchor" onclick={() => (open = !open)}
    >Open menu</button
>

{#if open}
    <ExpressiveMenu anchored x="start" y="down" label="Actions" vibrant>
        <ExpressiveMenuItem
            leadingIcon={iconEdit}
            label="Edit"
            onclick={() => (open = false)}
        />
        <ExpressiveMenuItem leadingIcon={iconShare} label="Share" />
        <ExpressiveMenuGroup>
            <ExpressiveMenuItem label="First" selected />
            <ExpressiveMenuItem label="Second" />
        </ExpressiveMenuGroup>
        <MenuDivider />
        <ExpressiveMenuItem leadingIcon={iconDelete} label="Delete" />
    </ExpressiveMenu>
{/if}
```

### Submenu

```svelte
<script lang="ts">
    let submenuOpen = $state(false);
</script>

{#snippet submenu(o: boolean)}
    <ExpressiveMenu submenu y="down" open={o} x="start">
        <ExpressiveMenuItem label="Copy link" />
        <ExpressiveMenuItem label="Email" />
    </ExpressiveMenu>
{/snippet}

<ExpressiveMenuItem label="Share" bind:submenuOpen {submenu} />
```

### API

| Component                | Props                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExpressiveMenu`         | `children` (required), `vibrant`, `open` (default `true`), `submenu`, `anchored`, `label`, `x: "start"\|"end"`, `y: "down"\|"up"`                                                                         |
| `ExpressiveMenuItem`     | `leadingIcon`, `trailingIcon`, `disabled`, `selected`, `label` (required), `details`, `submenuOpen` (bindable), `badge` (snippet), `submenu` (snippet `(open: boolean)`), `trailing` (snippet), `onclick` |
| `ExpressiveMenuGroup`    | `children`                                                                                                                                                                                                |
| `MenuDivider`            | —                                                                                                                                                                                                         |
| `Menu` (legacy, patched) | `children`, `open`, `anchored`, `x`, `y`                                                                                                                                                                  |

### Positioning notes

- `anchored` / `submenu` uses CSS anchor positioning: the menu is `position: fixed` with `position-anchor: --m3-menu-anchor`. **Your trigger element must set `anchor-name: --m3-menu-anchor`** (submenus get this automatically from the parent item). Requires Chromium 125+.
- `x="start"` → `left: anchor(start)` · `x="end"` → `right: anchor(end)`
- `y="down"` → `top: anchor(end)` · `y="up"` → `bottom: anchor(start)`
- Enter animation: slide (200ms, `easeEmphasizedDecel`); exit: fade (100ms).
- `vibrant` recolors the menu (and nested submenus) with tertiary-container colors.
- To restyle menus, target `:global(.m3-container.expressive-menu)` and override `--m3-menuitem-text` / `--m3-menuitem-icon` / `--m3-menuitem-selected` / `--m3-menuitem-on-selected`.

## Other components (quick list)

- **Buttons**: `Button` (elevated/filled/tonal/outlined/text, sizes xs–xl, `iconType`), `ButtonGroup` (selected stadium pill, press-grow), `ConnectedButtons`, `SplitButton` (menu via `Menu`), `FAB`
- **Containers**: `Card`, `ListItem`, `Menu`/`MenuItem` (legacy), expressive menu family, `BottomSheet`, `Dialog`, `Snackbar` + `snackbar()`, `StandardSideSheet`, `Divider`
- **Inputs**: `Checkbox`, `RadioAnim1..3`, `Switch` (wrap in `<label>`), `Chip`, `Select`/`SelectOutlined`, `Slider`, `TextField*`, `TextFieldOutlined*`, `TextFieldMultiline*`, `DateField*`, `TimePickerDial`
- **Progress**: `LinearProgress`/`LinearProgressEstimate`, `WavyLinearProgress*`, `CircularProgress*`, `LoadingIndicator`
- **Navigation**: `Tabs`/`VariableTabs`, `NavCMLX`/`NavCMLXItem`, `NavigationRail`/`NavigationRailItem`
- **Extras**: `Icon` (Iconify), shape paths, `sharedAxisTransition`, `containerTransform`

See the m3-svelte README (`node_modules/m3-svelte/README.md`) or component sources (`node_modules/m3-svelte/package/containers/*.svelte`) for full demos.
