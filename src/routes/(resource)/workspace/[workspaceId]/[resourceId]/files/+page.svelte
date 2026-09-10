<script lang="ts">
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import filesIcon from "@ktibow/iconset-material-symbols/description-outline";
    import warningIcon from "@ktibow/iconset-material-symbols/warning-outline";
    import {
        Button,
        Card,
        Dialog,
        Icon,
        LoadingIndicator,
        Snackbar,
        Switch,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import {
        getResource,
        updateResourceSettings,
    } from "#lib/api/resources.remote";
    import {
        createResourceFile,
        deleteResourceFile,
        listResourceConfigReferences,
        listResourceFiles,
        updateResourceFile,
    } from "#lib/api/resource-files.remote";
    import {
        parseResourceSettings,
        shouldSyncResourceFilesToGit,
    } from "#lib/domain/resources/settings";
    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const resourceQuery = getResource(params.resourceId);
    const svc = await resourceQuery;

    const filesQuery = $derived(listResourceFiles(params.resourceId));
    const savedFiles = $derived(await filesQuery);
    const referencesQuery = $derived(
        listResourceConfigReferences(params.resourceId)
    );
    const references = $derived(await referencesQuery);

    const selectedFile = useQueryState("file", parseAsString.withDefault(""));
    const selected = $derived(
        savedFiles.find((file) => file.id === selectedFile.current) ??
            savedFiles[0]
    );
    const selectedId = $derived(selected?.id);

    // svelte-ignore state_referenced_locally
    let content = $state(selected?.content ?? "");
    // svelte-ignore state_referenced_locally
    let pathDraft = $state(selected?.path ?? "");
    let lastSelection = $state<string | undefined>(selected?.id);
    let newPath = $state("");
    let saving = $state(false);
    let creating = $state(false);
    let deleting = $state(false);
    let editorLoading = $state(true);
    let deleteDialogOpen = $state(false);
    let syncSaveInFlight = false;

    const initialSyncFiles = shouldSyncResourceFilesToGit(
        parseResourceSettings(svc?.settings)
    );
    let syncFiles = $state(initialSyncFiles);

    // Reset drafts when the selection changes. Typing only touches the
    // drafts, so in-progress edits are never clobbered.
    $effect(() => {
        if (selectedId !== lastSelection) {
            lastSelection = selectedId;
            content = selected?.content ?? "";
            pathDraft = selected?.path ?? "";
            editorLoading = true;
        }
    });

    const dirty = $derived(
        selected !== undefined &&
            (content !== selected.content || pathDraft.trim() !== selected.path)
    );
    const savedPaths = $derived(new Set(savedFiles.map((file) => file.path)));
    const missingReferences = $derived(
        references.filter(
            (reference) =>
                reference.file !== null && !savedPaths.has(reference.file)
        )
    );
    const usedByConfigs = $derived(
        selected
            ? references
                  .filter((reference) => reference.file === selected.path)
                  .map((reference) => reference.config)
            : []
    );

    const editorStyles = {
        "&": {
            backgroundColor: "transparent",
            color: "var(--m3c-on-surface)",
            colorScheme: "inherit",
            height: "100%",
            minHeight: "16rem",
        },
        "&.cm-focused .cm-selectionBackground": {
            backgroundColor: "var(--m3c-primary-container) !important",
        },
        ".cm-activeLine": {
            backgroundColor:
                "color-mix(in srgb, var(--m3c-on-surface) 8%, transparent) !important",
        },
        ".cm-content": { padding: "0.5rem 1rem" },
        ".cm-content ::selection": {
            backgroundColor: "var(--m3c-primary-container)",
            color: "var(--m3c-on-primary-container)",
        },
        ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--m3c-primary)",
        },
        ".cm-scroller": {
            fontFamily: "var(--m3-font-mono, ui-monospace, monospace)",
            height: "100%",
            overflow: "auto",
        },
    };

    const refreshFiles = async (): Promise<void> => {
        await filesQuery.refresh();
        await referencesQuery.refresh();
    };

    const save = async (): Promise<void> => {
        if (!selected || saving || !dirty) {
            return;
        }

        const trimmedPath = pathDraft.trim();

        if (!trimmedPath) {
            snackbar("File path is required");
            return;
        }

        saving = true;

        try {
            const patch: { content?: string; path?: string } = {};

            if (content !== selected.content) {
                patch.content = content;
            }

            if (trimmedPath !== selected.path) {
                patch.path = trimmedPath;
            }

            await updateResourceFile({
                ...patch,
                fileId: selected.id,
                resourceId: params.resourceId,
            });
            await refreshFiles();
            snackbar("File saved");
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Unable to save file"
            );
        } finally {
            saving = false;
        }
    };

    const create = async (path?: string): Promise<void> => {
        const candidate = (path ?? newPath).trim();

        if (!candidate) {
            snackbar("Enter a file name, such as party.conf");
            return;
        }

        creating = true;

        try {
            const created = await createResourceFile({
                content: "",
                path: candidate,
                resourceId: params.resourceId,
            });
            newPath = "";
            await refreshFiles();
            void selectedFile.set(created.id);
            snackbar(`Created ${created.path}`);
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Unable to create file"
            );
        } finally {
            creating = false;
        }
    };

    const confirmDelete = (): void => {
        if (selected) {
            deleteDialogOpen = true;
        }
    };

    const remove = async (): Promise<void> => {
        if (!selected || deleting) {
            return;
        }

        deleting = true;

        try {
            await deleteResourceFile({
                fileId: selected.id,
                resourceId: params.resourceId,
            });
            deleteDialogOpen = false;
            await refreshFiles();
            void selectedFile.set("");
            snackbar(`Deleted ${selected.path}`);
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Unable to delete file"
            );
        } finally {
            deleting = false;
        }
    };

    const persistSyncFiles = async (next: boolean): Promise<void> => {
        if (!svc || syncSaveInFlight) {
            return;
        }

        syncSaveInFlight = true;

        try {
            await updateResourceSettings({
                resourceId: svc.id,
                settings: { syncFilesToGit: next },
            }).updates(getResource);
        } catch (error) {
            syncFiles = !next;
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to update file sync setting"
            );
        } finally {
            syncSaveInFlight = false;
        }
    };
