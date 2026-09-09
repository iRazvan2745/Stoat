<script lang="ts">
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import codeIcon from "@ktibow/iconset-material-symbols/code";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import variablesIcon from "@ktibow/iconset-material-symbols/variables-outline";
    import {
        Button,
        ButtonGroup,
        Card,
        Icon,
        LoadingIndicator,
        Snackbar,
        Switch,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";

    import {
        listEnvironmentVariables,
        updateEnvironmentVariables,
    } from "#lib/api/resources.remote";
    import { listWorkspaceEnvironmentVariables } from "#lib/api/workspaces.remote";
    import type { EnvironmentVariable } from "#lib/domain/environment";
    import {
        normalizeEnvironmentVariables,
        parseEnvFile,
        serializeEnvFile,
        validateEnvironmentVariables,
    } from "#lib/domain/environment";

    import EnvironmentEditor from "./environment-editor.svelte";

    interface DraftVariable extends EnvironmentVariable {
        id: string;
    }

    const { params } = $props();

    const variablesQuery = $derived(listEnvironmentVariables(params.resourceId));
    const savedVariables = $derived(await variablesQuery);

    const createDraft = (name = "", value = ""): DraftVariable => ({
        id: crypto.randomUUID(),
        name,
        value,
    });

    const view = useQueryState(
        "view",
        parseAsStringLiteral(["editor", "list"] as const).withDefault("editor")
    );
    const draftsFrom = (rows: EnvironmentVariable[]): DraftVariable[] =>
        rows.map((variable) => createDraft(variable.name, variable.value));

    // These values intentionally seed the editable draft once the initial
    // query resolves. Later refreshes are applied explicitly after a save so
    // an external refresh cannot overwrite unsaved edits.
    // svelte-ignore state_referenced_locally
    let variables = $state<DraftVariable[]>(draftsFrom(savedVariables));
    // svelte-ignore state_referenced_locally
    let envFile = $state(serializeEnvFile(savedVariables));
    let saving = $state(false);
    let showEnvironmentValues = $state(false);

    const workspaceQuery = $derived(
        listWorkspaceEnvironmentVariables(params.workspaceId)
    );
    // Falls back to empty while loading, on error, or if the workspace
    // query is unavailable — the section then shows its empty state.
    const workspaceVars = $derived(workspaceQuery.current ?? []);
    const resourceNames = $derived(
        new Set(variables.map((variable) => variable.name.trim()))
    );
    const inherited = $derived(
        workspaceVars.filter(
            (variable) => !resourceNames.has(variable.name.trim())
        )
    );
    const overridden = $derived(
        workspaceVars.filter((variable) =>
            resourceNames.has(variable.name.trim())
        )
    );

    const applySaved = (rows: EnvironmentVariable[]): void => {
        variables = draftsFrom(rows);
        envFile = serializeEnvFile(rows);
    };

    const setView = (next: "editor" | "list"): void => {
        if (next === view.current) {
            return;
        }

        if (next === "editor") {
            envFile = serializeEnvFile(
                normalizeEnvironmentVariables(variables)
            );
            view.set("editor");
            return;
        }

        const parsed = parseEnvFile(envFile);

        if (parsed.errors.length > 0) {
            snackbar(parsed.errors[0] ?? "Invalid .env file");
            return;
        }

        variables = parsed.variables.map((variable) =>
            createDraft(variable.name, variable.value)
        );
        view.set("list");
    };

    const addVariable = (): void => {
        variables = [...variables, createDraft()];
    };

    const removeVariable = (id: string): void => {
        variables = variables.filter((variable) => variable.id !== id);
    };

    const variablesToSave = (): EnvironmentVariable[] | undefined => {
        if (view.current === "editor") {
            const parsed = parseEnvFile(envFile);

            if (parsed.errors.length > 0) {
                snackbar(parsed.errors[0] ?? "Invalid .env file");
                return;
            }

            return parsed.variables;
        }

        const errors = validateEnvironmentVariables(variables);

        if (errors.length > 0) {
            snackbar(errors[0] ?? "Invalid environment variables");
            return;
        }

        return normalizeEnvironmentVariables(variables);
    };

    const save = async (): Promise<void> => {
        if (saving) {
            return;
        }

        const nextVariables = variablesToSave();

        if (!nextVariables) {
            return;
        }

        saving = true;

        try {
            const saved = await updateEnvironmentVariables({
                resourceId: params.resourceId,
                variables: nextVariables,
            });
            await variablesQuery.refresh();
            applySaved(variablesQuery.current ?? saved);
            snackbar("Environment saved");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save environment"
            );
        } finally {
            saving = false;
        }
    };
</script>

