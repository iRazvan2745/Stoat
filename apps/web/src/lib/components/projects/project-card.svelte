<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import {
        Card,
        CardDescription,
        CardFooter,
        CardHeader,
        CardTitle,
    } from "$lib/components/ui/card";
    import LayoutGrid from "@lucide/svelte/icons/layout-grid";

    let {
        name,
        description,
        resourceCount = 0,
        href,
    }: {
        name: string;
        description?: string | null;
        resourceCount?: number;
        href?: string;
    } = $props();
</script>

<Card class="group gap-0 p-4 transition-colors hover:border-input" data-slot="project-card">
    <CardHeader class="space-y-0 p-0">
        <div class="flex items-start gap-3">
            <span
                class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50"
                aria-hidden="true"
            >
                <LayoutGrid class="size-4 text-muted-foreground" />
            </span>
            <span class="min-w-0">
                <CardTitle class="block truncate text-[15px] leading-tight">
                    {#if href}
                        <a {href} class="before:absolute before:inset-0 group-hover:underline"
                            >{name}</a
                        >
                    {:else}
                        {name}
                    {/if}
                </CardTitle>
                {#if description?.trim()}
                    <CardDescription class="mt-0.5 block truncate">{description}</CardDescription>
                {/if}
            </span>
        </div>
    </CardHeader>

    <CardFooter class="mt-5 items-center justify-between gap-2 p-0">
        <p class="flex items-center gap-1.5">
            <Badge variant="secondary"
                >{resourceCount} {resourceCount === 1 ? "resource" : "resources"}</Badge
            >
        </p>
    </CardFooter>
</Card>
