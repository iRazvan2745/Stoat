<script lang="ts">
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import hiveIcon from "@ktibow/iconset-material-symbols/hive-outline";
    import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
    import workspacesOutlineIcon from "@ktibow/iconset-material-symbols/workspaces-outline";
    import {
        ExpressiveMenu,
        ExpressiveMenuItem,
        FAB,
        NavigationRail,
        NavigationRailItem,
    } from "m3-svelte";

    let { children } = $props();
    let railOpen = $state(false);
    let fabMenuOpen = $state(false);
</script>

<div class="flex h-full w-svw">
    <NavigationRail bind:open={railOpen}>
        {#snippet fab(open)}
            <FAB
                icon={addIcon}
                color="primary-container"
                text={open ? "Label" : undefined}
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

        <NavigationRailItem href="/" label="Overview" icon={houseOutlineIcon} />

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

        <NavigationRailItem href="/cluster" label="Cluster" icon={hiveIcon} />
    </NavigationRail>
    <main
        class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] w-svw overflow-y-auto rounded-md p-4"
    >
        {@render children()}
    </main>
</div>

<style>
    :global(.fab-menu > .m3-container.expressive-menu.anchored.anchor-start) {
        left: anchor(end);
    }
</style>
