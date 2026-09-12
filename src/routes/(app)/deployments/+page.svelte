<script lang="ts">
    import cancelIcon from "@ktibow/iconset-material-symbols/cancel";
    import checkCircleIcon from "@ktibow/iconset-material-symbols/check-circle-outline";
    import deployedCodeIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import errorIcon from "@ktibow/iconset-material-symbols/error-outline";
    import progressActivityIcon from "@ktibow/iconset-material-symbols/progress-activity";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import scheduleIcon from "@ktibow/iconset-material-symbols/schedule";
    import searchIcon from "@ktibow/iconset-material-symbols/search";
    import { Button, Card, Icon, TextFieldOutlined } from "m3-svelte";

    import { liveDeployments } from "#lib/api/deployments.remote";
    import type { DeploymentListItem } from "#lib/domain/deployments/records";

    type DeploymentStatus =
        | "cancelled"
        | "deployed"
        | "failed"
        | "pending"
        | "queued"
        | "started";
    type DeploymentFilter =
        | "active"
        | "all"
        | "cancelled"
        | "deployed"
        | "failed";

    interface DeploymentCounts {
        active: number;
        all: number;
        cancelled: number;
        deployed: number;
        failed: number;
    }

    const filterOptions: readonly {
        label: string;
        value: DeploymentFilter;
    }[] = [
        { label: "All", value: "all" },
        { label: "In progress", value: "active" },
        { label: "Deployed", value: "deployed" },
        { label: "Failed", value: "failed" },
        { label: "Cancelled", value: "cancelled" },
    ];
    const skeletonRows = [0, 1, 2, 3, 4];
    const dateFormatter = new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        year: "numeric",
    });

    const deployments = liveDeployments();
    let selectedFilter = $state<DeploymentFilter>("all");
    let searchQuery = $state("");

    function getDeploymentStatus(
        deployment: DeploymentListItem
    ): DeploymentStatus {
        if (deployment.outcome === "cancelled") {
            return "cancelled";
        }

        if (deployment.outcome === "failed") {
            return "failed";
        }

        if (deployment.finishedAt) {
            return "deployed";
        }

        if (deployment.startedAt) {
            return "started";
        }

        if (deployment.queuedAt) {
            return "queued";
        }

        return "pending";
    }

    function matchesFilter(
        status: DeploymentStatus,
        filter: DeploymentFilter
    ): boolean {
        if (filter === "all") {
            return true;
        }

        if (filter === "active") {
            return (
                status === "pending" ||
                status === "queued" ||
                status === "started"
            );
        }

        return status === filter;
    }

    function getStatusLabel(status: DeploymentStatus): string {
        switch (status) {
            case "deployed": {
                return "Deployed";
            }
            case "failed": {
                return "Failed";
            }
            case "cancelled": {
                return "Cancelled";
            }
            case "started": {
                return "Deploying";
            }
            case "queued": {
                return "Queued";
            }
            case "pending": {
                return "Pending";
            }
            default: {
                return "Pending";
            }
        }
    }

    function getStatusIcon(status: DeploymentStatus) {
        switch (status) {
            case "deployed": {
                return checkCircleIcon;
            }
            case "failed": {
                return errorIcon;
            }
            case "cancelled": {
                return cancelIcon;
            }
            case "started": {
                return progressActivityIcon;
            }
            case "queued":
            case "pending": {
                return scheduleIcon;
            }
            default: {
                return scheduleIcon;
            }
        }
    }

    function getStatusClasses(status: DeploymentStatus): string {
        switch (status) {
            case "deployed": {
                return "bg-primary-container text-on-primary-container";
            }
            case "failed": {
                return "bg-error-container-subtle text-on-error-container-subtle";
            }
            case "cancelled": {
                return "bg-surface-container-high text-on-surface-variant";
            }
            case "started": {
                return "bg-tertiary-container text-on-tertiary-container";
            }
            case "queued":
            case "pending": {
                return "bg-secondary-container text-on-secondary-container";
            }
            default: {
                return "bg-secondary-container text-on-secondary-container";
            }
        }
    }

    function getResourceLabel(deployment: DeploymentListItem): string {
        return (
            deployment.resourceName ??
            deployment.resourceSlug ??
            "Untitled resource"
        );
    }

    function getWorkspaceLabel(deployment: DeploymentListItem): string {
        return deployment.workspaceName ?? deployment.workspaceSlug;
    }

    function getSearchText(deployment: DeploymentListItem): string {
        return [
            deployment.id,
            deployment.gitCommit,
            deployment.resourceName,
            deployment.resourceSlug,
            deployment.workspaceName,
            deployment.workspaceSlug,
        ]
            .filter((value): value is string => Boolean(value))
            .join(" ")
            .toLowerCase();
    }

    function getDeploymentHref(deployment: DeploymentListItem): string {
        return `/workspace/${deployment.workspaceId}/${deployment.resourceId}/deployments?view=${encodeURIComponent(deployment.id)}`;
    }

    function getShortId(id: string): string {
        return id.slice(0, 7);
    }

    function formatDate(date: Date): string {
        return dateFormatter.format(date);
    }

    function formatDuration(deployment: DeploymentListItem): string {
        if (!deployment.startedAt) {
            return "Not started";
        }

        if (!deployment.finishedAt) {
            return "In progress";
        }

        const seconds = Math.max(
            0,
            Math.round(
                (deployment.finishedAt.getTime() -
                    deployment.startedAt.getTime()) /
                    1000
            )
        );

        if (seconds < 60) {
            return `${seconds}s`;
        }

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;

        return remainingSeconds
            ? `${minutes}m ${remainingSeconds}s`
            : `${minutes}m`;
    }

    const deploymentItems = $derived(deployments.current ?? []);
    const totalCount = $derived(deploymentItems.length);
    const counts = $derived.by(() => {
        const next: DeploymentCounts = {
            active: 0,
            all: deploymentItems.length,
            cancelled: 0,
            deployed: 0,
            failed: 0,
        };

        for (const deployment of deploymentItems) {
            const status = getDeploymentStatus(deployment);

            if (status === "deployed") {
                next.deployed += 1;
            } else if (status === "failed") {
                next.failed += 1;
            } else if (status === "cancelled") {
                next.cancelled += 1;
            } else {
                next.active += 1;
            }
        }

        return next;
    });
    const visibleDeployments = $derived.by(() => {
        const normalizedSearch = searchQuery.trim().toLowerCase();

        return deploymentItems.filter((deployment) => {
            const status = getDeploymentStatus(deployment);

            if (!matchesFilter(status, selectedFilter)) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            return getSearchText(deployment).includes(normalizedSearch);
        });
    });

    function getFilterCount(filter: DeploymentFilter): number {
        return counts[filter];
    }

    const reconnect = async (): Promise<void> => {
        await deployments.reconnect();
    };
