<script lang="ts">
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import { Card, Icon, LoadingIndicator } from "m3-svelte";

    import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";

    import type { Deployment } from "./deployment";
    import DeploymentRow from "./deployment-row.svelte";

    interface Props {
        actionsMenuOpenFor: string | null;
        deployments: Deployment[];
        error?: { message: string } | null;
        loading: boolean;
        logs: DeploymentLogRecord[];
        logsLoadingFor: string | null;
        onOpenLogs: (deploymentId: string) => void;
        onToggleActions: (deploymentId: string) => void;
        selectedDeploymentId: string;
    }

    let {
        actionsMenuOpenFor,
        deployments,
        error,
        loading,
        logs,
        logsLoadingFor,
        onOpenLogs,
        onToggleActions,
        selectedDeploymentId,
    }: Props = $props();
</script>

{#if loading}
    <Card variant="elevated">
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading deployments" />
        </div>
    </Card>
{:else if error}
    <Card variant="elevated">
        <p class="text-error m3-font-body-medium p-6" role="alert">{error.message}</p>
    </Card>
{:else if deployments.length === 0}
    <Card variant="elevated">
        <div class="px-6 py-10 text-center">
            <div
                class="bg-secondary-container text-on-secondary-container mx-auto mb-3 flex size-12 items-center justify-center rounded-xl"
            >
                <Icon icon={deploymentsIcon} size={36} />
            </div>

            <p class="m3-font-label-large text-on-surface">
                No deployments yet
            </p>

            <p class="text-on-surface-variant m3-font-body-medium mx-auto mt-1 max-w-m">
                Deployments for this resource will appear here once one has been
                created.
            </p>
        </div>
    </Card>
{:else}
    <section
        class="bg-surface-container-low rounded-li"
        aria-label="Deployment history"
    >
        {#each deployments as deployment (deployment.id)}
            <DeploymentRow
                {deployment}
                actionsMenuOpen={actionsMenuOpenFor === deployment.id}
                logs={selectedDeploymentId === deployment.id ? logs : undefined}
                logsLoading={logsLoadingFor === deployment.id}
                {onOpenLogs}
                {onToggleActions}
            />
        {/each}
    </section>
{/if}
