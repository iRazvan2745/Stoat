<script lang="ts">
    import contentCopyIcon from "@ktibow/iconset-material-symbols/content-copy-outline";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import { Button, Card, Icon, LoadingIndicator, Snackbar } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import { listOrganizationCaddyConfigs } from "#lib/api/cluster/caddy.remote";
    import type { OrganizationCaddyConfig } from "#lib/api/cluster/caddy.remote";
    import { copyToClipboard } from "#lib/shared/ui/clipboard";
    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    const caddy = listOrganizationCaddyConfigs();
    const result = $derived(caddy.current);
    const configs = $derived(result?.items ?? []);

    const selectedConfigKey = useQueryState(
        "config",
        parseAsString.withDefault(""),
    );

    const configKey = (item: OrganizationCaddyConfig): string =>
        `${item.dataSourceId}:${item.config.machineId}`;

    const selectedConfig = $derived.by(
        (): OrganizationCaddyConfig | undefined => {
            const selected = configs.find(
                (item) => configKey(item) === selectedConfigKey.current
            );

            return selected ?? configs[0];
        }
    );

    const selectedCaddyfile = $derived(selectedConfig?.config.caddyfile ?? "");

    const sourceLabel = (dataSourceId: string): string =>
        result?.dataSources.find(
            (source) => source.dataSourceId === dataSourceId
        )?.label ?? dataSourceId;

    const selectConfig = (item: OrganizationCaddyConfig): void => {
        void selectedConfigKey.set(configKey(item));
    };

    const copySelectedConfig = async (): Promise<void> => {
        if (!selectedCaddyfile) {
            return;
        }

        await copyToClipboard(selectedCaddyfile, {
            failure: "Unable to copy Caddyfile",
            success: "Caddyfile copied",
        });
    };
</script>

<div class="flex items-center justify-between gap-4 p-5">
    <div>
        <h1 class="text-on-surface text-lg font-medium">Caddy</h1>

        <p class="text-on-surface-variant mt-0.5 text-sm">
            Select a machine to view its Caddyfile.
        </p>
    </div>

    <Button variant="tonal" iconType="left" onclick={() => caddy.refresh()}>
        <Icon icon={refreshIcon} />
        Refresh
    </Button>
</div>

<Card variant="outlined" id="caddy-machines-card">
    {#if caddy.loading && !result}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading Caddy configurations" />
        </div>
    {:else if caddy.error}
        <div class="text-error p-6 text-sm">{caddy.error.message}</div>
    {:else if configs.length === 0}
        <div class="text-on-surface-variant px-5 py-10 text-center text-sm">
            No Caddy configurations are available.
        </div>
    {:else}
        <div class="overflow-x-auto">
            <table class="w-full min-w-[32rem] text-left">
                <thead
                    class="bg-surface-container-high text-on-surface-variant"
                >
                    <tr>
                        <th class="px-5 py-3 text-xs font-medium" scope="col">
                            Machine
                        </th>
                        <th class="px-5 py-3 text-xs font-medium" scope="col">
                            Data source
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {#each configs as item (configKey(item))}
                        <tr
                            class={[
                                "border-outline-variant border-t transition-colors",
                                selectedConfig === item
                                    ? "bg-primary-container-subtle"
                                    : "hover:bg-surface-container-low",
                            ]}
                        >
                            <td class="px-5 py-3">
                                <label
                                    class="text-on-surface flex cursor-pointer items-center gap-3"
                                >
                                    <input
                                        class="machine-selector size-4"
                                        type="radio"
                                        name="caddy-machine"
                                        value={configKey(item)}
                                        checked={selectedConfig === item}
                                        onchange={() => selectConfig(item)}
                                        aria-label={`Show Caddyfile for ${item.config.machineName}`}
                                    />
                                    <span class="min-w-0">
                                        <span
                                            class="block truncate text-sm font-medium"
                                        >
                                            {item.config.machineName}
                                        </span>
                                        <span
                                            class="text-on-surface-variant block truncate font-mono text-xs"
                                        >
                                            {item.config.machineId}
                                        </span>
                                    </span>
                                </label>
                            </td>
                            <td
                                class="text-on-surface-variant px-5 py-3 text-sm"
                            >
                                {sourceLabel(item.dataSourceId)}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</Card>

{#if selectedConfig}
    <div class="mt-4">
        <Card variant="outlined" id="caddyfile-card">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <h2 class="m3-font-title-small text-on-surface">
                        Caddyfile
                    </h2>
                    <p
                        class="text-on-surface-variant mt-0.5 truncate font-mono text-xs"
                    >
                        {selectedConfig.config.machineName}
                        <span aria-hidden="true"> · </span>
                        {selectedConfig.config.machineId}
                    </p>
                </div>

                <Button
                    variant="text"
                    size="s"
                    iconType="left"
                    disabled={!selectedCaddyfile}
                    onclick={copySelectedConfig}
                >
                    <Icon icon={contentCopyIcon} />
                    Copy
                </Button>
            </div>

            {#if selectedConfig.config.error}
                <p class="text-error m3-font-body-small mt-4" role="alert">
                    {selectedConfig.config.error}
                </p>
            {:else if selectedCaddyfile}
                <div
                    class="caddyfile-editor bg-surface-container-low mt-4 max-h-[70vh] overflow-auto rounded-lg border border-[var(--m3c-outline-variant)]"
                    aria-label={`Caddyfile for ${selectedConfig.config.machineName}`}
                >
                    {#key configKey(selectedConfig)}
                        <CodeMirror
                            value={selectedCaddyfile}
                            editable={false}
                            readonly
                            lineNumbers
                            foldGutter={false}
                            syntaxHighlighting={false}
                            extensions={codeMirrorSearchExtensions}
                            highlight={{
                                activeLine: false,
                                activeLineGutter: false,
                                selectionMatches: false,
                                specialChars: false,
                            }}
                            styles={{
                                "&": {
                                    backgroundColor:
                                        "var(--m3c-surface-container-low)",
                                    color: "var(--m3c-on-surface)",
                                    height: "auto",
                                },
                                ".cm-content": {
                                    minHeight: "0",
                                    padding: "1rem 0",
                                },
                                ".cm-gutters": {
                                    backgroundColor:
                                        "var(--m3c-surface-container-low)",
                                    borderRight:
                                        "1px solid var(--m3c-outline-variant)",
                                    color: "var(--m3c-on-surface-variant)",
                                },
                                ".cm-line": { padding: "0 1rem" },
                                ".cm-scroller": {
                                    fontFamily:
                                        "var(--m3-font-mono, ui-monospace, monospace)",
                                    height: "auto",
                                    overflow: "visible",
                                },
                            }}
                        />
                    {/key}
                </div>
            {:else}
                <p class="text-on-surface-variant m3-font-body-small mt-4">
                    No generated Caddyfile is available for this machine.
                </p>
            {/if}
        </Card>
    </div>
{/if}

<Snackbar />

<style>
    :global(#caddy-machines-card.m3-container) {
        padding: 0;
        overflow: hidden;
    }

    :global(#caddyfile-card.m3-container) {
        padding: 1rem;
    }

    .machine-selector {
        accent-color: var(--m3c-primary);
    }

    .caddyfile-editor :global(.codemirror-wrapper),
    .caddyfile-editor :global(.cm-editor) {
        height: auto;
        min-height: 0;
        color-scheme: inherit;
    }

    .caddyfile-editor :global(.cm-scroller) {
        height: auto !important;
        overflow: visible !important;
    }
</style>
