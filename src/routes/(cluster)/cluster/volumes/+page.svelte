<script lang="ts">
    // oxlint-disable func-style
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import { Button, Card, Divider, Icon, LoadingIndicator } from "m3-svelte";

    import { listVolumes } from "#lib/api/cluster/volumes.remote";

    type Volume = NonNullable<
        ReturnType<typeof listVolumes>["current"]
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

    const volumes = listVolumes();

    const metadata = (volume: Volume): VolumeMetadata =>
        volume.volume as unknown as VolumeMetadata;
</script>

<div class="flex items-center justify-between gap-4 p-5">
    <div>
        <h1 class="m3-font-headline-small text-on-surface">Volumes</h1>

        <p class="m3-font-body-medium text-on-surface-variant mt-0.5">
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
        <div class="text-error m3-font-body-medium p-6">
            {volumes.error.message}
        </div>
    {:else}
        <div class="overflow-x-auto">
            <!-- table header -->
            <div
                class="
          text-on-surface-variant
          m3-font-label-medium
          bg-surface-container-high grid
          min-w-275
          grid-cols-[minmax(240px,1.4fr)_200px_120px_minmax(260px,1fr)] items-center
          gap-4 px-5
          py-3
        "
            >
                <span>Volume</span>
                <span>Machine</span>
                <span>Driver</span>
                <span>Mountpoint</span>
            </div>

            <Divider />

            <!-- table rows -->
            {#each volumes.current?.items ?? [] as item, index (`${item.dataSourceId}:${item.machineId}:${metadata(item).Name ?? ""}`)}
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
                            <Icon icon={databaseIcon} size={18} />
                        </div>

                        <div class="min-w-0">
                            <div
                                class="m3-font-label-large text-on-surface truncate"
                            >
                                {metadata(item).Name ?? item.machineId}
                            </div>

                            <div
                                class="m3-font-label-small text-on-surface-variant truncate"
                            >
                                {metadata(item).Driver ?? "local"} volume
                            </div>
                        </div>
                    </div>

                    <!-- Machine -->
                    <div class="m3-font-body-medium text-on-surface truncate">
                        {item.machineName}
                    </div>

                    <!-- Driver -->
                    <div class="m3-font-body-medium text-on-surface truncate">
                        {metadata(item).Driver ?? "—"}
                    </div>

                    <!-- Mountpoint -->
                    <div
                        class="text-on-surface-variant m3-font-body-medium truncate font-mono"
                    >
                        {metadata(item).Mountpoint ?? "—"}
                    </div>
                </div>

                {#if index < (volumes.current?.items.length ?? 0) - 1}
                    <Divider />
                {/if}
            {/each}

            {#if (volumes.current?.items.length ?? 0) === 0}
                <div
                    class="text-on-surface-variant m3-font-body-medium px-5 py-10 text-center"
                >
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
