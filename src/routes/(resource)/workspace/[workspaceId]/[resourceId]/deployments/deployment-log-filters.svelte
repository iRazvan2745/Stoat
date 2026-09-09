<script lang="ts">
    import { Checkbox } from "m3-svelte";

    import type { LogFilter } from "./deployment-log-view";

    interface Props {
        allCount: number;
        debugCount: number;
        logFilter: LogFilter;
        showDebugLogs: boolean;
        stderrCount: number;
        stdoutCount: number;
    }

    let {
        allCount,
        debugCount,
        logFilter = $bindable(),
        showDebugLogs = $bindable(),
        stderrCount,
        stdoutCount,
    }: Props = $props();

    function getLogFilterButtonClasses(active: boolean) {
        return [
            "log-filter m3-font-label-medium m3-layer inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 py-1.5 transition-colors",
            active
                ? "bg-secondary-container text-on-secondary-container"
                : "bg-transparent text-on-surface-variant",
        ].join(" ");
    }
</script>

<div class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <div
        class="bg-surface-container flex w-fit items-center gap-1 rounded-full p-1"
        role="group"
        aria-label="Filter deployment logs"
    >
        <button
            class={getLogFilterButtonClasses(logFilter === "all")}
            type="button"
            aria-pressed={logFilter === "all"}
            onclick={() => (logFilter = "all")}
        >
            All
            <span class="tabular-nums">{allCount}</span>
        </button>

        <button
            class={getLogFilterButtonClasses(logFilter === "stdout")}
            type="button"
            aria-pressed={logFilter === "stdout"}
            onclick={() => (logFilter = "stdout")}
        >
            Output
            <span class="tabular-nums">{stdoutCount}</span>
        </button>

        <button
            class={getLogFilterButtonClasses(logFilter === "stderr")}
            type="button"
            aria-pressed={logFilter === "stderr"}
            onclick={() => (logFilter = "stderr")}
        >
            Errors
            <span class="tabular-nums">{stderrCount}</span>
        </button>
    </div>

    {#if debugCount > 0}
        <label
            class="text-on-surface-variant m3-font-label-medium flex cursor-pointer items-center gap-2"
        >
            <Checkbox>
                <input type="checkbox" bind:checked={showDebugLogs} />
            </Checkbox>
            Show debug logs
            <span class="tabular-nums">{debugCount}</span>
        </label>
    {/if}
</div>

<style>
    .log-filter {
        @apply --m3-focus-inward;
    }
</style>
