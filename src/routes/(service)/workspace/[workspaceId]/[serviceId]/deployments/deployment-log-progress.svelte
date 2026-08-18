<script lang="ts">
    import checkIcon from "@ktibow/iconset-material-symbols/check-circle-outline";
    import { Icon, LinearProgress, LinearProgressEstimate } from "m3-svelte";

    import type { ParsedDeploymentProgress } from "#lib/deployment-logs";

    interface Props {
        createdAt: Date;
        formatTime: (date: Date | null) => string | null;
        isError: boolean;
        progress: ParsedDeploymentProgress;
    }

    let { createdAt, formatTime, isError, progress }: Props = $props();

    const isComplete = $derived(
        progress.phase === "done" && !progress.indeterminate
    );

    const displayStatus = $derived(
        progress.status === "updated" && isComplete
            ? "Complete"
            : progress.status
    );

    const statusTone = $derived.by(() => {
        if (isError) {
            return "error";
        }
        if (isComplete) {
            return "complete";
        }
        if (progress.indeterminate) {
            return "active";
        }
        return "running";
    });

    const statusBadgeClass = $derived.by(() => {
        switch (statusTone) {
            case "error": {
                return "bg-error-container text-on-error-container";
            }
            case "complete": {
                return "bg-primary-container text-on-primary-container";
            }
            case "active": {
                return "bg-tertiary-container text-on-tertiary-container";
            }
            default: {
                return "bg-secondary-container text-on-secondary-container";
            }
        }
    });

    const progressBarClass = $derived.by(() => {
        switch (statusTone) {
            case "error": {
                return "[&_.m3-container]:text-error";
            }
            case "complete": {
                return "[&_.m3-container]:text-primary";
            }
            default: {
                return "[&_.m3-container]:text-tertiary";
            }
        }
    });
</script>

<div
    class="grid grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-4 rounded-xl px-4 py-2 font-sans transition-colors
        {isError
        ? 'bg-error-container-subtle/10 hover:bg-error-container-subtle/20'
        : 'hover:bg-surface-container-high/60'}"
>
    <time
        class="text-on-surface-variant pt-1.5 text-right text-[0.6875rem] leading-5 tabular-nums select-none"
        datetime={createdAt.toISOString()}
    >
        {formatTime(createdAt)}
    </time>

    <div class="min-w-0 py-1 pr-1">
        <div class="mb-2 flex items-start justify-between gap-4">
            <p
                class="text-on-surface min-w-0 text-sm leading-snug font-medium break-all"
            >
                {progress.label}
            </p>

            <span
                class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium capitalize {statusBadgeClass}"
            >
                {#if isComplete}
                    <Icon icon={checkIcon} size={14} />
                {/if}
                {displayStatus}
            </span>
        </div>

        <div
            class="[&_.m3-container]:w-full [&_.m3-container]:max-w-full {progressBarClass}"
        >
            {#if progress.indeterminate && !isComplete}
                <LinearProgressEstimate
                    height={4}
                    aria-labelledby={progress.label}
                />
            {:else}
                <LinearProgress
                    height={4}
                    percent={progress.percent ?? (isComplete ? 100 : 0)}
                    title={progress.label}
                />
            {/if}
        </div>

        {#if progress.percent != null && !isComplete}
            <p class="text-on-surface-variant mt-1.5 text-[11px] tabular-nums">
                {Math.round(progress.percent)}%
            </p>
        {/if}
    </div>
</div>
