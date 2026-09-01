<script lang="ts">
    import { goto } from "$app/navigation";
    import refreshIcon from "@ktibow/iconset-material-symbols/arrow-back";
    import logsIcon from "@ktibow/iconset-material-symbols/article-outline";
    import dashboardIcon from "@ktibow/iconset-material-symbols/dashboard";
    import environmentOutlineIcon from "@ktibow/iconset-material-symbols/data-object";
    import ingressesIcon from "@ktibow/iconset-material-symbols/language";
    import deploymentsIcon from "@ktibow/iconset-material-symbols/rocket-launch-outline";
    import settingsIcon from "@ktibow/iconset-material-symbols/settings-outline";
    import { FAB, NavigationRailItem } from "m3-svelte";

    import Sidebar from "#lib/components/sidebar.svelte";

    let { children, data, params } = $props();

    const hrefRoute = $derived(
        `/workspace/${params.workspaceId}/${params.serviceId}/`
    );
</script>

<div class="flex h-svh w-svw min-w-0">
    <Sidebar
        initialGravatarUrl={data.gravatarUrl}
        initialUser={data.session?.user}
    >
        {#snippet fab(open)}
            <FAB
                icon={refreshIcon}
                color="secondary-container"
                text={open ? "Go back" : undefined}
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

    <main
        class="bg-surface m:p-6 mt-6 h-[calc(100svh-1.5rem)] min-w-0 flex-1 overflow-y-auto p-4"
        style="border-radius: var(--m3-shape-extra-large) 0 0 var(--m3-shape-extra-large)"
    >
        {#key params.serviceId}
            {@render children()}
        {/key}
    </main>
</div>
