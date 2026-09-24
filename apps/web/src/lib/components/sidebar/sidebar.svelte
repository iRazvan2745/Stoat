<script lang="ts">
    import { page } from "$app/state";
    import { authClient } from "$lib/auth-client";
    import CreateOrganizationDialog from "$lib/components/organization/create-organization-dialog.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarSeparator } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import { sidebarMenuButtonVariants } from "$lib/components/ui/sidebar/sidebar-menu-button.svelte";
    import { orpc } from "$lib/orpc";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Container from "@lucide/svelte/icons/container";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
    import Plus from "@lucide/svelte/icons/plus";
    import Rocket from "@lucide/svelte/icons/rocket";
    import Settings from "@lucide/svelte/icons/settings-2";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { watch } from "runed";
    import { onMount } from "svelte";
    import UserMenu from "./user-menu.svelte";

    let { variant = "inset", user, organizations, activeOrganizationId }: {
        variant?: "sidebar" | "floating" | "inset";
        user: { name: string; email: string; image?: string | null };
        organizations: { id: string; name: string; slug: string }[];
        activeOrganizationId?: string | null;
    } = $props();

    const activeOrganization = $derived(organizations.find((organization) => organization.id === activeOrganizationId));

    const sidebar = useSidebar();

    let open = $state(false);

    function closeNavigation() { open = false; sidebar.setOpenMobile(false); }

    // Link items don't auto-close, and SPA navigation keeps the layout (and
    // its portals) mounted, so close on every route change as a fallback.
    const pathname = $derived(page.url.pathname);

    watch(
        () => pathname,
        (currentPathname) => {
            // Track the route so an open menu never survives navigation.
            if (currentPathname) {
                open = false;
                sidebar.setOpenMobile(false);
            }
        },
    );

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    const dialog = useQueryState("dialog", parseAsString.withOptions({ shallow: true, scroll: false }));

    onMount(() => { ready = true; });

    // The queries below reuse the TanStack cache warmed by the layout and the
    // detail pages, so they don't trigger extra requests.
    const projectId = $derived(page.params.projectId);

    const resourceId = $derived(page.params.resourceId);

    const isProjectPage = $derived(Boolean(projectId) && !resourceId);

    const projectBase = $derived(`/projects/${projectId}`);

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjects.queryOptions({ enabled: Boolean(projectId) }),
    );

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: Boolean(projectId),
        }),
    );

    const projectName = $derived(
        (projectsQuery.data ?? []).find((p) => p.id === projectId)?.name ?? "Project",
    );

    const resources = $derived(resourcesQuery.data ?? []);

    const mainLinks = [
        { title: "Home", url: "/", icon: LayoutDashboard },
        { title: "Projects", url: "/projects", icon: Boxes },
        { title: "Deployments", url: "/deployments", icon: Rocket },
    ];

    const configLinks = [
        { title: "Clusters", url: "/clusters", icon: Boxes },
        { title: "Git", url: "/git", icon: GitBranch },
        { title: "Settings", url: "/settings", icon: Settings },
    ];

    async function switchOrganization(organizationId: string) {
        if (pending || organizationId === activeOrganizationId) return;
        pending = true;
        error = "";

        try {
            const result = await authClient.organization.setActive({ organizationId });

            if (result.error) { error = result.error.message ?? "Unable to switch organization.";

 return; }

            window.location.assign("/");
        } catch { error = "Unable to connect. Try again."; }
        finally { pending = false; }
    }
</script>

