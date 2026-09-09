<script lang="ts">
    import { Button, Dialog, LoadingIndicator } from "m3-svelte";

    import type { Deployment } from "./deployment";
    import { getShortId } from "./deployment";

    interface Props {
        deleting: boolean;
        deployment: Deployment | undefined;
        onCancel: () => void;
        onConfirm: () => void;
        open: boolean;
    }

    let { deleting, deployment, onCancel, onConfirm, open }: Props = $props();
</script>

<Dialog headline="Delete deployment" {open} onclose={onCancel}>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Delete deployment
            {#if deployment}
                <span class="m3-font-body-medium font-mono"
                    >#{getShortId(deployment.id)}</span
                >
            {/if}?
        </p>

        <p class="text-on-surface-variant m3-font-body-medium">
            This permanently removes the deployment and all of its logs.
        </p>
    </div>

    {#snippet buttons()}
        <Button variant="text" disabled={deleting} onclick={onCancel}
            >Cancel</Button
        >

        <Button disabled={deleting} aria-busy={deleting} onclick={onConfirm}>
            {#if deleting}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Deleting deployment"
                />
                Deleting...
            {:else}
                Delete
            {/if}
        </Button>
    {/snippet}
</Dialog>
