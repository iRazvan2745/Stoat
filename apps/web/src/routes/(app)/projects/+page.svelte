<script lang="ts">
    import CreateProjectDialog from "$lib/components/projects/create-project-dialog.svelte";
    import ProjectCard from "$lib/components/projects/project-card.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/orpc";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import Plus from "@lucide/svelte/icons/plus";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { onMount } from "svelte";

    const projectsQuery = createQuery(() => orpc.projects.listProjects.queryOptions());

    const projects = $derived(projectsQuery.data ?? []);

    const dialog = useQueryState("dialog", parseAsString.withOptions({ shallow: true, scroll: false }));

    let ready = $state(false);

    onMount(() => {
        ready = true;

        return () => { ready = false; };
    });
</script>

<svelte:head><title>Projects / Stoat</title></svelte:head>

<div class="w-full space-y-6 py-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
            <h1 class="text-2xl font-semibold">Projects</h1>
            <p class="mt-1 text-sm text-muted-foreground">Projects in your active organization.</p>
        </div>
        <Button size="sm" disabled={!ready} onclick={() => void dialog.set("create-project")}>
            <Plus class="size-4" aria-hidden="true" />
            Create project
        </Button>
    </div>

    {#if projectsQuery.isPending}
        <Skeleton loading count={2} count-gap={12} loading-label="Loading projects">
            <ProjectCard
                name="Project workspace"
                description="Project resources and environments"
                resourceCount={3}
            />
        </Skeleton>
    {:else if projectsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load projects: {projectsQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if projects.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <FolderOpen aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>Create your first project to get started.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" disabled={!ready} onclick={() => void dialog.set("create-project")}>
                    <Plus class="size-4" aria-hidden="true" />
                    Create project
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        <main>
            <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {#each projects as p (p.id)}
                    <li>
                        <ProjectCard
                            name={p.name}
                            description={p.description}
                            resourceCount={p.resourceCount ?? 0}
                            href="/projects/{p.id}"
                        />
                    </li>
                {/each}
            </ul>
        </main>
    {/if}
</div>

<CreateProjectDialog
    bind:open={
        () => dialog.current === "create-project",
        (open) => {
            if (ready && !open && dialog.current === "create-project") void dialog.set(null);
        }
    }
/>