{#snippet resourceList(highlightCurrent: boolean)}
    {#if resourcesQuery.isPending}
        <Skeleton
            loading
            count={2}
            count-gap={8}
            class="mx-2"
            loading-label="Loading resources"
        >
            <div class="flex h-7 items-center gap-2 rounded-lg px-2">
                <Container class="size-4" aria-hidden="true" />
                <span class="truncate text-sm">Resource service</span>
            </div>
        </Skeleton>
    {:else if resources.length === 0}
        <p class="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            No resources yet.
        </p>
    {:else}
        <SidebarMenu>
            {#each resources as resource (resource.id)}
                {@const href = `/projects/${projectId}/${resource.id}`}
                {@const current = highlightCurrent && pathname === href}
                <SidebarMenuItem>
                    <SidebarMenuButton isActive={current}>
                        {#snippet child({ props })}
                            <a {...props} onclick={closeNavigation} {href} title={resource.name} aria-current={current ? "page" : undefined}><Container aria-hidden="true" /><span>{resource.name}</span></a>
                        {/snippet}
                    </SidebarMenuButton>
                </SidebarMenuItem>
            {/each}
        </SidebarMenu>
    {/if}
{/snippet}

<Sidebar {variant} collapsible="icon">
    <SidebarHeader>
        <SidebarMenu>
            <SidebarMenuItem>
                <Menu bind:open>
                    <MenuTrigger class={sidebarMenuButtonVariants({ size: "lg", class: "data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center" })} disabled={!ready || pending} aria-label="Switch organization" title={activeOrganization?.name ?? "Select organization"}>
                        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg group-data-[collapsible=icon]:size-6"><Boxes class="size-full" aria-hidden="true" /></span>
                        <span class="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                            <span class="truncate font-semibold">{activeOrganization?.name ?? "Select organization"}</span>
                            <span class="truncate text-xs">{activeOrganization?.slug ?? "Organization"}</span>
                        </span>
                        <ChevronDown class="ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" aria-hidden="true" />
                    </MenuTrigger>
                    <MenuPopup class="w-(--anchor-width) min-w-56 max-w-[calc(100vw-2rem)]" align="start" side="bottom" sideOffset={4}>
                        <MenuGroup>
                            <MenuGroupLabel>Organizations</MenuGroupLabel>
                            {#each organizations as organization (organization.id)}
                                <MenuItem class="gap-2 p-2" disabled={pending} onclick={() => switchOrganization(organization.id)}>
                                    <span class="flex size-6 shrink-0 items-center justify-center rounded-sm border"><Boxes class="size-4" aria-hidden="true" /></span>
                                    <span class="truncate">{organization.name}</span>
                                    {#if organization.id === activeOrganizationId}<span class="ml-auto text-xs text-muted-foreground">Active</span>{/if}
                                </MenuItem>
                            {/each}
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuItem disabled={!ready || pending} onclick={() => { closeNavigation(); void dialog.set("create-organization"); }} class="gap-2 p-2"><span class="flex size-6 items-center justify-center rounded-md border bg-background"><Plus class="size-4" aria-hidden="true" /></span>Add organization</MenuItem>
                    </MenuPopup>
                </Menu>
            </SidebarMenuItem>
        </SidebarMenu>
        {#if error}
            <Alert variant="error" class="mx-2 p-2 text-xs group-data-[collapsible=icon]:hidden">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {/if}
    </SidebarHeader>
    <SidebarContent class="overflow-x-hidden">
        {#if isProjectPage}
            <SidebarGroup>
                <SidebarGroupLabel class="truncate">{projectName}</SidebarGroupLabel>
                <SidebarGroupContent>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton isActive={pathname === projectBase}>
                                {#snippet child({ props })}
                                    <a {...props} onclick={closeNavigation} href={projectBase} title="Project overview" aria-current={pathname === projectBase ? "page" : undefined}><LayoutDashboard aria-hidden="true" /><span>Overview</span></a>
                                {/snippet}
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
            <SidebarGroup>
                <SidebarGroupLabel>Resources</SidebarGroupLabel>
                <SidebarGroupContent>
                    {@render resourceList(true)}
                </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
        {/if}
        <SidebarGroup>
            <SidebarGroupLabel>Main</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each mainLinks as link (link.url)}
                        <SidebarMenuItem>
                            <SidebarMenuButton isActive={link.url === "/" ? pathname === "/" : pathname.startsWith(link.url)}>
                                {#snippet child({ props })}
                                    <a {...props} onclick={closeNavigation} href={link.url} title={link.title} aria-current={pathname === link.url ? "page" : undefined}><link.icon aria-hidden="true" /><span>{link.title}</span></a>
                                {/snippet}
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
            <SidebarGroupLabel>Configuration</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each configLinks as link (link.url)}
                        <SidebarMenuItem>
                            <SidebarMenuButton isActive={pathname.startsWith(link.url)}>
                                {#snippet child({ props })}
                                    <a {...props} onclick={closeNavigation} href={link.url} title={link.title} aria-current={pathname === link.url ? "page" : undefined}><link.icon aria-hidden="true" /><span>{link.title}</span></a>
                                {/snippet}
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
        <SidebarMenu><SidebarMenuItem><UserMenu {user} /></SidebarMenuItem></SidebarMenu>
        <p class="px-2 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">v0.0.1</p>
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
<CreateOrganizationDialog
    bind:open={
        () => ready && !pending && dialog.current === "create-organization",
        (open) => {
            if (!open && dialog.current === "create-organization") void dialog.set(null);
        }
    }
/>
