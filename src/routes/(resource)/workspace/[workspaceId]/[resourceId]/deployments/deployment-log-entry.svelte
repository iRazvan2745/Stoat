<script lang="ts">
    import type {
        DeploymentLogEntry,
        LogHighlightKind,
    } from "#lib/domain/deployments/logs";
    import { highlightLogMessage } from "#lib/domain/deployments/logs";

    import { formatTime } from "./deployment";
    import DeploymentLogProgress from "./deployment-log-progress.svelte";
    import { getChangeSummary } from "./deployment-log-view";

    interface Props {
        entry: DeploymentLogEntry;
    }

    let { entry }: Props = $props();

    function getLogRowClasses(isError: boolean, isDebug = false) {
        const base =
            "grid min-h-6 grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-4 rounded-md px-4 py-2 font-mono text-[0.75rem] leading-5 transition-colors";

        if (isError) {
            return `${base} bg-error-container-subtle/16 text-error hover:bg-error-container-subtle/28`;
        }

        if (isDebug) {
            return `${base} text-on-surface-variant hover:bg-surface-container-high`;
        }

        return `${base} text-on-surface hover:bg-surface-container-high`;
    }

    function getLogSegmentClasses(kind: LogHighlightKind) {
        switch (kind) {
            case "keyword": {
                return "text-primary";
            }

            case "info": {
                return "text-tertiary";
            }

            case "path": {
                return "text-on-secondary-container";
            }

            case "success": {
                return "text-primary";
            }

            case "number": {
                return "text-secondary";
            }

            default: {
                return "";
            }
        }
    }
</script>

{#if entry.kind === "section"}
    <div
        class="bg-surface-container-lowest/95 sticky top-0 z-10 px-4 pt-3 pb-1.5 first:pt-1"
    >
        <p
            class="m3-font-label-small text-on-surface-variant uppercase"
        >
            {entry.title}
        </p>
    </div>
{:else}
    {@const log = entry.log}
    {@const isError = log.stream === "stderr"}
    {@const isDebug = entry.kind === "text" && entry.debug}
    {@const changeSummary =
        entry.kind === "text" ? getChangeSummary(log.message) : null}

    {#if entry.kind === "progress"}
        <DeploymentLogProgress
            createdAt={log.createdAt}
            {isError}
            progress={entry.progress}
        />
    {:else if changeSummary}
        <div class={getLogRowClasses(isError, isDebug)}>
            <span
                class="text-on-surface-variant m3-font-label-small shrink-0 pt-0.5 text-right tabular-nums select-none"
            >
                {formatTime(log.createdAt)}
            </span>

            <span
                class="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 wrap-break-word"
            >
                <span>Changes: {changeSummary.changes},</span>

                <span
                    class="text-primary"
                    aria-label={`${changeSummary.insertions} insertions`}
                    title={`${changeSummary.insertions} insertions`}
                >
                    {"+".repeat(changeSummary.insertions)}
                </span>

                {#if changeSummary.deletions > 0}
                    <span
                        class="text-error"
                        aria-label={`${changeSummary.deletions} deletions`}
                        title={`${changeSummary.deletions} deletions`}
                    >
                        {"-".repeat(changeSummary.deletions)}
                    </span>
                {/if}
            </span>
        </div>
    {:else if entry.kind === "text"}
        {#each entry.lines as line, lineIndex (`${log.id}-${lineIndex}`)}
            <div class={getLogRowClasses(isError, isDebug)}>
                <span
                    class="text-on-surface-variant m3-font-label-small shrink-0 pt-0.5 text-right tabular-nums select-none"
                >
                    {#if lineIndex === 0}
                        {formatTime(log.createdAt)}
                    {/if}
                </span>

                <span class="min-w-0 wrap-break-word whitespace-pre-wrap">
                    {#each highlightLogMessage(line) as segment, segmentIndex (`${log.id}-${lineIndex}-${segmentIndex}`)}
                        <span class={getLogSegmentClasses(segment.kind)}>
                            {segment.text}
                        </span>
                    {/each}
                </span>
            </div>
        {/each}
    {/if}
{/if}
