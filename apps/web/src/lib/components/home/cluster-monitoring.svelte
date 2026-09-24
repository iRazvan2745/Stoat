<script lang="ts">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/orpc";
    import { createQuery } from "@tanstack/svelte-query";

    type ClusterOption = { id: string; name: string; initializedAt?: unknown };

    let {
        clusters = [],
        clusterId = $bindable(""),
    }: {
        clusters: ClusterOption[];
        clusterId: string;
    } = $props();

    const metricsQuery = createQuery(() =>
        orpc.cluster.getClusterMetrics.queryOptions({
            input: { clusterId },
            enabled: clusterId.length > 0,
        }),
    );

    const metrics = $derived(metricsQuery.data);

    type Usage = { used: number; total: number } | null;

    function percent(usage: Usage): number | null {
        if (!usage || usage.total <= 0) return null;
        return Math.min(100, Math.max(0, (usage.used / usage.total) * 100));
    }

    function formatBytes(value: number): string {
        if (!Number.isFinite(value)) return "—";
        const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
        let v = Math.max(0, value);
        let i = 0;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i += 1;
        }
        return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
    }

    function formatCores(value: number): string {
        return `${value.toFixed(value >= 100 ? 0 : 1)} cores`;
    }
</script>

<Card>
    <CardHeader class="p-4 sm:p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
                <CardTitle>Cluster monitoring</CardTitle>
                <CardDescription class="mt-1">CPU, memory, and disk usage over the last 5 minutes.</CardDescription>
            </div>
            {#if clusters.length > 1}
                <select
                    class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="Select cluster"
                    bind:value={() => clusterId, (id) => (clusterId = id)}
                >
                    {#each clusters as cluster (cluster.id)}
                        <option value={cluster.id}>{cluster.name}</option>
                    {/each}
                </select>
            {/if}
        </div>
    </CardHeader>
    <CardPanel class="p-4 pt-0 sm:p-5 sm:pt-0">
        {#if metricsQuery.isPending}
            <Skeleton loading loading-label="Loading cluster metrics">
                <p class="text-sm">CPU memory disk</p>
            </Skeleton>
        {:else if metricsQuery.isError}
            <Alert variant="error">
                <AlertDescription>Unable to load metrics: {metricsQuery.error.message}</AlertDescription>
            </Alert>
        {:else if !metrics}
            <p class="text-sm text-muted-foreground">No metrics available.</p>
        {:else if !metrics.available}
            <p class="text-sm text-muted-foreground">
                {#if metrics.reason === "uninitialized"}
                    Initialize monitoring for this cluster to see usage.
                {:else}
                    Metrics are currently unreachable. The cluster may be offline.
                {/if}
            </p>
        {:else}
            {@const cpuPct = percent(metrics.cpu)}
            {@const memPct = percent(metrics.memory)}
            {@const diskPct = percent(metrics.disk)}
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div class="rounded-lg border p-3">
                    <p class="text-xs text-muted-foreground">Machines</p>
                    <p class="mt-1 text-xl font-semibold">{metrics.machines}</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">Reporting in window</p>
                </div>
                <div class="rounded-lg border p-3">
                    <p class="text-xs text-muted-foreground">CPU</p>
                    <p class="mt-1 text-xl font-semibold">
                        {metrics.cpu ? formatCores(metrics.cpu.used) : "—"}
                    </p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                        {metrics.cpu ? `of ${formatCores(metrics.cpu.total)}${cpuPct !== null ? ` · ${cpuPct.toFixed(0)}%` : ""}` : "No data"}
                    </p>
                    {#if cpuPct !== null}
                        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-primary" style={`width: ${cpuPct}%`}></div>
                        </div>
                    {/if}
                </div>
                <div class="rounded-lg border p-3">
                    <p class="text-xs text-muted-foreground">Memory</p>
                    <p class="mt-1 text-xl font-semibold">
                        {metrics.memory ? formatBytes(metrics.memory.used) : "—"}
                    </p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                        {metrics.memory ? `of ${formatBytes(metrics.memory.total)}${memPct !== null ? ` · ${memPct.toFixed(0)}%` : ""}` : "No data"}
                    </p>
                    {#if memPct !== null}
                        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-primary" style={`width: ${memPct}%`}></div>
                        </div>
                    {/if}
                </div>
                <div class="rounded-lg border p-3">
                    <p class="text-xs text-muted-foreground">Disk (/)</p>
                    <p class="mt-1 text-xl font-semibold">
                        {metrics.disk ? formatBytes(metrics.disk.used) : "—"}
                    </p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                        {metrics.disk ? `of ${formatBytes(metrics.disk.total)}${diskPct !== null ? ` · ${diskPct.toFixed(0)}%` : ""}` : "No data"}
                    </p>
                    {#if diskPct !== null}
                        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-primary" style={`width: ${diskPct}%`}></div>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    </CardPanel>
</Card>
