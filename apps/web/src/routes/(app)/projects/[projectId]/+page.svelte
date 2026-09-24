<script lang="ts">
    import { page } from "$app/state";
    import CreateResourceDialog, { resourceFormParsers } from "$lib/components/projects/create-resource-dialog.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Card, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Menu, MenuItem, MenuPopup, MenuTrigger } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
    import Container from "@lucide/svelte/icons/container";
    import Plus from "@lucide/svelte/icons/plus";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { onMount } from "svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const projectsQuery = createQuery(() => orpc.projects.listProjects.queryOptions());

    const project = $derived((projectsQuery.data ?? []).find((p) => p.id === projectId));

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);

    let menuOpen = $state(false);

    const params = useQueryStates({ dialog: parseAsString, ...resourceFormParsers }, { shallow: true, scroll: false });

    let ready = $state(false);

    onMount(() => {
        ready = true;
    });

    function openComposeDialog() {
        menuOpen = false;
        void params.set({ dialog: "create-resource", resourceName: null, resourceDescription: null, source: null });
    }
</script>

<svelte:head><title>{project?.name ?? "Project"} / Stoat</title></svelte:head>

<div class="w-full space-y-6 py-6">
    {#if projectsQuery.isPending}
        <Skeleton loading loading-label="Loading project">
            <div class="space-y-1">
                <h1 class="text-2xl font-semibold">Project overview</h1>
                <p class="text-sm text-muted-foreground">Resources and deployment configuration.</p>
            </div>
        </Skeleton>
    {:else if projectsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load project: {projectsQuery.error.message}
            </AlertDescription>
        </Alert>
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
    {:else}
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 class="text-2xl font-semibold">{project.name}</h1>
                {#if project.description?.trim()}
                    <p class="mt-1 text-sm text-muted-foreground">{project.description}</p>
                {/if}
            </div>
            <Menu bind:open={menuOpen}>
                <MenuTrigger
                    class={buttonVariants({ size: "sm" })}
                    disabled={!ready}
                    aria-label="New resource"
                >
                    <Plus class="size-4" aria-hidden="true" />
                    New resource
                    <ChevronsUpDown class="size-4" aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end">
                    <MenuItem onclick={openComposeDialog}>
                        <Container aria-hidden="true" />
                        New Resource Compose
                    </MenuItem>
                </MenuPopup>
            </Menu>
        </div>

        {#if resourcesQuery.isPending}
            <Skeleton loading count={2} count-gap={12} loading-label="Loading resources">
                <Card class="p-4">
                    <CardHeader class="p-0">
                        <div class="flex items-center gap-3">
                            <span class="flex size-9 items-center justify-center rounded-lg border border-border">
                                <Container class="size-4" aria-hidden="true" />
                            </span>
                            <div class="min-w-0">
                                <CardTitle class="text-sm">Resource service</CardTitle>
                                <CardDescription class="text-xs">Compose service configuration</CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                </Card>
            </Skeleton>
        {:else if resourcesQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    Unable to load resources: {resourcesQuery.error.message}
                </AlertDescription>
            </Alert>
        {:else if resources.length === 0}
            <Empty class="rounded-xl border border-dashed border-border">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Container aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No resources yet</EmptyTitle>
                    <EmptyDescription>
                        Create your first resource to get started.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        {:else}
            <main>
                <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {#each resources as resource (resource.id)}
                        <li class="min-w-0">
                            <Card class="h-full p-4 transition-colors hover:bg-accent/50 focus-within:bg-accent/50">
                                <CardHeader class="p-0">
                                    <div class="flex items-center gap-3">
                                        <Avatar class="size-9 rounded-lg border border-border bg-transparent">
                                            {#if resource.icon}<AvatarImage src={resource.icon} alt="" class="object-contain" />{/if}
                                            <AvatarFallback class="rounded-none bg-muted/50">
                                                <Boxes class="size-4 text-muted-foreground" aria-hidden="true" />
                                            </AvatarFallback>
                                        </Avatar>
                                        <div class="min-w-0 flex-1">
                                            <CardTitle class="block truncate text-[15px] leading-tight">
                                                <a
                                                    href="/projects/{projectId}/{resource.id}"
                                                    class="before:absolute before:inset-0 before:rounded-xl hover:underline focus-visible:outline-none"
                                                >
                                                    {resource.name}
                                                </a>
                                            </CardTitle>
                                            {#if resource.description?.trim()}
                                                <CardDescription class="mt-0.5 block truncate">
                                                    {resource.description}
                                                </CardDescription>
                                            {/if}
                                        </div>
                                    </div>
                                </CardHeader>
                            </Card>
                        </li>
                    {/each}
                </ul>
            </main>
        {/if}
    {/if}
</div>

{#key projectId}
    <CreateResourceDialog
        bind:open={
            () => params.dialog.current === "create-resource",
            (open) => {
                if (!open && params.dialog.current === "create-resource") void params.set(null);
            }
        }
        {projectId}
    />
{/key}
