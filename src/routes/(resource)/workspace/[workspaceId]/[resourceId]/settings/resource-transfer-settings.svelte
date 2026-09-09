<script lang="ts">
    import { goto } from "$app/navigation";
    import copyIcon from "@ktibow/iconset-material-symbols/content-copy-outline";
    import moveIcon from "@ktibow/iconset-material-symbols/drive-file-move-outline";
    import {
        Button,
        Dialog,
        Icon,
        LoadingIndicator,
        SelectOutlined,
        snackbar,
    } from "m3-svelte";

    import {
        copyResource,
        getResource,
        listResourcesInWorkspace,
        moveResource,
    } from "#lib/api/resources.remote";
    import { listWorkspaces } from "#lib/api/workspaces.remote";

    const { resourceId, workspaceId } = $props<{
        resourceId: string;
        workspaceId: string;
    }>();

    const workspaceRecords = await listWorkspaces();
    const sourceWorkspace = workspaceRecords.find(
        (workspace) => workspace.id === workspaceId
    );
    const copyTargets = workspaceRecords.filter(
        (workspace) => workspace.id !== workspaceId
    );
    const moveTargets = copyTargets.filter(
        (workspace) => workspace.dataSourceId === sourceWorkspace?.dataSourceId
    );
    const copyWorkspaceOptions = copyTargets.map((workspace) => ({
        text: workspace.name ?? workspace.slug,
        value: workspace.id,
    }));
    const moveWorkspaceOptions = moveTargets.map((workspace) => ({
        text: workspace.name ?? workspace.slug,
        value: workspace.id,
    }));

    let copyDialogOpen = $state(false);
    let moveDialogOpen = $state(false);
    let transferring = $state(false);
    let selectedCopyWorkspaceId = $state(copyTargets[0]?.id ?? "");
    let selectedMoveWorkspaceId = $state(moveTargets[0]?.id ?? "");

    const copyToWorkspace = async (): Promise<void> => {
        if (!selectedCopyWorkspaceId || transferring) {
            return;
        }

        transferring = true;

        try {
            await copyResource({
                resourceId,
                targetWorkspaceId: selectedCopyWorkspaceId,
            }).updates(listResourcesInWorkspace);
            copyDialogOpen = false;
            const target = copyTargets.find(
                (workspace) => workspace.id === selectedCopyWorkspaceId
            );
            snackbar(`Compose copied to ${target?.name ?? "workspace"}`);
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to copy resource compose"
            );
        } finally {
            transferring = false;
        }
    };

    const moveToWorkspace = async (): Promise<void> => {
        if (!selectedMoveWorkspaceId || transferring) {
            return;
        }

        transferring = true;

        try {
            await moveResource({
                resourceId,
                targetWorkspaceId: selectedMoveWorkspaceId,
            }).updates(getResource, listResourcesInWorkspace);
            await goto(`/workspace/${selectedMoveWorkspaceId}/${resourceId}`);
            snackbar("Resource moved");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to move resource"
            );
        } finally {
            transferring = false;
        }
    };
</script>

<section class="flex max-w-m flex-col gap-3 pt-2">
    <h2 class="m3-font-title-small text-on-surface">Advanced</h2>

    <div class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
            <Button
                variant="tonal"
                square
                aria-label="Copy Compose"
                disabled={copyTargets.length === 0}
                onclick={() => (copyDialogOpen = true)}
            >
                <Icon icon={copyIcon} />
            </Button>
            <span class="flex min-w-0 flex-col gap-0.5">
                <span class="m3-font-body-large text-on-surface"
                    >Copy Compose</span
                >
                <span class="m3-font-body-small text-on-surface-variant">
                    Copy only the Compose file to another workspace.
                </span>
            </span>
        </div>

        <div class="flex items-center gap-3">
            <Button
                variant="tonal"
                square
                aria-label="Move resource"
                disabled={moveTargets.length === 0}
                onclick={() => (moveDialogOpen = true)}
            >
                <Icon icon={moveIcon} />
            </Button>
            <span class="flex min-w-0 flex-col gap-0.5">
                <span class="m3-font-body-large text-on-surface"
                    >Move resource</span
                >
                <span class="m3-font-body-small text-on-surface-variant">
                    Move the resource to a workspace using the same data source.
                </span>
            </span>
        </div>
    </div>
</section>

<Dialog
    bind:open={copyDialogOpen}
    headline="Copy Compose"
    onclose={() => (copyDialogOpen = false)}
>
    <div class="flex min-w-72 flex-col gap-4">
        <p class="m3-font-body-medium text-on-surface-variant">
            Settings, environment variables, and deployment history are not
            copied.
        </p>
        <SelectOutlined
            label="Destination workspace"
            options={copyWorkspaceOptions}
            width="20rem"
            bind:value={selectedCopyWorkspaceId}
        />
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={transferring}
            onclick={() => (copyDialogOpen = false)}
        >
            Cancel
        </Button>
        <Button
            disabled={!selectedCopyWorkspaceId || transferring}
            aria-busy={transferring}
            onclick={copyToWorkspace}
        >
            {#if transferring}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Copying Compose"
                />
                Copying...
            {:else}
                Copy
            {/if}
        </Button>
    {/snippet}
</Dialog>

<Dialog
    bind:open={moveDialogOpen}
    headline="Move resource"
    onclose={() => (moveDialogOpen = false)}
>
    <div class="flex min-w-72 flex-col gap-4">
        <p class="m3-font-body-medium text-on-surface-variant">
            Settings, environment variables, and deployment history move with
            the resource.
        </p>
        <SelectOutlined
            label="Destination workspace"
            options={moveWorkspaceOptions}
            width="20rem"
            bind:value={selectedMoveWorkspaceId}
        />
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={transferring}
            onclick={() => (moveDialogOpen = false)}
        >
            Cancel
        </Button>
        <Button
            disabled={!selectedMoveWorkspaceId || transferring}
            aria-busy={transferring}
            onclick={moveToWorkspace}
        >
            {#if transferring}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Moving resource"
                />
                Moving...
            {:else}
                Move
            {/if}
        </Button>
    {/snippet}
</Dialog>
