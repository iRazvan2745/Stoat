<script lang="ts">
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import { Chip, Icon, LoadingIndicator } from "m3-svelte";
    import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs-svelte";

    import { getServiceContainerLogs } from "#lib/api/services.remote";
    import { filterContainerLogs, matchContainerId } from "#lib/container-logs";
    import type { ContainerLogRecord } from "#lib/container-logs";
    import { attachFollowScroll } from "#lib/follow-scroll";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const logsQuery = getServiceContainerLogs(params.serviceId);

    const snapshot = $derived(logsQuery.current);
    const containers = $derived(snapshot?.containers ?? []);
    const logs = $derived(snapshot?.logs ?? []);
    const following = $derived(snapshot?.following ?? false);
    const streamError = $derived(snapshot?.error ?? null);

    const selectedIds = useQueryState(
        "containers",
        parseAsArrayOf(parseAsString).withDefault([] as string[])
    );
    let followLatest = $state(true);
    let logContainer: HTMLDivElement | undefined = $state();
    let ignoreProgrammaticScroll = false;

    const activeSelectedIds = $derived(
        selectedIds.current.filter((id) =>
            containers.some((container) => container.id === id)
        )
    );
    const showingAll = $derived(activeSelectedIds.length === 0);
    const visibleLogs = $derived(filterContainerLogs(logs, activeSelectedIds));
    const BOTTOM_STICK_THRESHOLD = 48;

    const timeFormatter = new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        second: "2-digit",
    });

    const labelFor = (log: ContainerLogRecord): string =>
        matchContainerId(containers, log.containerId)?.label ??
        log.containerLabel;

    const selectAll = (): void => {
        selectedIds.set([]);
        followLatest = true;
    };

    const toggleContainer = (id: string): void => {
        followLatest = true;
        const current = activeSelectedIds;

        if (current.length === 0) {
            selectedIds.set([id]);
            return;
        }

        if (current.includes(id)) {
            selectedIds.set(current.filter((selected) => selected !== id));
            return;
        }

        const next = [...current, id];
        selectedIds.set(next.length === containers.length ? [] : next);
    };

    const formatTime = (timestamp: string): string => {
        const date = new Date(timestamp);

        if (Number.isNaN(date.getTime())) {
            return "";
        }

        return timeFormatter.format(date);
    };

    const scrollToBottom = (
        container: HTMLElement | undefined = logContainer
    ): void => {
        if (!container) {
            return;
        }

        ignoreProgrammaticScroll = true;
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                ignoreProgrammaticScroll = false;
            });
        });
    };

    const handleLogScroll = (event: Event): void => {
        if (ignoreProgrammaticScroll) {
            return;
        }

        const container = event.currentTarget as HTMLDivElement | null;

        if (!container) {
            return;
        }

        const distanceFromBottom =
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight;

        followLatest = distanceFromBottom <= BOTTOM_STICK_THRESHOLD;
    };

    const jumpToLatest = (): void => {
        followLatest = true;
        scrollToBottom();
    };

    const followLogs = attachFollowScroll(() => followLatest, scrollToBottom);
</script>

<div class="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
    <header class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-on-surface text-xl font-medium">Logs</h1>

        <div class="flex items-center gap-3">
            {#if snapshot}
                <span class="text-on-surface-variant text-xs">
                    {following ? "Live" : "Idle"}
                </span>
            {/if}

            {#if !followLatest && visibleLogs.length > 0}
                <button
                    class="text-primary text-xs font-medium"
                    type="button"
                    onclick={jumpToLatest}
                >
                    Jump to latest
                </button>
            {/if}
        </div>
    </header>

    <div class="flex flex-wrap items-center gap-2">
        <Chip
            variant="general"
            selected={showingAll}
            onclick={selectAll}
            aria-pressed={showingAll}
        >
            All
        </Chip>

        {#each containers as container (container.id)}
            <Chip
                variant="general"
                selected={!showingAll &&
                    activeSelectedIds.includes(container.id)}
                onclick={() => toggleContainer(container.id)}
                aria-pressed={!showingAll &&
                    activeSelectedIds.includes(container.id)}
            >
                {container.label}
            </Chip>
        {/each}
    </div>

    <div
        id="service-logs-card"
        class="bg-surface-container-lowest border-outline-variant/40 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
        {#if logsQuery.loading && !snapshot}
            <div
                class="flex min-h-64 flex-col items-center justify-center gap-3"
            >
                <LoadingIndicator aria-label="Loading container logs" />
            </div>
        {:else if logsQuery.error}
            <p class="text-error p-4 text-sm">{logsQuery.error.message}</p>
        {:else if streamError && logs.length === 0}
            <p class="text-on-surface-variant p-4 text-sm">{streamError}</p>
        {:else if visibleLogs.length === 0}
            <div
                class="text-on-surface-variant flex min-h-64 flex-col items-center justify-center gap-2 px-6 text-center text-sm"
            >
                <Icon icon={logsIcon} size={20} />
                <p>No logs yet</p>
            </div>
        {:else}
            <div
                bind:this={logContainer}
                class="h-full min-h-0 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[18px]"
                role="log"
                aria-label="Container log output"
                aria-live="polite"
                onscroll={handleLogScroll}
            >
                <div {@attach followLogs}>
                    {#each visibleLogs as log (log.id)}
                        {@const lines = log.message.split("\n")}
                        {@const containerLabel = labelFor(log)}

                        {#each lines as line, lineIndex (`${log.id}-${lineIndex}`)}
                            <div class="flex gap-3">
                                <span
                                    class="text-on-surface-variant w-14 shrink-0 tabular-nums select-none"
                                >
                                    {#if lineIndex === 0}
                                        {formatTime(log.timestamp)}
                                    {/if}
                                </span>

                                <span
                                    class="text-primary w-20 shrink-0 truncate select-none"
                                    title={containerLabel}
                                >
                                    {#if lineIndex === 0}
                                        {containerLabel}
                                    {/if}
                                </span>

                                <span
                                    class="text-on-surface min-w-0 wrap-break-word whitespace-pre-wrap"
                                >
                                    {line}
                                </span>
                            </div>
                        {/each}
                    {/each}
                </div>
            </div>
        {/if}
    </div>
</div>
