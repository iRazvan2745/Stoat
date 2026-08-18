<script lang="ts">
    // oxlint-disable func-style
    import {
        Button,
        Card,
        Divider,
        LoadingIndicator,
        pathHeart,
    } from "m3-svelte";

    import { getMachines } from "#lib/api/cluster/machines.remote";

    const machines = getMachines();

    function stateClasses(state: string) {
        switch (state.toLowerCase()) {
            case "running":
            case "online":
            case "active": {
                return "bg-primary-container text-on-primary-container";
            }

            case "error":
            case "failed":
            case "offline":
            case "stopped": {
                return "bg-error-container text-on-error-container";
            }

            default: {
                return "bg-secondary-container text-on-secondary-container";
            }
        }
    }
</script>

<div class="flex items-center justify-between gap-4 p-5">
    <div>
        <h1 class="text-on-surface text-lg font-medium">Machines</h1>

        <p class="text-on-surface-variant mt-0.5 text-sm">
            {machines.current?.items.length ?? 0}
            {(machines.current?.items.length ?? 0) === 1
                ? "machine"
                : "machines"}
        </p>
    </div>

    <Button onclick={() => machines.refresh()}>Refresh</Button>
</div>
<Card variant="outlined" id="machines-card">
    {#if machines.loading}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading machines" />
        </div>
    {:else if machines.error}
        <div class="text-error p-6 text-sm">
            {machines.error.message}
        </div>
    {:else}
        <div class="overflow-x-auto">
            <!-- table header -->
            <div
                class="
          text-on-surface-variant
          bg-surface-container-high grid
          min-w-275
          grid-cols-[minmax(240px,1.4fr)_150px_150px_240px_110px_150px_150px_110px] items-center
          gap-4 px-5
          py-3 text-xs
          font-medium
        "
            >
                <span>Machine</span>
                <span>Public IP</span>
                <span>Management</span>
                <span>OS</span>
                <span>Arch</span>
                <span>Docker</span>
                <span>Daemon</span>
                <span>Status</span>
            </div>

            <Divider />

            <!-- table rows -->
            {#each machines.current?.items ?? [] as machine, index (machine.id)}
                <div
                    class="
            border-outline-variant
            grid min-w-275
            grid-cols-[minmax(240px,1.4fr)_150px_150px_240px_110px_150px_150px_110px]
            items-center gap-4
            border-b px-5 py-3
            transition-colors
          "
                >
                    <!-- machine -->
                    <div class="flex min-w-0 items-center gap-2">
                        <div
                            class={[
                                "inline-flex items-center rounded-full p-1.5",
                                "text-xs font-medium capitalize",
                                stateClasses(machine.state),
                            ]}
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 380 380"
                                aria-hidden="true"
                            >
                                <path d={pathHeart} fill="currentColor" />
                            </svg>
                        </div>

                        <div class="min-w-0">
                            <div
                                class="text-on-surface truncate text-sm font-medium"
                            >
                                {machine.name}
                            </div>

                            <div
                                class="text-on-surface-variant truncate text-xs"
                            >
                                {machine.hostname ?? machine.id}
                            </div>
                        </div>
                    </div>

                    <!-- public IP -->
                    <div class="text-on-surface truncate font-mono text-sm">
                        {machine.publicIp ?? "—"}
                    </div>

                    <!-- management IP -->
                    <div class="text-on-surface truncate font-mono text-sm">
                        {machine.network?.managementIp ?? "—"}
                    </div>

                    <!-- OS -->
                    <div class="flex min-w-0 items-center gap-2">
                        {#if machine.osPrettyName
                            ?.split(" ")[0]
                            ?.toLowerCase() === "debian"}
                            <img
                                src="/debian.svg"
                                alt="debian"
                                height="24"
                                width="24"
                            />
                        {/if}
                        <div class="min-w-0">
                            <div class="text-on-surface truncate text-sm">
                                {machine.osPrettyName ?? "—"}
                            </div>

                            {#if machine.kernelVersion}
                                <div
                                    class="text-on-surface-variant truncate text-xs"
                                >
                                    {machine.kernelVersion}
                                </div>
                            {/if}
                        </div>
                    </div>

                    <!-- arch -->
                    <div class="text-on-surface truncate text-sm">
                        {machine.arch ?? "—"}
                    </div>

                    <!-- docker -->
                    <div class="text-on-surface truncate text-sm">
                        {machine.dockerVersion ?? "—"}
                    </div>

                    <!-- daemon -->
                    <div class="text-on-surface truncate text-sm">
                        {machine.daemonVersion ?? "—"}
                    </div>

                    <!-- status -->
                    <div>
                        <span
                            class={[
                                "inline-flex items-center rounded-full px-2.5 py-1",
                                "text-xs font-medium capitalize",
                                stateClasses(machine.state),
                            ]}
                        >
                            {machine.state}
                        </span>
                    </div>
                </div>

                {#if index < (machines.current?.items.length ?? 0) - 1}
                    <Divider />
                {/if}
            {/each}

            {#if (machines.current?.items.length ?? 0) === 0}
                <div
                    class="text-on-surface-variant px-5 py-10 text-center text-sm"
                >
                    No machines found.
                </div>
            {/if}
        </div>
    {/if}
</Card>

<style>
    :global(#machines-card.m3-container) {
        padding: 0;
        overflow-x: hidden;
    }
</style>
