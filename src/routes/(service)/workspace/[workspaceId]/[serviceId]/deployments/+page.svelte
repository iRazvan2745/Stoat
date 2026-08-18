<script lang="ts">
    // oxlint-disable func-style default-case
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import errorIcon from "@ktibow/iconset-material-symbols/error-circle-rounded-outline";
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

    const logs = $derived(deploymentLogsQuery?.current ?? []);
    const logsCount = $derived(logs.length);
    const stdoutCount = $derived(
        logs.filter((log) => log.stream !== "stderr").length
    );
    const stderrCount = $derived(
        logs.filter((log) => log.stream === "stderr").length
    );

    type LogFilter = "all" | "stdout" | "stderr";

    let logFilter = $state<LogFilter>("all");
    let followLatest = $state(true);

    const visibleLogs = $derived.by(() => {
        if (logFilter === "all") {
            return logs;
        }

        return logs.filter((log) => log.stream === logFilter);
    });

    const BOTTOM_STICK_THRESHOLD = 48;
    const CHANGE_SUMMARY_PATTERN =
        /^Changes: (?<changes>\d+), insertions: (?<insertions>\d+), deletions: (?<deletions>\d+)$/u;

    let logContainer: HTMLDivElement | undefined = $state();
    let previousDeploymentId = "";
    let previousLogsCount = 0;

    $effect(() => {
        const container = logContainer;
        const count = logsCount;
        const deploymentId = view.current ?? "";

        if (deploymentId !== previousDeploymentId) {
            previousDeploymentId = deploymentId;
            previousLogsCount = 0;
            logFilter = "all";
            followLatest = true;
        }

        const wasEmpty = previousLogsCount === 0;
        previousLogsCount = count;

        if (!container || count === 0) {
            return;
        }

        const distanceFromBottom =
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight;

        if (
            wasEmpty ||
            (followLatest && distanceFromBottom < BOTTOM_STICK_THRESHOLD)
        ) {
            container.scrollTop = container.scrollHeight;
        }
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

    const selectedDeployment = $derived.by(() => {
        const deploymentId = view.current;

        return deployments.find((deployment) => deployment.id === deploymentId);
    });

    const selectedStatus = $derived(
        selectedDeployment ? getStatus(selectedDeployment) : undefined
    );
    const deploymentIsActive = $derived(
        selectedStatus === "pending" ||
            selectedStatus === "queued" ||
            selectedStatus === "started"
    );

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

    interface ChangeSummary {
        changes: number;
        deletions: number;
        insertions: number;
    }

    function getChangeSummary(message: string): ChangeSummary | null {
        const groups = CHANGE_SUMMARY_PATTERN.exec(message)?.groups;

        if (!groups?.changes || !groups.insertions || !groups.deletions) {
            return null;
        }

        return {
            changes: Number(groups.changes),
            deletions: Number(groups.deletions),
            insertions: Number(groups.insertions),
        };
    }

    function openLogs(deploymentId: string): void {
        logFilter = "all";
        followLatest = true;
        void view.set(deploymentId);
    }

    function closeLogs(): void {
        void view.set("");
    }

    function handleLogScroll(event: Event): void {
        const container = event.currentTarget as HTMLDivElement | null;

        if (!container) {
            return;
        }

        const distanceFromBottom =
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight;

        followLatest = distanceFromBottom <= BOTTOM_STICK_THRESHOLD;
    }

    function jumpToLatest(): void {
        followLatest = true;
        logContainer?.scrollTo({
            behavior: "smooth",
            top: logContainer.scrollHeight,
        });
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
                    {@const logsLoading =
                        view.current === deployment.id &&
                        deploymentLogsQuery?.loading === true}

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

                        <Button
                            disabled={logsLoading}
                            aria-busy={logsLoading}
                            onclick={() => openLogs(deployment.id)}
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
                    </article>
                {/each}
            </section>
        {/if}
    </main>
</div>

<div class="logs-dialog">
    <Dialog
        headline="Deployment Logs"
        open={!!view.current}
        onclose={closeLogs}
    >
        {#if deploymentLogsQuery?.loading}
            <div
                class="flex min-h-40 flex-col items-center justify-center gap-3"
            >
                <LoadingIndicator aria-label="Loading logs" />

                <p class="text-on-surface-variant text-sm">Loading logs…</p>
            </div>
        {:else if deploymentLogsQuery?.error}
            <div
                class="bg-error-container-subtle text-on-error-container-subtle flex items-center gap-3 rounded-xl px-4 py-3"
                role="alert"
            >
                <Icon icon={errorIcon} size={20} />

                <p class="text-sm">{deploymentLogsQuery.error.message}</p>
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
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span
                        class="bg-surface-container text-on-surface-variant inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                    >
                        <span
                            class="size-1.5 rounded-full {deploymentIsActive
                                ? 'animate-pulse bg-green-400'
                                : 'bg-primary'}"
                            aria-hidden="true"
                        ></span>
                        {deploymentIsActive ? "Live" : "Complete"}
                    </span>

                    <span class="text-on-surface-variant text-xs tabular-nums">
                        {logsCount}
                        {logsCount === 1 ? "entry" : "entries"}
                    </span>
                </div>

                {#if !followLatest}
                    <button
                        class="bg-primary-container text-on-primary-container inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition hover:shadow-sm"
                        type="button"
                        onclick={jumpToLatest}
                    >
                        <span
                            class="size-1.5 rounded-full bg-current"
                            aria-hidden="true"
                        ></span>
                        Jump to latest
                    </button>
                {/if}
            </div>

            <div
                class="bg-surface-container flex w-fit items-center gap-1 rounded-full p-1"
                role="group"
                aria-label="Filter deployment logs"
            >
                <button
                    class="log-filter-button"
                    class:active={logFilter === "all"}
                    type="button"
                    aria-pressed={logFilter === "all"}
                    onclick={() => (logFilter = "all")}
                >
                    All
                    <span>{logsCount}</span>
                </button>

                <button
                    class="log-filter-button"
                    class:active={logFilter === "stdout"}
                    type="button"
                    aria-pressed={logFilter === "stdout"}
                    onclick={() => (logFilter = "stdout")}
                >
                    Output
                    <span>{stdoutCount}</span>
                </button>

                <button
                    class="log-filter-button"
                    class:active={logFilter === "stderr"}
                    type="button"
                    aria-pressed={logFilter === "stderr"}
                    onclick={() => (logFilter = "stderr")}
                >
                    Errors
                    <span>{stderrCount}</span>
                </button>
            </div>

            {#if visibleLogs.length === 0}
                <div
                    class="bg-surface-container-lowest border-outline-variant/40 mt-2 flex min-h-32 items-center justify-center rounded-xl border px-4 text-center"
                >
                    <p class="text-on-surface-variant text-sm">
                        {logFilter === "stderr"
                            ? "No errors in this deployment."
                            : "No output in this deployment."}
                    </p>
                </div>
            {:else}
                <div
                    bind:this={logContainer}
                    class="bg-surface-container-lowest border-outline-variant/40 mt-2 max-h-[55vh] overflow-y-auto rounded-xl border p-1 font-mono text-xs/5"
                    role="log"
                    aria-label="Deployment log output"
                    aria-live="polite"
                    onscroll={handleLogScroll}
                >
                    {#each visibleLogs as log (log.id)}
                        {@const isError = log.stream === "stderr"}
                        {@const changeSummary = getChangeSummary(log.message)}

                        {#if changeSummary}
                            <div
                                class="log-line change-summary flex gap-3 px-2 py-0.5 {isError
                                    ? 'log-line-error text-error'
                                    : 'text-on-surface'}"
                            >
                                <span
                                    class="text-on-surface-variant shrink-0 tabular-nums select-none"
                                >
                                    {formatTime(log.createdAt)}
                                </span>

                                <span class="flex flex-wrap gap-x-1.5 gap-y-1">
                                    <span>
                                        Changes: {changeSummary.changes},
                                    </span>

                                    <span
                                        class="change-marks text-green-400"
                                        aria-label={`${changeSummary.insertions} insertions`}
                                        title={`${changeSummary.insertions} insertions`}
                                    >
                                        {"+".repeat(changeSummary.insertions)}
                                    </span>

                                    {#if changeSummary.deletions > 0}
                                        <span
                                            class="change-marks text-red-400"
                                            aria-label={`${changeSummary.deletions} deletions`}
                                            title={`${changeSummary.deletions} deletions`}
                                        >
                                            {"-".repeat(
                                                changeSummary.deletions
                                            )}
                                        </span>
                                    {/if}
                                </span>
                            </div>
                        {:else}
                            {#each log.message.split("\n") as line, lineIndex (`${log.id}-${lineIndex}`)}
                                <div
                                    class="log-line flex gap-3 px-2 py-0.5 {isError
                                        ? 'log-line-error text-error'
                                        : 'text-on-surface'}"
                                >
                                    <span
                                        class="text-on-surface-variant shrink-0 tabular-nums select-none"
                                    >
                                        {#if lineIndex === 0}
                                            {formatTime(log.createdAt)}
                                        {/if}
                                    </span>

                                    <span
                                        class="min-w-0 wrap-break-word whitespace-pre-wrap"
                                    >
                                        {line || " "}
                                    </span>
                                </div>
                            {/each}
                        {/if}
                    {/each}
                </div>
            {/if}
        {/if}

        {#snippet buttons()}
            <Button variant="tonal" onclick={closeLogs}>OK</Button>
        {/snippet}
    </Dialog>
</div>

<style>
    .logs-dialog :global(dialog.m3-container) {
        width: 100%;
        max-width: min(52rem, calc(100vw - 2rem));
    }

    .log-filter-button {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        border: 0;
        border-radius: 999px;
        background: transparent;
        padding: 0.375rem 0.75rem;
        color: var(--m3c-on-surface-variant);
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 500;
        line-height: 1rem;
        transition:
            background-color var(--m3-easing-fast),
            color var(--m3-easing-fast);
    }

    .log-filter-button:hover:not(.active) {
        background-color: var(--m3c-surface-container-high);
    }

    .log-filter-button.active {
        background-color: var(--m3c-secondary-container);
        color: var(--m3c-on-secondary-container);
    }

    .log-filter-button:focus-visible {
        outline: 2px solid var(--m3c-primary);
        outline-offset: 2px;
    }

    .log-filter-button span {
        opacity: 0.72;
        font-variant-numeric: tabular-nums;
    }

    .log-line {
        min-height: 1.5rem;
        border-radius: 0.375rem;
        transition: background-color var(--m3-easing-fast);
    }

    .log-line:hover {
        background-color: var(--m3c-surface-container-high);
    }

    .log-line-error {
        background-color: --translucent(
            var(--m3c-error-container-subtle),
            0.16
        );
    }

    .log-line-error:hover {
        background-color: --translucent(
            var(--m3c-error-container-subtle),
            0.28
        );
    }

    .change-summary {
        align-items: baseline;
        flex-wrap: wrap;
    }

    .change-marks {
        letter-spacing: 0.08em;
        font-weight: 700;
    }
</style>
