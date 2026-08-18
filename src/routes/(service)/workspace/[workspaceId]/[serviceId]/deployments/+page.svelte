<script lang="ts">
    // oxlint-disable func-style default-case
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import { Button, Card, Dialog, Icon, LoadingIndicator } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import {
        getDeploymentLogs,
        getDeployments,
    } from "#lib/api/deployments.remote";

    let { params } = $props();

    // svelte-ignore state_referenced_locally
    const deploymentsQuery = getDeployments(params.serviceId);
    const deployments = $derived(deploymentsQuery.current ?? []);

    const view = useQueryState("view", parseAsString.withDefault(""));
    const deploymentLogsQuery = $derived.by(() => {
        const deploymentId = view.current;

        return deploymentId ? getDeploymentLogs(deploymentId) : undefined;
    });

    type Deployment = (typeof deployments)[number];
    type DeploymentStatus = "pending" | "queued" | "started" | "finished";

    const dateFormatter = new Intl.DateTimeFormat("en", {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
    });

    const timeFormatter = new Intl.DateTimeFormat("en", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    });

    function getStatus(deployment: Deployment): DeploymentStatus {
        if (deployment.finishedAt) {
            return "finished";
        }

        if (deployment.startedAt) {
            return "started";
        }

        if (deployment.queuedAt) {
            return "queued";
        }

        return "pending";
    }

    function getStatusLabel(status: DeploymentStatus) {
        switch (status) {
            case "finished": {
                return "Deployed";
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
        }
    }

    function getStatusClasses(status: DeploymentStatus) {
        switch (status) {
            case "finished": {
                return "bg-primary-container text-on-primary-container";
            }

            case "started": {
                return "bg-tertiary-container text-on-tertiary-container";
            }

            case "queued": {
                return "bg-secondary-container text-on-secondary-container";
            }

            case "pending": {
                return "bg-surface-container-high text-on-surface-variant";
            }
        }
    }

    function getIconClasses(status: DeploymentStatus) {
        switch (status) {
            case "finished": {
                return "bg-primary-container text-on-primary-container";
            }

            case "started": {
                return "bg-tertiary-container text-on-tertiary-container";
            }

            case "queued": {
                return "bg-secondary-container text-on-secondary-container";
            }

            case "pending": {
                return "bg-surface-container-high text-on-surface-variant";
            }
        }
    }

    function getStatusIndex(status: DeploymentStatus) {
        switch (status) {
            case "pending": {
                return 0;
            }

            case "queued": {
                return 1;
            }

            case "started": {
                return 2;
            }

            case "finished": {
                return 3;
            }
        }
    }

    function getTimeline(deployment: Deployment) {
        return [
            {
                date: deployment.createdAt,
                label: "Created",
            },
            {
                date: deployment.queuedAt,
                label: "Queued",
            },
            {
                date: deployment.startedAt,
                label: "Started",
            },
            {
                date: deployment.finishedAt,
                label: "Finished",
            },
        ];
    }

    function getTimelineClasses(
        index: number,
        currentIndex: number,
        reached: boolean
    ) {
        if (index === currentIndex) {
            return "bg-primary-container text-on-primary-container";
        }

        if (reached) {
            return "bg-secondary-container text-on-secondary-container";
        }

        return "bg-surface-container-high text-on-surface-variant opacity-50";
    }

    function formatDate(date: Date | null) {
        return date ? dateFormatter.format(date) : null;
    }

    function formatTime(date: Date | null) {
        return date ? timeFormatter.format(date) : null;
    }

    function getDuration(deployment: Deployment) {
        if (!deployment.startedAt || !deployment.finishedAt) {
            return null;
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

        if (minutes < 60) {
            return remainingSeconds
                ? `${minutes}m ${remainingSeconds}s`
                : `${minutes}m`;
        }

        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;

        return remainingMinutes
            ? `${hours}h ${remainingMinutes}m`
            : `${hours}h`;
    }

    function getShortId(id: string) {
        return id.slice(0, 7);
    }
</script>

<div class="mx-auto w-full max-w-6xl">
    <header class="mb-4 flex items-center justify-between gap-4">
        <div>
            <h1 class="text-on-surface text-[28px]">Deployments</h1>
        </div>

        {#if deployments.length > 0}
            <div
                class="bg-secondary-container text-on-secondary-container shrink-0 rounded-full px-3 py-1 text-xs font-medium"
            >
                {deployments.length} total
            </div>
        {/if}
    </header>

    <main>
        {#if deploymentsQuery.loading}
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

                    <p
                        class="text-on-surface-variant mx-auto mt-1 max-w-sm text-sm"
                    >
                        Deployments for this service will appear here once one
                        has been created.
                    </p>
                </div>
            </Card>
        {:else}
            <section
                class="bg-surface-container-low overflow-hidden rounded-[20px]"
                aria-label="Deployment history"
            >
                {#each deployments as deployment (deployment.id)}
                    {@const status = getStatus(deployment)}
                    {@const duration = getDuration(deployment)}
                    {@const statusClasses = getStatusClasses(status)}
                    {@const iconClasses = getIconClasses(status)}

                    <article
                        class="border-outline-variant/40 flex items-center justify-between border-b px-4 py-3 last:border-b-0 sm:px-5"
                    >
                        <div class="flex items-center gap-3">
                            <div
                                class="flex size-9 shrink-0 items-center justify-center rounded-[14px] {iconClasses}"
                            >
                                <Icon icon={deploymentsIcon} size={20} />
                            </div>

                            <div
                                class="flex min-w-0 flex-1 flex-row gap-2 sm:items-center"
                            >
                                <div>
                                    <!-- Identity -->
                                    <div
                                        class="flex min-w-0 items-baseline gap-1.5 sm:w-56"
                                    >
                                        <span
                                            class="text-on-surface text-sm font-medium"
                                        >
                                            Deployment
                                        </span>

                                        <span
                                            class="text-on-surface-variant truncate font-mono text-xs"
                                        >
                                            #{getShortId(deployment.id)}
                                        </span>
                                    </div>

                                    <!-- Created -->
                                    <span
                                        class="text-on-surface-variant text-xs sm:flex-1"
                                    >
                                        {formatDate(deployment.createdAt)}
                                    </span>
                                </div>

                                <!-- Status -->
                                <div class="flex shrink-0 items-center gap-2">
                                    <span
                                        class="rounded-full px-2.5 py-1 text-xs font-medium {statusClasses}"
                                    >
                                        {getStatusLabel(status)}
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

                        <Button onclick={() => view.set(deployment.id)}
                            >View logs</Button
                        >
                    </article>
                {/each}
            </section>
        {/if}
    </main>
</div>

<Dialog
    headline="Deployment Logs"
    open={!!view.current}
    onclose={() => view.set("")}
>
    {#if deploymentLogsQuery?.loading}
        Loading logs...
    {:else if deploymentLogsQuery?.error}
        {deploymentLogsQuery.error.message}
    {:else if (deploymentLogsQuery?.current?.length ?? 0) === 0}
        No logs yet.
    {:else}
        {#each deploymentLogsQuery?.current ?? [] as log (log.id)}
            <pre>{log.message}</pre>
        {/each}
    {/if}
    {#snippet buttons()}
        <Button variant="tonal">OK</Button>
    {/snippet}
</Dialog>
