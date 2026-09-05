<script lang="ts" module>
    const timeFormatter = new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        second: "2-digit",
    });

    const formatTime = (timestamp: string): string => {
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? "" : timeFormatter.format(date);
    };
</script>

<script lang="ts">
    import AnsiLogLine from "#lib/components/logs/ansi-log-line.svelte";
    import { parseAnsiLogLines } from "#lib/domain/logs/ansi";

    let {
        message,
        timestamp,
        containerLabel,
    }: {
        message: string;
        timestamp: string;
        containerLabel: string;
    } = $props();

    // Scalar props keep existing entries parsed when a new snapshot arrives.
    const lines = $derived(parseAnsiLogLines(message));
    const time = $derived(formatTime(timestamp));
</script>

{#each lines as line, lineIndex (lineIndex)}
    <div class="flex gap-3">
        <span
            class="text-on-surface-variant w-14 shrink-0 tabular-nums select-none"
        >
            {lineIndex === 0 ? time : ""}
        </span>
        <span
            class="text-primary max-w-40 shrink-0 truncate select-none"
            title={containerLabel}
        >
            {lineIndex === 0 ? containerLabel : ""}
        </span>
        <span
            class="text-on-surface min-w-0 wrap-break-word whitespace-pre-wrap"
        >
            <AnsiLogLine segments={line} />
        </span>
    </div>
{/each}
