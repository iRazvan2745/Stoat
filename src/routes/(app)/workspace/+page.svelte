<script lang="ts">
    import { goto } from "$app/navigation";
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import expandMoreIcon from "@ktibow/iconset-material-symbols/expand-more";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import workspacesIcon from "@ktibow/iconset-material-symbols/workspaces";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        snackbar,
        Snackbar,
        TextFieldOutlined,
    } from "m3-svelte";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryState,
        useQueryStates,
    } from "nuqs-svelte";

    import { listDataSources } from "#lib/api/data-sources.remote";
    import {
        createWorkspace,
        listWorkspaces,
    } from "#lib/api/workspaces.remote";

    const workspace = listWorkspaces();
    const dataSources = listDataSources();

    const createWorkspaceDialogOpen = useQueryState(
        "createWorkspaceDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    const newWorkspace = useQueryStates({
        name: parseAsString.withDefault(""),
    });
    const dataSourceId = useQueryState(
        "dataSourceId",
        parseAsString.withDefault("")
    );
    let dataSourceMenuOpen = $state(false);

    const selectedDataSource = $derived(
        dataSources.current?.find(
            (source) => source.id === dataSourceId.current
        )
    );
    const selectedDataSourceLabel = $derived(
        selectedDataSource?.gitUrl ??
            selectedDataSource?.uncloudUrl ??
            "Select a data source"
    );
    const hasSelectedDataSource = $derived(selectedDataSource !== undefined);

    const create = async (): Promise<void> => {
        if (!newWorkspace.name.current.trim()) {
            return;
        }

        if (!hasSelectedDataSource) {
            snackbar("Attach a data source before creating a workspace");
            return;
        }

        try {
            await createWorkspace({
                dataSourceId: dataSourceId.current,
                name: newWorkspace.name.current.trim(),
            });

            createWorkspaceDialogOpen.set(false);
            newWorkspace.set({
                name: "",
            });
            dataSourceId.set("");

            snackbar("Workspace created");

            await listWorkspaces().refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create workspace"
            );
        }
    };

    const openCreateDialog = (): void => {
        dataSourceId.set("");
        dataSourceMenuOpen = false;
        createWorkspaceDialogOpen.set(true);
    };

    const closeCreateDialog = (): void => {
        dataSourceMenuOpen = false;
        createWorkspaceDialogOpen.set(false);
    };

    const selectDataSource = (id: string): void => {
        dataSourceId.set(id);
        dataSourceMenuOpen = false;
    };

    const openCreateDataSource = (): void => {
        dataSourceMenuOpen = false;
        goto("/data-sources?createDialogOpen=true");
    };
</script>

<header class="flex items-center justify-between">
    <p class="text-lg">Workspaces</p>
    <div class="flex items-center gap-2">
        <Button onclick={openCreateDialog}>Create Workspace</Button>
        <Button variant="tonal" onclick={async () => await workspace.refresh()}>
            <Icon icon={refreshIcon} />
        </Button>
    </div>
</header>
<main>
    {#if workspace.loading}
        <div class="mt-10">
            <LoadingIndicator aria-label="Workspace loading indicator" />
        </div>
    {:else}
        {#if (await listWorkspaces()).length === 0}
            <div class="text-on-surface-variant px-5 py-10 text-center text-sm">
                No data sources found.
            </div>
        {/if}
        <div
            class="m:grid-cols-2 l:grid-cols-3 grid grid-cols-1 gap-2 xl:grid-cols-4"
        >
            {#each await listWorkspaces() as wrk}
                <div class="workspace-card">
                    <Card
                        variant="elevated"
                        onclick={() => goto(`/workspace/${wrk.id}`)}
                    >
                        <div class="workspace-icon">
                            <Icon icon={workspacesIcon} size={48} />
                        </div>
                        <p class="workspace-name">{wrk.name}</p>
                    </Card>
                </div>
            {/each}
        </div>
    {/if}
</main>

<Dialog
    open={createWorkspaceDialogOpen.current}
    onclose={closeCreateDialog}
    headline="Create Workspace"
>
    <div class="flex flex-col gap-2">
        <TextFieldOutlined
            bind:value={newWorkspace.name.current}
            label="Name"
            required
            placeholder="Weasel"
        />

        {#if dataSources.loading}
            <LoadingIndicator aria-label="Loading data sources" />
        {:else}
            <div class="data-source-picker">
                <Button
                    variant="outlined"
                    aria-expanded={dataSourceMenuOpen}
                    aria-haspopup="menu"
                    style="anchor-name: --m3-menu-anchor"
                    onclick={() => (dataSourceMenuOpen = !dataSourceMenuOpen)}
                >
                    <Icon icon={databaseIcon} size={18} />
                    <span class="data-source-picker-label">
                        {selectedDataSourceLabel}
                    </span>
                    <Icon icon={expandMoreIcon} size={18} />
                </Button>

                {#if dataSourceMenuOpen}
                    <ExpressiveMenu
                        anchored
                        label="Data source"
                        x="start"
                        y="down"
                    >
                        {#if (dataSources.current?.length ?? 0) > 0}
                            {#each dataSources.current ?? [] as source (source.id)}
                                <ExpressiveMenuItem
                                    leadingIcon={databaseIcon}
                                    label={source.gitUrl ?? source.uncloudUrl}
                                    selected={source.id ===
                                        dataSourceId.current}
                                    onclick={() => selectDataSource(source.id)}
                                />
                            {/each}
                        {:else}
                            <ExpressiveMenuItem
                                label="No data sources available"
                                disabled
                            />
                            <ExpressiveMenuItem
                                leadingIcon={addIcon}
                                label="Add data source"
                                onclick={openCreateDataSource}
                            />
                        {/if}
                    </ExpressiveMenu>
                {/if}
            </div>
            {#if (dataSources.current?.length ?? 0) === 0}
                <p class="text-on-surface-variant text-sm">
                    Add a data source before creating a workspace.
                </p>
            {/if}
        {/if}
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={closeCreateDialog}>Cancel</Button>

        <Button disabled={!hasSelectedDataSource} onclick={create}
            >Create</Button
        >
    {/snippet}
</Dialog>

<Snackbar />

<style>
    :global(.workspace-card .m3-container.elevated) {
        width: 100%;
        min-width: 0;
        flex-direction: row;
        align-items: center;
        gap: 1.25rem;
        padding: 1.25rem;
        border-radius: var(--m3-shape-large);
    }

    .workspace-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 4.5rem;
        height: 4.5rem;
        border-radius: var(--m3-shape-medium);
        background-color: var(--m3c-primary-container);
        color: var(--m3c-on-primary-container);
    }

    .workspace-name {
        margin: 0;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .data-source-picker {
        position: relative;
    }

    :global(.data-source-picker > .m3-container) {
        width: 100%;
        justify-content: space-between;
    }

    :global(.data-source-picker > .m3-container.expressive-menu) {
        width: min(22rem, calc(100vw - 2rem));
    }

    .data-source-picker-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
