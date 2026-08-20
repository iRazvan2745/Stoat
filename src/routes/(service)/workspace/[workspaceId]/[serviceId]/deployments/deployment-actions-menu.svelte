<script lang="ts">
    import cancelIcon from "@ktibow/iconset-material-symbols/cancel";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import { ExpressiveMenu, ExpressiveMenuItem } from "m3-svelte";

    import type { Deployment } from "./deployment";

    interface Props {
        active: boolean;
        deployment: Deployment | undefined;
        onCancel: (deploymentId: string) => void;
        onDelete: (deploymentId: string) => void;
    }

    let { active, deployment, onCancel, onDelete }: Props = $props();
</script>

{#if deployment}
    <div class="[&_:global(.m3-container.expressive-menu.anchored)]:z-20">
        <ExpressiveMenu anchored x="end" y="down" label="Deployment actions">
            {#if active}
                <ExpressiveMenuItem
                    leadingIcon={cancelIcon}
                    label="Force cancel"
                    onclick={() => onCancel(deployment.id)}
                />
            {/if}

            <ExpressiveMenuItem
                leadingIcon={deleteIcon}
                label="Delete"
                onclick={() => onDelete(deployment.id)}
            />
        </ExpressiveMenu>
    </div>
{/if}
