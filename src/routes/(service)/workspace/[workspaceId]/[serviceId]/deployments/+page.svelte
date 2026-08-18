<script lang="ts">
    // oxlint-disable func-style default-case
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import cancelIcon from "@ktibow/iconset-material-symbols/cancel";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import deploymentsIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
    import errorIcon from "@ktibow/iconset-material-symbols/error-circle-rounded-outline";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        Snackbar,
        snackbar,
    } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import {
        cancelDeployment,
        deleteDeployment,
        getDeploymentLogs,
        getDeployments,
    } from "#lib/api/deployments.remote";
    import { detectDeploymentFailure } from "#lib/deployment-failure";
    import type { LogHighlightKind } from "#lib/deployment-logs";
    import {
        buildDeploymentLogEntries,
        highlightLogMessage,
    } from "#lib/deployment-logs";
    import { attachFollowScroll } from "#lib/follow-scroll";

    import DeploymentLogBanner from "./deployment-log-banner.svelte";
    import DeploymentLogProgress from "./deployment-log-progress.svelte";

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

    const visibleLogEntries = $derived(buildDeploymentLogEntries(visibleLogs));

    const BOTTOM_STICK_THRESHOLD = 48;
    const CHANGE_SUMMARY_PATTERN =
        /^Changes: (?<changes>\d+), insertions: (?<insertions>\d+), deletions: (?<deletions>\d+)$/u;

    let logContainer: HTMLDivElement | undefined = $state();
    const followLogs = attachFollowScroll(() => followLatest);

    type Deployment = (typeof deployments)[number];
    type DeploymentPhase = "pending" | "queued" | "started" | "finished";
    type DeploymentDisplayStatus =
        | DeploymentPhase
        | "cancelled"
        | "deployed"
        | "failed";

    let actionsMenuOpenFor = $state<string | null>(null);
    const actionsMenuDeployment = $derived(
        deployments.find((deployment) => deployment.id === actionsMenuOpenFor)
    );
    const actionsMenuDeploymentActive = $derived(
        actionsMenuDeployment
            ? // oxlint-disable-next-line no-use-before-define
              isDeploymentActive(actionsMenuDeployment)
            : false
    );
    let cancelDialogDeploymentId = $state<string | null>(null);
    let deleteDialogDeploymentId = $state<string | null>(null);
    let cancelling = $state(false);
    let deleting = $state(false);

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

    function getPhase(deployment: Deployment): DeploymentPhase {
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

    function getDisplayStatus(deployment: Deployment): DeploymentDisplayStatus {
        if (deployment.outcome === "cancelled") {
            return "cancelled";
        }

        if (deployment.outcome === "failed") {
            return "failed";
        }

        const selectedLogs = view.current === deployment.id ? logs : undefined;

        if (selectedLogs && detectDeploymentFailure(selectedLogs)) {
            return "failed";
        }

        const phase = getPhase(deployment);

        if (phase !== "finished") {
            return phase;
        }

        return "deployed";
    }

    function isDeploymentActive(deployment: Deployment): boolean {
        return (
            getPhase(deployment) !== "finished" &&
            getDisplayStatus(deployment) !== "failed"
        );
    }

    const selectedDeployment = $derived.by(() => {
        const deploymentId = view.current;

        return deployments.find((deployment) => deployment.id === deploymentId);
    });

    const deploymentIsActive = $derived(
        selectedDeployment ? isDeploymentActive(selectedDeployment) : false
    );

    function getStatusLabel(status: DeploymentDisplayStatus) {
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

            case "finished": {
                return "Finished";
            }
        }
    }

    function getStatusClasses(status: DeploymentDisplayStatus) {
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

            case "queued": {
                return "bg-secondary-container text-on-secondary-container";
            }

            case "pending":
            case "finished": {
                return "bg-surface-container-high text-on-surface-variant";
            }
        }
    }

    function getLogFilterButtonClasses(active: boolean) {
        return [
            "inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 py-1.5 text-xs leading-4 font-medium transition-colors",
            "text-on-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            active
                ? "bg-secondary-container text-on-secondary-container"
                : "bg-transparent hover:bg-surface-container-high",
        ].join(" ");
    }

    function getLogRowClasses(isError: boolean) {
        return [
            "grid min-h-6 grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-4 rounded-md px-4 py-2 font-mono text-xs/5 transition-colors",
            isError
                ? "bg-error-container-subtle/16 text-error hover:bg-error-container-subtle/28"
                : "text-on-surface hover:bg-surface-container-high",
        ].join(" ");
    }

    function getLogSegmentClasses(kind: LogHighlightKind) {
        switch (kind) {
            case "keyword": {
                return "font-semibold text-primary";
            }

            case "info": {
                return "font-medium text-tertiary";
            }

            case "path": {
                return "text-on-secondary-container";
            }

            case "success": {
                return "font-semibold text-primary";
            }

            case "number": {
                return "font-medium text-secondary";
            }

            default: {
                return "";
            }
        }
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
        logFilter = "all";
        followLatest = true;
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

    function closeActionsMenu(): void {
        actionsMenuOpenFor = null;
    }

    function toggleActionsMenu(deploymentId: string): void {
        actionsMenuOpenFor =
            actionsMenuOpenFor === deploymentId ? null : deploymentId;
    }

    function handleWindowPointerDown(event: PointerEvent): void {
        if (!actionsMenuOpenFor) {
            return;
        }

        const { target } = event;

        if (!(target instanceof Element)) {
            return;
        }

        if (
            target.closest("[data-deployment-actions-trigger]") ||
            target.closest(".m3-container.expressive-menu")
        ) {
            return;
        }

        closeActionsMenu();
    }

    function openCancelDialog(deploymentId: string): void {
        closeActionsMenu();
        cancelDialogDeploymentId = deploymentId;
    }

    function openDeleteDialog(deploymentId: string): void {
        closeActionsMenu();
        deleteDialogDeploymentId = deploymentId;
    }

    const cancelDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === cancelDialogDeploymentId
        )
    );
    const deleteDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === deleteDialogDeploymentId
        )
    );

    const forceCancel = async (): Promise<void> => {
        if (!cancelDialogDeploymentId || cancelling) {
            return;
        }

        cancelling = true;

        try {
            await cancelDeployment(cancelDialogDeploymentId);
            cancelDialogDeploymentId = null;
            snackbar("Deployment cancelled");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to cancel deployment"
            );
        } finally {
            cancelling = false;
        }
    };

    const removeDeployment = async (): Promise<void> => {
        if (!deleteDialogDeploymentId || deleting) {
            return;
        }

        deleting = true;

        try {
            await deleteDeployment(deleteDialogDeploymentId);

            if (view.current === deleteDialogDeploymentId) {
                closeLogs();
            }

            deleteDialogDeploymentId = null;
            snackbar("Deployment deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete deployment"
            );
        } finally {
            deleting = false;
        }
    };
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

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
                class="bg-surface-container-low rounded-[20px]"
                aria-label="Deployment history"
            >
                {#each deployments as deployment (deployment.id)}
                    {@const displayStatus = getDisplayStatus(deployment)}
                    {@const duration = getDuration(deployment)}
                    {@const statusClasses = getStatusClasses(displayStatus)}
                    {@const logsLoading =
                        view.current === deployment.id &&
                        deploymentLogsQuery?.loading === true}
                    {@const actionsMenuOpen =
                        actionsMenuOpenFor === deployment.id}

                    <article
                        class="border-outline-variant/40 flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:px-5"
                    >
                        <div class="flex min-w-0 flex-1 items-center gap-3">
                            <div
                                class="flex size-9 shrink-0 items-center justify-center rounded-[14px] {statusClasses}"
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

                            <span
                                class="relative inline-flex"
                                data-deployment-actions-trigger
                                style={actionsMenuOpen
                                    ? "anchor-name: --m3-menu-anchor"
                                    : undefined}
                            >
                                <Button
                                    variant="tonal"
                                    square
                                    aria-label="Deployment actions"
                                    aria-expanded={actionsMenuOpen}
                                    aria-haspopup="menu"
                                    onclick={() =>
                                        toggleActionsMenu(deployment.id)}
                                >
                                    <Icon icon={moreVertIcon} />
                                </Button>
                            </span>
                        </div>
                    </article>
                {/each}
            </section>
        {/if}
    </main>
</div>

{#if actionsMenuDeployment}
    <div class="[&_:global(.m3-container.expressive-menu.anchored)]:z-20">
        <ExpressiveMenu anchored x="end" y="down" label="Deployment actions">
            {#if actionsMenuDeploymentActive}
                <ExpressiveMenuItem
                    leadingIcon={cancelIcon}
                    label="Force cancel"
                    onclick={() => openCancelDialog(actionsMenuDeployment.id)}
                />
            {/if}

            <ExpressiveMenuItem
                leadingIcon={deleteIcon}
                label="Delete"
                onclick={() => openDeleteDialog(actionsMenuDeployment.id)}
            />
        </ExpressiveMenu>
    </div>
{/if}

<div class="max-w-none">
    <Dialog
        headline="Deployment Logs"
        id="deployment-logs-dialog"
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
                                ? 'bg-tertiary animate-pulse'
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
                    <Button variant="tonal" square onclick={jumpToLatest}>
                        <span
                            class="size-1.5 rounded-full bg-current"
                            aria-hidden="true"
                        ></span>
                        Jump to latest
                    </Button>
                {/if}
            </div>

            <div
                class="bg-surface-container flex w-fit items-center gap-1 rounded-full p-1"
                role="group"
                aria-label="Filter deployment logs"
            >
                <button
                    class={getLogFilterButtonClasses(logFilter === "all")}
                    type="button"
                    aria-pressed={logFilter === "all"}
                    onclick={() => (logFilter = "all")}
                >
                    All
                    <span class="tabular-nums opacity-72">{logsCount}</span>
                </button>

                <button
                    class={getLogFilterButtonClasses(logFilter === "stdout")}
                    type="button"
                    aria-pressed={logFilter === "stdout"}
                    onclick={() => (logFilter = "stdout")}
                >
                    Output
                    <span class="tabular-nums opacity-72">{stdoutCount}</span>
                </button>

                <button
                    class={getLogFilterButtonClasses(logFilter === "stderr")}
                    type="button"
                    aria-pressed={logFilter === "stderr"}
                    onclick={() => (logFilter = "stderr")}
                >
                    Errors
                    <span class="tabular-nums opacity-72">{stderrCount}</span>
                </button>
            </div>

            {#if visibleLogEntries.length === 0}
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
                    class="bg-surface-container-lowest border-outline-variant/40 text-on-surface mt-2 max-h-[70vh] w-full overflow-y-auto rounded-xl border px-1 py-2"
                    role="log"
                    aria-label="Deployment log output"
                    aria-live="polite"
                    onscroll={handleLogScroll}
                >
                    <div {@attach followLogs}>
                        {#if logFilter !== "stderr"}
                            <DeploymentLogBanner
                                serviceId={selectedDeployment?.serviceId ?? ""}
                            />
                        {/if}

                        {#each visibleLogEntries as entry (entry.kind === "text" ? entry.log.id : entry.key)}
                            {@const log = entry.log}
                            {@const isError = log.stream === "stderr"}
                            {@const changeSummary =
                                entry.kind === "text"
                                    ? getChangeSummary(log.message)
                                    : null}

                            {#if entry.kind === "progress"}
                                <DeploymentLogProgress
                                    createdAt={log.createdAt}
                                    {formatTime}
                                    {isError}
                                    progress={entry.progress}
                                />
                            {:else if changeSummary}
                                <div class={getLogRowClasses(isError)}>
                                    <span
                                        class="text-on-surface-variant shrink-0 pt-0.5 text-right text-[0.6875rem] tabular-nums select-none"
                                    >
                                        {formatTime(log.createdAt)}
                                    </span>

                                    <span
                                        class="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 wrap-break-word"
                                    >
                                        <span>
                                            Changes: {changeSummary.changes},
                                        </span>

                                        <span
                                            class="text-primary font-bold tracking-wider"
                                            aria-label={`${changeSummary.insertions} insertions`}
                                            title={`${changeSummary.insertions} insertions`}
                                        >
                                            {"+".repeat(
                                                changeSummary.insertions
                                            )}
                                        </span>

                                        {#if changeSummary.deletions > 0}
                                            <span
                                                class="text-error font-bold tracking-wider"
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
                                {#each entry.lines as line, lineIndex (`${log.id}-${lineIndex}`)}
                                    <div class={getLogRowClasses(isError)}>
                                        <span
                                            class="text-on-surface-variant shrink-0 pt-0.5 text-right text-[0.6875rem] tabular-nums select-none"
                                        >
                                            {#if lineIndex === 0}
                                                {formatTime(log.createdAt)}
                                            {/if}
                                        </span>

                                        <span
                                            class="min-w-0 wrap-break-word whitespace-pre-wrap"
                                        >
                                            {#each highlightLogMessage(line) as segment, segmentIndex (`${log.id}-${lineIndex}-${segmentIndex}`)}
                                                <span
                                                    class={getLogSegmentClasses(
                                                        segment.kind
                                                    )}
                                                >
                                                    {segment.text}
                                                </span>
                                            {/each}
                                        </span>
                                    </div>
                                {/each}
                            {/if}
                        {/each}
                    </div>
                </div>
            {/if}
        {/if}

        {#snippet buttons()}
            {#if selectedDeployment && deploymentIsActive}
                <Button
                    variant="text"
                    disabled={cancelling}
                    onclick={() => openCancelDialog(selectedDeployment.id)}
                >
                    Force cancel
                </Button>
            {/if}

            {#if selectedDeployment}
                <Button
                    variant="text"
                    disabled={deleting}
                    onclick={() => openDeleteDialog(selectedDeployment.id)}
                >
                    Delete
                </Button>
            {/if}

            <Button variant="tonal" onclick={closeLogs}>OK</Button>
        {/snippet}
    </Dialog>
</div>

<Dialog
    headline="Force cancel deployment"
    open={cancelDialogDeploymentId !== null}
    onclose={() => (cancelDialogDeploymentId = null)}
>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Cancel deployment
            {#if cancelDialogDeployment}
                <span class="font-mono text-sm">
                    #{getShortId(cancelDialogDeployment.id)}
                </span>
            {/if}?
        </p>

        <p class="text-on-surface-variant text-sm">
            This marks the deployment as cancelled. Any in-flight work may
            continue briefly in the background.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={cancelling}
            onclick={() => (cancelDialogDeploymentId = null)}
        >
            Keep running
        </Button>

        <Button
            disabled={cancelling}
            aria-busy={cancelling}
            onclick={forceCancel}
        >
            {#if cancelling}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Cancelling deployment"
                />
                Cancelling...
            {:else}
                Force cancel
            {/if}
        </Button>
    {/snippet}
</Dialog>

<Dialog
    headline="Delete deployment"
    open={deleteDialogDeploymentId !== null}
    onclose={() => (deleteDialogDeploymentId = null)}
>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Delete deployment
            {#if deleteDialogDeployment}
                <span class="font-mono text-sm">
                    #{getShortId(deleteDialogDeployment.id)}
                </span>
            {/if}?
        </p>

        <p class="text-on-surface-variant text-sm">
            This permanently removes the deployment and all of its logs.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={deleting}
            onclick={() => (deleteDialogDeploymentId = null)}
        >
            Cancel
        </Button>

        <Button
            disabled={deleting}
            aria-busy={deleting}
            onclick={removeDeployment}
        >
            {#if deleting}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Deleting deployment"
                />
                Deleting...
            {:else}
                Delete
            {/if}
        </Button>
    {/snippet}
</Dialog>

<Snackbar />

<style>
    :global(#deployment-logs-dialog.m3-container) {
        width: min(70rem, calc(100vw - 2rem));
        max-width: none;
    }
</style>
