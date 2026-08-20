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
            "inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 py-1.5 text-xs leading-4 font-medium transition-colors",
            "text-on-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            active
                ? "bg-secondary-container text-on-secondary-container"
                : "bg-transparent hover:bg-surface-container-high",
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
            <span class="tabular-nums opacity-72">{allCount}</span>
        </button>

        <button
            class={getLogFilterButtonClasses(logFilter === "stdout")}
            type="button"
            aria-pressed={logFilter === "stdout"}
            onclick={() => (logFilter = "stdout")}
        >
            Output
            <span class="tabular-nums opacity-72">{stdoutCount}</span>
        </button>

        <button
            class={getLogFilterButtonClasses(logFilter === "stderr")}
            type="button"
            aria-pressed={logFilter === "stderr"}
            onclick={() => (logFilter = "stderr")}
        >
            Errors
            <span class="tabular-nums opacity-72">{stderrCount}</span>
        </button>
    </div>

    {#if debugCount > 0}
        <label
            class="text-on-surface-variant flex cursor-pointer items-center gap-2 text-xs font-medium"
        >
            <Checkbox>
                <input type="checkbox" bind:checked={showDebugLogs} />
            </Checkbox>
            Show debug logs
            <span class="tabular-nums opacity-72">{debugCount}</span>
        </label>
    {/if}
</div>
