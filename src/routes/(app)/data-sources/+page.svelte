<script lang="ts">
    // oxlint-disable func-style
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import editIcon from "@ktibow/iconset-material-symbols/edit";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import searchIcon from "@ktibow/iconset-material-symbols/search";
    import {
        Button,
        Card,
        Dialog,
        Divider,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        MenuDivider,
        Snackbar,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, parseAsString, useQueryState } from "nuqs-svelte";

    import {
        createDataSource,
        deleteDataSource,
        discoverDataSource,
        listDataSources,
        updateDataSource,
    } from "#lib/api/data-sources.remote";

    const dataSources = listDataSources();

    let createDialogOpen = useQueryState(
        "createDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let deleting = useQueryState("deleting", parseAsString.withDefault(""));
    let editing = useQueryState("editing", parseAsString.withDefault(""));
    let gitUrl = $state("");
    let uncloudUrl = $state("");
    let editingGitUrl = $state("");
    let editingUncloudUrl = $state("");
    let submitting = $state(false);
    let discoveringId = $state<string | null>(null);
    let actionsMenuOpen = $state<string | null>(null);

    const closeActionsMenuOnOutsideClick = ({ target }: MouseEvent): void => {
        if (
            target instanceof Element &&
            !target.closest("[data-data-source-actions]")
        ) {
            actionsMenuOpen = null;
        }
    };

    const closeActionsMenuOnEscape = ({ key }: KeyboardEvent): void => {
        if (key === "Escape") {
            actionsMenuOpen = null;
        }
    };

    const create = async (): Promise<void> => {
        if (!uncloudUrl.trim()) {
            return;
        }

        submitting = true;

        try {
            await createDataSource({
                gitUrl: gitUrl.trim() || undefined,
                uncloudUrl: uncloudUrl.trim(),
            });

            createDialogOpen.set(false);
            gitUrl = "";
            uncloudUrl = "";

            snackbar("Data source added");

            await dataSources.refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to add data source"
            );
        } finally {
            submitting = false;
        }
    };

    const openEditDialog = (source: {
        gitUrl: string | null;
        id: string;
        uncloudUrl: string;
    }): void => {
        actionsMenuOpen = null;
        editingGitUrl = source.gitUrl ?? "";
        editingUncloudUrl = source.uncloudUrl;
        editing.set(source.id);
    };

    const openDeleteDialog = (id: string): void => {
        actionsMenuOpen = null;
        deleting.set(id);
    };

    const toggleActionsMenu = (id: string): void => {
        actionsMenuOpen = actionsMenuOpen === id ? null : id;
    };

    const closeEditDialog = (): void => {
        editing.set("");
        editingGitUrl = "";
        editingUncloudUrl = "";
    };

    const save = async (): Promise<void> => {
        const id = editing.current;

        if (!id || !editingUncloudUrl.trim()) {
            return;
        }

        submitting = true;

        try {
            await updateDataSource({
                gitUrl: editingGitUrl.trim() || undefined,
                id,
                uncloudUrl: editingUncloudUrl.trim(),
            });

            closeEditDialog();
            await dataSources.refresh();

            snackbar("Data source updated");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to update data source"
            );
        } finally {
            submitting = false;
        }
    };

    const remove = async (): Promise<void> => {
        const id = deleting.current;

        if (!id) {
            return;
        }

        try {
            await deleteDataSource(id);
            deleting.set("");
            await dataSources.refresh();

            snackbar("Data source deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete data source"
            );
        }
    };

    const discover = async (id: string): Promise<void> => {
        actionsMenuOpen = null;

        if (discoveringId !== null) {
            return;
        }

        discoveringId = id;

        try {
            const result = await discoverDataSource(id);
            const parts = [`imported ${result.imported}`];

            if (result.existing > 0) {
                parts.push(`${result.existing} already imported`);
            }

            if (result.skipped > 0) {
                parts.push(`${result.skipped} skipped`);
            }

            snackbar(`Autodiscovery: ${parts.join(", ")}`);
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to autodiscover Compose services"
            );
        } finally {
            discoveringId = null;
        }
    };
</script>

<svelte:window
    onclick={closeActionsMenuOnOutsideClick}
    onkeydown={closeActionsMenuOnEscape}
/>

<div class="flex items-center justify-between gap-4 py-5">
    <div>
        <h1 class="text-on-surface text-lg font-medium">Data Sources</h1>

        <p class="text-on-surface-variant mt-0.5 text-sm">
            {dataSources.current?.length ?? 0}
            {(dataSources.current?.length ?? 0) === 1
                ? "data source"
                : "data sources"}
        </p>
    </div>

    <div class="flex items-center gap-2">
        <Button iconType="left" onclick={() => createDialogOpen.set(true)}>
            <Icon icon={addIcon} size={18} />
            Add
        </Button>

        <Button variant="tonal" onclick={() => dataSources.refresh()}>
            Refresh
        </Button>
    </div>
</div>

