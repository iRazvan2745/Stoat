<script lang="ts">
    import { watch } from "runed";
    import { untrack, type Snippet } from "svelte";

    import { useFlowNodeAnchorContext } from "./node-context.svelte";
    import { createElementAttachment } from "./render-props";

    interface FlowAnchorProps {
        type?: "start" | "end";
        children?: Snippet;
        render?: Snippet<[{ props: Record<string, unknown> }]>;
    }

    let { type, children, render }: FlowAnchorProps = $props();

    const context = useFlowNodeAnchorContext();

    let anchorRef = $state<HTMLElement | null>(null);

    const attachAnchor = createElementAttachment<HTMLElement>((element) => {
        anchorRef = element;
    });

    const renderProps = attachAnchor({});

    watch([() => anchorRef, () => type], ([currentAnchor, currentType]) => {
        if (!currentAnchor) return;

        if (currentType === "start" || currentType === undefined) {
            untrack(() => context.registerStartAnchor(currentAnchor));
        }

        if (currentType === "end" || currentType === undefined) {
            untrack(() => context.registerEndAnchor(currentAnchor));
        }

        return () => {
            if (currentType === "start" || currentType === undefined) {
                context.registerStartAnchor(null);
            }

            if (currentType === "end" || currentType === undefined) {
                context.registerEndAnchor(null);
            }
        };
    });
</script>

{#if render}
    {@render render({ props: renderProps })}
{:else}
    <div bind:this={anchorRef}>
        {@render children?.()}
    </div>
{/if}
