<script lang="ts">
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import { Card, Icon, LoadingIndicator } from "m3-svelte";

    import type { DeploymentLogRecord } from "#lib/deployment-logs";

    import type { Deployment } from "./deployment";
    import DeploymentRow from "./deployment-row.svelte";

    interface Props {
        actionsMenuOpenFor: string | null;
        deployments: Deployment[];
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
{:else if deployments.length === 0}
    <Card variant="elevated">
        <div class="px-6 py-10 text-center">
            <div
                class="bg-secondary-container text-on-secondary-container mx-auto mb-3 flex size-12 items-center justify-center rounded-xl"
            >
                <Icon icon={deploymentsIcon} size={36} />
            </div>

            <p class="text-on-surface text-sm font-medium">
                No deployments yet
            </p>

            <p class="text-on-surface-variant mx-auto mt-1 max-w-sm text-sm">
                Deployments for this service will appear here once one has been
                created.
            </p>
        </div>
    </Card>
{:else}
    <section
        class="bg-surface-container-low rounded-[20px]"
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
