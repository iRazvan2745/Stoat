<script lang="ts">
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import monitorHeartIcon from "@ktibow/iconset-material-symbols/monitor-heart";
    import { Button, Card, Icon, LoadingIndicator } from "m3-svelte";

    import { listOrganizationMachines } from "#lib/api/cluster/machines.remote";

    const machines = listOrganizationMachines();
    const machineCount = $derived(machines.current?.items.length ?? 0);
    const sourceCount = $derived(machines.current?.dataSources.length ?? 0);
    const connectedSourceCount = $derived(
        machines.current?.dataSources.filter(
            (source) => source.status === "connected"
        ).length ?? 0
    );
    const machineGroups = $derived.by(() => {
        const { current } = machines;

        if (!current) {
            return [];
        }

        return current.dataSources.map((source) => ({
            items: current.items.filter(
                (item) => item.dataSourceId === source.dataSourceId
            ),
            source,
        }));
    });

    function stateClasses(state: string): string {
        switch (state.toLowerCase()) {
            case "active":
            case "healthy":
            case "online":
            case "ready":
            case "running":
            case "up": {
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

<div class="flex items-center justify-between gap-4 py-5">
    <div>
        <h1 class="m3-font-headline-small text-on-surface">Machines</h1>

        <p class="m3-font-body-medium text-on-surface-variant mt-0.5">
            {machineCount}
            {machineCount === 1 ? "machine" : "machines"}
            <span aria-hidden="true"> · </span>
            {sourceCount}
            {sourceCount === 1 ? "data source" : "data sources"}
            <span aria-hidden="true"> · </span>
            {connectedSourceCount}/{sourceCount} connected
        </p>
    </div>

    <Button variant="tonal" onclick={() => machines.refresh()}>Refresh</Button>
</div>

<Card variant="outlined" id="machines-card">
    {#if machines.loading}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading machines" />
        </div>
    {:else if machines.error}
        <div class="text-error m3-font-body-medium p-6">{machines.error.message}</div>
    {:else if sourceCount === 0}
        <div class="text-on-surface-variant m3-font-body-medium px-5 py-10 text-center">
            No data sources are configured for this organization.
        </div>
    {:else}
        <div class="overflow-x-auto">
            <table
                class="w-full min-w-[44rem] table-fixed border-collapse text-left"
            >
                <colgroup>
                    <col class="w-[38%]" />
                    <col class="w-[17%]" />
                    <col class="w-[16%]" />
                    <col class="w-[29%]" />
                </colgroup>
                <thead
                    class="bg-surface-container-high text-on-surface-variant"
                >
                    <tr>
                        <th
                            class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                            scope="col"
                        >
                            Machine
                        </th>
                        <th
                            class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                            scope="col"
                        >
                            Public IP
                        </th>
                        <th
                            class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                            scope="col"
                        >
                            Management
                        </th>
                        <th
                            class="m3-font-label-medium px-5 py-3 whitespace-nowrap"
                            scope="col"
                        >
                            OS
                        </th>
                    </tr>
                </thead>

                {#each machineGroups as group (group.source.dataSourceId)}
                    <tbody>
                        <tr class="bg-surface-container-low">
                            <th
                                class="border-outline-variant border-t px-5 py-3"
                                colspan="4"
                                scope="rowgroup"
                            >
                                <div class="flex min-w-0 items-start gap-3">
                                    <span
                                        class="bg-surface-container text-on-surface-variant mt-0.5 inline-flex shrink-0 items-center rounded-full p-2"
                                    >
                                        <Icon icon={databaseIcon} size={18} />
                                    </span>

                                    <div class="min-w-0 text-left">
                                        <div
                                            class="m3-font-label-large text-on-surface truncate"
                                        >
                                            {group.source.label}
                                        </div>
                                        <div
                                            class="text-on-surface-variant m3-font-label-small truncate font-mono"
                                        >
                                            {group.source.uncloudUrl}
                                        </div>
                                        {#if group.source.error}
                                            <div
                                                class="text-error m3-font-body-small mt-1"
                                            >
                                                {group.source.error}
                                            </div>
                                        {/if}
                                    </div>
                                </div>
                            </th>
                        </tr>

                        {#each group.items as item (item.machine.id)}
                            {@const machine = item.machine}
                            <tr
                                class="border-outline-variant border-t align-top transition-colors"
                            >
                                <td class="px-5 py-4">
                                    <div class="flex items-start gap-2">
                                        <div
                                            class={[
                                                "inline-flex shrink-0 items-center rounded-full p-1.5",
                                                stateClasses(machine.state),
                                            ]}
                                            role="img"
                                            aria-label={`Machine status: ${machine.state}`}
                                        >
                                            <Icon
                                                icon={monitorHeartIcon}
                                                size={20}
                                            />
                                        </div>
                                        <div class="min-w-0">
                                            <div
                                                class="m3-font-label-large text-on-surface truncate"
                                            >
                                                {machine.name}
                                            </div>
                                            <div
                                                class="text-on-surface-variant m3-font-label-small truncate font-mono"
                                            >
                                                {machine.hostname ?? machine.id}
                                            </div>
                                        </div>
                                    </div>
                                </td>

                                <td
                                    class="m3-font-body-medium px-5 py-4 align-middle font-mono whitespace-nowrap"
                                >
                                    <div
                                        class="truncate"
                                        title={machine.publicIp ?? "—"}
                                    >
                                        {machine.publicIp ?? "—"}
                                    </div>
                                </td>

                                <td
                                    class="m3-font-body-medium px-5 py-4 align-middle font-mono whitespace-nowrap"
                                >
                                    <div
                                        class="max-w-40 truncate"
                                        title={machine.network?.managementIp ??
                                            "—"}
                                    >
                                        {machine.network?.managementIp ?? "—"}
                                    </div>
                                </td>

                                <td class="px-5 py-4 align-middle">
                                    <div class="m3-font-body-medium text-on-surface">
                                        {machine.osPrettyName ?? "Unknown OS"}
                                    </div>
                                    <div
                                        class="text-on-surface-variant m3-font-body-small mt-1 max-w-48 truncate"
                                        title={machine.kernelVersion ?? "—"}
                                    >
                                        Kernel {machine.kernelVersion ?? "—"}
                                    </div>
                                </td>
                            </tr>
                        {/each}

                        {#if group.items.length === 0}
                            <tr>
                                <td
                                    class="text-on-surface-variant m3-font-body-medium border-outline-variant border-t px-5 py-4"
                                    colspan="4"
                                >
                                    No machines returned from this data source.
                                </td>
                            </tr>
                        {/if}
                    </tbody>
                {/each}
            </table>
        </div>
    {/if}
</Card>

<style>
    :global(#machines-card.m3-container) {
        padding: 0;
        overflow: hidden;
    }
</style>
