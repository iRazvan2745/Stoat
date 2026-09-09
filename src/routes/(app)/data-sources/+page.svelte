<script lang="ts">
    // oxlint-disable func-style
    import { refreshAll as refreshPage } from "$app/navigation";
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import cloudIcon from "@ktibow/iconset-material-symbols/cloud-outline";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import editIcon from "@ktibow/iconset-material-symbols/edit";
    import keyIcon from "@ktibow/iconset-material-symbols/key";
    import linkIcon from "@ktibow/iconset-material-symbols/link";
    import lockIcon from "@ktibow/iconset-material-symbols/lock";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import terminalIcon from "@ktibow/iconset-material-symbols/terminal";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        MenuDivider,
        SelectOutlined,
        Snackbar,
        TextFieldOutlined,
        TextFieldOutlinedMultiline,
        VariableTabs,
        snackbar,
    } from "m3-svelte";
    import {
        parseAsBoolean,
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
        useQueryStates,
    } from "nuqs-svelte";

    import {
        createDataSource,
        createGitSource,
        deleteDataSource,
        deleteGitSource,
        listDataSources,
        listGitSources,
        updateDataSource,
        updateGitSource,
        syncGitSource,
        resolveGitSourceSync,
        updateGitSourceSync,
    } from "#lib/api/data-sources.remote";
    import { GIT_AUTH_METHODS } from "#lib/domain/data-sources";
    import type { GitAuthMethod } from "#lib/domain/data-sources";
    import {
        hasGitRepository,
        presentDataSource,
    } from "#lib/shared/ui/data-source-display";

    const dataSources = listDataSources();
    const gitSources = listGitSources();
    let syncingGitSourceId = $state<string | null>(null);
    let updatingSyncId = $state<string | null>(null);
    let resolvingGitSourceId = $state<string | null>(null);

    const syncRepository = async (
        gitSourceId: string,
        resolution?: "app" | "git"
    ): Promise<void> => {
        if (syncingGitSourceId) return;
        syncingGitSourceId = gitSourceId;
        try {
            const result = resolution
                ? await resolveGitSourceSync({ gitSourceId, resolution })
                : await syncGitSource(gitSourceId);
            resolvingGitSourceId = null;
            snackbar(
                `Synced ${result.commits} commits · ${result.deployments} deployments · ${result.issues.length} issues`
            );
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Git sync failed"
            );
        } finally {
            syncingGitSourceId = null;
            await refreshPage();
        }
    };

    const toggleAutomaticSync = async (
        gitSourceId: string,
        enabled: boolean
    ): Promise<void> => {
        if (updatingSyncId) return;
        updatingSyncId = gitSourceId;
        try {
            await updateGitSourceSync({ gitSourceId, enabled });
            await gitSources.refresh();
            snackbar(
                enabled
                    ? "Automatic Git sync enabled; checks every minute"
                    : "Automatic Git sync paused"
            );
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to update automatic sync"
            );
        } finally {
            updatingSyncId = null;
        }
    };

    const authMethodOptions = [
        { text: "Public repository", value: "none" },
        { text: "HTTPS token", value: "token" },
        { text: "HTTPS username + password", value: "basic" },
        { text: "SSH private key", value: "ssh" },
    ];

    let createDialogOpen = useQueryState(
        "createDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let deleting = useQueryState("deleting", parseAsString.withDefault(""));
    let editing = useQueryState("editing", parseAsString.withDefault(""));
    let deletingGitSource = useQueryState(
        "deletingGitSource",
        parseAsString.withDefault("")
    );
    let editingGitSource = useQueryState(
        "editingGitSource",
        parseAsString.withDefault("")
    );
    let createGitSourceDialogOpen = useQueryState(
        "createGitSourceDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    const query = useQueryStates({
        editingGitAuthMethod:
            parseAsStringLiteral(GIT_AUTH_METHODS).withDefault("none"),
        editingGitSourceId: parseAsString.withDefault(""),
        editingGitSourceName: parseAsString.withDefault(""),
        editingGitSourceUrl: parseAsString.withDefault(""),
        editingGitUsername: parseAsString.withDefault(""),
        editingUncloudUrl: parseAsString.withDefault(""),
        gitAuthMethod:
            parseAsStringLiteral(GIT_AUTH_METHODS).withDefault("none"),
        gitSourceId: parseAsString.withDefault(""),
        gitSourceName: parseAsString.withDefault(""),
        gitSourceUrl: parseAsString.withDefault(""),
        gitUsername: parseAsString.withDefault(""),
        tab: parseAsStringLiteral([
            "data-sources",
            "git-sources",
        ] as const).withDefault("data-sources"),
        uncloudUrl: parseAsString.withDefault(""),
    });
    let uncloudToken = $state("");
    let gitPassword = $state("");
    let gitToken = $state("");
    let gitSshPrivateKey = $state("");
    let gitSshPassphrase = $state("");
    let gitSshKnownHosts = $state("");
    let editingUncloudToken = $state("");
    let editingGitPassword = $state("");
    let editingGitToken = $state("");
    let editingGitSshPrivateKey = $state("");
    let editingGitSshPassphrase = $state("");
    let editingGitSshKnownHosts = $state("");
    let submitting = $state(false);
    let deletingSubmitting = $state(false);
    let actionsMenuOpen = $state<string | null>(null);
    const sourceCount = $derived(dataSources.current?.length ?? 0);
    const gitSourceCount = $derived(gitSources.current?.length ?? 0);
    const selectedGitSource = $derived(
        gitSources.current?.find(
            (source) => source.id === query.gitSourceId.current
        )
    );
    const gitSourceOptions = $derived(
        (gitSources.current ?? []).map((source) => ({
            text: source.name,
            value: source.id,
        }))
    );
    const editingSelectedGitSource = $derived(
        gitSources.current?.find(
            (source) => source.id === query.editingGitSourceId.current
        )
    );

    const authMethodLabel = (method: GitAuthMethod): string => {
        switch (method) {
            case "token": {
                return "HTTPS token";
            }
            case "basic": {
                return "HTTPS basic";
            }
            case "ssh": {
                return "SSH key";
            }
            default: {
                return "Public";
            }
        }
    };

    const connectionLabel = (url: string): string => {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    };

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

    const refreshAll = async (): Promise<void> => {
        await Promise.all([dataSources.refresh(), gitSources.refresh()]);
    };

    const create = async (): Promise<void> => {
        if (!query.uncloudUrl.current.trim() || !query.gitSourceId.current) {
            snackbar("Choose a Git Source before adding a data source");
            return;
        }

        submitting = true;

        try {
            await createDataSource({
                gitSourceId: query.gitSourceId.current,
                uncloudToken: uncloudToken.trim() || undefined,
                uncloudUrl: query.uncloudUrl.current.trim(),
            });

            createDialogOpen.set(false);
            query.set({
                gitSourceId: "",
                uncloudUrl: "",
            });
            uncloudToken = "";

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
        gitSourceId: string;
        id: string;
        uncloudUrl: string;
    }): void => {
        actionsMenuOpen = null;
        editingUncloudToken = "";
        query.set({
            editingGitSourceId: source.gitSourceId,
            editingUncloudUrl: source.uncloudUrl,
        });
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
        editingUncloudToken = "";
        query.set({
            editingGitSourceId: "",
            editingUncloudUrl: "",
        });
    };

    const save = async (): Promise<void> => {
        const id = editing.current;

        if (!id || !query.editingUncloudUrl.current.trim()) {
            return;
        }

        submitting = true;

        try {
            await updateDataSource({
                gitSourceId: query.editingGitSourceId.current,
                id,
                uncloudToken: editingUncloudToken.trim() || undefined,
                uncloudUrl: query.editingUncloudUrl.current.trim(),
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

    const resetGitSourceForm = (): void => {
        query.set({
            gitAuthMethod: "none",
            gitSourceName: "",
            gitSourceUrl: "",
            gitUsername: "",
        });
        gitPassword = "";
        gitToken = "";
        gitSshPrivateKey = "";
        gitSshPassphrase = "";
        gitSshKnownHosts = "";
    };

    const resetEditingGitSourceForm = (): void => {
        query.set({
            editingGitAuthMethod: "none",
            editingGitSourceName: "",
            editingGitSourceUrl: "",
            editingGitUsername: "",
        });
        editingGitPassword = "";
        editingGitToken = "";
        editingGitSshPrivateKey = "";
        editingGitSshPassphrase = "";
        editingGitSshKnownHosts = "";
    };

    const openCreateGitSourceDialog = (): void => {
        query.set({ tab: "git-sources" });
        resetGitSourceForm();
        createGitSourceDialogOpen.set(true);
    };

    const closeCreateGitSourceDialog = (): void => {
        createGitSourceDialogOpen.set(false);
        resetGitSourceForm();
    };

    const openEditGitSourceDialog = (source: {
        authMethod: GitAuthMethod;
        id: string;
        name: string;
        url: string | null;
        username: string | null;
    }): void => {
        actionsMenuOpen = null;
        editingGitPassword = "";
        editingGitToken = "";
        editingGitSshPrivateKey = "";
        editingGitSshPassphrase = "";
        editingGitSshKnownHosts = "";
        query.set({
            editingGitAuthMethod: source.authMethod,
            editingGitSourceName: source.name,
            editingGitSourceUrl: source.url ?? "",
            editingGitUsername: source.username ?? "",
        });
        editingGitSource.set(source.id);
    };

    const closeEditGitSourceDialog = (): void => {
        editingGitSource.set("");
        resetEditingGitSourceForm();
    };

    const saveGitSource = async (): Promise<void> => {
        const id = editingGitSource.current;

        if (
            !id ||
            !query.editingGitSourceName.current.trim() ||
            !query.editingGitSourceUrl.current.trim()
        ) {
            return;
        }

        submitting = true;

        try {
            await updateGitSource({
                authMethod: query.editingGitAuthMethod.current,
                id,
                name: query.editingGitSourceName.current.trim(),
                password: editingGitPassword.trim() || undefined,
                sshKnownHosts: editingGitSshKnownHosts.trim() || undefined,
                sshPassphrase: editingGitSshPassphrase.trim() || undefined,
                sshPrivateKey: editingGitSshPrivateKey.trim() || undefined,
                token: editingGitToken.trim() || undefined,
                url: query.editingGitSourceUrl.current.trim(),
                username: query.editingGitUsername.current.trim() || undefined,
            });

            closeEditGitSourceDialog();
            await Promise.all([gitSources.refresh(), dataSources.refresh()]);
            snackbar("Git Source updated");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to update Git Source"
            );
        } finally {
            submitting = false;
        }
    };

    const createGitSourceRecord = async (): Promise<void> => {
        const credentialsAreValid =
            query.gitAuthMethod.current === "none" ||
            (query.gitAuthMethod.current === "token" && gitToken.trim()) ||
            (query.gitAuthMethod.current === "basic" &&
                query.gitUsername.current.trim() &&
                gitPassword.trim()) ||
            (query.gitAuthMethod.current === "ssh" && gitSshPrivateKey.trim());

        if (
            !query.gitSourceName.current.trim() ||
            !query.gitSourceUrl.current.trim() ||
            !credentialsAreValid
        ) {
            snackbar("Complete the Git Source name, URL, and credentials");
            return;
        }

        submitting = true;

        try {
            await createGitSource({
                authMethod: query.gitAuthMethod.current,
                name: query.gitSourceName.current.trim(),
                password: gitPassword.trim() || undefined,
                sshKnownHosts: gitSshKnownHosts.trim() || undefined,
                sshPassphrase: gitSshPassphrase.trim() || undefined,
                sshPrivateKey: gitSshPrivateKey.trim() || undefined,
                token: gitToken.trim() || undefined,
                url: query.gitSourceUrl.current.trim(),
                username: query.gitUsername.current.trim() || undefined,
            });

            closeCreateGitSourceDialog();
            await gitSources.refresh();
            snackbar("Git Source added");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to add Git Source"
            );
        } finally {
            submitting = false;
        }
    };

    const openDeleteGitSourceDialog = (id: string): void => {
        actionsMenuOpen = null;
        deletingGitSource.set(id);
    };

    const removeGitSource = async (): Promise<void> => {
        const id = deletingGitSource.current;

        if (!id) {
            return;
        }

        deletingSubmitting = true;

        try {
            await deleteGitSource(id);
            deletingGitSource.set("");
            await gitSources.refresh();
            snackbar("Git Source deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete Git Source"
            );
        } finally {
            deletingSubmitting = false;
        }
    };

    const remove = async (): Promise<void> => {
        const id = deleting.current;

        if (!id || deletingSubmitting) {
            return;
        }

        deletingSubmitting = true;

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
        } finally {
            deletingSubmitting = false;
        }
    };
</script>

<svelte:window
    onclick={closeActionsMenuOnOutsideClick}
    onkeydown={closeActionsMenuOnEscape}
/>

<main class="mx-auto w-full max-w-l px-6 py-10 max-m:px-4 max-m:py-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
            <h1 class="m3-font-headline-medium text-on-surface">
                Data sources
            </h1>
            <p class="text-on-surface-variant m3-font-body-medium mt-2 max-w-m">
                Cluster connections select where services deploy. Git
                repositories store Compose configuration and provide discovery;
                assign one to each connection.
            </p>
        </div>

        <div class="flex items-center gap-2">
            <Button
                variant="text"
                iconType="left"
                disabled={dataSources.loading || gitSources.loading}
                onclick={refreshAll}
            >
                <Icon icon={refreshIcon} size={18} />
                Refresh
            </Button>
            {#if query.tab.current === "data-sources"}
                <Button
                    iconType="left"
                    onclick={() => createDialogOpen.set(true)}
                >
                    <Icon icon={addIcon} size={18} />
                    Add cluster connection
                </Button>
            {:else}
                <Button iconType="left" onclick={openCreateGitSourceDialog}>
                    <Icon icon={addIcon} size={18} />
                    Add Git repository
                </Button>
            {/if}
        </div>
    </header>

    <div class="border-outline-variant mt-8 border-b">
        <VariableTabs
            bind:tab={query.tab.current}
            items={[
                { name: `Cluster connections`, value: "data-sources" },
                { name: `Git repositories`, value: "git-sources" },
            ]}
        />
    </div>

    {#if query.tab.current === "data-sources"}
        <div class="mt-6">
            {#if dataSources.loading}
                <div class="flex min-h-32 items-center justify-center">
                    <LoadingIndicator aria-label="Loading data sources" />
                </div>
            {:else if dataSources.error}
                <div class="text-error m3-font-body-medium p-6">
                    {dataSources.error.message}
                </div>
            {:else}
                <Card variant="filled" id="data-sources-list">
                    {#each dataSources.current ?? [] as ds (ds.id)}
                        {@const presentation = presentDataSource(ds)}
                        <div class="source-row">
                            <span class="source-row-icon primary">
                                <Icon icon={cloudIcon} size={20} />
                            </span>
                            <span class="source-copy">
                                <span class="source-name">
                                    {connectionLabel(presentation.uncloudUrl)}
                                </span>
                                <span
                                    class="source-meta"
                                    title={presentation.uncloudUrl}
                                >
                                    {presentation.uncloudUrl}
                                </span>
                            </span>
                            <span class="source-copy source-assignment">
                                <span class="source-name"
                                    >{presentation.gitSource}</span
                                >
                                <span
                                    class="source-meta"
                                    title={presentation.gitRepository ??
                                        "Not assigned"}
                                >
                                    {presentation.gitRepository ??
                                        "Not assigned"}
                                </span>
                            </span>
                            <div
                                data-data-source-actions
                                class="relative flex justify-end"
                            >
                                <Button
                                    iconType="full"
                                    size="xs"
                                    variant="text"
                                    aria-label={`Actions for ${connectionLabel(presentation.uncloudUrl)}`}
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
                                            leadingIcon={refreshIcon}
                                            label="Sync Git and deploy"
                                            details={!hasGitRepository(ds)
                                                ? "Assign a Git Source first"
                                                : undefined}
                                            disabled={syncingGitSourceId !==
                                                null || !hasGitRepository(ds)}
                                            onclick={() => {
                                                actionsMenuOpen = null;
                                                void syncRepository(
                                                    ds.gitSourceId
                                                );
                                            }}
                                        />
                                        <MenuDivider />
                                        <ExpressiveMenuItem
                                            leadingIcon={deleteIcon}
                                            label="Delete"
                                            onclick={() =>
                                                openDeleteDialog(ds.id)}
                                        />
                                    </ExpressiveMenu>
                                {/if}
                            </div>
                        </div>
                    {:else}
                        <div
                            class="text-on-surface-variant m3-font-body-medium px-5 py-10 text-center"
                        >
                            No data sources yet.
                        </div>
                    {/each}
                </Card>
            {/if}
        </div>

        <Dialog
            bind:open={createDialogOpen.current}
            headline="Add cluster connection"
        >
            <div
                class="flex min-w-[min(30rem,calc(100vw-3rem))] flex-col gap-5 max-m:min-w-0"
            >
                <div
                    class="bg-primary-container-subtle flex items-start gap-3 rounded-xl p-3.5"
                >
                    <span
                        class="bg-primary-container text-on-primary-container grid size-10 shrink-0 place-items-center rounded-xl"
                        ><Icon icon={cloudIcon} size={20} /></span
                    >
                    <div>
                        <p class="m3-font-label-large text-on-surface">
                            Connect an Uncloud cluster
                        </p>
                        <p
                            class="text-on-surface-variant m3-font-body-small mt-1"
                        >
                            Assign a Git Source for Compose discovery.
                            Credentials are stored with the source and are never
                            embedded in URLs.
                        </p>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <span class="m3-font-label-large text-on-surface"
                        >Git repository</span
                    >
                    {#if gitSources.loading}
                        <LoadingIndicator aria-label="Loading Git Sources" />
                    {:else if gitSourceOptions.length === 0}
                        <p
                            class="text-on-surface-variant m3-font-body-small"
                        >
                            Add a Git Source first, then assign it to this data
                            source.
                        </p>
                        <div>
                            <Button
                                variant="tonal"
                                onclick={openCreateGitSourceDialog}
                            >
                                Add Git repository
                            </Button>
                        </div>
                    {:else}
                        <SelectOutlined
                            bind:value={query.gitSourceId.current}
                            label="Git repository"
                            options={gitSourceOptions}
                        />
                        {#if selectedGitSource}
                            <p
                                class="text-on-surface-variant m3-font-body-small"
                            >
                                {authMethodLabel(selectedGitSource.authMethod)} ·
                                {presentDataSource({
                                    gitUrl: selectedGitSource.url,
                                }).gitRepository ?? "No repository URL"}
                            </p>
                        {/if}
                    {/if}
                </div>
                <div class="flex flex-col gap-3">
                    <span class="m3-font-label-large text-on-surface"
                        >Uncloud</span
                    >
                    <TextFieldOutlined
                        bind:value={query.uncloudUrl.current}
                        label="Cluster URL"
                        required
                        placeholder="https://uncloud.example.com"
                        autocomplete="url"
                    />
                    <TextFieldOutlined
                        bind:value={uncloudToken}
                        label="Cluster API token (optional)"
                        type="password"
                        autocomplete="new-password"
                    />
                </div>
            </div>

            {#snippet buttons()}
                <Button
                    variant="text"
                    onclick={() => createDialogOpen.set(false)}
                >
                    Cancel
                </Button>

                <Button disabled={submitting} onclick={create}>Add</Button>
            {/snippet}
        </Dialog>
    {:else}
        <div class="mt-6">
            <p class="text-on-surface-variant m3-font-body-medium mb-4">
                Sync pulls Git changes and publishes app edits as formatted
                Compose. Every new commit deploys its services. Enable automatic
                deployments from a repository’s actions menu to check every
                minute.
            </p>
            {#if gitSources.loading}
                <div class="flex min-h-32 items-center justify-center">
                    <LoadingIndicator aria-label="Loading Git Sources" />
                </div>
            {:else if gitSources.error}
                <div class="text-error m3-font-body-medium p-6">
                    {gitSources.error.message}
                </div>
            {:else if (gitSources.current?.length ?? 0) === 0}
                <div
                    class="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center"
                >
                    <span
                        class="bg-secondary-container text-on-secondary-container grid size-10 place-items-center rounded-xl"
                        ><Icon icon={keyIcon} size={20} /></span
                    >
                    <h3 class="m3-font-title-medium text-on-surface mt-3">
                        No Git Sources yet
                    </h3>
                    <p class="text-on-surface-variant m3-font-body-medium mt-1 max-w-m">
                        Add a public repository or connect with an HTTPS token,
                        basic credentials, or an SSH private key.
                    </p>
                    <div class="mt-4">
                        <Button onclick={openCreateGitSourceDialog}
                            >Add Git repository</Button
                        >
                    </div>
                </div>
            {:else}
                <Card variant="filled" id="git-sources-list">
                    {#each gitSources.current ?? [] as source (source.id)}
                        {@const linkedCount = (
                            dataSources.current ?? []
                        ).filter(
                            (dataSource) => dataSource.gitSourceId === source.id
                        ).length}
                        {@const repositoryUrl =
                            presentDataSource({ gitUrl: source.url })
                                .gitRepository ?? "No repository URL"}
                        <div class="source-row">
                            <span class="source-row-icon secondary">
                                <Icon icon={keyIcon} size={20} />
                            </span>
                            <span class="source-copy">
                                <span class="source-name">{source.name}</span>
                                <span class="source-meta" title={repositoryUrl}>
                                    {repositoryUrl}
                                </span>
                                <span class="source-meta">
                                    {source.syncEnabled
                                        ? "Auto deploy: every minute"
                                        : "Auto deploy paused"}
                                    {#if source.syncResult}
                                        · Last checked {new Date(
                                            source.syncResult.checkedAt
                                        ).toLocaleString()}
                                        {#if source.syncResult.commit}
                                            · {source.syncResult.commit.slice(
                                                0,
                                                8
                                            )}{/if}
                                    {/if}
                                </span>
                                {#if (source.syncResult?.issues ?? []).length > 0}
                                    <span role="alert" class="flex flex-col gap-1">
                                        {#each source.syncResult?.issues ?? [] as issue}
                                            <span
                                                class="text-error m3-font-body-small whitespace-normal"
                                                >{issue}</span
                                            >
                                        {/each}
                                    </span>
                                {/if}
                            </span>
                            <span class="source-detail">
                                <span class="source-auth">
                                    <Icon
                                        icon={source.authMethod === "ssh"
                                            ? terminalIcon
                                            : source.authMethod === "none"
                                              ? linkIcon
                                              : lockIcon}
                                        size={16}
                                    />
                                    {authMethodLabel(source.authMethod)}
                                </span>
                                <span class="source-meta">
                                    {#if source.username}{source.username} ·
                                    {/if}{linkedCount}
                                    {linkedCount === 1
                                        ? "data source"
                                        : "data sources"}
                                </span>
                            </span>
                            <div
                                data-data-source-actions
                                class="relative flex items-center justify-end gap-2"
                            >
                                <Button
                                    variant="tonal"
                                    size="xs"
                                    iconType="left"
                                    disabled={syncingGitSourceId !== null ||
                                        !source.url ||
                                        linkedCount === 0}
                                    onclick={() => syncRepository(source.id)}
                                >
                                    <Icon icon={refreshIcon} size={18} />
                                    {syncingGitSourceId === source.id
                                        ? "Syncing…"
                                        : "Sync"}
                                </Button>
                                <Button
                                    iconType="full"
                                    size="xs"
                                    variant="text"
                                    aria-label={`Actions for ${source.name}`}
                                    aria-haspopup="menu"
                                    aria-expanded={actionsMenuOpen ===
                                        source.id}
                                    style={actionsMenuOpen === source.id
                                        ? "anchor-name: --m3-menu-anchor"
                                        : undefined}
                                    onclick={() => toggleActionsMenu(source.id)}
                                >
                                    <Icon icon={moreVertIcon} size={18} />
                                </Button>
                                {#if actionsMenuOpen === source.id}
                                    <ExpressiveMenu
                                        anchored
                                        x="end"
                                        y="down"
                                        label="Actions"
                                    >
                                        {#if (source.syncResult?.issues.length ?? 0) > 0}
                                            <ExpressiveMenuItem
                                                leadingIcon={editIcon}
                                                label="Resolve sync differences"
                                                onclick={() => {
                                                    actionsMenuOpen = null;
                                                    resolvingGitSourceId =
                                                        source.id;
                                                }}
                                            />
                                        {/if}
                                        <ExpressiveMenuItem
                                            leadingIcon={refreshIcon}
                                            label={source.syncEnabled
                                                ? "Pause automatic deployments"
                                                : "Enable automatic deployments"}
                                            details="Sync both ways and deploy every new commit"
                                            disabled={updatingSyncId !== null ||
                                                !source.url ||
                                                linkedCount === 0}
                                            onclick={() => {
                                                actionsMenuOpen = null;
                                                void toggleAutomaticSync(
                                                    source.id,
                                                    !source.syncEnabled
                                                );
                                            }}
                                        />
                                        <ExpressiveMenuItem
                                            leadingIcon={editIcon}
                                            label="Edit"
                                            onclick={() =>
                                                openEditGitSourceDialog(source)}
                                        />
                                        <MenuDivider />
                                        <ExpressiveMenuItem
                                            leadingIcon={deleteIcon}
                                            label="Delete"
                                            details={linkedCount > 0
                                                ? "Reassign linked data sources first"
                                                : undefined}
                                            disabled={linkedCount > 0}
                                            onclick={() =>
                                                openDeleteGitSourceDialog(
                                                    source.id
                                                )}
                                        />
                                    </ExpressiveMenu>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </Card>
            {/if}
        </div>
    {/if}
</main>

<Dialog
    open={resolvingGitSourceId !== null}
    headline="Resolve Git sync differences"
    onclose={() => {
        if (!syncingGitSourceId) resolvingGitSourceId = null;
    }}
>
    <p class="text-on-surface-variant m3-font-body-medium">
        Choose which version to keep when the app and Git both changed. Unseen
        Git commits still receive deployments in order. Keeping app changes
        publishes them as a new commit after those commits.
    </p>
    <p class="text-on-surface-variant m3-font-body-medium mt-3">
        Missing files or rewritten Git history must be restored in the
        repository first.
    </p>
    {#snippet buttons()}
        <Button
            variant="text"
            disabled={syncingGitSourceId !== null}
            onclick={() => {
                resolvingGitSourceId = null;
            }}>Cancel</Button
        >
        <Button
            variant="tonal"
            disabled={syncingGitSourceId !== null}
            onclick={() => {
                if (resolvingGitSourceId)
                    void syncRepository(resolvingGitSourceId, "git");
            }}>Use Git changes</Button
        >
        <Button
            disabled={syncingGitSourceId !== null}
            onclick={() => {
                if (resolvingGitSourceId)
                    void syncRepository(resolvingGitSourceId, "app");
            }}>Keep app changes</Button
        >
    {/snippet}
</Dialog>

<Dialog
    open={editing.current !== ""}
    onclose={closeEditDialog}
    headline="Edit cluster connection"
>
    <div
        class="flex min-w-[min(30rem,calc(100vw-3rem))] flex-col gap-5 max-m:min-w-0"
    >
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface"
                >Git repository</span
            >
            <SelectOutlined
                bind:value={query.editingGitSourceId.current}
                label="Git repository"
                options={gitSourceOptions}
            />
            {#if editingSelectedGitSource}
                <p class="text-on-surface-variant m3-font-body-small">
                    {authMethodLabel(editingSelectedGitSource.authMethod)} ·
                    {presentDataSource({ gitUrl: editingSelectedGitSource.url })
                        .gitRepository ?? "No repository URL"}
                </p>
            {/if}
        </div>
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface">Uncloud</span>
            <TextFieldOutlined
                bind:value={query.editingUncloudUrl.current}
                label="Cluster URL"
                required
                placeholder="https://uncloud.example.com"
                autocomplete="url"
            />
            <TextFieldOutlined
                bind:value={editingUncloudToken}
                label="Replace cluster API token"
                type="password"
                autocomplete="new-password"
                placeholder="Leave blank to keep the current token"
            />
        </div>
    </div>

    {#snippet buttons()}
        <Button variant="text" disabled={submitting} onclick={closeEditDialog}>
            Cancel
        </Button>

        <Button
            disabled={submitting || !query.editingUncloudUrl.current.trim()}
            onclick={save}
        >
            Save
        </Button>
    {/snippet}
</Dialog>

<Dialog
    open={deleting.current !== ""}
    onclose={() => deleting.set("")}
    headline="Delete cluster connection"
>
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Are you sure you want to delete this data source?
        </p>

        <p class="text-on-surface-variant m3-font-body-medium">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={deletingSubmitting}
            onclick={() => deleting.set("")}>Cancel</Button
        >

        <Button disabled={deletingSubmitting} onclick={remove}>Delete</Button>
    {/snippet}
</Dialog>

<Dialog
    bind:open={createGitSourceDialogOpen.current}
    headline="Add Git repository"
    onclose={closeCreateGitSourceDialog}
>
    <div
        class="flex min-w-[min(30rem,calc(100vw-3rem))] flex-col gap-5 max-m:min-w-0"
    >
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface">Repository</span>
            <TextFieldOutlined
                bind:value={query.gitSourceName.current}
                label="Name"
                required
            />
            <TextFieldOutlined
                bind:value={query.gitSourceUrl.current}
                label="Repository URL"
                required
                autocomplete="url"
                placeholder="https://github.com/org/repository.git"
            />
        </div>
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface"
                >Authentication</span
            >
            <SelectOutlined
                bind:value={query.gitAuthMethod.current}
                label="Method"
                options={authMethodOptions}
            />
            {#if query.gitAuthMethod.current === "token"}
                <TextFieldOutlined
                    bind:value={query.gitUsername.current}
                    label="Username (optional)"
                    autocomplete="username"
                />
                <TextFieldOutlined
                    bind:value={gitToken}
                    label="Access token"
                    type="password"
                    required
                    autocomplete="new-password"
                />
            {:else if query.gitAuthMethod.current === "basic"}
                <TextFieldOutlined
                    bind:value={query.gitUsername.current}
                    label="Username"
                    required
                    autocomplete="username"
                />
                <TextFieldOutlined
                    bind:value={gitPassword}
                    label="Password"
                    type="password"
                    required
                    autocomplete="new-password"
                />
            {:else if query.gitAuthMethod.current === "ssh"}
                <TextFieldOutlined
                    bind:value={query.gitUsername.current}
                    label="SSH user (optional)"
                    autocomplete="username"
                />
                <TextFieldOutlinedMultiline
                    bind:value={gitSshPrivateKey}
                    label="Private key"
                    required
                    rows={6}
                />
                <TextFieldOutlinedMultiline
                    bind:value={gitSshKnownHosts}
                    label="Known hosts (optional)"
                    rows={3}
                />
            {/if}
            <p class="text-on-surface-variant m3-font-body-small">
                Keep credentials out of the repository URL. Secret values are
                write-only.
            </p>
        </div>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={submitting}
            onclick={closeCreateGitSourceDialog}
        >
            Cancel
        </Button>
        <Button disabled={submitting} onclick={createGitSourceRecord}
            >Add</Button
        >
    {/snippet}
</Dialog>

<Dialog
    open={editingGitSource.current !== ""}
    headline="Edit Git repository"
    onclose={closeEditGitSourceDialog}
>
    <div
        class="flex min-w-[min(30rem,calc(100vw-3rem))] flex-col gap-5 max-m:min-w-0"
    >
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface">Repository</span>
            <TextFieldOutlined
                bind:value={query.editingGitSourceName.current}
                label="Name"
                required
            />
            <TextFieldOutlined
                bind:value={query.editingGitSourceUrl.current}
                label="Repository URL"
                required
                autocomplete="url"
            />
        </div>
        <div class="flex flex-col gap-3">
            <span class="m3-font-label-large text-on-surface"
                >Authentication</span
            >
            <SelectOutlined
                bind:value={query.editingGitAuthMethod.current}
                label="Method"
                options={authMethodOptions}
            />
            {#if query.editingGitAuthMethod.current === "token"}
                <TextFieldOutlined
                    bind:value={query.editingGitUsername.current}
                    label="Username (optional)"
                    autocomplete="username"
                />
                <TextFieldOutlined
                    bind:value={editingGitToken}
                    label="Replace access token"
                    type="password"
                    autocomplete="new-password"
                    placeholder="Leave blank to keep the current token"
                />
            {:else if query.editingGitAuthMethod.current === "basic"}
                <TextFieldOutlined
                    bind:value={query.editingGitUsername.current}
                    label="Username"
                    required
                    autocomplete="username"
                />
                <TextFieldOutlined
                    bind:value={editingGitPassword}
                    label="Replace password"
                    type="password"
                    autocomplete="new-password"
                    placeholder="Leave blank to keep the current password"
                />
            {:else if query.editingGitAuthMethod.current === "ssh"}
                <TextFieldOutlined
                    bind:value={query.editingGitUsername.current}
                    label="SSH user (optional)"
                    autocomplete="username"
                />
                <TextFieldOutlinedMultiline
                    bind:value={editingGitSshPrivateKey}
                    label="Replace private key"
                    rows={6}
                    placeholder="Leave blank to keep the current key"
                />
                <TextFieldOutlinedMultiline
                    bind:value={editingGitSshKnownHosts}
                    label="Replace known hosts"
                    rows={3}
                    placeholder="Leave blank to keep the current hosts"
                />
            {/if}
        </div>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={submitting}
            onclick={closeEditGitSourceDialog}
        >
            Cancel
        </Button>
        <Button disabled={submitting} onclick={saveGitSource}>Save</Button>
    {/snippet}
</Dialog>

<Dialog
    open={deletingGitSource.current !== ""}
    headline="Delete Git repository"
    onclose={() => deletingGitSource.set("")}
>
    <p class="text-on-surface-variant m3-font-body-medium">
        This removes the repository configuration and its credentials. Assigned
        Git Sources must be reassigned first.
    </p>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={deletingSubmitting}
            onclick={() => deletingGitSource.set("")}
        >
            Cancel
        </Button>
        <Button disabled={deletingSubmitting} onclick={removeGitSource}
            >Delete</Button
        >
    {/snippet}
</Dialog>

<Snackbar />

<style>
    :global(#data-sources-list.m3-container),
    :global(#git-sources-list.m3-container) {
        padding: 0;
        border-radius: var(--m3-shape-large);
        background: var(--m3c-surface-container-low);
    }

    .source-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1.2fr) minmax(12rem, 0.8fr) auto;
        align-items: center;
        gap: 0.875rem;
        min-height: 4.5rem;
        padding: 0.75rem 0.875rem 0.75rem 1rem;
        border-bottom: 1px solid var(--m3c-outline-variant);
        transition: background-color var(--m3-easing-fast);
    }

    .source-row:first-child {
        border-radius: var(--m3-shape-large) var(--m3-shape-large) 0 0;
    }

    .source-row:last-child {
        border-bottom: 0;
        border-radius: 0 0 var(--m3-shape-large) var(--m3-shape-large);
    }

    .source-row:only-child {
        border-radius: var(--m3-shape-large);
    }

    .source-row:hover {
        background: var(--m3c-surface-container);
    }

    .source-row-icon {
        display: inline-flex;
        width: 2.25rem;
        height: 2.25rem;
        align-items: center;
        justify-content: center;
        border-radius: var(--m3-shape-full);
    }

    .source-row-icon.primary {
        color: var(--m3c-on-primary-container);
        background: var(--m3c-primary-container);
    }

    .source-row-icon.secondary {
        color: var(--m3c-on-secondary-container);
        background: var(--m3c-secondary-container);
    }

    .source-copy,
    .source-detail {
        display: flex;
        min-width: 0;
        overflow: hidden;
        flex-direction: column;
    }

    .source-name {
        @apply --m3-title-small;
        overflow: hidden;
        color: var(--m3c-on-surface);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .source-meta {
        @apply --m3-body-small;
        overflow: hidden;
        margin-top: 0.125rem;
        color: var(--m3c-on-surface-variant);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .source-auth {
        @apply --m3-label-medium;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        color: var(--m3c-on-surface);
    }

    @media (width < 44rem) {
        .source-row {
            grid-template-columns: auto minmax(0, 1fr) auto;
            gap: 0.625rem 0.75rem;
        }

        .source-assignment,
        .source-detail {
            grid-column: 2;
        }

        .source-row > :last-child {
            grid-column: 3;
            grid-row: 1 / 3;
        }
    }
</style>
