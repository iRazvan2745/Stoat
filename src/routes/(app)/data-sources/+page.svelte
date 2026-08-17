<script lang="ts">
    // oxlint-disable func-style
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import databaseIcon from "@ktibow/iconset-material-symbols/database";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import {
        Button,
        Card,
        Dialog,
        Divider,
        Icon,
        LoadingIndicator,
        Snackbar,
        TextField,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, parseAsString, useQueryState } from "nuqs-svelte";

    import {
        createDataSource,
        deleteDataSource,
        listDataSources,
    } from "#lib/api/data-source/data-source.remote";

    type DataSourceRow = NonNullable<
        ReturnType<typeof listDataSources>["current"]
    >[number];

    const dataSources = listDataSources();

    let createDialogOpen = useQueryState(
        "createDialogOpen",
        parseAsBoolean.withDefault(false)
    );

    let url = useQueryState("url", parseAsString.withDefault(""));

    let submitting = useQueryState(
        "submitting",
        parseAsBoolean.withDefault(false)
    );

    let deleting = useQueryState("deleting", parseAsString.withDefault(""));

    const create = async (): Promise<void> => {
        if (!url.current.trim()) {
            return;
        }

        submitting.current = true;

        try {
            await createDataSource({
                url: url.current.trim(),
            });

            createDialogOpen.set(false);
            url.set("");

            snackbar("Data source added");

            await dataSources.refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to add data source"
            );
        } finally {
            submitting.set(false);
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
</script>

<div class="flex items-center justify-between gap-4 p-5">
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
          grid-cols-[minmax(220px,1fr)_minmax(340px,1.6fr)_48px] items-center
          gap-4 px-5
          py-3 text-xs
          font-medium
        "
            >
                <span>Path</span>
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
            grid-cols-[minmax(220px,1fr)_minmax(340px,1.6fr)_48px] items-center
            gap-4 border-b px-5
            py-3 transition-colors
          "
                >
                    <!-- path -->
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
                            {ds.path ?? "—"}
                        </div>
                    </div>

                    <!-- url -->
                    <div
                        class="text-on-surface-variant min-w-0 truncate font-mono text-sm"
                    >
                        {ds.url ?? "—"}
                    </div>

                    <Button
                        size="xs"
                        variant="tonal"
                        onclick={() => deleting.set(ds.id)}
                    >
                        <Icon icon={deleteIcon} size={18} />
                    </Button>
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
        <TextField
            bind:value={url.current}
            label="URL"
            required
            placeholder="https://example.com/data"
        />
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={() => createDialogOpen.set(false)}>
            Cancel
        </Button>

        <Button disabled={submitting.current} onclick={create}>Add</Button>
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
