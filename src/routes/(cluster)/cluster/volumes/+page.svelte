<script lang="ts">
  // oxlint-disable func-style
  import { Button, Card, Divider, LoadingIndicator } from "m3-svelte";

  import { getVolumes } from "#lib/api/volumes.remote";

  type Volume = NonNullable<
    ReturnType<typeof getVolumes>["current"]
  >["items"][number];

  interface VolumeMetadata {
    Name?: string;
    Driver?: string;
    Mountpoint?: string;
    Scope?: string;
    Labels?: Record<string, string>;
    Options?: Record<string, string>;
    CreatedAt?: string;
  }

  const volumes = getVolumes();

  const metadata = (volume: Volume): VolumeMetadata =>
    volume.volume as unknown as VolumeMetadata;
</script>

<div class="flex items-center justify-between gap-4 p-5">
  <div>
    <h1 class="text-on-surface text-lg font-medium">Volumes</h1>

    <p class="text-on-surface-variant mt-0.5 text-sm">
      {volumes.current?.items.length ?? 0}
      {(volumes.current?.items.length ?? 0) === 1 ? "volume" : "volumes"}
    </p>
  </div>

  <Button onclick={() => volumes.refresh()}>Refresh</Button>
</div>
<Card variant="outlined" id="volumes-card">
  {#if volumes.loading}
    <div class="flex min-h-32 items-center justify-center">
      <LoadingIndicator aria-label="Loading volumes" />
    </div>
  {:else if volumes.error}
    <div class="text-error p-6 text-sm">
      {volumes.error.message}
    </div>
  {:else}
    <div class="overflow-x-auto">
      <!-- table header -->
      <div
        class="
          text-on-surface-variant
          bg-surface-container-high grid
          min-w-275
          grid-cols-[minmax(240px,1.4fr)_200px_120px_minmax(260px,1fr)] items-center
          gap-4 px-5
          py-3 text-xs
          font-medium
        "
      >
        <span>Volume</span>
        <span>Machine</span>
        <span>Driver</span>
        <span>Mountpoint</span>
      </div>

      <Divider />

      <!-- table rows -->
      {#each volumes.current?.items ?? [] as item, index (item.machineId + (metadata(item).Name ?? ""))}
        <div
          class="
            border-outline-variant
            grid min-w-275
            grid-cols-[minmax(240px,1.4fr)_200px_120px_minmax(260px,1fr)]
            items-center gap-4
            border-b px-5 py-3
            transition-colors
          "
        >
          <!-- Volume -->
          <div class="flex min-w-0 items-center">
            <div
              class="
                bg-surface-container
                text-on-surface-variant
                mr-2 inline-flex shrink-0 items-center
                rounded-full p-1.5
              "
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  d="M12 3C7.58 3 4 4.79 4 7s3.58 4 8 4 8-1.79 8-4-3.58-4-8-4zM4 9v5c0 2.21 3.58 4 8 4s8-1.79 8-4V9c0 2.21-3.58 4-8 4s-8-1.79-8-4zm0 7v2c0 2.21 3.58 4 8 4s8-1.79 8-4v-2c0 2.21-3.58 4-8 4s-8-1.79-8-4z"
                  fill="currentColor"
                />
              </svg>
            </div>

            <div class="min-w-0">
              <div class="text-on-surface truncate text-sm font-medium">
                {metadata(item).Name ?? item.machineId}
              </div>

              <div class="text-on-surface-variant truncate text-[11px]">
                {metadata(item).Driver ?? "local"} volume
              </div>
            </div>
          </div>

          <!-- Machine -->
          <div class="text-on-surface truncate text-sm">
            {item.machineName}
          </div>

          <!-- Driver -->
          <div class="text-on-surface truncate text-sm">
            {metadata(item).Driver ?? "—"}
          </div>

          <!-- Mountpoint -->
          <div class="text-on-surface-variant truncate font-mono text-sm">
            {metadata(item).Mountpoint ?? "—"}
          </div>
        </div>

        {#if index < (volumes.current?.items.length ?? 0) - 1}
          <Divider />
        {/if}
      {/each}

      {#if (volumes.current?.items.length ?? 0) === 0}
        <div class="text-on-surface-variant px-5 py-10 text-center text-sm">
          No volumes found.
        </div>
      {/if}
    </div>
  {/if}
</Card>

<style>
  :global(#volumes-card.m3-container) {
    padding: 0;
    overflow-x: hidden;
  }
</style>
