<script lang="ts">
    import type { Snippet } from "svelte";

    let { children }: { children: Snippet } = $props();
</script>

<main
    class="bg-surface m:p-8 mt-6 h-[calc(100svh-1.5rem)] min-h-0 min-w-0 flex-1 overflow-y-auto p-4"
    style="border-radius: var(--m3-shape-extra-large) 0 0 var(--m3-shape-extra-large)"
>
    {@render children()}
</main>
