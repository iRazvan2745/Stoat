<script lang="ts">
    import { page } from "$app/state";
    import CodeEditor from "$lib/components/code-editor.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Frame, FrameHeader, FramePanel } from "$lib/components/ui/frame";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Container from "@lucide/svelte/icons/container";
    import Eye from "@lucide/svelte/icons/eye";
    import EyeOff from "@lucide/svelte/icons/eye-off";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { untrack } from "svelte";
    import { watch } from "runed";
    import { z } from "zod";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const projectsQuery = createQuery(() => orpc.projects.listProjects.queryOptions());

    const project = $derived((projectsQuery.data ?? []).find((p) => p.id === projectId));

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: projectId.length > 0 && resourceId.length > 0,
        }),
    );

    const resource = $derived(resourceQuery.data);


    const envSchema = z.object({ env: z.string().catch("") }).catch({ env: "" });

    let env = $state("");

    let loadedResourceId = $state("");

    let savedEnv = $state("");

    let showVariables = $state(false);

    const variablesVisible = $derived(showVariables && loadedResourceId === resourceId);

    const isDirty = $derived(env !== savedEnv);

    watch(() => resourceId, () => {
        showVariables = false;
    });

    $effect(() => {
        const current = resource;

        if (!current) return;
        untrack(() => {
            if (loadedResourceId !== current.id) {
                showVariables = false;
                loadedResourceId = current.id;
                env = envSchema.parse(current.settings).env;
                savedEnv = env;
                saveMutation.reset();
            } else if (!isDirty) {
                env = envSchema.parse(current.settings).env;
                savedEnv = env;
            }
        });
    });

    const saveMutation = createMutation(() =>
        orpc.resources.updateVariables.mutationOptions({
            onSuccess: (updated, input) => {
                if (loadedResourceId === updated.id) savedEnv = envSchema.parse(updated.settings).env;
                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
        }),
    );

    function saveVariables() {
        if (!isDirty || saveMutation.isPending) return;
        saveMutation.mutate({ projectId, resourceId, env: env });
    }

</script>

<svelte:head><title>Variables / {resource?.name ?? "Resource"} / Stoat</title></svelte:head>

<div class="variables-page flex h-[calc(100dvh-7rem)] min-h-112 min-w-0 w-full flex-col gap-3 py-3 xl:h-auto xl:min-h-0 xl:flex-1">
    {#if projectsQuery.isPending || resourceQuery.isPending}
        <Skeleton loading loading-label="Loading resource variables" class="flex min-h-0 flex-1 flex-col">
            <div class="flex min-h-0 flex-1 flex-col gap-3">
                    <Frame class="min-h-0 min-w-0 w-full flex-1">
                            <FrameHeader class="flex-row flex-wrap shrink-0 items-center justify-between gap-3 px-3 py-2">
                                <div>
                                    <h2 class="text-sm font-medium">.env</h2>
                                </div>
                                <div class="flex items-center gap-2 text-sm">
                                    <span>Show values</span>
                                    <span>Save</span>
                                </div>
                            </FrameHeader>
                            <FramePanel class="flex min-h-0 flex-1 overflow-hidden p-0">
                                <div class="flex-1 bg-code p-4 font-mono text-sm text-muted-foreground">VARIABLE=********</div>
                            </FramePanel>
                    </Frame>
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
            <Frame
                class="min-h-0 min-w-0 w-full flex-1 overflow-hidden"
            >
                    <FrameHeader class="flex-row flex-wrap shrink-0 items-center gap-3 px-3 py-2">
                        <div>
                            <h2 class="text-sm font-medium">.env</h2>
                        </div>
                        <div class="min-w-0 flex-1 text-sm text-muted-foreground wrap-anywhere" aria-live="polite">
                            {#if saveMutation.isError}
                                <Alert variant="error" class="w-auto px-2 py-1.5">
                                    <AlertDescription>
                                        Unable to save: {saveMutation.error.message}
                                    </AlertDescription>
                                </Alert>
                            {:else if saveMutation.isPending}
                                <p>Saving...</p>
                            {:else if isDirty}
                                <p>Unsaved changes</p>
                            {:else if saveMutation.isSuccess}
                                <p>Variables saved.</p>
                            {/if}
                        </div>
                        <div class="ml-auto flex shrink-0 items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={variablesVisible}
                            aria-controls="env-editor"
                            disabled={loadedResourceId !== resourceId}
                            onclick={() => (showVariables = !showVariables)}
                        >
                            {#if variablesVisible}
                                <EyeOff class="size-4" aria-hidden="true" />
                                Hide values
                            {:else}
                                <Eye class="size-4" aria-hidden="true" />
                                Show values
                            {/if}
                        </Button>
                        <Button
                            size="sm"
                            onclick={saveVariables}
                            loading={saveMutation.isPending}
                            disabled={!isDirty || saveMutation.isPending || loadedResourceId !== resourceId}
                        >{saveMutation.isPending ? "Saving..." : "Save"}</Button>
                        </div>
                    </FrameHeader>
                    <FramePanel id="env-editor" class="flex min-h-0 min-w-0 flex-1 overflow-hidden p-0">
                        {#if loadedResourceId === resourceId}
                                <div class="env-editor-canvas min-h-0 flex-1 bg-code dark:bg-black/20">
                                    {#key loadedResourceId}<CodeEditor bind:value={env} language="env" label="Environment variables (.env)" hideEnvValues={!variablesVisible} />{/key}
                                </div>
                        {/if}
                    </FramePanel>
            </Frame>
    {/if}
</div>

<style>
    .env-editor-canvas > :global(div),
    .env-editor-canvas :global(.cm-editor) {
        height: 100%;
        min-height: 0;
    }

    .env-editor-canvas :global(.cm-scroller) {
        height: 100%;
        min-height: 0;
        max-height: none;
    }
</style>
