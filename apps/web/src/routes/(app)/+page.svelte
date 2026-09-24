<script lang="ts">
    import ClusterUsageRow from "$lib/components/home/cluster-usage-row.svelte";
    import ProjectOverviewCard from "$lib/components/home/project-overview-card.svelte";
    import CreateProjectDialog from "$lib/components/projects/create-project-dialog.svelte";
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
    import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import Plus from "@lucide/svelte/icons/plus";
    import Search from "@lucide/svelte/icons/search";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { onMount } from "svelte";

    const params = useQueryStates(
        { q: parseAsString.withDefault(""), dialog: parseAsString },
        { shallow: true, scroll: false },
    );

    const projectsQuery = createQuery(() => orpc.projects.listProjectOverviews.queryOptions());

    const clustersQuery = createQuery(() =>
        orpc.cluster.listClusters.queryOptions({ input: { limit: 100 } }),
    );

    const projects = $derived(projectsQuery.data ?? []);

    const filtered = $derived.by(() => {
        const q = params.q.current.trim().toLowerCase();

        if (!q) return projects;

        return projects.filter((project) =>
            [project.name, project.description ?? "", project.clusterName, ...project.resources.map((r) => r.name)]
                .some((value) => value.toLowerCase().includes(q)),
        );
    });

    const clusters = $derived(clustersQuery.data?.items ?? []);

    let ready = $state(false);

    let now = $state(Date.now());

    onMount(() => {
        ready = true;
        const clock = setInterval(() => (now = Date.now()), 30_000);
        const queryKey = orpc.projects.listProjectOverviews.key();

        // Keep resource status dots current; failures only disable live updates.
        const stop = subscribeToStream(
            (signal) => client.cluster.watchDeployments(undefined, { signal }),
            () => void queryClient.invalidateQueries({ queryKey }),
            () => {},
        );

        return () => {
            ready = false;
            clearInterval(clock);
            stop();
        };
    });

    function openCreate() {
        void params.set({ dialog: "create-project" });
    }
</script>

<svelte:head><title>Home / Stoat</title></svelte:head>

<div class="w-full space-y-6 py-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
            <h1 class="text-2xl font-semibold">Projects</h1>
            <p class="mt-1 text-sm text-muted-foreground">Overview of your active organization.</p>
        </div>
        <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <InputGroup class="w-full sm:w-64">
                <InputGroupInput
                    type="search"
                    placeholder="Search projects…"
                    aria-label="Search projects"
                    bind:value={() => params.q.current, (q) => { void params.set({ q: q || null }); }}
                />
                <InputGroupAddon align="inline-start">
                    <Search aria-hidden="true" />
                </InputGroupAddon>
            </InputGroup>
            <Button size="sm" disabled={!ready} onclick={openCreate}>
                <Plus class="size-4" aria-hidden="true" />
                Create project
            </Button>
        </div>
    </div>

    {#if projectsQuery.isPending}
        <Skeleton loading count={3} count-gap={12} loading-label="Loading projects">
            <div class="rounded-2xl border p-4">
                <p class="text-[15px]">Project workspace</p>
                <p class="text-sm">Project resources</p>
                <p class="mt-5 text-sm">web api db</p>
                <p class="mt-3 text-xs">cluster · 1h ago</p>
            </div>
        </Skeleton>
    {:else if projectsQuery.isError}
        <Alert variant="error">
            <AlertDescription>Unable to load projects: {projectsQuery.error.message}</AlertDescription>
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
                <Button size="sm" disabled={!ready} onclick={openCreate}>
                    <Plus class="size-4" aria-hidden="true" />
                    Create project
                </Button>
            </EmptyContent>
        </Empty>
    {:else if filtered.length === 0}
        <p class="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No projects match “{params.q.current}”.
        </p>
    {:else}
        <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each filtered as project (project.id)}
                <li><ProjectOverviewCard {project} {now} /></li>
            {/each}
        </ul>
    {/if}

    {#if clustersQuery.isError}
        <Alert variant="error">
            <AlertDescription>Unable to load clusters: {clustersQuery.error.message}</AlertDescription>
        </Alert>
    {:else if clusters.length}
        <Frame class="min-w-0">
            <FrameHeader class="flex-row flex-wrap items-center justify-between gap-2 py-3">
                <div class="min-w-0">
                    <FrameTitle class="text-base"><h2>Clusters</h2></FrameTitle>
                    <FrameDescription class="mt-0.5">Current resource usage across each cluster's machines.</FrameDescription>
                </div>
                <Button size="sm" variant="ghost" href="/clusters">
                    View all
                    <ArrowRight class="size-4" aria-hidden="true" />
                </Button>
            </FrameHeader>
            <FramePanel class="overflow-hidden p-0">
                <ul class="divide-y divide-border">
                    {#each clusters as cluster (cluster.id)}
                        <ClusterUsageRow {cluster} />
                    {/each}
                </ul>
            </FramePanel>
        </Frame>
    {/if}
</div>

<CreateProjectDialog
    bind:open={
        () => params.dialog.current === "create-project",
        (open) => {
            if (ready && !open && params.dialog.current === "create-project") void params.set({ dialog: null });
        }
    }
/>
