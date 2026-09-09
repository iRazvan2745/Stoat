<script lang="ts">
    import appsIcon from "@ktibow/iconset-material-symbols/apps";
    import { Icon } from "m3-svelte";

    import type { Service } from "./service-tree";

    let {
        service,
        label,
        depth = 0,
        last = false,
    }: {
        service: Service;
        label: string;
        depth?: number;
        last?: boolean;
    } = $props();

    const modeClasses = (mode: string) => {
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
    };
</script>

<div
    class="
    border-outline-variant
    grid min-w-275
    grid-cols-[minmax(260px,1.4fr)_130px_240px_110px_110px]
    items-center gap-4
    border-b px-5 py-3
    transition-colors
  "
>
    <!-- Service -->
    <div class="flex min-w-0 items-center">
        <div
            class="flex shrink-0 items-center"
            style:width={`${depth * 28}px`}
        ></div>
        <div
            class={[
                "mr-2 inline-flex shrink-0 items-center",
                "rounded-full p-1.5",
                modeClasses(service.mode),
            ]}
        >
            <Icon icon={appsIcon} size={18} />
        </div>

        <div class="min-w-0">
            <div class="m3-font-label-large text-on-surface truncate">
                {label}
            </div>

            <div
                class="
          text-on-surface-variant
          m3-font-label-small truncate font-mono
        "
            >
                {service.id}
            </div>
        </div>
    </div>

    <!-- Mode -->
    <div>
        <span
            class={[
                "m3-font-label-medium inline-flex rounded-full px-2.5 py-1 capitalize",
                modeClasses(service.mode),
            ]}
        >
            {service.mode}
        </span>
    </div>

    <!-- Machines -->
    <div class="flex min-w-0 flex-wrap gap-1.5">
        {#each service.containers as container}
            <span
                class="
          bg-surface-container
          text-on-surface-variant
          m3-font-label-medium
          truncate rounded-full
          px-2.5 py-1
        "
            >
                {container.machineName}
            </span>
        {/each}
    </div>

    <!-- Containers -->
    <div class="m3-font-body-medium text-on-surface">
        {service.containers.length}
    </div>
</div>
