<script lang="ts">
    import { goto } from "$app/navigation";
    import refreshIcon from "@ktibow/iconset-material-symbols/arrow-back";
    import dashboardIcon from "@ktibow/iconset-material-symbols/dashboard";
    import environmentOutlineIcon from "@ktibow/iconset-material-symbols/data-object";
    import { FAB, NavigationRail, NavigationRailItem } from "m3-svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    //let params: PageProps = $props();

    let { children, params } = $props();
    let railOpen = useQueryState("railOpen", parseAsBoolean.withDefault(false));

    // svelte-ignore state_referenced_locally
    const hrefRoute = `/workspace/${params.workspaceId}/${params.serviceId}/`;
</script>

<div class="flex h-full w-svw">
    <NavigationRail bind:open={railOpen.current}>
        {#snippet fab(open)}
            <FAB
                icon={refreshIcon}
                color="secondary-container"
                text={open ? "Go back" : undefined}
                elevation="lowered"
                onclick={() => goto(`/workspace/${params.workspaceId}`)}
            />
        {/snippet}

        <NavigationRailItem href="/" label="Overview" icon={dashboardIcon} />

        <NavigationRailItem
            href={hrefRoute + "environment"}
            label="Environment"
            id="environment-rail-button"
            icon={environmentOutlineIcon}
        />
    </NavigationRail>
    <main
        class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] w-svw overflow-y-auto rounded-md p-4"
    >
        {@render children()}
    </main>
</div>
