<script lang="ts">
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import errorIcon from "@ktibow/iconset-material-symbols/error-circle-rounded-outline";
    import { Button, Dialog, Icon, LoadingIndicator } from "m3-svelte";

    import type { DeploymentLogRecord } from "#lib/deployment-logs";

    import { isDeploymentActive } from "./deployment";
    import type { Deployment } from "./deployment";
    import DeploymentLogViewer from "./deployment-log-viewer.svelte";

    interface Props {
        cancelling: boolean;
        deleting: boolean;
        deployment: Deployment | undefined;
        error?: { message: string } | null;
        loading: boolean;
        logs: DeploymentLogRecord[];
        onCancel: (deploymentId: string) => void;
        onclose: () => void;
        onDelete: (deploymentId: string) => void;
        open: boolean;
    }

    let {
        cancelling,
        deleting,
        deployment,
        error,
        loading,
        logs,
        onCancel,
        onclose,
        onDelete,
        open,
    }: Props = $props();

    const deploymentIsActive = $derived(
        deployment ? isDeploymentActive(deployment, logs) : false
    );
</script>

<div class="max-w-none">
    <Dialog
        headline="Deployment Logs"
        id="deployment-logs-dialog"
        {open}
        {onclose}
    >
        {#if loading}
            <div
                class="flex min-h-40 flex-col items-center justify-center gap-3"
            >
                <LoadingIndicator aria-label="Loading logs" />

                <p class="text-on-surface-variant text-sm">Loading logs…</p>
            </div>
        {:else if error}
            <div
                class="bg-error-container-subtle text-on-error-container-subtle flex items-center gap-3 rounded-xl px-4 py-3"
                role="alert"
            >
                <Icon icon={errorIcon} size={20} />

                <p class="text-sm">{error.message}</p>
            </div>
        {:else if logs.length === 0}
            <div
                class="flex min-h-40 flex-col items-center justify-center text-center"
            >
                <div
                    class="bg-secondary-container text-on-secondary-container mb-3 flex size-10 items-center justify-center rounded-xl"
                >
                    <Icon icon={logsIcon} size={24} />
                </div>

                <p class="text-on-surface text-sm font-medium">No logs yet</p>

                <p class="text-on-surface-variant mt-1 max-w-xs text-sm">
                    Logs will appear here as the deployment runs.
                </p>
            </div>
        {:else}
            {#key deployment?.id}
                <DeploymentLogViewer
                    {deployment}
                    live={deploymentIsActive}
                    {logs}
                />
            {/key}
        {/if}

        {#snippet buttons()}
            {#if deployment && deploymentIsActive}
                <Button
                    variant="text"
                    disabled={cancelling}
                    onclick={() => onCancel(deployment.id)}
                >
                    Force cancel
                </Button>
            {/if}

            {#if deployment}
                <Button
                    variant="text"
                    disabled={deleting}
                    onclick={() => onDelete(deployment.id)}
                >
                    Delete
                </Button>
            {/if}

            <Button variant="tonal" onclick={onclose}>OK</Button>
        {/snippet}
    </Dialog>
</div>

<style>
    :global(#deployment-logs-dialog.m3-container) {
        width: min(70rem, calc(100vw - 2rem));
        max-width: none;
    }
</style>
