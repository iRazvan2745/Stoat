<script lang="ts" module>
    export type ResourceStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | null;

    export type ProjectOverview = {
        id: string;
        name: string;
        description: string | null;
        clusterId: string;
        clusterName: string;
        lastActivityAt: Date | string;
        resources: { id: string; name: string; status: ResourceStatus }[];
    };
</script>

<script lang="ts">
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Card } from "$lib/components/ui/card";
    import { Menu, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "$lib/components/ui/menu";
    import { cn } from "$lib/utils";
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import Plus from "@lucide/svelte/icons/plus";
    import Server from "@lucide/svelte/icons/server";

    let { project, now }: { project: ProjectOverview; now: number } = $props();

    const maxResources = 6;

    const visible = $derived(project.resources.slice(0, maxResources));

    const hidden = $derived(project.resources.length - visible.length);

    const statusLabels: Record<Exclude<ResourceStatus, null>, string> = {
        queued: "Deploy queued",
        running: "Deploying",
        ready: "Deployed",
        failed: "Deploy failed",
        cancelled: "Deploy cancelled",
    };

    function dotClass(status: ResourceStatus) {
        switch (status) {
            case "ready":
                return "bg-success";
            case "failed":
                return "bg-destructive";
            case "queued":
            case "running":
                return "animate-pulse bg-warning";
            default:
                return "bg-muted-foreground/40";
        }
    }

    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

    function ago(value: Date | string) {
        const seconds = Math.round((new Date(value).getTime() - now) / 1000);
        const units: [Intl.RelativeTimeFormatUnit, number][] = [
            ["year", 31_536_000],
            ["month", 2_592_000],
            ["week", 604_800],
            ["day", 86_400],
            ["hour", 3_600],
            ["minute", 60],
        ];

        for (const [unit, size] of units) {
            if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
        }

        return "just now";
    }
</script>

<Card class="group h-full gap-0 p-4 transition-colors hover:border-input" data-slot="project-overview-card">
    <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
            <h2 class="truncate text-[15px] font-semibold leading-tight">
                <a href="/projects/{project.id}" class="before:absolute before:inset-0 group-hover:underline">
                    {project.name}
                </a>
            </h2>
            <p class={cn("mt-0.5 truncate text-sm text-muted-foreground", !project.description?.trim() && "italic opacity-64")}>
                {project.description?.trim() || "No description"}
            </p>
        </div>
        <Menu>
            <MenuTrigger
                class={buttonVariants({ variant: "ghost", size: "icon-xs", class: "relative z-10 -me-1 -mt-0.5 shrink-0" })}
                aria-label={`Actions for ${project.name}`}
            >
                <Ellipsis class="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
                <MenuLinkItem href="/projects/{project.id}">
                    <FolderOpen aria-hidden="true" />
                    Open project
                </MenuLinkItem>
                <MenuLinkItem href="/projects/{project.id}?dialog=create-resource">
                    <Plus aria-hidden="true" />
                    New resource
                </MenuLinkItem>
                <MenuSeparator />
                <MenuLinkItem href="/clusters/{project.clusterId}">
                    <Server aria-hidden="true" />
                    View cluster
                </MenuLinkItem>
            </MenuPopup>
        </Menu>
    </div>

    <ul class="mt-5 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm" aria-label="Resources">
        {#each visible as resource (resource.id)}
            <li class="flex min-w-0 max-w-40 items-center gap-1.5">
                <span class={cn("size-2 shrink-0 rounded-full", dotClass(resource.status))} aria-hidden="true"></span>
                <span class="truncate">{resource.name}</span>
                <span class="sr-only">({resource.status ? statusLabels[resource.status] : "Not deployed"})</span>
            </li>
        {:else}
            <li class="text-muted-foreground">No resources yet</li>
        {/each}
        {#if hidden > 0}
            <li class="text-xs text-muted-foreground">+{hidden} more</li>
        {/if}
    </ul>

    <p class="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span class="truncate">{project.clusterName}</span>
        <span aria-hidden="true">·</span>
        <time class="shrink-0" datetime={new Date(project.lastActivityAt).toISOString()}>{ago(project.lastActivityAt)}</time>
    </p>
</Card>
