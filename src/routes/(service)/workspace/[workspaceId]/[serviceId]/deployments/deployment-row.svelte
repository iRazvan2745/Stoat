<script lang="ts">
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import { Button, Icon, LoadingIndicator } from "m3-svelte";

    import type { DeploymentLogRecord } from "#lib/deployments/logs";

    import type { Deployment } from "./deployment";
    import {
        formatDate,
        getDisplayStatus,
        getDuration,
        getShortId,
        getStatusClasses,
        getStatusLabel,
    } from "./deployment";

    interface Props {
        actionsMenuOpen: boolean;
        deployment: Deployment;
        logs?: DeploymentLogRecord[];
        logsLoading: boolean;
        onOpenLogs: (deploymentId: string) => void;
        onToggleActions: (deploymentId: string) => void;
    }

    let {
        actionsMenuOpen,
        deployment,
        logs,
        logsLoading,
        onOpenLogs,
        onToggleActions,
    }: Props = $props();

    const displayStatus = $derived(getDisplayStatus(deployment, logs));
    const duration = $derived(getDuration(deployment));
    const statusClasses = $derived(getStatusClasses(displayStatus));
</script>

<article
    class="border-outline-variant/40 flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:px-5"
>
    <div class="flex min-w-0 flex-1 items-center gap-3">
        <div
            class="flex size-9 shrink-0 items-center justify-center rounded-[14px] {statusClasses}"
        >
            <Icon icon={deploymentsIcon} size={20} />
        </div>

        <div class="flex min-w-0 flex-1 flex-row gap-2 sm:items-center">
            <div>
                <div class="flex min-w-0 items-baseline gap-1.5 sm:w-56">
                    <span class="text-on-surface text-sm font-medium">
                        Deployment
                    </span>

                    <span
                        class="text-on-surface-variant truncate font-mono text-xs"
                    >
                        #{getShortId(deployment.id)}
                    </span>
                </div>

                <span class="text-on-surface-variant text-xs sm:flex-1">
                    {formatDate(deployment.createdAt)}
                </span>
            </div>

            <div class="flex shrink-0 items-center gap-2">
                <span
                    class="rounded-full px-2.5 py-1 text-xs font-medium {statusClasses}"
                >
                    {getStatusLabel(displayStatus)}
                </span>

                {#if duration}
                    <span
                        class="text-on-surface-variant min-w-8 text-right text-xs tabular-nums"
                    >
                        {duration}
                    </span>
                {/if}
            </div>
        </div>
    </div>

    <div class="flex shrink-0 items-center gap-2">
        <Button
            disabled={logsLoading}
            aria-busy={logsLoading}
            onclick={() => onOpenLogs(deployment.id)}
        >
            {#if logsLoading}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Loading deployment logs"
                />
                Loading...
            {:else}
                View logs
            {/if}
        </Button>

        <span
            class="relative inline-flex"
            data-deployment-actions-trigger
            style={actionsMenuOpen
                ? "anchor-name: --m3-menu-anchor"
                : undefined}
        >
            <Button
                variant="text"
                square
                aria-label="Deployment actions"
                aria-expanded={actionsMenuOpen}
                aria-haspopup="menu"
                onclick={() => onToggleActions(deployment.id)}
            >
                <Icon icon={moreVertIcon} />
            </Button>
        </span>
    </div>
</article>
