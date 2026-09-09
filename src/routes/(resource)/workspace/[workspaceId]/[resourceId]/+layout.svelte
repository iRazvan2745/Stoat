<script lang="ts">
    import { goto } from "$app/navigation";
    import backIcon from "@ktibow/iconset-material-symbols/arrow-back";
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import dashboardIcon from "@ktibow/iconset-material-symbols/dashboard";
    import environmentOutlineIcon from "@ktibow/iconset-material-symbols/data-object";
    import ingressesIcon from "@ktibow/iconset-material-symbols/language";
    import deploymentsIcon from "@ktibow/iconset-material-symbols/rocket-launch-outline";
    import settingsIcon from "@ktibow/iconset-material-symbols/settings-outline";
    import { FAB, NavigationRailItem } from "m3-svelte";

    import PageShell from "#lib/components/page-shell.svelte";
    import Sidebar from "#lib/components/sidebar.svelte";

    let { children, data, params } = $props();

    const hrefRoute = $derived(
        `/workspace/${params.workspaceId}/${params.resourceId}/`
    );
</script>

<div class="flex h-svh w-svw min-w-0">
    <Sidebar
        initialGravatarUrl={data.gravatarUrl}
        initialUser={data.session?.user}
    >
        {#snippet fab(open)}
            <FAB
                icon={backIcon}
                color="secondary-container"
                text={open ? "Go back" : undefined}
                aria-label="Go back"
                elevation="lowered"
                onclick={() => goto(`/workspace/${params.workspaceId}`)}
            />
        {/snippet}

        {#snippet children()}
            <NavigationRailItem
                href={hrefRoute}
                label="Overview"
                icon={dashboardIcon}
            />

            <NavigationRailItem
                href={hrefRoute + "environment"}
                label="Environment"
                id="environment-rail-button"
                icon={environmentOutlineIcon}
            />
            <NavigationRailItem
                href={hrefRoute + "ingresses"}
                label="Ingresses"
                id="ingresses-rail-button"
                icon={ingressesIcon}
            />
            <NavigationRailItem
                href={hrefRoute + "deployments"}
                label="Deployments"
                id="deployments-rail-button"
                icon={deploymentsIcon}
            />
            <NavigationRailItem
                href={hrefRoute + "logs"}
                label="Logs"
                id="logs-rail-button"
                icon={logsIcon}
            />
            <NavigationRailItem
                href={hrefRoute + "settings"}
                label="Settings"
                id="settings-rail-button"
                icon={settingsIcon}
            />
        {/snippet}
    </Sidebar>

    <PageShell>
        {#key params.resourceId}
            {@render children()}
        {/key}
    </PageShell>
</div>
