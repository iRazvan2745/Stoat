<script lang="ts">
  import addIcon from "@ktibow/iconset-material-symbols/add";
  import appsIcon from "@ktibow/iconset-material-symbols/apps";
  import computerIcon from "@ktibow/iconset-material-symbols/computer-outline";
  import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
  import starsOutlineIcon from "@ktibow/iconset-material-symbols/stars-outline";
  import { addBadge, FAB, NavigationRail, NavigationRailItem } from "m3-svelte";

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

    <NavigationRailItem href="/machines" label="Machines" icon={computerIcon} />

    <NavigationRailItem href="/services" label="Services" icon={appsIcon} />

    <NavigationRailItem
      href="/"
      label="Badge"
      icon={addBadge(starsOutlineIcon, 3)}
    />

    <NavigationRailItem
      href="/"
      label="More"
      icon={addBadge(starsOutlineIcon)}
    />
  </NavigationRail>
  <main
    class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] w-svw overflow-y-auto rounded-md p-4"
  >
    {@render children()}
  </main>
</div>
