<script lang="ts">
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import jumpToBottomIcon from "@ktibow/iconset-material-symbols/vertical-align-bottom";
    import {
        Button,
        Chip,
        Icon,
        LoadingIndicator,
        TextFieldOutlined,
    } from "m3-svelte";
    import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs-svelte";

    import { streamResourceContainerLogs } from "#lib/api/resources.remote";
    import ContainerLogEntry from "#lib/components/logs/container-log-entry.svelte";
    import type { ContainerLogRecord } from "#lib/domain/resources/container-logs";
    import {
        filterContainerLogs,
        matchContainerId,
    } from "#lib/domain/resources/container-logs";
    import { attachFollowScroll } from "#lib/shared/ui/follow-scroll";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const logsQuery = streamResourceContainerLogs(params.resourceId);

    const snapshot = $derived(logsQuery.current);
    const containers = $derived(snapshot?.containers ?? []);
    const logs = $derived(snapshot?.logs ?? []);
    const following = $derived(snapshot?.following ?? false);
    const streamError = $derived(snapshot?.error ?? null);

    const selectedIds = useQueryState(
        "containers",
        parseAsArrayOf(parseAsString).withDefault([] as string[])
    );
    let search = $state("");
    let stderrOnly = $state(false);
    let followLatest = $state(true);
    let logContainer: HTMLDivElement | undefined = $state();
    let ignoreProgrammaticScroll = false;

    const activeSelectedIds = $derived(
        selectedIds.current.filter((id) =>
            containers.some((container) => container.id === id)
        )
    );
    const showingAll = $derived(activeSelectedIds.length === 0);
    const visibleLogs = $derived(
        filterContainerLogs(logs, activeSelectedIds, search, stderrOnly)
    );
    const BOTTOM_STICK_THRESHOLD = 48;

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
        <h1 class="m3-font-headline-small text-on-surface">Logs</h1>

        <div class="flex items-center gap-3">
            {#if !followLatest && visibleLogs.length > 0}
                <Button
                    variant="tonal"
                    size="xs"
                    iconType="left"
                    onclick={jumpToLatest}
                >
                    <Icon icon={jumpToBottomIcon} />
                    Jump to latest
                </Button>
            {/if}
            {#if snapshot}
                <span
                    class={[
                        "m3-font-label-medium inline-flex h-6 items-center gap-1.5 rounded-full px-2.5",
                        following
                            ? "bg-primary-container-subtle text-on-primary-container-subtle"
                            : "bg-secondary-container-subtle text-on-secondary-container-subtle",
                    ]}
                >
                    <span
                        class="size-1.5 rounded-full bg-current"
                        aria-hidden="true"
                    ></span>
                    {following ? "Live" : "Idle"}
                </span>
            {/if}
        </div>
    </header>
    <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-48 flex-1">
            <TextFieldOutlined
                label="Search logs"
                bind:value={search}
                type="search"
            />
        </div>
        <Chip
            variant="general"
            selected={stderrOnly}
            aria-pressed={stderrOnly}
            onclick={() => {
                stderrOnly = !stderrOnly;
            }}>stderr only</Chip
        >
        <span class="text-on-surface-variant m3-font-label-small"
            >{visibleLogs.length} / {logs.length} entries</span
        >
    </div>
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
        id="resource-logs-card"
        class="bg-surface-container-low border-outline-variant/40 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
        {#if logsQuery.loading && !snapshot}
            <div
                class="flex min-h-64 flex-col items-center justify-center gap-3"
            >
                <LoadingIndicator aria-label="Loading container logs" />
            </div>
        {:else if logsQuery.error}
            <p class="text-error m3-font-body-small p-4">
                {logsQuery.error.message}
            </p>
        {:else if streamError && logs.length === 0}
            <p class="text-on-surface-variant m3-font-body-small p-4">
                {streamError}
            </p>
        {:else if visibleLogs.length === 0}
            <div
                class="text-on-surface-variant flex min-h-64 flex-col items-center justify-center gap-2 px-6 text-center"
            >
                <Icon icon={logsIcon} size={24} />
                <p class="m3-font-body-medium">
                    {logs.length > 0
                        ? "No logs match your filters"
                        : "No logs yet"}
                </p>
            </div>
        {:else}
            {#if streamError}
                <p role="alert" class="text-error m3-font-body-small p-3">
                    {streamError}
                </p>
            {/if}
            <div
                bind:this={logContainer}
                class="h-full min-h-0 overflow-y-auto px-3 py-2 font-mono text-[0.75rem] leading-5"
                role="log"
                aria-label="Container log output"
                aria-live="polite"
                onscroll={handleLogScroll}
            >
                <div {@attach followLogs}>
                    {#each visibleLogs as log (log.id)}
                        <ContainerLogEntry
                            message={log.message}
                            timestamp={log.timestamp}
                            containerLabel={labelFor(log)}
                        />
                    {/each}
                </div>
            </div>
        {/if}
    </div>
</div>
