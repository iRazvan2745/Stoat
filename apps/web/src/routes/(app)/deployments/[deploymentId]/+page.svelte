<script lang="ts">
    import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
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
    import { Empty, EmptyDescription, EmptyHeader } from "$lib/components/ui/empty";
    import { ScrollArea } from "$lib/components/ui/scroll-area";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Spinner } from "$lib/components/ui/spinner";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import Info from "@lucide/svelte/icons/info";
    import Terminal from "@lucide/svelte/icons/terminal";
    import { createMutation } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { watch } from "runed";
    import { untrack } from "svelte";

    let {
        open = $bindable(false),
        deploymentId,
    }: {
        open?: boolean;
        deploymentId: string | null;
    } = $props();

    type DeploymentEvent = Awaited<ReturnType<typeof client.cluster.streamDeployment>> extends AsyncIterable<infer T> ? T : never;

    let deployment = $state<DeploymentEvent["deployment"] | null>(null);

    let logs = $state<DeploymentEvent["logs"]>([]);

    let cancelAllowed = $state(false);

    let streamError = $state("");

    let reconnecting = $state(false);

    let showDebug = $state(false);

    const visibleLogs = $derived(showDebug ? logs : logs.filter((line) => line.metadata?.level !== "debug"));

    $effect(() => {
        const id = deploymentId;

        if (!open || !id) return;

        deployment = null;
        logs = [];
        cancelAllowed = false;
        streamError = "";
        reconnecting = false;
        showDebug = false;
        untrack(() => cancelMutationState.reset());
        let afterId = 0;
        let completed = false;
        let streamComplete = false;

        return subscribeToStream(
            (signal) => client.cluster.streamDeployment({ deploymentId: id, afterId }, { signal }),
            (event) => {
                streamComplete = event.complete;
                deployment = event.deployment;
                cancelAllowed = event.canCancel;
                streamError = "";
                reconnecting = false;

                // IDs are ordered by the server, including chunked replay and reconnects.
                for (const line of event.logs) {
                    if (line.id <= afterId) continue;
                    logs.push(line);
                    afterId = line.id;
                }

                if (!completed && ["ready", "failed", "cancelled"].includes(event.deployment.status)) {
                    completed = true;
                    void queryClient.invalidateQueries({ queryKey: orpc.cluster.key() });

                    if (event.deployment.resourceId) {
                        void queryClient.invalidateQueries({ queryKey: orpc.resources.key() });
                    }
                }
            },
            (error, retrying) => {
                streamError = error.message || "Unable to stream deployment logs.";
                reconnecting = retrying;
            },
            () => streamComplete,
        );
    });

    const status = $derived(deployment?.status ?? "queued");

    const isActive = $derived(status === "queued" || status === "running");

    const statusLabel = $derived(
        Match.value(status).pipe(
            Match.when("queued", () => "Queued"),
            Match.when("running", () => "Running"),
            Match.when("ready", () => "Ready"),
            Match.when("failed", () => "Failed"),
            Match.when("cancelled", () => "Cancelled"),
            Match.orElse(() => status),
        ),
    );

    const statusVariant = $derived<"success" | "warning" | "error" | "secondary">(
        status === "ready"
            ? "success"
            : status === "failed"
              ? "error"
              : status === "queued" || status === "running"
                ? "warning"
                : "secondary",
    );

    const canCancel = $derived(cancelAllowed && isActive);

    const durationMs = $derived.by(() => {
        if (!deployment) return null;
        const start = new Date(deployment.createdAt).getTime();
        const end = deployment.finishedAt ? new Date(deployment.finishedAt).getTime() : Date.now();

        return Math.max(0, end - start);
    });

    function formatDuration(ms: number) {
        const seconds = Math.floor(ms / 1000);

        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
        const hours = Math.floor(minutes / 60);

        return `${hours}h ${minutes % 60}m`;
    }

    function formatTime(value: Date | string) {
        return new Date(value).toLocaleTimeString();
    }

    let logContainer: HTMLElement | null = $state(null);

    const cancelMutationState = createMutation(() =>
        orpc.cluster.cancelDeployment.mutationOptions({
            onSuccess: (_data, input) => {
                if (deploymentId === input.deploymentId) cancelAllowed = false;
                void queryClient.invalidateQueries({ queryKey: orpc.cluster.key() });
                void queryClient.invalidateQueries({ queryKey: orpc.resources.key() });
            },
        }),
    );

    const cancelErrorMessage = $derived(
        cancelMutationState.error
            ? cancelMutationState.error.message || "Unable to cancel the deployment."
            : "",
    );

    function cancelDeployment() {
        if (!deploymentId || !canCancel || cancelMutationState.isPending) return;
        cancelMutationState.mutate({ deploymentId });
    }

    // Follow the visible output, including changes to the debug filter.
    watch(
        () => visibleLogs.length,
        () => {
            if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
        },
    );
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-3xl">
        <DialogHeader>
            <DialogTitle>
                <span class="flex items-center gap-2">
                    <Terminal class="size-4 text-muted-foreground" aria-hidden="true" />
                    {deployment?.name ?? "Deployment"}
                </span>
            </DialogTitle>
            <DialogDescription>
                {#if deployment}
                    Started {new Date(deployment.createdAt).toLocaleString()}
                    {#if durationMs !== null}
                        · ran {formatDuration(durationMs)}
                    {/if}
                {:else}
                    Live deployment status and logs.
                {/if}
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if streamError}
                <Alert variant={reconnecting ? "warning" : "error"} class="mb-4">
                    <Info aria-hidden="true" />
                    <AlertTitle>{reconnecting ? "Reconnecting to deployment" : "Deployment stream stopped"}</AlertTitle>
                    <AlertDescription>
                        {streamError}
                        {#if reconnecting}Saved log output is retained while reconnecting.{/if}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if !deployment && !streamError}
                <Skeleton loading loading-label="Loading deployment">
                    <div class="space-y-3">
                        <div class="flex items-center gap-2">
                            <Badge variant="secondary">Queued</Badge>
                            <span class="text-xs text-muted-foreground">Deployment status</span>
                        </div>
                        <div class="min-h-64 rounded-lg border border-border bg-muted/20 p-4 font-mono text-xs">
                            <p>Preparing deployment configuration...</p>
                            <p class="mt-2">Waiting for cluster response...</p>
                        </div>
                    </div>
                </Skeleton>
            {:else if deployment}
                <div class="space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                        <Badge variant={statusVariant}>
                            {#if status === "ready"}
                                <CircleCheck aria-hidden="true" />
                            {:else if status === "failed"}
                                <CircleAlert aria-hidden="true" />
                            {:else if isActive}
                                <Spinner aria-hidden="true" />
                            {/if}
                            {statusLabel}
                        </Badge>
                        {#if isActive}
                            <span class="text-xs text-muted-foreground">Logs update automatically while running.</span>
                        {/if}
                        <Button
                            variant="ghost"
                            size="sm"
                            class="ml-auto"
                            aria-pressed={showDebug}
                            onclick={() => (showDebug = !showDebug)}
                        >{showDebug ? "Hide debug logs" : "Show debug logs"}</Button>
                    </div>

                    {#if deployment.error}
                        <Alert variant={status === "failed" ? "error" : "info"}>
                            {#if status === "failed"}
                                <CircleAlert aria-hidden="true" />
                                <AlertTitle>Deployment failed</AlertTitle>
                            {:else}
                                <Info aria-hidden="true" />
                                <AlertTitle>Deployment {statusLabel.toLowerCase()}</AlertTitle>
                            {/if}
                            <AlertDescription>{deployment.error}</AlertDescription>
                        </Alert>
                    {/if}

                    <ScrollArea
                        bind:viewportRef={logContainer}
                        orientation="vertical"
                        class="h-80 rounded-lg border border-border bg-black/90"
                        fill
                    >
                        <div
                            class="min-h-full p-4 font-mono text-xs leading-relaxed text-zinc-200"
                            role="log"
                            aria-label="Deployment logs"
                        >
                            {#if visibleLogs.length === 0}
                                <Empty class="h-full p-6 text-zinc-500 md:py-6">
                                    <EmptyHeader>
                                        <EmptyDescription class="text-zinc-500">
                                            {#if logs.length > 0}
                                                Only debug logs are available. Enable debug logs to view them.
                                            {:else if isActive}
                                                <span class="flex items-center justify-center gap-2">
                                                    <Spinner class="size-4" aria-hidden="true" />
                                                    Waiting for logs…
                                                </span>
                                            {:else}
                                                No logs were recorded for this deployment.
                                            {/if}
                                        </EmptyDescription>
                                    </EmptyHeader>
                                </Empty>
                            {:else}
                                {#each visibleLogs as line (line.id)}
                                    <div class="flex gap-3">
                                        <span class="shrink-0 text-zinc-500">{formatTime(line.createdAt)}</span>
                                        <span class="min-w-0 break-words whitespace-pre-wrap" class:text-red-400={line.metadata?.level === "error"} class:text-zinc-500={line.metadata?.level === "debug"}>{line.text}</span>
                                    </div>
                                {/each}
                            {/if}
                        </div>
                    </ScrollArea>

                </div>
            {/if}
        </DialogPanel>

        <DialogFooter>
            {#if cancelErrorMessage}
                <Alert variant="error" class="mr-auto w-auto py-2">
                    <AlertDescription>{cancelErrorMessage}</AlertDescription>
                </Alert>
            {/if}
            {#if canCancel}
                <Button
                    variant="destructive"
                    loading={cancelMutationState.isPending}
                    disabled={cancelMutationState.isPending}
                    onclick={cancelDeployment}
                >
                    Cancel deployment
                </Button>
            {/if}
            <Button variant="outline" onclick={() => (open = false)}>Close</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
