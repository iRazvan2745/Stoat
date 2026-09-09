<script lang="ts">
    import { goto } from "$app/navigation";
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import codeBlocksIcon from "@ktibow/iconset-material-symbols/code-blocks-outline";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import widgetsIcon from "@ktibow/iconset-material-symbols/widgets-outline";
    import {
        Button,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        Snackbar,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    import {
        createResource,
        listResourcesInWorkspace,
    } from "#lib/api/resources.remote";
    import {
        deleteWorkspace,
        getWorkspace,
        listWorkspaces,
    } from "#lib/api/workspaces.remote";
    import ResourceGroups from "#lib/components/resources/resource-groups.svelte";
    import WorkspaceEnvironmentSection from "#lib/components/resources/workspace-environment-section.svelte";

    import type { PageProps } from "./$types";
    import TemplatesDialog from "./templates-dialog.svelte";

    let { params }: PageProps = $props();

    // svelte-ignore state_referenced_locally
    const workspace = getWorkspace(params.workspaceId);
    // svelte-ignore state_referenced_locally
    const resources = listResourcesInWorkspace(params.workspaceId);

    let createDialogOpen = useQueryState(
        "createDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let templatesDialogOpen = useQueryState(
        "templatesDialogOpen",
        parseAsBoolean.withDefault(false)
    );

    let compose = $state("");
    let resourceName = $state("");
    let submitting = $state(false);

    let actionsMenuOpen = $state(false);
    let addResourceMenuOpen = $state(false);
    const deleteWorkspaceDialogOpen = useQueryState(
        "deleteWorkspaceDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let deletingWorkspace = $state(false);

    const create = async (): Promise<void> => {
        if (!resourceName.trim()) {
            return;
        }

        submitting = true;

        try {
            await createResource({
                name: resourceName.trim(),
                value: compose.trim(),
                workspaceId: params.workspaceId,
            });

            createDialogOpen.set(false);
            resourceName = "";
            compose = "";

            snackbar("Resource created");

            await resources.refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create resource"
            );
        } finally {
            submitting = false;
        }
    };

    const removeWorkspace = async (): Promise<void> => {
        deletingWorkspace = true;

        try {
            await deleteWorkspace(params.workspaceId);
            await listWorkspaces().refresh();
            await goto("/workspace");
            snackbar("Workspace has been deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete workspace"
            );
        } finally {
            deletingWorkspace = false;
        }
    };
</script>

<div class="flex items-center justify-between gap-4">
    <h1 class="m3-font-headline-small text-on-surface">
        {workspace.current?.name ?? "…"}
    </h1>

    <div class="flex items-center gap-2">
        <div class="relative">
            <Button
                iconType="left"
                aria-expanded={addResourceMenuOpen}
                aria-haspopup="menu"
                style={addResourceMenuOpen
                    ? "anchor-name: --m3-menu-anchor"
                    : undefined}
                onclick={() => {
                    actionsMenuOpen = false;
                    addResourceMenuOpen = !addResourceMenuOpen;
                }}
            >
                <Icon icon={addIcon} size={18} />
                Add resource
            </Button>

            {#if addResourceMenuOpen}
                <ExpressiveMenu anchored x="end" y="down" label="Add resource">
                    <ExpressiveMenuItem
                        leadingIcon={codeBlocksIcon}
                        label="Compose"
                        onclick={() => {
                            addResourceMenuOpen = false;
                            createDialogOpen.set(true);
                        }}
                    />
                    <ExpressiveMenuItem
                        leadingIcon={widgetsIcon}
                        label="Template"
                        onclick={() => {
                            addResourceMenuOpen = false;
                            templatesDialogOpen.set(true);
                        }}
                    />
                </ExpressiveMenu>
            {/if}
        </div>

        <Button
            variant="tonal"
            aria-label="Refresh workspace"
            onclick={async () => {
                await workspace.refresh();
                await resources.refresh();
            }}
        >
            <Icon icon={refreshIcon} />
        </Button>

        <div class="relative">
            <Button
                variant="text"
                size="xs"
                aria-label="More workspace actions"
                aria-expanded={actionsMenuOpen}
                aria-haspopup="menu"
                style={actionsMenuOpen
                    ? "anchor-name: --m3-menu-anchor"
                    : undefined}
                onclick={() => {
                    addResourceMenuOpen = false;
                    actionsMenuOpen = !actionsMenuOpen;
                }}
            >
                <Icon icon={moreVertIcon} />
            </Button>

            {#if actionsMenuOpen}
                <ExpressiveMenu
                    anchored
                    x="end"
                    y="down"
                    label="Workspace actions"
                >
                    <ExpressiveMenuItem
                        leadingIcon={deleteIcon}
                        label="Delete workspace"
                        onclick={() => {
                            actionsMenuOpen = false;
                            void deleteWorkspaceDialogOpen.set(true);
                        }}
                    />
                </ExpressiveMenu>
            {/if}
        </div>
    </div>
</div>

<WorkspaceEnvironmentSection workspaceId={params.workspaceId} />

<div id="resources-card">
    {#if resources.loading}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading resources" />
        </div>
    {:else if resources.error}
        <div class="text-error m3-font-body-medium p-6">{resources.error.message}</div>
    {:else if (resources.current?.length ?? 0) === 0}
        <div class="text-on-surface-variant m3-font-body-medium px-5 py-10 text-center">
            No resources yet. Add a compose file or start from a template.
        </div>
    {:else}
        <ResourceGroups
            resources={resources.current ?? []}
            workspaceId={params.workspaceId}
        />
    {/if}
</div>

<Dialog bind:open={createDialogOpen.current} headline="Add resource">
    <div class="flex flex-col gap-4">
        <TextFieldOutlined
            bind:value={resourceName}
            label="Name"
            required
            placeholder="My Web App"
        />
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={() => createDialogOpen.set(false)}>
            Cancel
        </Button>

        <Button disabled={submitting} onclick={create}>Add</Button>
    {/snippet}
</Dialog>

<Dialog
    bind:open={deleteWorkspaceDialogOpen.current}
    headline="Delete workspace"
    onclose={() => deleteWorkspaceDialogOpen.set(false)}
>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Are you sure you want to delete this workspace?
        </p>

        <p class="text-on-surface-variant m3-font-body-medium">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            onclick={() => deleteWorkspaceDialogOpen.set(false)}>Cancel</Button
        >

        <Button disabled={deletingWorkspace} onclick={removeWorkspace}
            >Delete</Button
        >
    {/snippet}
</Dialog>

<TemplatesDialog
    bind:open={templatesDialogOpen.current}
    workspaceId={params.workspaceId}
    oncreated={() => resources.refresh()}
/>

<Snackbar />

<style>
    :global(#resources-card.m3-container) {
        padding: 0;
        overflow-x: hidden;
    }
</style>
