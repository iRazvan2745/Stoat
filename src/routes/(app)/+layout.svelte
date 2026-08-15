<script lang="ts">
  import addIcon from "@ktibow/iconset-material-symbols/add";
  import hiveIcon from "@ktibow/iconset-material-symbols/hive-outline";
  import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
  import { FAB, NavigationRail, NavigationRailItem } from "m3-svelte";

  let { children } = $props();
  let railOpen = $state(false);
</script>

<div class="flex h-full w-svw">
  <NavigationRail bind:open={railOpen}>
    {#snippet fab(open)}
      <FAB
        icon={addIcon}
        color="primary-container"
        text={open ? "Label" : undefined}
        elevation="none"
        onclick={() => console.log("clicked")}
      />
    {/snippet}

    <NavigationRailItem href="/" label="Overview" icon={houseOutlineIcon} />

    <NavigationRailItem href="/cluster" label="Cluster" icon={hiveIcon} />
  </NavigationRail>
  <main
    class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] w-svw overflow-y-auto rounded-md p-4"
  >
    {@render children()}
  </main>
</div>
