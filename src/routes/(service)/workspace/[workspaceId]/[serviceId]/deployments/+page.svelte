<script lang="ts">
    // oxlint-disable func-style default-case
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import { Card, Icon } from "m3-svelte";

    import { getDeployments } from "#lib/api/deployments.remote";

    let { params } = $props();

    // svelte-ignore state_referenced_locally
    const deployments = await getDeployments(params.serviceId);

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
    <header
        class="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
    >
        <div>
            <h1
                class="text-on-surface text-[32px] leading-10 font-medium tracking-[-0.02em]"
            >
                Deployments
            </h1>

            <p class="text-on-surface-variant mt-1 text-sm">
                Build and deployment history for this service
            </p>
        </div>

        {#if deployments.length > 0}
            <div
                class="bg-secondary-container text-on-secondary-container w-fit rounded-full px-3.5 py-1.5 text-sm font-medium"
            >
                {deployments.length} total
            </div>
        {/if}
    </header>

    <main>
        {#if deployments.length === 0}
            <Card variant="filled">
                <div class="px-6 py-14 text-center">
                    <div
                        class="bg-secondary-container text-on-secondary-container mx-auto mb-4 flex size-14 items-center justify-center rounded-[20px]"
                    >
                        <Icon icon={deploymentsIcon} size={28} />
                    </div>

                    <p class="text-on-surface text-base font-medium">
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
                class="bg-surface-container-low overflow-hidden rounded-[28px]"
                aria-label="Deployment history"
            >
                {#each deployments as deployment (deployment.id)}
                    {@const status = getStatus(deployment)}
                    {@const statusIndex = getStatusIndex(status)}
                    {@const timeline = getTimeline(deployment)}
                    {@const duration = getDuration(deployment)}
                    {@const statusClasses = getStatusClasses(status)}
                    {@const iconClasses = getIconClasses(status)}

                    <article
                        class="border-outline-variant/40 border-b px-5 py-5 last:border-b-0 sm:px-6"
                    >
                        <!-- Header -->
                        <div class="flex items-start gap-4">
                            <div
                                class="flex size-12 shrink-0 items-center justify-center rounded-[18px] {iconClasses}"
                            >
                                <Icon icon={deploymentsIcon} size={26} />
                            </div>

                            <div class="min-w-0 flex-1">
                                <div
                                    class="flex flex-wrap items-center gap-x-2 gap-y-1"
                                >
                                    <h2
                                        class="text-on-surface text-base font-medium"
                                    >
                                        Deployment
                                    </h2>

                                    <span
                                        class="text-on-surface-variant font-mono text-sm"
                                    >
                                        #{getShortId(deployment.id)}
                                    </span>
                                </div>

                                <p
                                    class="text-on-surface-variant mt-0.5 text-sm"
                                >
                                    {formatDate(deployment.createdAt)}
                                </p>

                                <!-- Main status -->
                            </div>
                        </div>

                        <!-- Lifecycle timeline -->
                        <div class="mt-6 sm:ml-16">
                            <div
                                class="grid grid-cols-4"
                                aria-label="Deployment lifecycle"
                            >
                                {#each timeline as step, index}
                                    {@const reached = step.date !== null}
                                    {@const current = index === statusIndex}

                                    <div
                                        class="relative flex min-w-0 flex-col items-center"
                                    >
                                        <!--
                    Connector runs from the center of this stage
                    to the center of the next one.

                    The pills sit above it, hiding the line underneath
                    themselves so it visually connects pill-to-pill.
                -->
                                        {#if index < timeline.length - 1}
                                            <div
                                                class={[
                                                    "absolute top-[17px] left-1/2 h-0.5 w-full",
                                                    index < statusIndex
                                                        ? "bg-primary"
                                                        : "bg-outline-variant",
                                                ]}
                                                aria-hidden="true"
                                            ></div>
                                        {/if}

                                        <!-- Stage pill -->
                                        <div
                                            class={[
                                                "relative z-10 flex h-9 items-center justify-center",
                                                "rounded-full px-4 text-sm font-medium",
                                                "whitespace-nowrap transition-colors",

                                                current
                                                    ? "bg-primary text-on-primary"
                                                    : reached
                                                      ? "bg-primary-container text-on-primary-container"
                                                      : "bg-surface-container-high text-on-surface-variant",
                                            ]}
                                        >
                                            {step.label}
                                        </div>

                                        <!-- Timestamp -->
                                        <span
                                            class={[
                                                "mt-2 text-center text-xs tabular-nums",
                                                reached
                                                    ? "text-on-surface-variant"
                                                    : "text-on-surface-variant/50",
                                            ]}
                                        >
                                            {step.date
                                                ? formatTime(step.date)
                                                : "—"}
                                        </span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    </article>
                {/each}
            </section>
        {/if}
    </main>
</div>
