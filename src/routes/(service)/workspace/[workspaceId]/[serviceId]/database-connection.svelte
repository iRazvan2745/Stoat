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
        <div class="flex min-h-10 items-center justify-between gap-2">
            <h2 class="m3-font-title-small text-on-surface">Connection</h2>
        </div>
        <div class="flex justify-center py-2">
            <LoadingIndicator
                size={24}
                aria-label="Loading connection details"
            />
        </div>
    </Card>
{:else if connectionQuery.error}
    <Card variant="elevated">
        <div class="flex min-h-10 items-center justify-between gap-2">
            <h2 class="m3-font-title-small text-on-surface">Connection</h2>
        </div>
        <p class="m3-font-body-small text-error mt-2">
            {connectionQuery.error.message}
        </p>
    </Card>
{:else if connectionQuery.current}
    {@const connection = connectionQuery.current}
    <Card variant="elevated">
        <div class="flex min-h-10 items-center justify-between gap-2">
            <h2 class="m3-font-title-small text-on-surface">Connection</h2>

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

        <ul class="m-0 grid list-none gap-1 p-0">
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
            class="hover:bg-on-surface/8 focus-visible:bg-on-surface/8 focus-visible:outline-primary grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1 rounded-md border-0 bg-transparent px-1 py-2 text-left text-on-surface transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
            title={copyValue}
            aria-label="Copy {label}"
            aria-describedby="click-to-copy-hint"
            onclick={() => copyText(copyValue, label)}
        >
            <span class="m3-font-label-small text-on-surface-variant">
                {label}
            </span>
            <span
                class="text-on-surface-variant grid place-items-center"
                aria-hidden="true"
            >
                <Icon icon={contentCopyIcon} size={20} />
            </span>
            <span
                class="m3-font-body-small col-span-2 min-w-0 font-mono wrap-break-word"
            >
                {#each wrapUrlSegments(displayValue) as segment, index (index)}
                    {#if index > 0}<wbr />{/if}{segment}
                {:else}
                    —
                {/each}
            </span>
        </button>
    </li>
{/snippet}
