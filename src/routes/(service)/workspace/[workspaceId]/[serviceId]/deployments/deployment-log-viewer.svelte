<script lang="ts">
    import { Button } from "m3-svelte";
    import {
        parseAsBoolean,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";

    import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";
    import { attachFollowScroll } from "#lib/shared/ui/follow-scroll";

    import type { Deployment } from "./deployment";
    import DeploymentLogBanner from "./deployment-log-banner.svelte";
    import DeploymentLogEntry from "./deployment-log-entry.svelte";
    import DeploymentLogFilters from "./deployment-log-filters.svelte";
    import {
        buildDeploymentLogView,
        getEmptyLogFilterMessage,
    } from "./deployment-log-view";

    const BOTTOM_STICK_THRESHOLD = 48;

    interface Props {
        deployment: Deployment | undefined;
        live: boolean;
        logs: DeploymentLogRecord[];
    }

    let { deployment, live, logs }: Props = $props();

    const logFilter = useQueryState(
        "logFilter",
        parseAsStringLiteral(["all", "stderr", "stdout"] as const).withDefault(
            "all"
        )
    );
    const showDebugLogs = useQueryState(
        "debug",
        parseAsBoolean.withDefault(false)
    );
    let followLatest = $state(true);
    let logContainer: HTMLDivElement | undefined = $state();
    const followLogs = attachFollowScroll(() => followLatest);

    const logView = $derived(
        buildDeploymentLogView(logs, {
            logFilter: logFilter.current,
            showDebugLogs: showDebugLogs.current,
        })
    );

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

<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2">
        <span
            class="bg-surface-container text-on-surface-variant inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        >
            <span
                class="size-1.5 rounded-full {live
                    ? 'bg-tertiary animate-pulse'
                    : 'bg-primary'}"
                aria-hidden="true"
            ></span>
            {live ? "Live" : "Complete"}
        </span>

        <span class="text-on-surface-variant text-xs tabular-nums">
            {logView.visibleLogsCount}
            {logView.visibleLogsCount === 1 ? "entry" : "entries"}
        </span>
    </div>

    {#if !followLatest}
        <Button variant="tonal" square onclick={jumpToLatest}>
            <span class="size-1.5 rounded-full bg-current" aria-hidden="true"
            ></span>
            Jump to latest
        </Button>
    {/if}
</div>

<DeploymentLogFilters
    bind:logFilter={logFilter.current}
    bind:showDebugLogs={showDebugLogs.current}
    allCount={logView.allCount}
    debugCount={logView.debugCount}
    stderrCount={logView.stderrCount}
    stdoutCount={logView.stdoutCount}
/>

{#if logView.filteredLogEntries.length === 0}
    <div
        class="bg-surface-container-lowest border-outline-variant/40 mt-2 flex min-h-32 items-center justify-center rounded-xl border px-4 text-center"
    >
        <p class="text-on-surface-variant text-sm">
            {getEmptyLogFilterMessage(
                logFilter.current,
                logView.debugCount,
                showDebugLogs.current
            )}
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
            {#if logFilter.current !== "stderr"}
                <DeploymentLogBanner serviceId={deployment?.serviceId ?? ""} />
            {/if}

            {#each logView.visibleLogEntries as entry (entry.kind === "text" ? entry.log.id : entry.key)}
                <DeploymentLogEntry {entry} />
            {/each}
        </div>
    </div>
{/if}