<div class="flex h-full min-h-0 flex-col gap-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
            <h1 class="m3-font-headline-small text-on-surface">Environment</h1>
            <p class="m3-font-body-medium text-on-surface-variant">
                Variables are applied to every container on the next deploy.
                Workspace variables are merged in; resource values win on
                conflict.
            </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <ButtonGroup
                selected={view.current === "editor" ? 0 : 1}
                aria-label="Environment view"
            >
                <Button
                    variant="filled"
                    aria-pressed={view.current === "editor"}
                    onclick={() => setView("editor")}
                >
                    <Icon icon={codeIcon} size={18} />
                    .env
                </Button>
                <Button
                    variant="filled"
                    aria-pressed={view.current === "list"}
                    onclick={() => setView("list")}
                >
                    <Icon icon={variablesIcon} size={18} />
                    Variables
                </Button>
            </ButtonGroup>

            <Button
                variant="tonal"
                iconType="left"
                onclick={addVariable}
                disabled={view.current === "editor"}
            >
                <Icon icon={addIcon} size={18} />
                Add
            </Button>

            <Button disabled={saving} aria-busy={saving} onclick={save}>
                {#if saving}
                    <LoadingIndicator
                        size={18}
                        center={false}
                        aria-label="Saving environment"
                    />
                    Saving...
                {:else}
                    Save
                {/if}
            </Button>
        </div>
    </header>

    <Card variant="outlined">
        <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
                <h2 class="m3-font-title-small text-on-surface">
                    Inherited from workspace ({workspaceVars.length})
                </h2>
                <p class="m3-font-body-small text-on-surface-variant">
                    Read-only. Workspace variables are merged in; resource values
                    win on conflict. Toggle “Show values” in the .env editor to
                    reveal values.
                </p>
            </div>
            {#if workspaceVars.length === 0}
                <p class="m3-font-body-medium text-on-surface-variant">
                    No workspace variables defined.
                </p>
            {:else}
                {#if inherited.length > 0}
                    <ul class="flex flex-col gap-2">
                        {#each inherited as variable (variable.name)}
                            <li
                                class="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                            >
                                <code
                                    class="m3-font-body-medium text-on-surface font-mono"
                                    >{variable.name}</code
                                >
                                <span
                                    class="m3-font-body-medium text-on-surface-variant font-mono break-all"
                                    >={showEnvironmentValues
                                        ? variable.value
                                        : "•••"}</span
                                >
                            </li>
                        {/each}
                    </ul>
                {/if}
                {#if overridden.length > 0}
                    <div class="flex flex-col gap-2">
                        <p class="m3-font-body-small text-on-surface-variant">
                            Overridden by this resource:
                        </p>
                        <ul class="flex flex-col gap-2">
                            {#each overridden as variable (variable.name)}
                                <li
                                    class="flex flex-wrap items-center gap-x-2 gap-y-1"
                                >
                                    <code
                                        class="m3-font-body-medium text-on-surface font-mono"
                                        >{variable.name}</code
                                    >
                                    <span
                                        class="m3-font-body-medium text-on-surface-variant font-mono break-all"
                                        >={showEnvironmentValues
                                            ? variable.value
                                            : "•••"}</span
                                    >
                                    <span
                                        class="bg-secondary-container text-on-secondary-container m3-font-label-small inline-flex h-5 shrink-0 items-center rounded-full px-2"
                                        >Resource value wins</span
                                    >
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}
            {/if}
        </div>
    </Card>

    {#if view.current === "list"}
        <Card variant="elevated">
            {#if variables.length === 0}
                <div
                    class="text-on-surface-variant flex min-h-48 flex-col items-center justify-center gap-3"
                >
                    <Icon icon={variablesIcon} size={24} />
                    <p class="m3-font-body-medium">
                        No environment variables yet
                    </p>
                    <Button
                        variant="tonal"
                        iconType="left"
                        onclick={addVariable}
                    >
                        <Icon icon={addIcon} size={18} />
                        Add variable
                    </Button>
                </div>
            {:else}
                <ul class="flex flex-col gap-3">
                    {#each variables as variable (variable.id)}
                        <li class="flex w-full items-end gap-8">
                            <div class="w-56 shrink-0 [&_.m3-container]:w-full">
                                <TextFieldOutlined
                                    bind:value={variable.name}
                                    label="Name"
                                    spellcheck="false"
                                    autocapitalize="off"
                                    autocomplete="off"
                                />
                            </div>

                            <div
                                class="min-w-0 flex-1 [&_.m3-container]:w-full"
                            >
                                <TextFieldOutlined
                                    bind:value={variable.value}
                                    label="Value"
                                    spellcheck="false"
                                    autocapitalize="off"
                                    autocomplete="off"
                                />
                            </div>

                            <Button
                                variant="text"
                                square
                                aria-label={`Remove ${variable.name || "variable"}`}
                                onclick={() => removeVariable(variable.id)}
                            >
                                <Icon icon={deleteIcon} />
                            </Button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </Card>
    {:else}
        <Card variant="elevated">
            <div
                class="text-on-surface-variant mb-2 flex flex-wrap items-center justify-between gap-3"
            >
                <div class="flex items-center gap-2">
                    <Icon icon={codeIcon} size={18} />
                    <p class="m3-font-body-small">.env file</p>
                </div>
                <label class="text-on-surface flex items-center gap-2">
                    <span class="m3-font-label-large">Show values</span>
                    <Switch
                        bind:checked={showEnvironmentValues}
                        aria-label="Show environment values"
                    />
                </label>
            </div>
            <EnvironmentEditor
                bind:value={envFile}
                showValues={showEnvironmentValues}
            />
        </Card>
    {/if}
</div>

<Snackbar />
