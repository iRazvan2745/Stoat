<script lang="ts">
    import { page } from "$app/state";
    import {
        Breadcrumb,
        BreadcrumbItem,
        BreadcrumbLink,
        BreadcrumbList,
        BreadcrumbPage,
        BreadcrumbSeparator,
    } from "$lib/components/ui/breadcrumb";
    import { Separator } from "$lib/components/ui/separator";
    import { SidebarInset, SidebarProvider, SidebarTrigger } from "$lib/components/ui/sidebar";
    import { orpc } from "$lib/orpc";
    import Boxes from "@lucide/svelte/icons/boxes";
    import { createQuery } from "@tanstack/svelte-query";
    import { onMount } from "svelte";
    import { setHeaderActions } from "./header-actions";

    import type { Snippet } from "svelte";

    const {
        children,
        sidebar,
        fullWidth = false,
        fullHeight = false,
    }: { children: Snippet; sidebar: Snippet; fullWidth?: boolean; fullHeight?: boolean } = $props();

    const headerActions = $state<{ content?: Snippet }>({});

    setHeaderActions(headerActions);

    const pageTitle = $derived(page.url.pathname.startsWith("/settings") ? "Settings" : page.url.pathname.startsWith("/projects") ? "Projects" : page.url.pathname.startsWith("/clusters") ? "Clusters" : "Home");

    // On a project detail route, show Projects › <name> in the header.
    // The projects list is shared from the TanStack cache, so this does not
    // trigger an extra request when the detail page loads it too.
    const projectId = $derived(page.params.projectId);

    const isProjectDetail = $derived(
        page.url.pathname.startsWith("/projects/") && Boolean(projectId),
    );

    const isProjectScope = $derived(Boolean(projectId));

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjects.queryOptions({ enabled: isProjectDetail || isProjectScope }),
    );

    const projectName = $derived(
        (projectsQuery.data ?? []).find((p) => p.id === projectId)?.name,
    );

    const resourceId = $derived(page.params.resourceId);

    const isResourceDetail = $derived(
        page.url.pathname.startsWith("/projects/") && Boolean(projectId) && Boolean(resourceId),
    );

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: (isResourceDetail || isProjectScope) && Boolean(projectId),
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);

    const resource = $derived(
        resources.find((r) => r.id === resourceId),
    );

    const clusterId = $derived(page.params.clusterId);

    const isClusterDetail = $derived(
        page.url.pathname.startsWith("/clusters/") && Boolean(clusterId),
    );

    const clusterQuery = createQuery(() =>
        orpc.cluster.getCluster.queryOptions({
            input: { clusterId: clusterId ?? "" },
            enabled: isClusterDetail,
        }),
    );

    const clusterName = $derived(clusterQuery.data?.name);

    // The toggle is client-only; keep it disabled until hydration so a fast
    // click can't land on an inert button.
    let ready = $state(false);

    onMount(() => { ready = true; });
</script>
<SidebarProvider class={fullHeight ? "xl:h-dvh xl:min-h-0" : undefined}>
    {@render sidebar()}
    <SidebarInset class={fullHeight ? "min-h-0 overflow-visible border" : "overflow-visible border"}>
        <header class="sticky top-0 z-40 flex min-h-16 rounded-t-xl shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-popover/80 px-4 py-2 backdrop-blur-lg">
            <div class="flex min-w-0 max-w-full items-center gap-2">
                <SidebarTrigger disabled={!ready} />
                <Separator orientation="vertical" class="mx-2 h-4" />
                <Breadcrumb class="min-w-0">
                    <BreadcrumbList class="flex-nowrap">
                        {#if isClusterDetail}
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/clusters">Clusters</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem class="min-w-0">
                                <BreadcrumbPage class="max-w-48 truncate sm:max-w-64">
                                    {clusterName ?? "…"}
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        {:else if isResourceDetail}
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/projects">Projects</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem class="min-w-0">
                                <BreadcrumbLink
                                    href="/projects/{projectId}"
                                    class="max-w-32 truncate sm:max-w-48"
                                >
                                    {projectName ?? "…"}
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem class="min-w-0">
                                <BreadcrumbPage class="flex min-w-0 max-w-48 items-center gap-2 sm:max-w-64">
                                    {#if resource?.icon}
                                        <img src={resource.icon} alt="" class="size-4 shrink-0 rounded object-contain" />
                                    {:else}
                                        <Boxes class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    {/if}
                                    <span class="truncate">{resource?.name ?? "…"}</span>
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        {:else if isProjectDetail}
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/projects">Projects</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem class="min-w-0">
                                <BreadcrumbPage class="max-w-48 truncate sm:max-w-64">
                                    {projectName ?? "…"}
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        {:else}
                            <BreadcrumbItem>
                                <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
                            </BreadcrumbItem>
                        {/if}
                    </BreadcrumbList>
                </Breadcrumb>
            </div>
            {#if headerActions.content}
                <div class="ml-auto shrink-0">
                    {@render headerActions.content()}
                </div>
            {/if}
        </header>
        <div class={[fullWidth ? "w-full px-4 pb-6" : "mx-auto w-full max-w-7xl px-4 pb-6", fullHeight && "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:overflow-y-auto"]}>
            {@render children?.()}
        </div>
    </SidebarInset>
</SidebarProvider>