</script>

<div class="flex h-full min-h-0 flex-col gap-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-start gap-2">
            <div class="flex min-w-0 flex-col gap-1">
                <h1 class="m3-font-headline-small text-on-surface">
                    Files{svc?.name ? ` · ${svc.name}` : ""}
                </h1>
                <p class="m3-font-body-medium text-on-surface-variant">
                    Config files for this resource. They are inlined into the
                    compose file at deploy time wherever
                    <span class="font-mono">configs:</span>
                    uses
                    <span class="font-mono">file:</span>.
                </p>
            </div>
        </div>

        <label class="text-on-surface flex items-center gap-2">
            <span class="m3-font-label-large">Mirror to Git</span>
            <Switch
                bind:checked={
                    () => syncFiles,
                    (next) => {
                        syncFiles = next;
                        void persistSyncFiles(next);
                    }
                }
                aria-label="Mirror files to Git"
            />
        </label>
    </header>

    {#if missingReferences.length > 0}
        <Card variant="elevated">
            <div
                class="text-on-surface flex flex-wrap items-center gap-3"
                role="status"
            >
                <Icon icon={warningIcon} size={20} />
                <p class="m3-font-body-medium min-w-0 flex-1">
                    The compose file references
                    {missingReferences.length === 1 ? "a file" : "files"}
                    that {missingReferences.length === 1 ? "doesn't" : "don't"}
                    exist yet — deploys using
                    <span class="font-mono">file:</span> will fail until
                    {missingReferences.length === 1 ? "it is" : "they are"} added.
                </p>
            </div>
            <ul class="mt-3 flex flex-col gap-2">
                {#each missingReferences as reference (reference.config)}
                    <li class="flex flex-wrap items-center gap-2">
                        <span class="m3-font-body-small font-mono">
                            {reference.file} (configs: {reference.config})
                        </span>
                        <Button
                            variant="text"
                            size="s"
                            disabled={creating}
                            onclick={() => create(reference.file ?? "")}
                        >
                            <Icon icon={addIcon} size={18} />
                            Add
                        </Button>
                    </li>
                {/each}
            </ul>
        </Card>
    {/if}

    <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
        <Card variant="elevated">
            <div class="flex items-center justify-between gap-2">
                <h2 class="m3-font-title-small text-on-surface m-0">
                    Resource files
                </h2>
                <span
                    class="m3-font-label-small text-on-surface-variant"
                >
                    {savedFiles.length}
                </span>
            </div>

            {#if savedFiles.length === 0}
                <div
                    class="text-on-surface-variant flex min-h-32 flex-col items-center justify-center gap-2 text-center"
                >
                    <Icon icon={filesIcon} size={24} />
                    <p class="m3-font-body-medium m-0">No files yet</p>
                </div>
            {:else}
                <ul class="mt-2 flex flex-col gap-1">
                    {#each savedFiles as file (file.id)}
                        <li>
                            <Button
                                variant={file.id === selected?.id
                                    ? "tonal"
                                    : "text"}
                                onclick={() => selectedFile.set(file.id)}
                            >
                                <span
                                    class="min-w-0 flex-1 truncate text-left font-mono"
                                >
                                    {file.path}
                                </span>
                            </Button>
                        </li>
                    {/each}
                </ul>
            {/if}

            <div class="mt-3 flex items-end gap-2 [&_.m3-container]:w-full">
                <div class="min-w-0 flex-1">
                    <TextFieldOutlined
                        bind:value={newPath}
                        label="New file"
                        placeholder="party.conf"
                        spellcheck="false"
                        autocapitalize="off"
                        autocomplete="off"
                        enter={() => create()}
                    />
                </div>
                <Button
                    variant="tonal"
                    square
                    aria-label="Create file"
                    disabled={creating || !newPath.trim()}
                    onclick={() => create()}
                >
                    {#if creating}
                        <LoadingIndicator
                            size={18}
                            center={false}
                            aria-label="Creating file"
                        />
                    {:else}
                        <Icon icon={addIcon} />
                    {/if}
                </Button>
            </div>
        </Card>

        <Card variant="elevated">
            {#if !selected}
                <div
                    class="text-on-surface-variant flex min-h-48 flex-col items-center justify-center gap-3 text-center"
                >
                    <Icon icon={filesIcon} size={24} />
                    <p class="m3-font-body-medium m-0">
                        Select a file, or create one to use it as a compose
                        config.
                    </p>
                </div>
            {:else}
                <div
                    class="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2"
                >
                    <div class="flex min-w-0 flex-1 items-end gap-2">
                        <div
                            class="w-64 max-w-full shrink-0 [&_.m3-container]:w-full"
                        >
                            <TextFieldOutlined
                                bind:value={pathDraft}
                                label="Path"
                                spellcheck="false"
                                autocapitalize="off"
                                autocomplete="off"
                            />
                        </div>
                        {#if usedByConfigs.length > 0}
                            <p
                                class="m3-font-body-small text-on-surface-variant m-0 truncate"
                                title={usedByConfigs.join(", ")}
                            >
                                configs: {usedByConfigs.join(", ")}
                            </p>
                        {:else}
                            <p
                                class="m3-font-body-small text-on-surface-variant m-0"
                            >
                                Not referenced by any configs: entry yet.
                            </p>
                        {/if}
                    </div>

                    <div class="flex shrink-0 items-center gap-1">
                        <Button
                            variant="text"
                            size="s"
                            aria-label={`Delete ${selected.path}`}
                            onclick={confirmDelete}
                        >
                            <Icon icon={deleteIcon} />
                        </Button>
                        <Button
                            disabled={saving || !dirty}
                            aria-busy={saving}
                            onclick={save}
                        >
                            {#if saving}
                                <LoadingIndicator
                                    size={18}
                                    center={false}
                                    aria-label="Saving file"
                                />
                                Saving...
                            {:else}
                                Save
                            {/if}
                        </Button>
                    </div>
                </div>

                <div
                    class="editor relative -mx-4 -mb-4 mt-2 min-h-0 flex-1 overflow-hidden rounded-b-md bg-transparent!"
                    aria-busy={editorLoading || (saving && dirty)}
                    aria-label={`${selected.path} editor`}
                >
                    {#key selected.id}
                        <CodeMirror
                            bind:value={content}
                            styles={editorStyles}
                            extensions={codeMirrorSearchExtensions}
                            lineNumbers={true}
                            foldGutter={false}
                            highlight={{
                                activeLine: true,
                                activeLineGutter: false,
                                selectionMatches: false,
                                specialChars: true,
                            }}
                            onready={() => (editorLoading = false)}
                        />
                    {/key}

                    {#if editorLoading}
                        <div
                            class="absolute inset-0 z-10 flex items-center justify-center bg-transparent!"
                            role="status"
                        >
                            <LoadingIndicator aria-label="Loading file editor" />
                        </div>
                    {/if}
                </div>
            {/if}
        </Card>
    </div>
</div>

<Dialog
    headline="Delete file"
    bind:open={deleteDialogOpen}
    onclose={() => (deleteDialogOpen = false)}
>
    <p class="m3-font-body-medium text-on-surface-variant m-0">
        Delete <span class="font-mono">{selected?.path}</span>? Deploys
        referencing it with
        <span class="font-mono">file:</span> will fail until it is added again.
    </p>

    {#snippet buttons()}
        <Button
            variant="text"
            type="button"
            onclick={() => (deleteDialogOpen = false)}>Cancel</Button
        >
        <Button type="button" disabled={deleting} onclick={remove}>
            {#if deleting}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Deleting file"
                />
                Deleting...
            {:else}
                Delete
            {/if}
        </Button>
    {/snippet}
</Dialog>

<Snackbar />

<style>
    .editor :global(.codemirror-wrapper),
    .editor :global(.cm-editor) {
        height: 100%;
        color-scheme: inherit;
    }

    .editor :global(.cm-content ::selection) {
        color: var(--m3c-on-primary-container);
        background-color: var(--m3c-primary-container);
    }
</style>
