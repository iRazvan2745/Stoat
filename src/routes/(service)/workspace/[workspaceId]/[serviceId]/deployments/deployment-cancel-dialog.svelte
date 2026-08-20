<script lang="ts">
    import { Button, Dialog, LoadingIndicator } from "m3-svelte";

    import type { Deployment } from "./deployment";
    import { getShortId } from "./deployment";

    interface Props {
        cancelling: boolean;
        deployment: Deployment | undefined;
        onCancel: () => void;
        onConfirm: () => void;
        open: boolean;
    }

    let { cancelling, deployment, onCancel, onConfirm, open }: Props = $props();
</script>

<Dialog headline="Force cancel deployment" {open} onclose={onCancel}>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Cancel deployment
            {#if deployment}
                <span class="font-mono text-sm"
                    >#{getShortId(deployment.id)}</span
                >
            {/if}?
        </p>

        <p class="text-on-surface-variant text-sm">
            This marks the deployment as cancelled. Any in-flight work may
            continue briefly in the background.
        </p>
    </div>

    {#snippet buttons()}
        <Button variant="text" disabled={cancelling} onclick={onCancel}
            >Keep running</Button
        >

        <Button
            disabled={cancelling}
            aria-busy={cancelling}
            onclick={onConfirm}
        >
            {#if cancelling}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Cancelling deployment"
                />
                Cancelling...
            {:else}
                Force cancel
            {/if}
        </Button>
    {/snippet}
</Dialog>
