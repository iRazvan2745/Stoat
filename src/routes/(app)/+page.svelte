<script lang="ts">
    import addCircleIcon from "@ktibow/iconset-material-symbols/add-circle-outline";
    import arrowForwardIcon from "@ktibow/iconset-material-symbols/arrow-forward";
    import checkCircleIcon from "@ktibow/iconset-material-symbols/check-circle-outline";
    import computerIcon from "@ktibow/iconset-material-symbols/computer-outline";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import deployedCodeIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import errorIcon from "@ktibow/iconset-material-symbols/error-outline";
    import historyIcon from "@ktibow/iconset-material-symbols/history";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import warningIcon from "@ktibow/iconset-material-symbols/warning-outline";
    import workspacesIcon from "@ktibow/iconset-material-symbols/workspaces-outline";
    import { Button, Card, Icon, LoadingIndicator } from "m3-svelte";

    import { listOrganizationMachines } from "#lib/api/cluster/machines.remote";
    import { getOverview } from "#lib/api/overview.remote";
    import { presentWorkspaceDataSource } from "#lib/shared/ui/data-source-display";

    const overview = getOverview();
    const machines = listOrganizationMachines();

    const healthyMachineStates = new Set([
        "active",
        "healthy",
        "online",
        "ready",
        "running",
        "up",
    ]);
    const unhealthyMachineStates = new Set([
        "error",
        "failed",
        "offline",
        "stopped",
    ]);

    const machineItems = $derived(machines.current?.items ?? []);
    const onlineMachineCount = $derived(
        machineItems.filter(({ machine }) =>
            healthyMachineStates.has(machine.state.toLowerCase())
        ).length
    );
    const unhealthyMachines = $derived(
        machineItems.filter(({ machine }) =>
            unhealthyMachineStates.has(machine.state.toLowerCase())
        )
    );
    const disconnectedDataSources = $derived(
        machines.current?.dataSources.filter(
            (source) => source.status === "error"
        ) ?? []
    );
    const machineHealthLoading = $derived(
        machines.loading && !machines.current
    );
    const attentionCount = $derived(
        (overview.current?.failedDeploymentCount ?? 0) +
            unhealthyMachines.length +
            disconnectedDataSources.length
    );

    const refresh = async (): Promise<void> => {
        await Promise.all([overview.refresh(), machines.refresh()]);
    };

    const plural = (
        count: number,
        singular: string,
        pluralForm = `${singular}s`
    ): string => (count === 1 ? singular : pluralForm);

    const deploymentLabel = (deployment: {
        finishedAt: Date | null;
        outcome: string | null;
    }): string => {
        if (!deployment.finishedAt) {
            return "In progress";
        }

        switch (deployment.outcome) {
            case "success": {
                return "Deployed";
            }

            case "failed": {
                return "Failed";
            }

            case "cancelled": {
                return "Cancelled";
            }

            default: {
                return "Finished";
            }
        }
    };

    const deploymentClasses = (deployment: {
        finishedAt: Date | null;
        outcome: string | null;
    }): string => {
        if (!deployment.finishedAt) {
            return "bg-secondary-container text-on-secondary-container";
        }

        if (deployment.outcome === "success") {
            return "bg-primary-container text-on-primary-container";
        }

        if (deployment.outcome === "failed") {
            return "bg-error-container text-on-error-container";
        }

        return "bg-surface-container-high text-on-surface-variant";
    };

    const formatTime = (value: Date): string =>
        new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(value);

    const interactiveRow = "m3-layer overview-row";
    const iconCircle =
        "inline-flex shrink-0 items-center justify-center rounded-full";
    const listRow = `flex min-h-[4.25rem] items-center gap-3 border-b border-outline-variant px-4 py-3 text-inherit no-underline transition-colors last:border-b-0 ${interactiveRow}`;
    const emptyRow = "flex min-h-32 items-center gap-3 p-5";
    const sectionHeading = "min-h-16 px-1 pt-1 pb-3";
    const summaryMetric = `flex min-w-0 items-center gap-3 border-l border-outline-variant p-4 text-inherit no-underline transition-colors max-[74rem]:first:border-l-0 max-[56rem]:nth-[3]:border-l-0 max-[56rem]:nth-[n+3]:border-t max-[40rem]:border-t max-[40rem]:border-l-0 ${interactiveRow}`;