<Card variant="outlined" id="data-sources-card">
    {#if dataSources.loading}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading data sources" />
        </div>
    {:else if dataSources.error}
        <div class="text-error p-6 text-sm">
            {dataSources.error.message}
        </div>
    {:else}
        <div class="overflow-x-auto">
            <!-- table header -->
            <div
                class="
          text-on-surface-variant
          bg-surface-container-high grid
          min-w-220
          grid-cols-[minmax(340px,1fr)_auto] items-center
          gap-4 px-5
          py-3 text-xs
          font-medium
        "
            >
                <span>URL</span>
                <span>Actions</span>
            </div>

            <Divider />

            <!-- table rows -->
            {#each dataSources.current ?? [] as ds, index (ds.id ?? index)}
                <div
                    class="
            border-outline-variant
            grid min-w-220
            grid-cols-[minmax(340px,1fr)_auto] items-center
            gap-4 border-b px-5
            py-3 transition-colors
          "
                >
                    <!-- url -->
                    <div class="flex min-w-0 items-center gap-2">
                        <div
                            class="
                bg-surface-container
                text-on-surface-variant
                inline-flex shrink-0 items-center
                rounded-full p-1.5
              "
                        >
                            <Icon icon={databaseIcon} size={18} />
                        </div>

                        <div
                            class="text-on-surface min-w-0 truncate font-mono text-sm"
                        >
                            {ds.gitUrl ?? ds.uncloudUrl}
                        </div>
                    </div>

                    <div
                        data-data-source-actions
                        class="relative flex items-center justify-end [&_:global(.m3-container.expressive-menu.anchored)]:z-20"
                    >
                        <Button
                            iconType="full"
                            size="xs"
                            variant="text"
                            aria-label={`Actions for ${ds.gitUrl ?? ds.uncloudUrl}`}
                            aria-haspopup="menu"
                            aria-expanded={actionsMenuOpen === ds.id}
                            style={actionsMenuOpen === ds.id
                                ? "anchor-name: --m3-menu-anchor"
                                : undefined}
                            onclick={() => toggleActionsMenu(ds.id)}
                        >
                            <Icon icon={moreVertIcon} size={18} />
                        </Button>

                        {#if actionsMenuOpen === ds.id}
                            <ExpressiveMenu
                                anchored
                                x="end"
                                y="down"
                                label="Actions"
                            >
                                <ExpressiveMenuItem
                                    leadingIcon={editIcon}
                                    label="Edit"
                                    onclick={() => openEditDialog(ds)}
                                />
                                <ExpressiveMenuItem
                                    leadingIcon={searchIcon}
                                    label="Autodiscover"
                                    details={!ds.gitUrl
                                        ? "Requires a git repo"
                                        : undefined}
                                    disabled={discoveringId !== null ||
                                        !ds.gitUrl}
                                    onclick={() => discover(ds.id)}
                                />
                                <MenuDivider />
                                <ExpressiveMenuItem
                                    leadingIcon={deleteIcon}
                                    label="Delete"
                                    onclick={() => openDeleteDialog(ds.id)}
                                />
                            </ExpressiveMenu>
                        {/if}
                    </div>
                </div>

                {#if index < (dataSources.current?.length ?? 0) - 1}
                    <Divider />
                {/if}
            {/each}

            {#if (dataSources.current?.length ?? 0) === 0}
                <div
                    class="text-on-surface-variant px-5 py-10 text-center text-sm"
                >
                    No data sources found.
                </div>
            {/if}
        </div>
    {/if}
</Card>

<Dialog bind:open={createDialogOpen.current} headline="Add data source">
    <div class="flex flex-col gap-4">
        <TextFieldOutlined
            bind:value={gitUrl}
            label="Git URL"
            placeholder="example.com/git/repo.git"
        />
        <TextFieldOutlined
            bind:value={uncloudUrl}
            label="Uncloud URL"
            required
            placeholder="example.com"
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
    open={editing.current !== ""}
    onclose={closeEditDialog}
    headline="Edit data source"
>
    <div class="flex flex-col gap-4">
        <TextFieldOutlined
            bind:value={editingGitUrl}
            label="Git URL"
            placeholder="example.com/git/repo.git"
        />
        <TextFieldOutlined
            bind:value={editingUncloudUrl}
            label="Uncloud URL"
            required
            placeholder="example.com"
        />
    </div>

    {#snippet buttons()}
        <Button variant="text" disabled={submitting} onclick={closeEditDialog}>
            Cancel
        </Button>

        <Button
            disabled={submitting || !editingUncloudUrl.trim()}
            onclick={save}
        >
            Save
        </Button>
    {/snippet}
</Dialog>

<Dialog
    open={deleting.current !== ""}
    onclose={() => deleting.set("")}
    headline="Delete data source"
>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Are you sure you want to delete this data source?
        </p>

        <p class="text-on-surface-variant text-sm">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={() => deleting.set("")}>Cancel</Button>

        <Button onclick={remove}>Delete</Button>
    {/snippet}
</Dialog>

<Snackbar />

<style>
    :global(#data-sources-card.m3-container) {
        padding: 0;
        overflow-x: hidden;
    }
</style>
