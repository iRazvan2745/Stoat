<script lang="ts">
    import { ScrollArea } from "$lib/components/ui/scroll-area";
    import { Separator } from "$lib/components/ui/separator";
    import { Tooltip, TooltipPopup, TooltipTrigger } from "$lib/components/ui/tooltip";
    import Server from "@lucide/svelte/icons/server";
    import { Match } from "effect";

    type Machine = { id: string; name: string; state: string };

    type Link = { from: string; to: string; medianMs: number; standardDevMs: number };

    let { machines, links }: { machines: Machine[]; links: Link[] } = $props();

    const markerId = $props.id();

    let focusedMachine = $state<string | null>(null);

    // Include endpoints missing from diagnostics, without duplicating machine nodes.
    const nodes = $derived.by(() => {
        const unique = new Map(machines.map((machine) => [machine.id, machine]));

        for (const link of links) {
            for (const id of [link.from, link.to]) {
                if (!unique.has(id)) unique.set(id, { id, name: id, state: "Unknown" });
            }
        }

        return [...unique.values()];
    });

    const width = $derived(nodes.length <= 2 ? 600 : Math.max(640, nodes.length * 115));

    const height = $derived(nodes.length <= 2 ? 250 : Math.max(380, nodes.length * 70));

    const positions = $derived(new Map(nodes.map((node, index) => {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / nodes.length;

        return [node.id, {
            x: Match.value(nodes.length).pipe(
                Match.when(1, () => width / 2),
                Match.when(2, () => 140 + index * 320),
                Match.orElse(() => width / 2 + (width / 2 - 110) * Math.cos(angle)),
            ),
            y: nodes.length <= 2 ? height / 2 : height / 2 + (height / 2 - 65) * Math.sin(angle),
        }];
    })));

    function formatLatency(value: number) {
        if (!Number.isFinite(value) || value < 0) return "Unavailable";

        if (value > 0 && value < 0.1) return "<0.1 ms";

        return `${value.toFixed(1)} ms`;
    }

    function machineName(id: string) {
        return nodes.find((node) => node.id === id)?.name ?? id;
    }

    const visualLinks = $derived.by(() => {
        const grouped = new Map<string, Link[]>();

        for (const [index, link] of links.entries()) {
            // Reciprocal diagnostics describe the same physical connection.
            // Keep self-links separate so repeated self-link measurements still
            // get their own loop.
            const key = link.from === link.to
                ? `self-${index}`
                : JSON.stringify([link.from, link.to].sort());

            const group = grouped.get(key) ?? [];
            group.push(link);
            grouped.set(key, group);
        }

        return [...grouped.values()].map((group, index) => ({
            ...group[0],
            index,
            links: group,
            bidirectional: group.some((link) =>
                link.from === group[0].to && link.to === group[0].from,
            ),
        }));
    });

    const edges = $derived.by(() => {
        const occurrences = new Map<string, number>();

        return visualLinks.map((link) => {
            const from = positions.get(link.from)!;
            const to = positions.get(link.to)!;
            const key = link.from === link.to ? link.from : JSON.stringify([link.from, link.to].sort());
            const occurrence = occurrences.get(key) ?? 0;
            occurrences.set(key, occurrence + 1);

            if (link.from === link.to) {
                const lift = 64 + occurrence * 32;

                return { ...link,
                    path: `M ${from.x - 28} ${from.y - 28} C ${from.x - 90} ${from.y - lift - 40}, ${from.x + 90} ${from.y - lift - 40}, ${from.x + 28} ${from.y - 32}`,
                    x: from.x, y: from.y - lift - 10,
                };
            }

            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy);
            const bend = occurrence * 38;
            const cx = (from.x + to.x) / 2 - dy / length * bend;
            const cy = (from.y + to.y) / 2 + dx / length * bend;

            // Intersect the curve tangents with each machine's rectangular boundary.
            function anchor(node: { x: number; y: number }, extra: number) {
                const vx = cx - node.x;
                const vy = cy - node.y;
                const scale = Math.min(76 / Math.abs(vx), 28 / Math.abs(vy));
                const distance = Math.hypot(vx, vy);

                return { x: node.x + vx * scale + vx / distance * extra, y: node.y + vy * scale + vy / distance * extra };
            }

            const start = anchor(from, 2);
            const end = anchor(to, 7);

            return { ...link,
                path: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
                x: (start.x + 2 * cx + end.x) / 4,
                y: (start.y + 2 * cy + end.y) / 4,
            };
        });
    });
