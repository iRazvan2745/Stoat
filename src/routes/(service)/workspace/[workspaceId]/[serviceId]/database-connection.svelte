<script lang="ts">
    import contentCopyIcon from "@ktibow/iconset-material-symbols/content-copy";
    import visibilityIcon from "@ktibow/iconset-material-symbols/visibility";
    import visibilityOffIcon from "@ktibow/iconset-material-symbols/visibility-off";
    import { Button, Card, Icon, LoadingIndicator } from "m3-svelte";

    import { getPostgresConnection } from "#lib/api/services.remote";
    import {
        maskPostgresUrl,
        wrapUrlSegments,
    } from "#lib/service/database-url";
    import { copyToClipboard } from "#lib/ui/clipboard";

    interface Props {
        serviceId: string;
    }

    let { serviceId }: Props = $props();

    const connectionQuery = $derived(getPostgresConnection(serviceId));
    let revealPassword = $state(false);

    const copyText = async (value: string, label: string): Promise<void> => {
        await copyToClipboard(value, {
            failure: `Unable to copy ${label.toLowerCase()}`,
            success: `${label} copied`,
        });
    };
</script>

<span id="click-to-copy-hint" class="sr-only">Click to copy</span>

{#if connectionQuery.loading}
    <Card variant="elevated">
        <div class="pane-bar">
            <h2 class="pane-title">Connection</h2>
        </div>
        <div class="pane-status">
            <LoadingIndicator
                size={24}
                aria-label="Loading connection details"
            />
        </div>
    </Card>
{:else if connectionQuery.error}
    <Card variant="elevated">
        <div class="pane-bar">
            <h2 class="pane-title">Connection</h2>
        </div>
        <p class="error-text">{connectionQuery.error.message}</p>
    </Card>
{:else if connectionQuery.current}
    {@const connection = connectionQuery.current}
    <Card variant="elevated">
        <div class="pane-bar">
            <h2 class="pane-title">Connection</h2>

            <Button
                variant="text"
                square
                aria-pressed={revealPassword}
                aria-label={revealPassword ? "Hide password" : "Show password"}
                onclick={() => (revealPassword = !revealPassword)}
            >
                <Icon
                    icon={revealPassword ? visibilityOffIcon : visibilityIcon}
                />
            </Button>
        </div>

        <ul class="url-list">
            {@render copyUrl(
                "Internal URL",
                maskPostgresUrl(connection.internal.url, revealPassword),
                connection.internal.url
            )}
            {#if connection.external}
                {@render copyUrl(
                    "External URL",
                    maskPostgresUrl(connection.external.url, revealPassword),
                    connection.external.url
                )}
            {/if}
        </ul>
    </Card>
{/if}

{#snippet copyUrl(label: string, displayValue: string, copyValue: string)}
    <li>
        <button
            type="button"
            class="url-row"
            title={copyValue}
            aria-label="Copy {label}"
            aria-describedby="click-to-copy-hint"
            onclick={() => copyText(copyValue, label)}
        >
            <span class="url-label">{label}</span>
            <span class="url-icon" aria-hidden="true">
                <Icon icon={contentCopyIcon} size={20} />
            </span>
            <span class="url-value">
                {#each wrapUrlSegments(displayValue) as segment, index (index)}
                    {#if index > 0}<wbr />{/if}{segment}
                {:else}
                    —
                {/each}
            </span>
        </button>
    </li>
{/snippet}

<style>
    .pane-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-height: 2.5rem;
    }

    .pane-title {
        @apply --m3-title-small;
        margin: 0;
        color: var(--m3c-on-surface);
    }

    .pane-status {
        display: flex;
        justify-content: center;
        padding: 0.5rem 0;
    }

    .error-text {
        @apply --m3-body-small;
        margin: 0.5rem 0 0;
        color: var(--m3c-error);
    }

    .url-list {
        display: grid;
        gap: 0.25rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .url-row {
        @apply --m3-focus-inward;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 2.5rem;
        grid-template-areas:
            "label copy"
            "value value";
        column-gap: 0.5rem;
        row-gap: 0.25rem;
        align-items: center;
        width: 100%;
        margin: 0;
        padding: 0.5rem 0.25rem;
        border: none;
        border-radius: var(--m3-shape-small);
        background: transparent;
        color: var(--m3c-on-surface);
        text-align: left;
        cursor: pointer;
    }

    .url-row:hover {
        background-color: color-mix(
            in srgb,
            var(--m3c-on-surface) 8%,
            transparent
        );
    }

    .url-label {
        @apply --m3-label-small;
        grid-area: label;
        color: var(--m3c-on-surface-variant);
    }

    .url-value {
        @apply --m3-body-small;
        grid-area: value;
        min-width: 0;
        overflow-wrap: break-word;
        font-family: var(--m3-font-mono, ui-monospace, monospace);
    }

    .url-icon {
        display: grid;
        grid-area: copy;
        color: var(--m3c-on-surface-variant);
        place-items: center;
    }
</style>
