<script lang="ts">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/orpc";
    import Database from "@lucide/svelte/icons/database";
    import Info from "@lucide/svelte/icons/info";
    import { createQuery } from "@tanstack/svelte-query";
    import ConnectionField from "./connection-field.svelte";

    let {
        open = $bindable(false),
        clusterId,
    }: {
        open?: boolean;
        clusterId: string;
    } = $props();

    const connectionQuery = createQuery(() =>
        orpc.cluster.getMonitoringConnection.queryOptions({
            input: { clusterId },
            enabled: open && clusterId.length > 0,
        }),
    );

    const connection = $derived(connectionQuery.data);

    const configured = $derived(connection?.configured === true ? connection : null);
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-xl">
        <DialogHeader>
            <DialogTitle>
                <span class="flex items-center gap-2">
                    <Database class="size-4 text-muted-foreground" aria-hidden="true" />
                    Monitoring connection
                </span>
            </DialogTitle>
            <DialogDescription>
                GreptimeDB credentials and endpoints for dashboards like Grafana.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if connectionQuery.isPending}
                <Skeleton loading count={3} count-gap={16} loading-label="Loading connection details">
                    <ConnectionField label="Connection endpoint" value="https://monitoring.example.com" />
                </Skeleton>
            {:else if connectionQuery.isError}
                <Alert variant="error">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        {(connectionQuery.error as Error).message || "Could not load connection details."}
                    </AlertDescription>
                </Alert>
            {:else if !configured}
                <Alert variant="info">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        Monitoring isn't initialized for this cluster yet, so there are no credentials to show.
                    </AlertDescription>
                </Alert>
            {:else if configured}
                <div class="space-y-4">
                    <ConnectionField label="HTTP endpoint (dashboard + SQL)" value={configured.httpUrl} />
                    <ConnectionField
                        label="Ingest endpoint (Prometheus / Loki)"
                        value={configured.ingestUrl}
                    />
                    <div class="grid gap-4 sm:grid-cols-2">
                        <ConnectionField label="Database" value={configured.database} />
                        <ConnectionField label="Username" value={configured.username} />
                    </div>
                    {#if configured.canReveal}
                        {#if configured.password}
                            <ConnectionField label="Password" value={configured.password} secret />
                        {:else}
                            <Alert variant="warning">
                                <Info aria-hidden="true" />
                                <AlertDescription>
                                    The stored credential couldn't be decrypted — the app secret
                                    likely rotated since issuance. Re-run initialization to issue
                                    a fresh password.
                                </AlertDescription>
                            </Alert>
                        {/if}
                    {:else}
                        <Alert variant="info">
                            <Info aria-hidden="true" />
                            <AlertDescription>
                                Only organization owners and admins can reveal the password.
                            </AlertDescription>
                        </Alert>
                    {/if}
                    <p class="text-xs text-muted-foreground">
                        These endpoints use Uncloud internal DNS and are reachable from inside
                        the cluster network. If your dashboard runs elsewhere, use a published
                        port or machine address with the same ports.
                    </p>
                </div>
            {/if}
        </DialogPanel>

        <DialogFooter>
            <Button variant="outline" onclick={() => (open = false)}>Close</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
