<script lang="ts">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button, buttonVariants } from "$lib/components/ui/button";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "$lib/components/ui/empty";
    import { Frame, FrameHeader, FramePanel } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "$lib/components/ui/popover";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "$lib/components/ui/tooltip";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { classifyLog, logActivity, logBucketIndex, selectedLogServices, type DisplayLog, type LogLevel } from "$lib/resource-logs";
    import ArrowDown from "@lucide/svelte/icons/arrow-down";
    import Check from "@lucide/svelte/icons/check";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Copy from "@lucide/svelte/icons/copy";
    import Pause from "@lucide/svelte/icons/pause";
    import Play from "@lucide/svelte/icons/play";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import Search from "@lucide/svelte/icons/search";
    import WrapText from "@lucide/svelte/icons/wrap-text";
    import type { ResourceLog } from "@stoat/api/routers/resources/logs";
    import { createQuery } from "@tanstack/svelte-query";
    import { onDestroy, onMount, tick, untrack } from "svelte";

    let { projectId, resourceId, active = true }: { projectId: string; resourceId: string; active?: boolean } = $props();

    let ready = $state(false);

    const resourceQuery = createQuery(() => orpc.resources.getResource.queryOptions({
        input: { projectId, resourceId }, enabled: ready && active,
    }));

    const servicesQuery = createQuery(() => orpc.resources.listLogServices.queryOptions({
        // Live connections populate discovery; keep the same cache for the service picker.
        input: { projectId, resourceId }, enabled: false, retry: false,
    }));

    const services = $derived(servicesQuery.data?.services ?? []);

    const loading = $derived(resourceQuery.isPending || servicesQuery.isPending);

    let selection = $state<string[] | null>(null);

    const selectedServices = $derived(selectedLogServices(services, selection));

    const selectedIds = $derived(selectedServices.map((service) => service.id));

    const selectionKey = $derived(selectedIds.join(","));

    const scopeKey = $derived(`${projectId}/${resourceId}/${selectionKey}`);

    const streamScopeKey = $derived(`${projectId}/${resourceId}/${selection === null ? "all" : selection.join(",")}`);

    let serviceSearch = $state("");

    const visibleServices = $derived(services.filter((service) => service.name.toLowerCase().includes(serviceSearch.toLowerCase())));

    let mode = $state<"live" | "search">("live");

    let paused = $state(false);

    let attempt = $state(0);

    let text = $state("");

    let levelFilter = $state<LogLevel | null>(null);

    let activeBucket = $state<number | null>(null);

    let selectedBucket = $state<{ index: number; domainStart: number; domainEnd: number } | null>(null);

    let wrap = $state(false);

    let following = $state(true);

    let viewport = $state<HTMLDivElement>();

    let liveLogs = $state.raw<DisplayLog[]>([]);

    let historyLogs = $state.raw<DisplayLog[]>([]);

    let discarded = $state(0);

    let streamError = $state("");

    let reconnecting = $state(false);

    let serviceStates = $state<{ id: string; state: "connecting" | "connected" | "reconnecting" | "error"; message?: string }[]>([]);

    let copiedId = $state<number | null>(null);

    let expandedLogId = $state<number | null>(null);

    let copyError = $state("");

    let nextId = 0;

    let preset = $state("15m");

    let start = $state("");

    let end = $state("");

    let timezone = $state("Local time");

    let pending = $state(false);

    let searchError = $state("");

    let nextCursor = $state<string | null>(null);

    let searched = $state(false);

    let searchController: AbortController | undefined;

    let flushLive = () => {};

    let submitted = $state<{ start: string; end: string; query: string; serviceIds: string[] } | null>(null);

    const series: { key: LogLevel; label: string; color: string; foreground: string }[] = [
        { key: "error", label: "Errors", color: "bg-destructive", foreground: "text-destructive-foreground" },
        { key: "warning", label: "Warnings", color: "bg-warning", foreground: "text-warning-foreground" },
        { key: "success", label: "Success", color: "bg-success", foreground: "text-success-foreground" },
        { key: "other", label: "Info", color: "bg-muted-foreground/40", foreground: "text-muted-foreground" },
    ];

    const logs = $derived(mode === "live" ? liveLogs : historyLogs);

    const matchedLogs = $derived(mode === "live" && text ? logs.filter((log) => log.message.toLowerCase().includes(text.toLowerCase())) : logs);

    const visibleLogs = $derived(levelFilter || selectedBucket ? matchedLogs.filter((log) =>
        (!levelFilter || log.level === levelFilter) &&
        (!selectedBucket || logBucketIndex(log.time, selectedBucket.domainStart, selectedBucket.domainEnd) === selectedBucket.index),
    ) : matchedLogs);

    const chartStart = $derived(selectedBucket?.domainStart ?? (mode === "search" && submitted ? Date.parse(submitted.start) : (logs[0]?.time ?? 0)));

    const chartEnd = $derived(selectedBucket?.domainEnd ?? (mode === "search" && submitted ? Date.parse(submitted.end) : Math.max(chartStart + 1000, logs.at(-1)?.time ?? 0)));

    const activity = $derived(logActivity(matchedLogs, chartStart, chartEnd));

    const selectedRange = $derived(selectedBucket ? activity.buckets[selectedBucket.index] : null);

    const connected = $derived(serviceStates.filter((service) => service.state === "connected").length);

    const failures = $derived(serviceStates.filter((service) => service.state === "error" || service.state === "reconnecting"));

    const status = $derived(paused ? "Paused" : reconnecting ? "Reconnecting" : streamError ? "Disconnected" : failures.length ? connected > 0 ? "Partial stream" : failures.some((service) => service.state === "reconnecting") ? "Reconnecting" : "Disconnected" : connected === selectedIds.length && connected > 0 ? "Live" : "Connecting");

    const searchSummary = $derived(submitted ? `${time(submitted.start, true)} to ${time(submitted.end, true)}${submitted.query ? ` / "${submitted.query}"` : ""}` : "Search within the configured retention period.");

    function localDate(value: Date) {
        return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    }

    function chooseRange(value: string) {
        preset = value;

        if (value === "custom") return;
        const now = new Date();
        let duration = 900_000;

        if (value === "1h") duration = 3_600_000;

        if (value === "24h") duration = 86_400_000;
        start = localDate(new Date(now.getTime() - duration));
        end = localDate(now);
    }

    function selectService(name: string, checked: boolean) {
        const names = selection ?? selectedServices.map((service) => service.name);
        selection = checked ? [...names, name] : names.filter((selected) => selected !== name);
    }

    async function selectBucket(index: number | null) {
        if (index !== null && !activity.buckets[index]?.total) return;

        // Capture the domain rather than following a bar whose boundaries shift with live output.
        selectedBucket = index === null || selectedBucket?.index === index
            ? null
            : { index, domainStart: chartStart, domainEnd: chartEnd };
        activeBucket = index;
        expandedLogId = null;
        following = selectedBucket === null;
        await tick();

        if (selectedBucket && viewport) viewport.scrollTop = 0;
    }

    function decorate(entries: ResourceLog[]) {
        return entries.map((entry) => ({ ...entry, id: nextId++, time: Date.parse(entry.timestamp), level: classifyLog(entry.message) }));
    }

    function resetSearch() {
        searchController?.abort();
        searchController = undefined;
        pending = false;
        historyLogs = [];
        nextCursor = null;
        searchError = "";
        searched = false;
        submitted = null;
        selectedBucket = null;
    }

    onMount(() => {
        ready = true;
        // Initialize local dates only in the browser, never in shared SSR state.
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        chooseRange("15m");
    });

    $effect.pre(() => {
        void streamScopeKey;
        liveLogs = [];
        discarded = 0;
        streamError = "";
        reconnecting = false;
        serviceStates = [];
        copiedId = null;
        expandedLogId = null;
        copyError = "";
        activeBucket = null;
    });

    $effect.pre(() => {
        void scopeKey;
        untrack(resetSearch);
    });

    $effect(() => {
        // Track selection intent, not IDs that can change during a deployment.
        const names = selection === null ? null : [...selection];
        const scope = { projectId, resourceId };
        const servicesKey = orpc.resources.listLogServices.queryKey({ input: scope });
        void attempt;

        if (!ready || paused || names?.length === 0) return;

        following = true;
        reconnecting = false;
        let incoming: ResourceLog[] = [];
        let overflow = false;
        let incomingBytes = 0;
        let replaceTail = true;
        let stop = () => {};

        const flush = () => {
            if (!incoming.length) return;
            const combined = [...(replaceTail ? [] : liveLogs), ...decorate(incoming)].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

            if (replaceTail) discarded = 0;
            replaceTail = false;
            incoming = [];
            incomingBytes = 0;
            let bytes = combined.reduce((sum, log) => sum + log.message.length * 2 + 512, 0);
            let remove = 0;

            // ponytail: keep a 2,000-line / 4 MiB tail; use virtualization for larger client buffers.
            while (combined.length - remove > 2000 || bytes > 4 * 1024 * 1024) {
                bytes -= combined[remove]!.message.length * 2 + 512;
                remove++;
            }

            discarded += remove;
            liveLogs = combined.slice(remove);
        };

        const timer = setInterval(flush, 100);
        flushLive = flush;
        stop = untrack(() => subscribeToStream(
            (signal) => {
                // Uncloud reconnects replay the recent tail, not an exactly-once cursor.
                // Keep the previous buffer visible until the first replay batch arrives.
                replaceTail = true;
                incoming = [];
                incomingBytes = 0;
                streamError = "";
                serviceStates = selectedIds.map((id) => ({ id, state: "connecting" }));

                // Resolve names and open current IDs together on the server, avoiding a refetch/open race.
                return client.resources.streamLogs({ ...scope, serviceNames: names ?? undefined }, { signal });
            },
            (event) => {
                reconnecting = false;

                if (event.type === "services") {
                    if (event.services.length === 0) {
                        liveLogs = [];
                        discarded = 0;
                    }

                    queryClient.setQueryData(servicesKey, {
                        services: event.services,
                        historyAvailable: event.historyAvailable,
                        retentionDays: event.retentionDays,
                    });
                    serviceStates = selectedLogServices(event.services, names).map((service) => ({ id: service.id, state: "connecting" }));
                } else if (event.type === "reset") {
                    liveLogs = liveLogs.filter((log) => log.serviceId !== event.serviceId);
                    incoming = incoming.filter((log) => log.serviceId !== event.serviceId);
                    incomingBytes = incoming.reduce((sum, log) => sum + log.message.length * 2 + 512, 0);

                    const replacement = event.replacement;

                    if (replacement) {
                        queryClient.setQueryData(servicesKey, (current) => current ? {
                            ...current,
                            services: current.services.map((service) => service.id === event.serviceId ? replacement : service),
                        } : current);
                        serviceStates = serviceStates.map((service) => service.id === event.serviceId ? { id: replacement.id, state: "connecting" } : service);
                    }
                } else if (event.type === "status") {
                    serviceStates = serviceStates.map((service) => service.id === event.serviceId ? { id: service.id, state: event.state, message: event.message } : service);
                } else {
                    for (const log of event.logs) {
                        incoming.push(log);
                        incomingBytes += log.message.length * 2 + 512;
                    }

                    if (incoming.length > 2000 || incomingBytes > 4 * 1024 * 1024) {
                        flush();
                        overflow = true;
                        streamError = "Log volume exceeded the live buffer. Reconnect or search a time range.";
                        clearInterval(timer);
                        stop();
                    }
                }
            },
            (error, retrying) => {
                flush();
                streamError = error.message;
                reconnecting = retrying;

                if (!retrying) clearInterval(timer);
            },
            () => {
                const ended = overflow || (serviceStates.length > 0 && serviceStates.every((service) => service.state === "error"));

                if (ended) {
                    flush();
                    clearInterval(timer);
                }

                return ended;
            },
            ["BAD_GATEWAY"],
        ));

        return () => {
            clearInterval(timer);
            stop();
            flushLive = () => {};
        };
    });

    $effect(() => {
        if (!visibleLogs.length) return;

        if (active && following && !selectedBucket && mode === "live" && viewport) viewport.scrollTop = viewport.scrollHeight;
    });

    $effect(() => {
        if (activeBucket !== null && !activity.buckets[activeBucket]?.total) activeBucket = null;
    });

    function togglePause() {
        if (!paused) flushLive();
        paused = !paused;
    }

    function reconnect() {
        paused = false;
        attempt++;
        reconnecting = false;
    }

    function changeMode(value: "live" | "search") {
        if (mode === value) return;
        resetSearch();
        mode = value;
        levelFilter = null;
        activeBucket = null;
        text = "";

        if (value === "search") chooseRange(preset);
    }

    async function search(older = false) {
        if (mode !== "search" || pending || !selectedIds.length || (older && (!submitted || !nextCursor))) return;
        const range = older && submitted ? submitted : { start, end, query: text, serviceIds: [...selectedIds] };
        const from = Date.parse(range.start);
        const until = Date.parse(range.end);

        if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 366 * 86_400_000) {
            searchError = "Choose valid dates with an end after the start, within a 366-day range.";

            return;
        }

        searchController?.abort();
        const controller = new AbortController();
        searchController = controller;
        const searchScope = scopeKey;
        const isCurrent = () => searchController === controller && !controller.signal.aborted && mode === "search" && scopeKey === searchScope;
        pending = true;
        searchError = "";

        try {
            const dates = { ...range, start: new Date(from).toISOString(), end: new Date(until).toISOString() };

            if (!older) {
                selectedBucket = null;
                submitted = dates;
                historyLogs = [];
                nextCursor = null;
                searched = false;
            }

            const result = await client.resources.searchLogs({ projectId, resourceId, ...dates, cursor: older ? nextCursor ?? undefined : undefined }, { signal: controller.signal });

            if (!isCurrent()) return;
            historyLogs = [...historyLogs, ...decorate(result.logs)];
            nextCursor = result.nextCursor;
            searched = true;

            if (!older && viewport) viewport.scrollTop = 0;
        } catch (error) {
            if (isCurrent()) searchError = error instanceof Error ? error.message : "Unable to search logs.";
        } finally {
            if (searchController === controller) pending = false;
        }
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault();

        if (preset !== "custom") chooseRange(preset);
        void search();
    }

    async function copy(log: DisplayLog) {
        copyError = "";

        try { await navigator.clipboard.writeText(log.message); copiedId = log.id; }
        catch { copyError = "Unable to copy. Select the message text to copy it manually."; }
    }

    function time(value: string | number, full = false) {
        return new Date(value).toLocaleString(undefined, full ? { dateStyle: "medium", timeStyle: "medium" } : { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
    }

    onDestroy(() => searchController?.abort());
</script>

<svelte:head>{#if active}<title>Logs / {resourceQuery.data?.name ?? "Resource"} / Stoat</title>{/if}</svelte:head>

{#if active}
<div class="flex h-[calc(100dvh-7rem)] min-h-160 min-w-0 w-full flex-col gap-3 py-3 xl:h-auto xl:min-h-0 xl:flex-1">
{#if resourceQuery.isError}
    <Alert variant="error"><AlertDescription>{resourceQuery.error.message}</AlertDescription></Alert>
    <Button variant="outline" size="sm" class="self-start" onclick={() => resourceQuery.refetch()}>Try again</Button>
{:else if servicesQuery.isError || (streamError && !servicesQuery.data)}
    <Alert variant="error"><AlertDescription>{servicesQuery.error?.message ?? streamError}</AlertDescription></Alert>
    <Button variant="outline" size="sm" class="self-start" onclick={reconnect}>Try again</Button>
{:else if !loading && !services.length}
    <Empty class="flex-1 rounded-2xl border border-dashed">
        <EmptyHeader><EmptyTitle>No deployed services</EmptyTitle><EmptyDescription>Deploy this resource to view logs from its current services.</EmptyDescription></EmptyHeader>
        <Button variant="outline" size="sm" href="/projects/{projectId}/{resourceId}">Open resource</Button>
    </Empty>
{:else}
    <Skeleton {loading} loading-label="Loading logs" class="flex min-h-0 min-w-0 flex-1 flex-col" background-color="color-mix(in oklab, var(--foreground) 8%, transparent)" shimmer-color="color-mix(in oklab, var(--foreground) 6%, transparent)">
    <Frame inert={loading} class="min-h-0 min-w-0 flex-1 overflow-hidden {mode === 'search' && preset === 'custom' ? 'max-xl:min-h-192' : ''}">
        <FrameHeader class="shrink-0 gap-3 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-1 rounded-lg bg-background/60 p-0.5" role="group" aria-label="Log source">
                    <Button variant={mode === "live" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "live"} onclick={() => changeMode("live")}>Live</Button>
                    <Button variant={mode === "search" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "search"} onclick={() => changeMode("search")}>Search</Button>
                </div>
                <Popover>
                    <PopoverTrigger class={buttonVariants({ variant: "outline", size: "sm" })}>
                        {selectedIds.length === services.length ? "All services" : `${selectedIds.length} services`}<ChevronDown class="size-3.5" aria-hidden="true" />
                    </PopoverTrigger>
                    <PopoverPopup align="start" class="w-80 max-w-[calc(100vw-2rem)]">
                        <PopoverTitle class="mb-2 text-sm font-medium">Services</PopoverTitle>
                        <Input size="sm" type="search" aria-label="Find a service" placeholder="Find a service..." bind:value={serviceSearch} />
                        <div class="my-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>Select up to 20</span>
                            <Button variant="ghost" size="xs" onclick={() => selection = (selection?.length ?? selectedIds.length) ? [] : services.slice(0, 20).map((service) => service.name)}>{(selection?.length ?? selectedIds.length) ? "Clear" : "Select all"}</Button>
                        </div>
                        <div class="max-h-64 space-y-1 overflow-y-auto">
                            {#each visibleServices as service (service.id)}
                                <label for={`log-service-${service.id}`} class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-muted">
                                    <Checkbox id={`log-service-${service.id}`} checked={selectedIds.includes(service.id)} onCheckedChange={(checked) => selectService(service.name, checked)} disabled={!selectedIds.includes(service.id) && (selection?.length ?? selectedIds.length) >= 20} />
                                    <span class="min-w-0 truncate text-sm" title={service.name}>{service.name}</span>
                                </label>
                            {/each}
                            {#if !visibleServices.length}<p class="py-3 text-sm text-muted-foreground">No matching services.</p>{/if}
                        </div>
                    </PopoverPopup>
                </Popover>
                <span data-shimmer-ignore class="min-w-16 flex-1 whitespace-nowrap text-xs text-muted-foreground"></span>
                {#if mode === "live" && (loading || selectedIds.length)}
                    <span role="status"><Badge variant={status === "Live" ? "success" : failures.length || streamError ? "warning" : "secondary"}>{status}</Badge></span>
                    <Button variant="outline" size="sm" onclick={togglePause}>
                        {#if paused}<Play class="size-3.5" aria-hidden="true" />Resume{:else}<Pause class="size-3.5" aria-hidden="true" />Pause{/if}
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Reconnect live logs" title="Refresh services and reload recent tail" disabled={servicesQuery.isFetching} onclick={reconnect}><RefreshCw class="size-3.5" aria-hidden="true" /></Button>
                {/if}
            </div>
            {#if mode === "live"}
                <Input size="sm" type="search" aria-label="Filter loaded logs" placeholder="Filter loaded logs..." bind:value={text} />
            {:else if servicesQuery.data?.historyAvailable}
                <form class="flex flex-col gap-2" onsubmit={submitSearch}>
                    <div class="flex flex-wrap items-center gap-2">
                        <div class="min-w-40 flex-1"><Input size="sm" type="search" aria-label="Search log messages" placeholder="Search messages (literal text)..." bind:value={text} maxlength={512} /></div>
                        <label class="sr-only" for="log-range">Time range</label>
                        <select id="log-range" class="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7" value={preset} onchange={(event) => chooseRange(event.currentTarget.value)}>
                            <option value="15m">Last 15 minutes</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="custom">Custom range</option>
                        </select>
                        <Button size="sm" type="submit" loading={pending} disabled={pending || !selectedIds.length}><Search class="size-3.5" aria-hidden="true" />Search</Button>
                    </div>
                    {#if preset === "custom"}
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div class="space-y-1"><Label for="log-start" class="text-xs">From</Label><Input id="log-start" size="sm" type="datetime-local" step="1" bind:value={start} required /></div>
                            <div class="space-y-1"><Label for="log-end" class="text-xs">Until</Label><Input id="log-end" size="sm" type="datetime-local" step="1" bind:value={end} required /></div>
                        </div>
                    {/if}
                    <p class="text-xs text-muted-foreground">{timezone}. {servicesQuery.data.retentionDays ? `Up to ${servicesQuery.data.retentionDays} days retained.` : "Within configured retention."} Current service IDs only.</p>
                </form>
            {/if}
        </FrameHeader>

        {#if mode === "search" && !servicesQuery.data?.historyAvailable}
            <FramePanel class="flex min-h-0 flex-1 items-center justify-center">
                <Empty><EmptyHeader><EmptyTitle>Historical logs unavailable</EmptyTitle><EmptyDescription>Initialize cluster monitoring to store and search logs in GreptimeDB. Live logs are still available.</EmptyDescription></EmptyHeader><Button variant="outline" size="sm" onclick={() => changeMode("live")}>View live logs</Button></Empty>
            </FramePanel>
        {:else}
            <FramePanel class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0">
                <section class="shrink-0 border-b px-3 py-2 sm:px-4" aria-label="Log activity">
                    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <p class="text-xs font-medium">Activity <span class="ml-1 font-normal text-muted-foreground">Loaded lines only</span></p>
                        <div class="flex flex-wrap gap-1" role="group" aria-label="Filter by log classification">
                            {#each series as item (item.key)}
                                <Button variant={levelFilter === item.key ? "secondary" : "ghost"} size="xs" class="gap-1.5 text-xs" aria-pressed={levelFilter === item.key} onclick={() => levelFilter = levelFilter === item.key ? null : item.key}>
                                    <span class="size-2 rounded-xs {item.color}" aria-hidden="true"></span><span class={item.foreground}>{item.label}</span><span class="font-mono tabular-nums">{activity.counts[item.key]}</span>
                                </Button>
                            {/each}
                        </div>
                    </div>
                    <TooltipProvider delay={100}>
                        <div class="relative mt-2 flex h-16 gap-1 border-b border-border sm:h-20" role="group" aria-label="Log activity by time. Hover for counts; select a bar to filter logs.">
                            {#each activity.buckets as bucket, index (index)}
                                {#if loading}
                                    <span class="min-w-0 flex-1 self-end rounded-t-sm" style:height={`${20 + (index * 17) % 65}%`}></span>
                                {:else if bucket.total > 0}
                                <Tooltip
                                    triggerId={`log-bucket-${index}`}
                                    bind:open={() => activeBucket === index, (open) => { if (open) activeBucket = index; else if (activeBucket === index) activeBucket = null; }}
                                    disabled={!matchedLogs.length}
                                >
                                    <TooltipTrigger
                                        id={`log-bucket-${index}`}
                                        type="button"
                                        closeOnClick={false}
                                        disabled={!matchedLogs.length}
                                        class="flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse justify-start rounded-t-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/60 aria-pressed:ring-1 aria-pressed:ring-foreground/70 {selectedBucket && selectedBucket.index !== index ? 'opacity-40' : ''}"
                                        aria-label="Show logs from {time(bucket.start)} to {time(bucket.end)}: {bucket.total} lines, {bucket.error} errors, {bucket.warning} warnings, {bucket.success} successes, {bucket.other} info"
                                        aria-pressed={selectedBucket?.index === index}
                                        aria-describedby={activeBucket === index && matchedLogs.length ? `log-bucket-tooltip-${index}` : undefined}
                                        onclick={() => selectBucket(index)}
                                    >
                                        {#each series as item (item.key)}
                                            <span class="w-full min-w-0 shrink-0 {item.color}" style:height={`${bucket[item.key] / activity.maximum * 100}%`}></span>
                                        {/each}
                                    </TooltipTrigger>
                                    <TooltipPopup id={`log-bucket-tooltip-${index}`} role="tooltip" side="top" sideOffset={8} class="w-60 max-w-[calc(100vw-2rem)] text-left">
                                        <div class="space-y-2 py-1.5">
                                            <div class="space-y-0.5 border-b pb-2">
                                                <p class="font-medium">{new Date(bucket.start).toLocaleDateString()} / {timezone}</p>
                                                <p class="font-mono text-[11px] text-muted-foreground">{time(bucket.start)} - {time(bucket.end)}</p>
                                            </div>
                                            <dl class="space-y-1">
                                                {#each series as item (item.key)}
                                                    <div class="flex items-center justify-between gap-4"><dt class={item.foreground}>{item.label}</dt><dd class="font-mono tabular-nums">{bucket[item.key].toLocaleString()}</dd></div>
                                                {/each}
                                                <div class="flex items-center justify-between gap-4 border-t pt-1.5 font-medium"><dt>Total</dt><dd class="font-mono tabular-nums">{bucket.total.toLocaleString()}</dd></div>
                                            </dl>
                                        </div>
                                    </TooltipPopup>
                                </Tooltip>
                                {:else}
                                    <span class="min-w-0 flex-1" aria-hidden="true"></span>
                                {/if}
                            {/each}
                            {#if !loading && !matchedLogs.length}<span class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{pending ? "Searching..." : "No activity loaded"}</span>{/if}
                        </div>
                    </TooltipProvider>
                    <div class="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                        <span>{loading ? "00:00:00.000" : logs.length || submitted ? time(chartStart) : ""}</span>
                        <span title="Classification uses explicit log levels and HTTP status codes. Informational and unclassified lines are shown as INFO.">Explicit levels / HTTP status</span>
                        <span>{loading ? "00:00:00.000" : logs.length || submitted ? time(chartEnd) : ""}</span>
                    </div>
                </section>

                {#if streamError && mode === "live"}
                    <Alert variant={reconnecting ? "warning" : "error"} class="m-2 shrink-0 px-3 py-2"><AlertDescription>{streamError} {#if reconnecting}Retrying with a fresh recent tail.{/if}</AlertDescription></Alert>
                {/if}
                {#if mode === "live" && failures.length}
                    <div class="shrink-0 border-b px-3 py-2 text-xs text-warning-foreground" role="status">
                        {#each failures as failure (failure.id)}<p>{services.find((service) => service.id === failure.id)?.name}: {failure.message ?? "Stream unavailable. Reconnect to retry."}</p>{/each}
                    </div>
                {/if}
                {#if searchError || copyError}<Alert variant="error" class="m-2 shrink-0 px-3 py-2"><AlertDescription>{searchError || copyError}</AlertDescription></Alert>{/if}

                <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
                    <p class="text-xs text-muted-foreground">{visibleLogs.length.toLocaleString()} lines{#if levelFilter} / {series.find((item) => item.key === levelFilter)?.label}{/if}{#if mode === "search" && searched}<span class="ml-2">Newest first</span>{/if}</p>
                    {#if selectedRange}
                        <p class="min-w-0 text-xs text-muted-foreground" role="status" title="{time(selectedRange.start, true)} to {time(selectedRange.end, true)}. The selected range stays fixed while logs arrive.">
                            {time(selectedRange.start)} - {time(selectedRange.end)}
                        </p>
                    {/if}
                    <div class="flex items-center gap-1">
                        {#if selectedBucket}<Button variant="outline" size="xs" onclick={() => selectBucket(null)}>Show all times</Button>{/if}
                        {#if levelFilter}<Button variant="ghost" size="xs" onclick={() => levelFilter = null}>Clear level filter</Button>{/if}
                        {#if mode === "live" && !following && !selectedBucket}<Button variant="ghost" size="xs" onclick={() => following = true}><ArrowDown class="size-3" aria-hidden="true" />Jump to latest</Button>{/if}
                        <Button variant={wrap ? "secondary" : "ghost"} size="icon-xs" aria-label="Wrap log lines" title="Wrap lines" aria-pressed={wrap} onclick={() => wrap = !wrap}><WrapText class="size-3.5" aria-hidden="true" /></Button>
                    </div>
                </div>

                <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must support keyboard scrolling.) -->
                <div bind:this={viewport} class="min-h-0 min-w-0 flex-1 overflow-auto bg-code p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-black/20" tabindex="0" role="region" aria-label="Log output" aria-busy={pending} onscroll={() => { if (viewport && mode === "live" && !selectedBucket) following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40; }}>
                    {#if loading}
                        <div class="flex h-full min-h-0 flex-col" aria-hidden="true">
                            {#each Array(16) as _, index (index)}
                                <div class="log-row log-placeholder min-h-0 basis-[38px] grid-rows-2 items-center px-1.5 font-mono text-xs md:basis-5 md:grid-rows-1">
                                    <span class="h-3/5 max-h-3 w-[11ch] rounded-xs"></span>
                                    <span class="h-3/5 max-h-3 w-[5ch] rounded-xs"></span>
                                    <span class="h-3/5 max-h-3 w-3/4 rounded-xs"></span>
                                    <span class="log-message h-3/5 max-h-3 rounded-xs" style:width={`${35 + (index * 19) % 60}%`}></span>
                                </div>
                            {/each}
                        </div>
                    {:else if !selectedIds.length}
                        <Empty class="h-full"><EmptyHeader><EmptyTitle>Select a service</EmptyTitle><EmptyDescription>Choose one or more services to view their logs.</EmptyDescription></EmptyHeader></Empty>
                    {:else if mode === "search" && !searched && !pending}
                        <Empty class="h-full"><EmptyHeader><EmptyTitle>Search stored logs</EmptyTitle><EmptyDescription>Choose a time range and search. Leave the message field empty to see all logs.</EmptyDescription></EmptyHeader></Empty>
                    {:else if !visibleLogs.length}
                        <Empty class="h-full"><EmptyHeader><EmptyTitle>{pending ? "Searching logs..." : selectedBucket ? "No matching logs in this time range" : matchedLogs.length && levelFilter ? "No lines at this level" : mode === "live" ? "Waiting for logs" : "No matching logs"}</EmptyTitle><EmptyDescription>{selectedBucket ? "Choose another bar, clear the level filter, or show all times to see more loaded logs." : mode === "live" ? "New output from selected services appears here." : "Try a wider time range, different services, or a shorter search."}</EmptyDescription></EmptyHeader></Empty>
                    {:else}
                        {#each visibleLogs as log (log.id)}
                            <details class="group rounded-md open:bg-muted/50" name="resource-log" bind:open={() => expandedLogId === log.id, (open) => { if (open) expandedLogId = log.id; else if (expandedLogId === log.id) expandedLogId = null; }}>
                                <summary class="log-row cursor-pointer list-none rounded-sm px-1.5 py-px font-mono text-xs leading-[18px] outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-6" class:nowrap={!wrap}>
                                    <time datetime={log.timestamp} class="whitespace-nowrap text-muted-foreground" title={log.timestamp}>{time(log.timestamp)}</time>
                                    <Badge size="sm" variant={log.level === "other" ? "secondary" : log.level} class="mt-px w-full h-4 justify-self-start self-start font-mono text-[10px] uppercase tracking-normal">{log.level === "other" ? "INFO" : log.level}</Badge>
                                    <span class="min-w-0 truncate text-muted-foreground" title={log.container ?? "Container not recorded"}>{log.container ?? "Unknown container"}</span>
                                    <span class="log-message min-w-0 whitespace-pre-wrap wrap-anywhere">{log.message}</span>
                                </summary>
                                {#if expandedLogId === log.id}
                                <div class="space-y-2 border-t border-border px-3 py-2">
                                    <div class="flex flex-wrap items-start justify-between gap-2">
                                        <dl class="grid min-w-0 gap-x-4 gap-y-1 text-xs sm:grid-cols-2 [&_dt]:mr-1">
                                            <div><dt class="inline text-muted-foreground">Time </dt><dd class="inline font-mono wrap-anywhere">{log.timestamp}</dd></div>
                                            <div><dt class="inline text-muted-foreground">Service </dt><dd class="inline font-mono wrap-anywhere">{log.serviceName}</dd></div>
                                            <div><dt class="inline text-muted-foreground">Machine </dt><dd class="inline font-mono wrap-anywhere">{log.machine ?? "Not recorded"}</dd></div>
                                            <div><dt class="inline text-muted-foreground">Container </dt><dd class="inline font-mono wrap-anywhere">{log.container ?? "Not recorded"}</dd></div>
                                            <div><dt class="inline text-muted-foreground">Stream </dt><dd class="inline font-mono">{log.stream ?? "Not recorded"}</dd></div>
                                        </dl>
                                        <Button variant="outline" size="xs" onclick={() => copy(log)}>{#if copiedId === log.id}<Check class="size-3" aria-hidden="true" />Copied{:else}<Copy class="size-3" aria-hidden="true" />Copy{/if}</Button>
                                    </div>
                                    <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 wrap-anywhere">{log.message}</pre>
                                </div>
                                {/if}
                            </details>
                        {/each}
                    {/if}
                </div>

                <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                    {#if mode === "live"}
                        <span>{timezone}</span>
                    {:else}
                        <p class="min-w-0 flex-1 truncate" title={searchSummary}>{searchSummary}</p>
                        {#if nextCursor}<Button variant="outline" size="sm" loading={pending} disabled={pending || historyLogs.length >= 2000} onclick={() => search(true)}>Load older</Button>{/if}
                        {#if historyLogs.length >= 2000 && nextCursor}<span>Narrow the range to browse more than 2,000 lines.</span>{/if}
                    {/if}
                </div>
            </FramePanel>
        {/if}
    </Frame>
    </Skeleton>
{/if}
</div>
{/if}

<style>
    details:not([open]):has(> .nowrap) { content-visibility: auto; contain-intrinsic-block-size: auto 38px; }
    .log-row { display: grid; grid-template-columns: 12ch 7ch minmax(0, 1fr); column-gap: 0.5rem; }
    .log-message { grid-column: 1 / -1; }
    .nowrap .log-message { max-height: 18px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    summary::-webkit-details-marker { display: none; }
    @media (max-width: 767px) {
        .log-placeholder:nth-child(n + 9) { display: none; }
    }
    @media (min-width: 768px) {
        details:not([open]):has(> .nowrap) { contain-intrinsic-block-size: auto 20px; }
        .log-row { grid-template-columns: 12ch 7ch 22ch minmax(0, 1fr); }
        .log-message { grid-column: auto; }
    }
</style>
