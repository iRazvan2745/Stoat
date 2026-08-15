<script lang="ts">
  import appsIcon from "@ktibow/iconset-material-symbols/apps";
  import computerIcon from "@ktibow/iconset-material-symbols/computer-outline";
  import folderIcon from "@ktibow/iconset-material-symbols/folder-outline";
  import houseOutlineIcon from "@ktibow/iconset-material-symbols/house-outline";
  import { NavigationRail, NavigationRailItem } from "m3-svelte";

  let { children } = $props();
  let railOpen = $state(false);
</script>

<div class="flex h-full w-svw">
  <NavigationRail bind:open={railOpen}>
    <NavigationRailItem href="/" label="Overview" icon={houseOutlineIcon} />

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
      href="/cluster/volumes"
      label="Volumes"
      icon={folderIcon}
    />
  </NavigationRail>
  <main
    class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] w-svw overflow-y-auto rounded-md p-4"
  >
    {@render children()}
  </main>
</div>
