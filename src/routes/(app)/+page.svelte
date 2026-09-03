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
</script>

<div class="overview-page">
    <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
            <h1
                class="text-on-surface mt-1 text-3xl font-medium tracking-tight"
            >
                Overview
            </h1>
            <p class="text-on-surface-variant mt-2 max-w-2xl text-sm">
                Your services, deployments, and cluster health at a glance.
            </p>
        </div>

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
                        <h2 class="text-on-surface font-medium">
                            Overview unavailable
                        </h2>
                        <p class="text-error mt-1 text-sm">
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
                    <div class="getting-started-copy">
                        <span
                            class="bg-primary-container text-on-primary-container rounded-full p-3"
                        >
                            <Icon icon={addCircleIcon} size={28} />
                        </span>
                        <div>
                            <h2
                                id="getting-started-title"
                                class="text-on-surface text-xl font-medium"
                            >
                                Connect your first cluster
                            </h2>
                            <p
                                class="text-on-surface-variant mt-1 max-w-xl text-sm"
                            >
                                Add a data source, create a workspace, then
                                deploy a service.
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

        <section class="summary-grid mt-6" aria-label="Organization summary">
            <a href="/workspace" class="summary-card">
                <Card variant="filled">
                    <span class="summary-icon primary">
                        <Icon icon={workspacesIcon} size={24} />
                    </span>
                    <span class="summary-value"
                        >{summary.workspaces.length}</span
                    >
                    <span class="summary-label">
                        {plural(summary.workspaces.length, "Workspace")}
                    </span>
                </Card>
            </a>

            <a href="/workspace" class="summary-card">
                <Card variant="filled">
                    <span class="summary-icon secondary">
                        <Icon icon={deployedCodeIcon} size={24} />
                    </span>
                    <span class="summary-value">{summary.serviceCount}</span>
                    <span class="summary-label">
                        {plural(summary.serviceCount, "Service")}
                    </span>
                </Card>
            </a>

            <a href="/machines" class="summary-card">
                <Card variant="filled">
                    <span class="summary-icon tertiary">
                        <Icon icon={computerIcon} size={24} />
                    </span>
                    {#if machines.loading && !machines.current}
                        <LoadingIndicator aria-label="Loading machine count" />
                    {:else}
                        <span class="summary-value">
                            {onlineMachineCount}/{machineItems.length}
                        </span>
                    {/if}
                    <span class="summary-label">Machines online</span>
                </Card>
            </a>

            <a href="#attention" class="summary-card">
                <Card variant="filled">
                    <span
                        class:attention={attentionCount > 0}
                        class="summary-icon neutral"
                    >
                        <Icon
                            icon={attentionCount > 0
                                ? warningIcon
                                : checkCircleIcon}
                            size={24}
                        />
                    </span>
                    <span class="summary-value">{attentionCount}</span>
                    <span class="summary-label">Needs attention</span>
                </Card>
            </a>
        </section>

        <div class="dashboard-grid mt-6">
            <section id="attention" aria-labelledby="attention-title">
                <div class="section-heading">
                    <div>
                        <h2 id="attention-title">Needs attention</h2>
                        <p>Problems worth checking now</p>
                    </div>
                </div>

                <Card variant="outlined" id="attention-card">
                    {#if machines.error}
                        <a href="/machines" class="attention-row">
                            <span class="status-icon error">
                                <Icon icon={errorIcon} size={20} />
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-sm font-medium"
                                    >Cluster health unavailable</span
                                >
                                <span
                                    class="text-on-surface-variant block truncate text-xs"
                                >
                                    {machines.error.message}
                                </span>
                            </span>
                            <Icon icon={arrowForwardIcon} size={18} />
                        </a>
                    {:else if attentionCount === 0}
                        <div class="empty-row">
                            <span class="status-icon success">
                                <Icon icon={checkCircleIcon} size={20} />
                            </span>
                            <div>
                                <p class="text-sm font-medium">
                                    Everything looks good
                                </p>
                                <p
                                    class="text-on-surface-variant mt-0.5 text-xs"
                                >
                                    No failed deployments or cluster problems
                                    found.
                                </p>
                            </div>
                        </div>
                    {:else}
                        {#if summary.failedDeploymentCount > 0}
                            <a href="#recent-activity" class="attention-row">
                                <span class="status-icon error">
                                    <Icon icon={deployedCodeIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span class="block text-sm font-medium">
                                        {summary.failedDeploymentCount}
                                        {plural(
                                            summary.failedDeploymentCount,
                                            "service"
                                        )} with a failed deployment
                                    </span>
                                    <span
                                        class="text-on-surface-variant block text-xs"
                                        >Review recent deployment activity</span
                                    >
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} />
                            </a>
                        {/if}

                        {#each disconnectedDataSources as source (source.dataSourceId)}
                            <a href="/data-sources" class="attention-row">
                                <span class="status-icon error">
                                    <Icon icon={databaseIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="block truncate text-sm font-medium"
                                        >{source.label}</span
                                    >
                                    <span
                                        class="text-on-surface-variant block truncate text-xs"
                                    >
                                        {source.error ??
                                            "Data source is unreachable"}
                                    </span>
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} />
                            </a>
                        {/each}

                        {#each unhealthyMachines as item (`${item.dataSourceId}:${item.machine.id}`)}
                            <a href="/machines" class="attention-row">
                                <span class="status-icon error">
                                    <Icon icon={computerIcon} size={20} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="block truncate text-sm font-medium"
                                        >{item.machine.name}</span
                                    >
                                    <span
                                        class="text-on-surface-variant block text-xs"
                                    >
                                        Machine is {item.machine.state.toLowerCase()}
                                    </span>
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} />
                            </a>
                        {/each}
                    {/if}
                </Card>
            </section>

            <section id="recent-activity" aria-labelledby="activity-title">
                <div class="section-heading">
                    <div>
                        <h2 id="activity-title">Recent activity</h2>
                        <p>
                            Latest deployments across your workspaces
                            {#if summary.activeDeploymentCount > 0}
                                · {summary.activeDeploymentCount} active
                            {/if}
                        </p>
                    </div>
                </div>

                <Card variant="outlined" id="activity-card">
                    {#if summary.recentDeployments.length === 0}
                        <div class="empty-row">
                            <span class="status-icon neutral">
                                <Icon icon={historyIcon} size={20} />
                            </span>
                            <div>
                                <p class="text-sm font-medium">
                                    No deployments yet
                                </p>
                                <p
                                    class="text-on-surface-variant mt-0.5 text-xs"
                                >
                                    Deployment activity will appear here.
                                </p>
                            </div>
                        </div>
                    {:else}
                        {#each summary.recentDeployments as deployment (deployment.id)}
                            <a
                                href={`/workspace/${deployment.workspaceId}/${deployment.serviceId}/deployments?view=${deployment.id}`}
                                class="activity-row"
                            >
                                <span
                                    class={[
                                        "deployment-state",
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
                                        class="block truncate text-sm font-medium"
                                    >
                                        {deployment.serviceName ??
                                            "Unnamed service"}
                                    </span>
                                    <span
                                        class="text-on-surface-variant block truncate text-xs"
                                    >
                                        {deployment.workspaceName ??
                                            "Workspace"} · {formatTime(
                                            deployment.createdAt
                                        )}
                                    </span>
                                </span>
                                <span
                                    class="text-on-surface-variant shrink-0 text-xs font-medium"
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
            <div class="section-heading workspaces-heading">
                <div>
                    <h2 id="workspaces-title">Workspaces</h2>
                    <p>Your most recently updated environments</p>
                </div>
                <Button href="/workspace" variant="text" iconType="left">
                    View all
                    <Icon icon={arrowForwardIcon} size={18} />
                </Button>
            </div>

            {#if summary.workspaces.length === 0}
                <Card variant="outlined">
                    <div class="empty-workspaces">
                        <span class="summary-icon primary">
                            <Icon icon={workspacesIcon} size={24} />
                        </span>
                        <h3 class="mt-3 font-medium">
                            Create your first workspace
                        </h3>
                        <p class="text-on-surface-variant mt-1 text-sm">
                            Workspaces organize the services deployed to a data
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
                <div class="workspace-grid">
                    {#each summary.workspaces.slice(0, 6) as item (item.id)}
                        <a
                            href={`/workspace/${item.id}`}
                            class="workspace-card"
                        >
                            <Card variant="elevated">
                                <span class="workspace-icon">
                                    <Icon icon={workspacesIcon} size={24} />
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium">
                                        {item.name ?? item.slug}
                                    </span>
                                    <span
                                        class="text-on-surface-variant mt-0.5 block truncate text-xs"
                                    >
                                        {item.serviceCount}
                                        {plural(item.serviceCount, "service")} · {item.dataSourceLabel}
                                    </span>
                                </span>
                                <Icon icon={arrowForwardIcon} size={18} />
                            </Card>
                        </a>
                    {/each}
                </div>
            {/if}
        </section>
    {/if}
</div>

<style>
    .overview-page {
        max-width: 96rem;
        margin-inline: auto;
        padding-block: 0.5rem 2rem;
    }

    .getting-started-copy {
        display: flex;
        align-items: center;
        gap: 1rem;
    }

    :global(#getting-started-card.m3-container) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
        padding: 1.5rem;
        border-radius: var(--m3-shape-extra-large);
        background: var(--m3c-primary-container-subtle);
    }

    .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
    }

    .summary-card {
        min-width: 0;
        color: inherit;
        text-decoration: none;
    }

    :global(.summary-card > .m3-container) {
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
        column-gap: 0.875rem;
        width: 100%;
        min-height: 7.75rem;
        padding: 1rem;
        border-radius: var(--m3-shape-large);
        background: var(--m3c-surface-container-low);
    }

    .summary-icon,
    .status-icon,
    .deployment-state,
    .workspace-icon {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        border-radius: var(--m3-shape-full);
    }

    .summary-icon {
        grid-row: 1 / 3;
        width: 3rem;
        height: 3rem;
        align-self: center;
    }

    .summary-icon.primary,
    .workspace-icon {
        color: var(--m3c-on-primary-container);
        background: var(--m3c-primary-container);
    }

    .summary-icon.secondary {
        color: var(--m3c-on-secondary-container);
        background: var(--m3c-secondary-container);
    }

    .summary-icon.tertiary {
        color: var(--m3c-on-tertiary-container);
        background: var(--m3c-tertiary-container);
    }

    .summary-icon.neutral {
        color: var(--m3c-on-surface-variant);
        background: var(--m3c-surface-container-high);
    }

    .summary-icon.attention {
        color: var(--m3c-on-error-container);
        background: var(--m3c-error-container);
    }

    .summary-value {
        align-self: end;
        font-size: 1.75rem;
        font-weight: 500;
        line-height: 1.1;
    }

    .summary-label {
        color: var(--m3c-on-surface-variant);
        align-self: start;
        margin-top: 0.25rem;
        font-size: 0.75rem;
    }

    .dashboard-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
        gap: 1rem;
    }

    .section-heading {
        min-height: 4rem;
        padding: 0.25rem 0.25rem 0.75rem;
    }

    .section-heading h2 {
        font-size: 1.125rem;
        font-weight: 500;
    }

    .section-heading p {
        color: var(--m3c-on-surface-variant);
        margin-top: 0.125rem;
        font-size: 0.75rem;
    }

    .workspaces-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    :global(#attention-card.m3-container),
    :global(#activity-card.m3-container) {
        min-height: 13rem;
        padding: 0;
        overflow: hidden;
    }

    .attention-row,
    .activity-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-height: 4.25rem;
        padding: 0.75rem 1rem;
        color: inherit;
        text-decoration: none;
        border-bottom: 1px solid var(--m3c-outline-variant);
        transition: background-color 150ms ease;
    }

    .attention-row:hover,
    .activity-row:hover {
        background: var(--m3c-surface-container-low);
    }

    .attention-row:last-child,
    .activity-row:last-child {
        border-bottom: 0;
    }

    .empty-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-height: 8rem;
        padding: 1.25rem;
    }

    .status-icon,
    .deployment-state {
        width: 2.25rem;
        height: 2.25rem;
    }

    .status-icon.error {
        color: var(--m3c-on-error-container);
        background: var(--m3c-error-container);
    }

    .status-icon.success {
        color: var(--m3c-on-primary-container);
        background: var(--m3c-primary-container);
    }

    .status-icon.neutral {
        color: var(--m3c-on-surface-variant);
        background: var(--m3c-surface-container-high);
    }

    .workspace-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
    }

    .workspace-card {
        min-width: 0;
        color: inherit;
        text-decoration: none;
    }

    :global(.workspace-card > .m3-container) {
        display: flex;
        align-items: center;
        gap: 0.875rem;
        width: 100%;
        min-width: 0;
        padding: 1rem;
        border-radius: var(--m3-shape-large);
    }

    .workspace-icon {
        width: 2.75rem;
        height: 2.75rem;
    }

    .empty-workspaces {
        padding: 2rem;
        text-align: center;
    }

    @media (max-width: 74rem) {
        .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .workspace-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @media (max-width: 56rem) {
        .dashboard-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }

    @media (max-width: 40rem) {
        :global(#getting-started-card.m3-container) {
            align-items: stretch;
            flex-direction: column;
        }

        .summary-grid,
        .workspace-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