</script>

<div>
    <Separator />
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground sm:px-5">
        <span>{nodes.length} machines <span class="mx-1 opacity-40">/</span> {links.length} measured paths</span>
        <span>Median latency / Hover a path for variation</span>
    </div>
    <ScrollArea
        orientation="both"
        class="h-auto max-h-[640px] rounded-b-xl"
        clampContentMinWidth={false}
        role="region"
        aria-label="Machine connection graph"
    >
        <div class="relative mx-auto" style:width={`${width}px`} style:height={`${height}px`}>
            <svg {width} {height} class="absolute inset-0 text-muted-foreground" aria-hidden="true">
                <defs>
                    <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                    </marker>
                </defs>
                {#each edges as edge (edge.index)}
                    <path d={edge.path} fill="none" stroke="currentColor" stroke-width="1.4"
                        marker-end={`url(#${markerId})`}
                        marker-start={edge.bidirectional ? `url(#${markerId})` : undefined}
                        class={focusedMachine !== null && edge.from !== focusedMachine && edge.to !== focusedMachine ? "opacity-15" : "opacity-60"} />
                {/each}
            </svg>
            {#each edges as edge (edge.index)}
                <div class="absolute z-[1] -translate-x-1/2 -translate-y-1/2 hover:z-[3] focus-within:z-[3]" style:left={`${edge.x}px`} style:top={`${edge.y}px`}
                    class:opacity-15={focusedMachine !== null && edge.from !== focusedMachine && edge.to !== focusedMachine}>
                    <Tooltip>
                        <TooltipTrigger
                            class="block cursor-help whitespace-nowrap rounded-[5px] border border-border bg-card px-[7px] py-[3px] font-mono text-[10px] tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[3px]"
                            aria-label={`${edge.bidirectional ? `${machineName(edge.from)} and ${machineName(edge.to)}` : `${machineName(edge.from)} to ${machineName(edge.to)}`}: median ${formatLatency(edge.medianMs)}`}
                        >
                            {formatLatency(edge.medianMs)}
                        </TooltipTrigger>
                        <TooltipPopup class="max-w-[260px] text-[11px]">
                            <span class="block [overflow-wrap:anywhere]">{edge.bidirectional ? `${machineName(edge.from)} ↔ ${machineName(edge.to)}` : `${machineName(edge.from)} → ${machineName(edge.to)}`}</span>
                            <span class="mt-1 block [overflow-wrap:anywhere] text-muted-foreground">
                                {#each edge.links as measuredLink (`${measuredLink.from}-${measuredLink.to}`)}
                                    <span class="block">{machineName(measuredLink.from)} → {machineName(measuredLink.to)}: {formatLatency(measuredLink.medianMs)} / ± {formatLatency(measuredLink.standardDevMs)}</span>
                                {/each}
                            </span>
                        </TooltipPopup>
                    </Tooltip>
                </div>
            {/each}
            {#each nodes as node (node.id)}
                {@const position = positions.get(node.id)!}
                <button type="button" class="absolute flex h-14 w-[152px] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-left text-foreground" style:left={`${position.x}px`} style:top={`${position.y}px`}
                    onmouseenter={() => focusedMachine = node.id}
                    onmouseleave={() => focusedMachine = null}
                    onfocus={() => focusedMachine = node.id}
                    onblur={() => focusedMachine = null}
                    aria-label={`${node.name}, ${node.state}. Highlight connected paths.`}>
                    <Server class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div class="min-w-0">
                        <span class="block overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium" title={node.name}>{node.name}</span>
                        <span class="text-[11px] text-muted-foreground capitalize">{node.state || "Unknown"}</span>
                    </div>
                </button>
            {/each}
        </div>
    </ScrollArea>
</div>
