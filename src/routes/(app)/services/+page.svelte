<script lang="ts">
  import { Button, Card, Divider, LoadingIndicator } from "m3-svelte";

  import { getServices } from "#lib/api/services.remote";

  import { toServiceTree } from "./service-tree";
  import ServiceTree from "./service-tree.svelte";

  const services = getServices();

  const tree = $derived(toServiceTree(services.current?.items ?? []));
</script>

<Card variant="outlined" id="services-card">
  {#if services.loading}
    <div class="flex min-h-32 items-center justify-center">
      <LoadingIndicator aria-label="Loading services" />
    </div>
  {:else if services.error}
    <div class="text-error p-6 text-sm">
      {services.error.message}
    </div>
  {:else}
    <!-- toolbar -->
    <div class="flex items-center justify-between gap-4 p-5">
      <div>
        <h1 class="text-on-surface text-lg font-medium">Services</h1>

        <p class="text-on-surface-variant mt-0.5 text-sm">
          {services.current?.items.length ?? 0}
          {(services.current?.items.length ?? 0) === 1 ? "service" : "services"}
        </p>
      </div>

      <Button onclick={() => services.refresh()}>Refresh</Button>
    </div>

    <Divider />

    <div class="overflow-x-auto">
      <!-- table header -->
      <div
        class="
          text-on-surface-variant
          grid min-w-275
          grid-cols-[minmax(260px,1.4fr)_130px_240px_110px_110px]
          items-center gap-4
          px-5 py-3
          text-xs font-medium
        "
      >
        <span>Service</span>
        <span>Mode</span>
        <span>Machines</span>
        <span>Containers</span>
        <span>Hooks</span>
      </div>

      <Divider />

      <!-- table/tree rows -->
      <ServiceTree nodes={tree} />

      {#if tree.length === 0}
        <div
          class="
            text-on-surface-variant
            px-5 py-10 text-center text-sm
          "
        >
          No services found.
        </div>
      {/if}
    </div>
  {/if}
</Card>

<style>
  #services-card :global(.m3-container) {
    @apply p-0;
  }
</style>
