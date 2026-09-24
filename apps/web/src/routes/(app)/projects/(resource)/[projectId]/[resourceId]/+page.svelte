<script lang="ts">
    import { beforeNavigate } from "$app/navigation";
    import { page } from "$app/state";
    import DeploymentDialog from "$lib/components/clusters/deployment-dialog.svelte";
    import CodeEditor from "$lib/components/code-editor.svelte";
    import PreviewComposeDialog from "$lib/components/projects/preview-compose-dialog.svelte";
    import { getHeaderActions } from "$lib/components/sidebar/header-actions";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { containerInfo } from "$lib/container-info";
    import { client, orpc, queryClient } from "$lib/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Box from "@lucide/svelte/icons/box";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Container from "@lucide/svelte/icons/container";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { onDestroy, onMount, untrack } from "svelte";

    const headerActions = getHeaderActions();

    onMount(() => {
        headerActions.content = deployAction;

        return () => {
            if (headerActions.content === deployAction) headerActions.content = undefined;
        };
    });

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const projectsQuery = createQuery(() => orpc.projects.listProjects.queryOptions());

    const project = $derived((projectsQuery.data ?? []).find((p) => p.id === projectId));

    const clusterId = $derived(project?.clusterId ?? "");

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: projectId.length > 0 && resourceId.length > 0,
        }),
    );

    const resource = $derived(resourceQuery.data);

    const hasUndeployedChanges = $derived(
        (resource?.draftSpec ?? "") !== (resource?.spec ?? ""),
    );

    let deploymentId = $state<string | null>(null);

    let deploymentOpen = $state(false);

    const containersQuery = createQuery(() =>
        orpc.resources.getContainers.queryOptions({
            input: { projectId, resourceId, clusterId },
            enabled: projectId.length > 0 && resourceId.length > 0 && clusterId.length > 0 && Boolean(resource?.spec?.trim()),
        }),
    );

    const containers = $derived(containersQuery.data ?? []);


    let compose = $state("");

    let loadedResourceId = $state("");

    let savedSpec = $state<string | null>(null);

    // Keep the source identity paired with the editor baseline, not live query data.
    let savedSource = $state<{ connectionId: string; repositoryUrl: string; branch: string; path: string; revision: string } | null>(null);

    let gitPending = $state(false);

    let gitError = $state("");

    let gitStatus = $state("");

    let generation = 0;

    let active = true;

    const isDirty = $derived(compose !== (savedSpec ?? ""));

    beforeNavigate((navigation) => {
        if (busy || isDirty) {
            if (navigation.willUnload || busy || !window.confirm("Discard unsaved Compose edits?")) navigation.cancel();
        }
    });

    onDestroy(() => {
        active = false;
    });

    $effect(() => {
        // Route components are reused when switching between resources.
        const identity = `${projectId}/${resourceId}`;
        untrack(() => {
            if (identity) generation++;
            loadedResourceId = "";
            compose = "";
            savedSpec = null;
            savedSource = null;
            gitError = gitStatus = "";
            gitPending = false;
            saveMutation.reset();
            deployMutation.reset();
            deploymentId = null;
            deploymentOpen = false;
        });
    });

    $effect(() => {
        const current = resource;

        if (!current || current.id !== resourceId) return;
        untrack(() => {
            if (loadedResourceId !== current.id) {
                loadedResourceId = current.id;
                compose = current.draftSpec ?? "";
                savedSpec = current.draftSpec;
                savedSource = current.gitConnectionId && current.gitSource ? { connectionId: current.gitConnectionId, ...current.gitSource } : null;
                saveMutation.reset();
            } else if (!isDirty && !busy) {
                compose = current.draftSpec ?? "";
                savedSpec = current.draftSpec;
                savedSource = current.gitConnectionId && current.gitSource ? { connectionId: current.gitConnectionId, ...current.gitSource } : null;
            }
        });
    });

    const saveMutation = createMutation(() =>
        orpc.resources.updateComposeSpec.mutationOptions({
            onSuccess: (updated, input) => {
                if (active && projectId === input.projectId && resourceId === input.resourceId && loadedResourceId === updated.id) {
                    savedSpec = updated.draftSpec;
                    savedSource = updated.gitConnectionId && updated.gitSource ? { connectionId: updated.gitConnectionId, ...updated.gitSource } : null;
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getContainers.key({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
        }),
    );

    const deployMutation = createMutation(() =>
        orpc.resources.deploy.mutationOptions({
            onSuccess: (deployment, input) => {
                void queryClient.invalidateQueries({ queryKey: orpc.cluster.key() });

                if (!active || projectId !== input.projectId || resourceId !== input.resourceId) return;
                deploymentId = deployment.id;
                deploymentOpen = true;
            },
        }),
    );

    const busy = $derived(gitPending || saveMutation.isPending || deployMutation.isPending);

    const formattedComposeQuery = createQuery(() =>
        orpc.resources.getFormattedCompose.queryOptions({
            input: { projectId, resourceId },
            // Validate each saved version, never the unsaved editor text.
            queryKey: [...orpc.resources.getFormattedCompose.queryKey({ input: { projectId, resourceId } }), resource?.updatedAt],
            enabled: !!resource?.draftSpec?.trim() && !isDirty && !busy,
            retry: false,
        }),
    );

    const canDeploy = $derived(
        !!resource && !!project && loadedResourceId === resourceId && !!savedSpec?.trim() &&
        savedSpec === resource.draftSpec && !isDirty && !busy && !resourceQuery.isFetching && formattedComposeQuery.isSuccess &&
        !formattedComposeQuery.isFetching && formattedComposeQuery.data.serviceCount > 0,
    );

    function deploySavedDraft() {
        if (!canDeploy) return;
        deployMutation.mutate({ projectId, resourceId });
    }

    function saveCompose() {
        if (!isDirty || busy || loadedResourceId !== resourceId) return;
        saveMutation.mutate({ projectId, resourceId, spec: compose, expectedSpec: savedSpec, expectedSource: savedSource ? { ...savedSource } : null });
    }

    async function gitAction(action: "source" | "pull" | "detach" | "push", source?: { connectionId: string; repositoryUrl: string; branch: string; path: string }, message?: string) {
        if (busy || !resource || loadedResourceId !== resourceId) return false;

        if ((action === "source" || action === "pull") && (isDirty || savedSpec !== null) && !window.confirm("Replace the current Compose draft with the Git version? Saved local drafts and unsaved edits will be replaced.")) return false;

        if (action === "detach" && !window.confirm("Detach the Git source? The current Compose spec and editor text will be retained.")) return false;
        const input = { projectId, resourceId };
        const currentGeneration = generation;
        const submitted = compose;
        const expectedSpec = savedSpec;
        const expectedSource = savedSource ? { ...savedSource } : null;
        const expectedRevision = expectedSource?.revision;
        gitPending = true;
        gitError = gitStatus = "";

        try {
            let updated;

            if (action === "source" && source) {
                updated = await client.resources.setGitSource({ ...input, ...source, expectedSpec, expectedSource });
            } else if (action === "pull") {
                updated = await client.resources.pullGitSource({ ...input, expectedSpec, expectedSource });
            } else if (action === "detach") {
                updated = await client.resources.detachGitSource({ ...input, expectedSpec, expectedSource });
            } else if (action === "push" && expectedRevision && message?.trim()) {
                updated = await client.resources.pushGitSource({ ...input, spec: submitted, expectedSpec, expectedSource, expectedRevision, message: message.trim() });
            } else return false;
            queryClient.setQueryData(orpc.resources.getResource.queryKey({ input }), updated);
            void queryClient.invalidateQueries({ queryKey: orpc.resources.listResources.queryKey({ input: { projectId: input.projectId } }) });
            void queryClient.invalidateQueries({ queryKey: orpc.resources.getContainers.key({ input }) });

            if (!active || generation !== currentGeneration || projectId !== input.projectId || resourceId !== input.resourceId) return false;

            // Do not overwrite text typed while a request was in flight, or a draft on detach.
            if (action !== "detach" && compose === submitted) compose = updated.draftSpec ?? "";
            savedSpec = updated.draftSpec;
            savedSource = updated.gitConnectionId && updated.gitSource ? { connectionId: updated.gitConnectionId, ...updated.gitSource } : null;
            saveMutation.reset();
            gitStatus = Match.value(action).pipe(
                Match.when("push", () => "Commit pushed and draft saved."),
                Match.when("detach", () => "Git source detached. Compose retained."),
                Match.orElse(() => "Compose imported from Git."),
            );

            return true;
        } catch (cause) {
            if (active && generation === currentGeneration) gitError = `${cause instanceof Error ? cause.message : "Git operation failed."} Your editor text has been kept.`;

            return false;
        } finally {
            if (active && generation === currentGeneration) gitPending = false;
        }
    }
</script>

<svelte:head><title>{resource?.name ?? "Resource"} / Stoat</title></svelte:head>

{#snippet deployAction()}
    <Button
        onclick={deploySavedDraft}
        loading={deployMutation.isPending}
        disabled={!canDeploy}
        title={hasUndeployedChanges ? "Saved draft has undeployed changes" : "Deploy"}
    >
        <span class="inline-flex items-baseline gap-0.5">
            Deploy
            {#if hasUndeployedChanges}
                <span class="inline-block origin-center text-md leading-none text-orange-500 scale-125" aria-hidden="true">*</span>
                <span class="sr-only">(undeployed changes)</span>
            {/if}
        </span>
    </Button>
{/snippet}

<div class="flex w-full flex-col gap-6 py-6 xl:min-h-0 xl:flex-1 xl:pb-0">
    {#if projectsQuery.isPending || resourceQuery.isPending}
        <Skeleton loading loading-label="Loading resource">
            <div class="space-y-6">
                <div class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0">
                    <Frame class="w-full min-w-0 xl:col-span-1 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid">
                        <FrameHeader class="shrink-0">
                            <FrameTitle class="text-base"><h2>Containers</h2></FrameTitle>
                            <FrameDescription class="mt-1">Runtime status across machines.</FrameDescription>
                        </FrameHeader>
                        <FramePanel class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none">
                            <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                                <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                    <Box class="size-5" aria-hidden="true" />
                                </span>
                                <div class="min-w-0">
                                    <h3 class="truncate text-sm font-medium leading-5">Container service</h3>
                                    <p class="mt-1 truncate text-xs leading-5 text-muted-foreground">image:latest &middot; machine</p>
                                </div>
                                <Badge variant="secondary" class="col-start-2 sm:col-start-auto">Healthy</Badge>
                            </div>
                        </FramePanel>
                    </Frame>
                    <Frame class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid">
                        <FrameHeader class="shrink-0 flex-row flex-wrap items-start justify-between gap-2">
                            <div class="min-w-0">
                                <FrameTitle class="text-base"><h2>Docker Compose</h2></FrameTitle>
                                <FrameDescription class="mt-1">Edit the Docker Compose YAML for this resource.</FrameDescription>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button variant="secondary" disabled>Preview compose</Button>
                                <Button disabled>Save draft</Button>
                            </div>
                        </FrameHeader>
                        <FramePanel class="min-h-88 overflow-hidden bg-code p-0 dark:bg-black/20" />
                    </Frame>
                </div>
            </div>
        </Skeleton>
    {:else if projectsQuery.isError}
        <div class="space-y-4">
            <Alert variant="error">
                <AlertDescription>
                    Unable to load project: {projectsQuery.error.message}
                </AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" href="/projects">
                <ArrowLeft class="size-4" aria-hidden="true" />
                Back to projects
            </Button>
        </div>
    {:else if !project}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Boxes aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Project not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another organization.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/projects">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to projects
                </Button>
            </EmptyContent>
        </Empty>
    {:else if resourceQuery.isError}
        <div class="space-y-4">
            <Alert variant="error">
                <AlertDescription>
                    Unable to load resource: {resourceQuery.error.message}
                </AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" href="/projects/{projectId}">
                <ArrowLeft class="size-4" aria-hidden="true" />
                Back to {project.name}
            </Button>
        </div>
    {:else if !resource}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Container aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Resource not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another organization.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/projects/{projectId}">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to {project.name}
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        <div class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0">
            <Frame class="w-full min-w-0 xl:col-span-1 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid" role="region" aria-labelledby="containers-heading">
                <FrameHeader class="shrink-0">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <FrameTitle class="text-base"><h2 id="containers-heading">Containers</h2></FrameTitle>
                        <span class="text-xs tabular-nums text-muted-foreground">
                            {#if resource.spec?.trim() && containersQuery.data !== undefined}
                                {containers.length} {containers.length === 1 ? "container" : "containers"}
                            {/if}
                        </span>
                    </div>
                    <FrameDescription class="mt-1">Runtime status across machines.</FrameDescription>
                </FrameHeader>
                <FramePanel class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none">
                    {#if !resource.spec?.trim()}
                        <Empty class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4">
                            <EmptyHeader>
                                <EmptyDescription>
                                    Deploy a Compose spec to view this resource's containers.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else}
                        {#if containersQuery.isError}
                            <Alert variant="error" class="m-3">
                                <AlertDescription>
                                    Unable to load containers: {containersQuery.error.message}
                                    {#if containers.length > 0}Showing previously loaded containers.{/if}
                                </AlertDescription>
                            </Alert>
                        {/if}
                        {#if containersQuery.isPending}
                            <Skeleton loading count={2} count-gap={1} loading-label="Loading containers">
                                <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                        <Box class="size-5" aria-hidden="true" />
                                    </span>
                                    <div class="min-w-0">
                                        <h3 class="truncate text-sm font-medium leading-5">Container service</h3>
                                        <p class="mt-1 truncate text-xs leading-5 text-muted-foreground">image:latest &middot; machine</p>
                                    </div>
                                    <Badge variant="secondary" class="col-start-2 sm:col-start-auto">Healthy</Badge>
                                </div>
                            </Skeleton>
                        {:else if containers.length > 0}
                            <ul>
                                {#each containers as item, index (`${item.machineId}-${item.container.Id ?? index}`)}
                                    {@const info = containerInfo(item.container)}
                                    <li class="min-w-0">
                                        {#if index > 0}<Separator />{/if}
                                        <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                                            <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                                <Box class="size-5" aria-hidden="true" />
                                            </span>
                                            <div class="min-w-0">
                                                <h3 class="truncate text-sm font-medium leading-5" title={info.name}>{info.name}</h3>
                                                <p
                                                    class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                                    title={`${info.image} · ${item.machineName || item.machineId || "Unknown machine"}${info.id ? ` · ${info.id}` : ""}`}
                                                >
                                                    {info.image} &middot; {item.machineName || item.machineId || "Unknown machine"}
                                                    {#if info.id}
                                                        &middot; <span class="font-mono" title={info.id}>{info.id.slice(0, 12)}</span>
                                                    {/if}
                                                </p>
                                            </div>
                                            <Badge
                                                variant={info.healthVariant}
                                                class="col-start-2 shrink-0 justify-self-start whitespace-nowrap capitalize sm:col-start-auto sm:justify-self-end"
                                                aria-label={`Health: ${info.health}. Runtime status: ${info.status}`}
                                                title={`Runtime status: ${info.status}`}
                                            >{info.health}</Badge>
                                        </div>
                                    </li>
                                {/each}
                            </ul>
                        {:else if !containersQuery.isError}
                            <Empty class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4">
                                <EmptyHeader>
                                    <EmptyDescription>
                                        No containers found. Deploy this resource to create containers.
                                    </EmptyDescription>
                                </EmptyHeader>
                            </Empty>
                        {/if}
                    {/if}
                </FramePanel>
            </Frame>
            <Frame
                id="compose-editor"
                class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
                role="region"
                aria-labelledby="compose-heading"
            >
                <FrameHeader class="shrink-0 flex-row flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0">
                        <FrameTitle class="text-base"><h2 id="compose-heading">Docker Compose</h2></FrameTitle>
                        <FrameDescription class="mt-1">
                            Edit the Docker Compose YAML for this resource.
                        </FrameDescription>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                        <div class="text-sm" aria-live="polite">
                            {#if saveMutation.isError}
                                <Alert variant="error" class="w-auto px-2 py-1.5">
                                    <AlertDescription>
                                        Unable to save: {saveMutation.error.message}
                                    </AlertDescription>
                                </Alert>
                            {:else if isDirty}
                                <p class="text-muted-foreground">Unsaved changes</p>
                            {:else if hasUndeployedChanges}
                                <p class="text-muted-foreground">Draft saved. Not deployed.</p>
                            {/if}
                        </div>
                        <PreviewComposeDialog {projectId} {resourceId} />
                        <Button
                            onclick={saveCompose}
                            loading={saveMutation.isPending}
                            disabled={!isDirty || busy}
                        >
                            {saveMutation.isPending ? "Saving..." : "Save draft"}
                        </Button>
                        {#if deployMutation.isError}
                            <Alert variant="error" class="w-full">
                                <AlertDescription>Unable to deploy: {deployMutation.error.message}</AlertDescription>
                            </Alert>
                        {:else if !isDirty && savedSpec?.trim() && formattedComposeQuery.isError}
                            <Alert variant="error" class="w-full">
                                <AlertDescription>Saved draft cannot be deployed: {formattedComposeQuery.error.message}</AlertDescription>
                            </Alert>
                        {/if}
                    </div>
                </FrameHeader>
                <FramePanel
                    class="min-h-0 overflow-hidden bg-code p-0 transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20 dark:bg-black/20"
                >
                    <div class="compose-editor-canvas">
                        {#key resource.id}
                            <CodeEditor bind:value={compose} readOnly={busy || loadedResourceId !== resource.id} />
                        {/key}
                    </div>
                </FramePanel>
            </Frame>
        </div>
    {/if}
</div>

<DeploymentDialog bind:open={deploymentOpen} {deploymentId} />

<style>
    @media (min-width: 80rem) {
        .compose-editor-canvas,
        .compose-editor-canvas > :global(div),
        .compose-editor-canvas :global(.cm-editor) {
            height: 100%;
            min-height: 0;
        }

        .compose-editor-canvas :global(.cm-scroller) {
            min-height: 0;
            max-height: none;
        }
    }
</style>
