<script lang="ts">
  import appsIcon from "@ktibow/iconset-material-symbols/apps";
  import iconSearch from "@ktibow/iconset-material-symbols/search";
  import {
    Button,
    Card,
    Divider,
    Icon,
    LoadingIndicator,
    TextField,
  } from "m3-svelte";
  import { parseAsString, useQueryState } from "nuqs-svelte";

  import { getServices } from "#lib/api/services.remote";

  const services = getServices();

  const search = useQueryState("q", parseAsString.withDefault(""));

  // oxlint-disable-next-line func-style
  function modeClasses(mode: string) {
    switch (mode.toLowerCase()) {
      case "global": {
        return "bg-primary-container text-on-primary-container";
      }

      case "replicated": {
        return "bg-secondary-container text-on-secondary-container";
      }

      default: {
        return "bg-tertiary-container text-on-tertiary-container";
      }
    }
  }

  const filteredServices = $derived(
    (services.current?.items ?? []).filter((service) => {
      const query = search.current.trim().toLowerCase();

      if (!query) {
        return true;
      }

      return [
        service.name,
        service.id,
        service.mode,
        ...service.containers.map((container) => container.machineName),
        ...service.hookContainers.map((container) => container.machineName),
      ].some((value) => value.toLowerCase().includes(query));
    })
  );
</script>

<Card variant="outlined" class="overflow-hidden">
  {#if services.loading}
    <div class="flex min-h-32 items-center justify-center">
      <LoadingIndicator aria-label="Loading services" />
    </div>
  {:else if services.error}
    <div class="text-error p-6 text-sm">
      {services.error.message}
    </div>
  {:else}
    <div class="overflow-x-auto">
      <div class="mb-4 flex w-full items-center justify-between gap-4">
        <h1 class="text-lg">Services</h1>
        <div class="flex items-center gap-4">
          <TextField
            label="Search services"
            leadingIcon={iconSearch}
            bind:value={search.current}
          />
          <Button onclick={() => getServices().refresh()}>Refresh</Button>
        </div>
      </div>
      <!-- table header -->
      <div
        class="
          text-on-surface-variant grid
          min-w-275
          grid-cols-[minmax(200px,1.4fr)_130px_240px_110px_110px] items-center
          gap-4 px-5
          py-3 text-xs
          font-medium
        "
      >
        <span>Service</span>
        <span>Mode</span>
        <span>Machines</span>
        <span>Containers</span>
        <span>Hooks</span>
      </div>

      <Divider />

      {#each filteredServices as service, index (service.id)}
        <div
          class="
            hover:bg-surface-container-low grid
            min-w-275
            grid-cols-[minmax(200px,1.4fr)_130px_240px_110px_110px] items-center
            gap-4 px-5
            py-4
            transition-colors
          "
        >
          <!-- service -->
          <div class="flex min-w-0 items-center gap-2">
            <div
              class={[
                "inline-flex items-center rounded-full px-2.5 py-1",
                "text-xs font-medium",
                modeClasses(service.mode),
              ]}
            >
              <Icon icon={appsIcon} size={20} />
            </div>

            <div>
              <div class="text-on-surface truncate font-medium">
                {service.name}
              </div>

              <div class="text-on-surface-variant truncate text-xs">
                {service.id}
              </div>
            </div>
          </div>

          <!-- mode -->
          <div>
            <span
              class={[
                "inline-flex items-center rounded-full px-2.5 py-1",
                "text-xs font-medium capitalize",
                modeClasses(service.mode),
              ]}
            >
              {service.mode}
            </span>
          </div>

          <!-- machines -->
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            {#each service.containers as container}
              <span
                class="bg-surface-container text-on-surface-variant truncate rounded-full px-2.5 py-1 text-xs"
              >
                {container.machineName}
              </span>
            {/each}
          </div>

          <!-- containers -->
          <div class="text-on-surface text-sm">
            {service.containers.length}
          </div>

          <!-- hook containers -->
          <div class="text-on-surface text-sm">
            {service.hookContainers.length}
          </div>
        </div>

        {#if index < filteredServices.length - 1}
          <Divider />
        {/if}
      {/each}

      {#if filteredServices.length === 0}
        <div class="text-on-surface-variant px-5 py-8 text-center text-sm">
          No services match "{search.current}".
        </div>
      {/if}
    </div>
  {/if}
</Card>