</script>

<svelte:head>
    <title>Deployments | Stoat</title>
</svelte:head>

<div class="mx-auto max-w-[90rem] pb-8">
    <header class="flex flex-wrap items-start justify-between gap-4 pt-5">
        <div>
            <div class="flex flex-wrap items-center gap-3">
                <h1 class="m3-font-headline-small text-on-surface">
                    Deployments
                </h1>
                <span
                    class="bg-surface-container-high text-on-surface-variant m3-font-label-medium inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
                >
                    <span
                        class={[
                            "size-1.5 rounded-full",
                            deployments.connected
                                ? "bg-primary"
                                : "bg-tertiary",
                        ]}
                        aria-hidden="true"
                    ></span>
                    {deployments.connected ? "Live updates" : "Reconnecting"}
                </span>
            </div>
            <p class="m3-font-body-medium text-on-surface-variant mt-1">
                {totalCount}
                {totalCount === 1 ? "deployment" : "deployments"} across every resource.
            </p>
        </div>

        <Button
            variant="tonal"
            iconType="left"
            disabled={deployments.loading}
            onclick={reconnect}
        >
            <Icon icon={refreshIcon} size={18} />
            Refresh
        </Button>
    </header>

    {#if deployments.error && !deployments.current}
        <Card variant="outlined" id="deployments-error-card">
            <div
                class="flex flex-wrap items-start justify-between gap-4 p-5"
                role="alert"
            >
                <div class="flex items-start gap-3">
                    <span
                        class="bg-error-container text-on-error-container inline-flex shrink-0 items-center justify-center rounded-full p-2"
                    >
                        <Icon icon={errorIcon} size={22} />
                    </span>
                    <div>
                        <h2 class="m3-font-title-medium text-on-surface">
                            Deployments unavailable
                        </h2>
                        <p class="m3-font-body-medium text-error mt-1">
                            {deployments.error.message}
                        </p>
                    </div>
                </div>
                <Button variant="tonal" onclick={reconnect}>Try again</Button>
            </div>
        </Card>
    {:else if deployments.loading && !deployments.current}
        <Card variant="outlined" id="deployments-loading-card">
            <div
                class="deployment-skeleton"
                role="status"
                aria-label="Loading deployments"
            >
                {#each skeletonRows as row}
                    <div
                        class="border-outline-variant grid grid-cols-[1.15fr_1.8fr_1fr_1.1fr_0.75fr] gap-4 border-b px-5 py-4 last:border-b-0"
                        aria-hidden="true"
                    >
                        <span class="skeleton h-5 w-24"></span>
                        <span class="skeleton h-5 w-40"></span>
                        <span class="skeleton h-5 w-24"></span>
                        <span class="skeleton h-5 w-32"></span>
                        <span class="skeleton h-5 w-16"></span>
                    </div>
                {/each}
            </div>
        </Card>
    {:else if totalCount === 0}
        <Card variant="outlined" id="deployments-empty-card">
            <div
                class="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center"
            >
                <span
                    class="bg-primary-container text-on-primary-container inline-flex items-center justify-center rounded-full p-3"
                >
                    <Icon icon={deployedCodeIcon} size={28} />
                </span>
                <h2 class="m3-font-title-large text-on-surface mt-4">
                    No deployments yet
                </h2>
                <p
                    class="m3-font-body-medium text-on-surface-variant mt-1 max-w-md"
                >
                    Deploy a resource from its workspace to see the rollout
                    history here.
                </p>
                <div class="mt-5">
                    <Button href="/workspace" variant="tonal">
                        Open workspace
                    </Button>
                </div>
            </div>
        </Card>
    {:else}
        {#if deployments.error}
            <div
                class="bg-error-container-subtle text-on-error-container-subtle m3-font-body-small mt-5 rounded-xl px-4 py-3"
                role="status"
            >
                Live updates paused. Showing the last received deployment list.
                <button
                    class="text-on-error-container-subtle ml-1 font-semibold underline underline-offset-2"
                    type="button"
                    onclick={reconnect}>Try again</button
                >
            </div>
        {/if}

        <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div
                class="flex flex-wrap items-center gap-1"
                aria-label="Filter deployments"
            >
                {#each filterOptions as option}
                    <Button
                        variant={selectedFilter === option.value
                            ? "tonal"
                            : "text"}
                        size="s"
                        aria-pressed={selectedFilter === option.value}
                        onclick={() => (selectedFilter = option.value)}
                    >
                        {option.label}
                        <span class="text-on-surface-variant ml-1 tabular-nums">
                            {getFilterCount(option.value)}
                        </span>
                    </Button>
                {/each}
            </div>

            <div class="deployment-search w-full sm:w-80">
                <TextFieldOutlined
                    label="Search deployments"
                    leadingIcon={searchIcon}
                    bind:value={searchQuery}
                    autocomplete="off"
                />
            </div>
        </div>

        <Card variant="outlined" id="deployments-card">
            <div class="overflow-x-auto">
                <table class="w-full min-w-[64rem] border-collapse text-left">
                    <colgroup>
                        <col class="w-[19%]" />
                        <col class="w-[31%]" />
                        <col class="w-[18%]" />
                        <col class="w-[20%]" />
                        <col class="w-[12%]" />
                    </colgroup>
                    <thead
                        class="bg-surface-container-high text-on-surface-variant"
                    >
                        <tr>
                            <th
                                class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                                scope="col"
                            >
                                Status
                            </th>
                            <th
                                class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                                scope="col"
                            >
                                Resource
                            </th>
                            <th
                                class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                                scope="col"
                            >
                                Source
                            </th>
                            <th
                                class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                                scope="col"
                            >
                                Created
                            </th>
                            <th
                                class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                                scope="col"
                            >
                                Duration
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each visibleDeployments as deployment (deployment.id)}
                            {@const status = getDeploymentStatus(deployment)}
                            <tr
                                class="border-outline-variant hover:bg-surface-container-low border-t align-top transition-colors"
                            >
                                <td class="px-5 py-4">
                                    <div class="flex items-center gap-3">
                                        <span
                                            class={[
                                                "deployment-status-icon inline-flex shrink-0 items-center justify-center rounded-full p-1.5",
                                                getStatusClasses(status),
                                                status === "started"
                                                    ? "is-running"
                                                    : "",
                                            ]}
                                            role="img"
                                            aria-label={`Deployment status: ${getStatusLabel(status)}`}
                                        >
                                            <Icon
                                                icon={getStatusIcon(status)}
                                                size={20}
                                            />
                                        </span>
                                        <div class="min-w-0">
                                            <div
                                                class="m3-font-label-large text-on-surface whitespace-nowrap"
                                            >
                                                {getStatusLabel(status)}
                                            </div>
                                            <div
                                                class="m3-font-label-small text-on-surface-variant font-mono"
                                            >
                                                {getShortId(deployment.id)}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td class="px-5 py-4">
                                    <a
                                        class="focus-visible:ring-primary block rounded-md text-inherit no-underline outline-none focus-visible:ring-2"
                                        href={getDeploymentHref(deployment)}
                                    >
                                        <div
                                            class="m3-font-label-large text-on-surface hover:text-primary truncate transition-colors"
                                        >
                                            {getResourceLabel(deployment)}
                                        </div>
                                        <div
                                            class="m3-font-label-small text-on-surface-variant mt-1 truncate"
                                        >
                                            {getWorkspaceLabel(deployment)}
                                        </div>
                                    </a>
                                </td>
                                <td class="px-5 py-4">
                                    {#if deployment.gitCommit}
                                        <code
                                            class="bg-surface-container-highest text-on-surface m3-font-label-small inline-flex max-w-36 rounded-md px-2 py-1 font-mono"
                                            title={deployment.gitCommit}
                                        >
                                            {getShortId(deployment.gitCommit)}
                                        </code>
                                    {:else}
                                        <span
                                            class="m3-font-body-medium text-on-surface-variant"
                                        >
                                            Manual deploy
                                        </span>
                                    {/if}
                                </td>
                                <td class="px-5 py-4">
                                    <time
                                        class="m3-font-body-medium text-on-surface whitespace-nowrap"
                                        datetime={deployment.createdAt.toISOString()}
                                        title={deployment.createdAt.toLocaleString()}
                                    >
                                        {formatDate(deployment.createdAt)}
                                    </time>
                                </td>
                                <td
                                    class="m3-font-body-medium text-on-surface-variant px-5 py-4 whitespace-nowrap tabular-nums"
                                >
                                    {formatDuration(deployment)}
                                </td>
                            </tr>
                        {:else}
                            <tr>
                                <td colspan="5">
                                    <div
                                        class="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center"
                                    >
                                        <h2
                                            class="m3-font-title-medium text-on-surface"
                                        >
                                            No matching deployments
                                        </h2>
                                        <p
                                            class="m3-font-body-medium text-on-surface-variant mt-1"
                                        >
                                            Try a different status or search
                                            term.
                                        </p>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </Card>
    {/if}
</div>

<style>
    :global(#deployments-card.m3-container),
    :global(#deployments-empty-card.m3-container),
    :global(#deployments-error-card.m3-container),
    :global(#deployments-loading-card.m3-container) {
        overflow: hidden;
        padding: 0;
    }

    .deployment-search :global(.m3-container) {
        width: 100%;
        min-width: 0;
    }

    .deployment-status-icon.is-running {
        animation: deployment-spin 1.5s linear infinite;
    }

    .skeleton {
        display: block;
        border-radius: var(--m3-shape-extra-small);
        background: var(--m3c-surface-container-high);
        animation: skeleton-pulse 1.4s ease-in-out infinite;
    }

    @keyframes deployment-spin {
        to {
            transform: rotate(360deg);
        }
    }

    @keyframes skeleton-pulse {
        50% {
            opacity: 0.45;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .deployment-status-icon.is-running,
        .skeleton {
            animation: none;
        }
    }
</style>