</script>

<div class="mx-auto max-w-l pt-2 pb-8">
    <header class="flex flex-wrap items-start justify-between gap-4">
        <h1 class="m3-font-headline-medium text-on-surface mt-1">
            Overview
        </h1>

        <Button
            variant="tonal"
            iconType="left"
            disabled={overview.loading || machines.loading}
            onclick={refresh}
        >
            <Icon icon={refreshIcon} size={18} />
            Refresh
        </Button>
    </header>

    {#if overview.loading && !overview.current}
        <div class="grid min-h-64 place-items-center">
            <LoadingIndicator aria-label="Loading overview" />
        </div>
    {:else if overview.error}
        <div class="mt-6">
            <Card variant="outlined">
                <div class="flex items-start gap-3 p-5" role="alert">
                    <span
                        class="bg-error-container text-on-error-container rounded-full p-2"
                    >
                        <Icon icon={errorIcon} size={20} />
                    </span>
                    <div>
                        <h2 class="m3-font-title-medium text-on-surface">
                            Overview unavailable
                        </h2>
                        <p class="text-error m3-font-body-medium mt-1">
                            {overview.error.message}
                        </p>
                    </div>
                </div>
            </Card>
        </div>
    {:else if overview.current}
        {@const summary = overview.current}

        {#if summary.dataSourceCount === 0}
            <section class="mt-6" aria-labelledby="getting-started-title">
                <Card variant="filled" id="getting-started-card">
                    <div class="flex items-center gap-4">
                        <span
                            class="bg-primary-container text-on-primary-container rounded-full p-3"
                        >
                            <Icon icon={addCircleIcon} size={28} />
                        </span>
                        <div>
                            <h2
                                id="getting-started-title"
                                class="m3-font-title-large text-on-surface"
                            >
                                Connect your first cluster
                            </h2>
                            <p
                                class="text-on-surface-variant m3-font-body-medium mt-1 max-w-m"
                            >
                                Add a data source, create a workspace, then
                                deploy a resource.
                            </p>
                        </div>
                    </div>
                    <Button
                        href="/data-sources?createDialogOpen=true"
                        iconType="left"
                    >
                        <Icon icon={databaseIcon} size={18} />
                        Add data source
                    </Button>
                </Card>
            </section>
        {/if}

        <section class="mt-6" aria-label="Organization summary">
            <Card variant="filled" id="summary-card">
                <a
                    href="#attention"
                    class={[
                        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 p-5 text-inherit no-underline transition-colors",
                        attentionCount > 0
                            ? "bg-error-container-subtle text-on-error-container"
                            : "bg-primary-container-subtle",
                        interactiveRow,
                    ]}
                >
                    <span
                        class={[
                            iconCircle,
                            "size-11",
                            attentionCount > 0
                                ? "bg-error-container text-on-error-container"
                                : "bg-primary-container text-on-primary-container",
                        ]}
                    >
                        <Icon
                            icon={attentionCount > 0
                                ? warningIcon
                                : checkCircleIcon}
                            size={28}
                        />
                    </span>
                    <strong class="m3-font-title-medium truncate">
                        {#if machineHealthLoading}
                            Checking cluster health…
                        {:else if attentionCount > 0}
                            {attentionCount}
                            {plural(attentionCount, "item")}
                            {attentionCount === 1 ? "needs" : "need"} attention
                        {:else}
                            Everything looks good
                        {/if}
                    </strong>
                    <Icon icon={arrowForwardIcon} size={20} aria-hidden="true" />
                </a>

                <div
                    class="max-[74rem]:border-outline-variant grid grid-cols-4 max-[74rem]:border-t max-[56rem]:grid-cols-2 max-[40rem]:grid-cols-1"
                >
                    <a href="/workspace" class={summaryMetric}>
                        <span
                            class="{iconCircle} bg-primary-container text-on-primary-container size-10"
                        >
                            <Icon icon={workspacesIcon} size={20} />
                        </span>
                        <span class="flex min-w-0 flex-col">
                            <strong
                                class="m3-font-title-large"
                                >{summary.workspaces.length}</strong
                            >
                            <span
                                class="text-on-surface-variant mt-1 truncate m3-font-body-small"
                                >{plural(
                                    summary.workspaces.length,
                                    "Workspace"
                                )}</span
                            >
                        </span>
                    </a>

                    <a href="/workspace" class={summaryMetric}>
                        <span
                            class="{iconCircle} bg-secondary-container text-on-secondary-container size-10"
                        >
                            <Icon icon={deployedCodeIcon} size={20} />
                        </span>
                        <span class="flex min-w-0 flex-col">
                            <strong
                                class="m3-font-title-large"
                                >{summary.resourceCount}</strong
                            >
                            <span
                                class="text-on-surface-variant mt-1 truncate m3-font-body-small"
                                >{plural(summary.resourceCount, "Resource")}</span
                            >
                        </span>
                    </a>

                    <a href="/data-sources" class={summaryMetric}>
                        <span
                            class="{iconCircle} bg-tertiary-container text-on-tertiary-container size-10"
                        >
                            <Icon icon={databaseIcon} size={20} />
                        </span>
                        <span class="flex min-w-0 flex-col">
                            <strong
                                class="m3-font-title-large"
                                >{summary.dataSourceCount}</strong
                            >
                            <span
                                class="text-on-surface-variant mt-1 truncate m3-font-body-small"
                                >{plural(
                                    summary.dataSourceCount,
                                    "Data source"
                                )}</span
                            >
                        </span>
                    </a>

                    <a href="/machines" class={summaryMetric}>
                        <span
                            class="{iconCircle} bg-surface-container-high text-on-surface-variant size-10"
                        >
                            <Icon icon={computerIcon} size={20} />
                        </span>
                        <span class="flex min-w-0 flex-col">
                            {#if machines.loading && !machines.current}
                                <LoadingIndicator
                                    aria-label="Loading machine count"
                                />
                            {:else}
                                <strong
                                    class="m3-font-title-large"
                                    >{onlineMachineCount}/{machineItems.length}</strong
                                >
                            {/if}
                            <span
                                class="text-on-surface-variant mt-1 truncate m3-font-body-small"
                                >Machines online</span
                            >
                        </span>
                    </a>
                </div>
            </Card>
        </section>

        <div
            class="mt-6 grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-4 max-[56rem]:grid-cols-1"
        >
            <section id="attention" aria-labelledby="attention-title">
                <div class={sectionHeading}>
                    <div>
                        <h2 id="attention-title" class="m3-font-title-large">
                            Needs attention
                        </h2>
                        <p class="text-on-surface-variant mt-0.5 m3-font-body-small">
                            Problems worth checking now
                        </p>
                    </div>
                </div>

                <Card variant="outlined" id="attention-card">
                    {#if machineHealthLoading}
                        <div class={emptyRow} role="status">
                            <LoadingIndicator
                                aria-label="Checking cluster health"
                            />
                            <p class="text-on-surface-variant m3-font-body-medium">
                                Checking cluster health…
                            </p>
                        </div>
                    {:else if machines.error}
                        <a href="/machines" class={listRow}>
                            <span
                                class="{iconCircle} bg-error-container text-on-error-container size-9"
                            >
                                <Icon icon={errorIcon} size={20} />
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="m3-font-label-large block"
                                    >Cluster health unavailable</span
                                >
                                <span
                                    class="text-on-surface-variant block truncate m3-font-body-small"
                                >
                                    {machines.error.message}
                                </span>
                            </span>
                            <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                        </a>
                    {:else if attentionCount === 0}
                        <div class={emptyRow}>
                            <span
                                class="{iconCircle} bg-primary-container text-on-primary-container size-9"
                            >
                                <Icon icon={checkCircleIcon} size={20} />
                            </span>
                            <div>
                                <p class="m3-font-label-large">
                                    Everything looks good
                                </p>
                                <p
                                    class="text-on-surface-variant mt-0.5 m3-font-body-small"
                                >
                                    No failed deployments or cluster problems
                                    found.
                                </p>
                            </div>
                        </div>
                    {:else}
                        {#if summary.failedDeploymentCount > 0}
                            <a href="#recent-activity" class={listRow}>
                                <span
                                    class="{iconCircle} bg-error-container text-on-error-container size-9"
                                >
                                    <Icon icon={deployedCodeIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span class="m3-font-label-large block">
                                        {summary.failedDeploymentCount}
                                        {plural(
                                            summary.failedDeploymentCount,
                                            "resource"
                                        )} with a failed deployment
                                    </span>
                                    <span
                                        class="text-on-surface-variant block m3-font-body-small"
                                        >Review recent deployment activity</span
                                    >
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                            </a>
                        {/if}

                        {#each disconnectedDataSources as source (source.dataSourceId)}
                            <a href="/data-sources" class={listRow}>
                                <span
                                    class="{iconCircle} bg-error-container text-on-error-container size-9"
                                >
                                    <Icon icon={databaseIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="m3-font-label-large block truncate"
                                        >{source.label}</span
                                    >
                                    <span
                                        class="text-on-surface-variant block truncate m3-font-body-small"
                                    >
                                        {source.error ??
                                            "Data source is unreachable"}
                                    </span>
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                            </a>
                        {/each}

                        {#each unhealthyMachines as item (`${item.dataSourceId}:${item.machine.id}`)}
                            <a href="/machines" class={listRow}>
                                <span
                                    class="{iconCircle} bg-error-container text-on-error-container size-9"
                                >
                                    <Icon icon={computerIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="m3-font-label-large block truncate"
                                        >{item.machine.name}</span
                                    >
                                    <span
                                        class="text-on-surface-variant block m3-font-body-small"
                                    >
                                        Machine is {item.machine.state.toLowerCase()}
                                    </span>
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                            </a>
                        {/each}
                    {/if}
                </Card>
            </section>

            <section id="recent-activity" aria-labelledby="activity-title">
                <div class={sectionHeading}>
                    <div>
                        <h2 id="activity-title" class="m3-font-title-large">
                            Recent activity
                        </h2>
                        <p class="text-on-surface-variant mt-0.5 m3-font-body-small">
                            Latest deployments across your workspaces
                            {#if summary.activeDeploymentCount > 0}
                                · {summary.activeDeploymentCount} active
                            {/if}
                        </p>
                    </div>
                </div>

                <Card variant="outlined" id="activity-card">
                    {#if summary.recentDeployments.length === 0}
                        <div class={emptyRow}>
                            <span
                                class="{iconCircle} bg-surface-container-high text-on-surface-variant size-9"
                            >
                                <Icon icon={historyIcon} size={20} />
                            </span>
                            <div>
                                <p class="m3-font-label-large">
                                    No deployments yet
                                </p>
                                <p
                                    class="text-on-surface-variant mt-0.5 m3-font-body-small"
                                >
                                    Deployment activity will appear here.
                                </p>
                            </div>
                        </div>
                    {:else}
                        {#each summary.recentDeployments as deployment (deployment.id)}
                            <a
                                href={`/workspace/${deployment.workspaceId}/${deployment.resourceId}/deployments?view=${deployment.id}`}
                                class={listRow}
                            >
                                <span
                                    class={[
                                        iconCircle,
                                        "size-9",
                                        deploymentClasses(deployment),
                                    ]}
                                >
                                    <Icon
                                        icon={deployment.outcome === "failed"
                                            ? errorIcon
                                            : deployedCodeIcon}
                                        size={18}
                                    />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="m3-font-label-large block truncate"
                                    >
                                        {deployment.resourceName ??
                                            "Unnamed resource"}
                                    </span>
                                    <span
                                        class="text-on-surface-variant block truncate m3-font-body-small"
                                    >
                                        {deployment.workspaceName ??
                                            "Workspace"} · {formatTime(
                                            deployment.createdAt
                                        )}
                                    </span>
                                </span>
                                <span
                                    class="text-on-surface-variant m3-font-label-medium shrink-0"
                                >
                                    {deploymentLabel(deployment)}
                                </span>
                            </a>
                        {/each}
                    {/if}
                </Card>
            </section>
        </div>

        <section class="mt-6" aria-labelledby="workspaces-title">
            <div
                class="flex min-h-16 items-center justify-between gap-4 px-1 pt-1 pb-3"
            >
                <div>
                    <h2 id="workspaces-title" class="m3-font-title-large">
                        Workspaces
                    </h2>
                    <p class="text-on-surface-variant mt-0.5 m3-font-body-small">
                        Your most recently updated environments
                    </p>
                </div>
                <Button href="/workspace" variant="text" iconType="left">
                    View all
                    <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                </Button>
            </div>

            {#if summary.workspaces.length === 0}
                <Card variant="outlined">
                    <div class="p-8 text-center">
                        <span
                            class="{iconCircle} bg-primary-container text-on-primary-container size-12"
                        >
                            <Icon icon={workspacesIcon} size={24} />
                        </span>
                        <h3 class="m3-font-title-medium mt-3">
                            Create your first workspace
                        </h3>
                        <p class="text-on-surface-variant m3-font-body-medium mt-1">
                            Workspaces organize the resources deployed to a data
                            source.
                        </p>
                        <div class="mt-4">
                            <Button
                                href="/workspace?createWorkspaceDialogOpen=true"
                            >
                                Create workspace
                            </Button>
                        </div>
                    </div>
                </Card>
            {:else}
                <Card variant="filled" id="workspaces-card">
                    {#each summary.workspaces.slice(0, 6) as item (item.id)}
                        <a
                            href={`/workspace/${item.id}`}
                            class={[
                                "border-outline-variant grid min-h-18 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 border-b px-4 py-3.5 text-inherit no-underline transition-colors last:border-b-0",
                                interactiveRow,
                            ]}
                        >
                            <span
                                class="text-primary inline-flex size-9 items-center justify-center"
                            >
                                <Icon icon={workspacesIcon} size={20} />
                            </span>
                            <span class="flex min-w-0 flex-col overflow-hidden">
                                <span
                                    class="m3-font-label-large truncate"
                                >
                                    {item.name ?? item.slug}
                                </span>
                                <span
                                    class="text-on-surface-variant mt-0.5 flex min-w-0 items-center gap-1.5 m3-font-body-small"
                                >
                                    <span>
                                        {item.resourceCount}
                                        {plural(item.resourceCount, "resource")}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span
                                        class="flex min-w-0 items-center gap-1 overflow-hidden"
                                    >
                                        <Icon icon={databaseIcon} size={14} />
                                        <span class="truncate"
                                            >{presentWorkspaceDataSource(
                                                item
                                            )}</span
                                        >
                                    </span>
                                </span>
                            </span>
                            <Icon icon={arrowForwardIcon} size={18} aria-hidden="true" />
                        </a>
                    {/each}
                </Card>
            {/if}
        </section>
    {/if}
</div>

<style>
    :global(#getting-started-card.m3-container) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
        padding: 1.5rem;
        border-radius: var(--m3-shape-extra-large);
        background: var(--m3c-primary-container-subtle);
    }

    :global(#summary-card.m3-container) {
        display: grid;
        grid-template-columns: minmax(15rem, 0.72fr) minmax(32rem, 1.6fr);
        overflow: hidden;
        padding: 0;
        border-radius: var(--m3-shape-extra-large);
        background: var(--m3c-surface-container-low);
    }

    :global(#attention-card.m3-container),
    :global(#activity-card.m3-container) {
        min-height: 13rem;
        padding: 0;
        overflow: hidden;
    }

    :global(#workspaces-card.m3-container) {
        overflow: hidden;
        padding: 0;
        border-radius: var(--m3-shape-large);
        background: var(--m3c-surface-container-low);
    }

    .overview-row {
        @apply --m3-focus-inward;
    }

    @media (max-width: 74rem) {
        :global(#summary-card.m3-container) {
            grid-template-columns: minmax(0, 1fr);
        }
    }

    @media (max-width: 40rem) {
        :global(#getting-started-card.m3-container) {
            align-items: stretch;
            flex-direction: column;
        }
    }
</style>
