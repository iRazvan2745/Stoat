<script lang="ts">
    import { page } from "$app/state";
    import AppShell from "$lib/components/sidebar/app-shell.svelte";
    import ResourceSidebar from "$lib/components/sidebar/resource-sidebar.svelte";
    import ResourceLogs from "$lib/components/projects/resource-logs.svelte";

    const { children: pageContent, data } = $props();

    const isOverview = $derived(
        page.route.id === "/(app)/projects/(resource)/[projectId]/[resourceId]",
    );

    const isVariables = $derived(
        page.route.id === "/(app)/projects/(resource)/[projectId]/[resourceId]/variables",
    );

    const isLogs = $derived(
        page.route.id === "/(app)/projects/(resource)/[projectId]/[resourceId]/logs",
    );
</script>

<AppShell fullWidth={isOverview || isVariables || isLogs} fullHeight={isOverview || isVariables || isLogs}>
    {#snippet children()}
        {@render pageContent()}
        {#key `${data.activeOrganizationId}/${page.params.projectId}/${page.params.resourceId}`}
            <ResourceLogs projectId={page.params.projectId ?? ""} resourceId={page.params.resourceId ?? ""} active={isLogs} />
        {/key}
    {/snippet}
    {#snippet sidebar()}
        <ResourceSidebar user={data.user} organizations={data.organizations} activeOrganizationId={data.activeOrganizationId} />
    {/snippet}
</AppShell>
