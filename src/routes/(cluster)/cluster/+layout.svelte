<script lang="ts">
    import appsIcon from "@ktibow/iconset-material-symbols/apps";
    import computerIcon from "@ktibow/iconset-material-symbols/computer-outline";
    import dnsIcon from "@ktibow/iconset-material-symbols/dns";
    import folderIcon from "@ktibow/iconset-material-symbols/folder-outline";
    import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
    import { NavigationRailItem } from "m3-svelte";

    import Sidebar from "#lib/components/sidebar.svelte";

    let { children, data } = $props();
</script>

<div class="flex h-svh w-svw min-w-0">
    <Sidebar
        initialGravatarUrl={data.gravatarUrl}
        initialUser={data.session?.user}
    >
        {#snippet children()}
            <NavigationRailItem
                href="/"
                label="Overview"
                icon={houseOutlineIcon}
            />

            <NavigationRailItem
                href="/cluster/machines"
                label="Machines"
                icon={computerIcon}
            />

            <NavigationRailItem
                href="/cluster/services"
                label="Services"
                icon={appsIcon}
            />

            <NavigationRailItem
                href="/cluster/caddy"
                label="Caddy"
                icon={dnsIcon}
            />

            <NavigationRailItem
                href="/cluster/volumes"
                label="Volumes"
                icon={folderIcon}
            />
        {/snippet}
    </Sidebar>

    <main
        class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] min-h-0 min-w-0 flex-1 overflow-y-auto rounded-md p-4"
    >
        {@render children()}
    </main>
</div>
