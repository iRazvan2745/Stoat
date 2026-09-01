<script lang="ts">
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import computerIcon from "@ktibow/iconset-material-symbols/computer-outline";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import hiveIcon from "@ktibow/iconset-material-symbols/hive-outline";
    import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
    import workspacesOutlineIcon from "@ktibow/iconset-material-symbols/workspaces-outline";
    import {
        ExpressiveMenu,
        ExpressiveMenuItem,
        FAB,
        NavigationRailItem,
    } from "m3-svelte";

    import Sidebar from "#lib/components/sidebar.svelte";

    let { children, data } = $props();
    let fabMenuOpen = $state(false);
</script>

<div class="flex h-svh w-svw min-w-0">
    <Sidebar
        activeOrganizationId={data.session.session.activeOrganizationId ?? null}
        initialGravatarUrl={data.gravatarUrl}
        initialUser={data.session?.user}
        organizations={data.organizations}
    >
        {#snippet fab(open)}
            <FAB
                icon={addIcon}
                color="primary-container"
                text={open ? "New" : undefined}
                elevation="none"
                style="anchor-name: --m3-menu-anchor"
                onclick={() => (fabMenuOpen = !fabMenuOpen)}
            />
            {#if fabMenuOpen}
                <div class="fab-menu">
                    <ExpressiveMenu anchored x="start" y="down" label="Actions">
                        <ExpressiveMenuItem
                            leadingIcon={addIcon}
                            label="Create Workspace"
                            onclick={() => (fabMenuOpen = false)}
                        />
                        <ExpressiveMenuItem
                            leadingIcon={addIcon}
                            label="Share"
                            onclick={() => (fabMenuOpen = false)}
                        />
                    </ExpressiveMenu>
                </div>
            {/if}
        {/snippet}

        {#snippet children()}
            <NavigationRailItem
                href="/"
                label="Overview"
                icon={houseOutlineIcon}
            />

            <NavigationRailItem
                href="/workspace"
                label="Workspace"
                id="workspaces-rail-button"
                icon={workspacesOutlineIcon}
            />

            <NavigationRailItem
                href="/data-sources"
                label="Data Sources"
                icon={databaseIcon}
            />

            <NavigationRailItem
                href="/machines"
                label="Machines"
                icon={computerIcon}
            />

            <NavigationRailItem
                href="/cluster"
                label="Cluster"
                icon={hiveIcon}
            />
        {/snippet}
    </Sidebar>

    <main
        class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] min-h-0 min-w-0 flex-1 overflow-y-auto rounded-md p-4"
    >
        {@render children()}
    </main>
</div>

<style>
    :global(.fab-menu > .m3-container.expressive-menu.anchored.anchor-start) {
        left: anchor(end);
    }
</style>
