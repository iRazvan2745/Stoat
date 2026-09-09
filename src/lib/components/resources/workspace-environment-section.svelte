<script lang="ts">
    // oxlint-disable unicorn/prefer-regexp-test
    import {
        HighlightStyle,
        LanguageSupport,
        StreamLanguage,
    } from "@codemirror/language";
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import codeIcon from "@ktibow/iconset-material-symbols/code";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import variablesIcon from "@ktibow/iconset-material-symbols/variables-outline";
    import { tags } from "@lezer/highlight";
    import {
        Button,
        ButtonGroup,
        Card,
        Icon,
        LoadingIndicator,
        Switch,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import * as workspacesRemote from "#lib/api/workspaces.remote";
    import type { EnvironmentVariable } from "#lib/domain/environment";
    import {
        normalizeEnvironmentVariables,
        parseEnvFile,
        serializeEnvFile,
        validateEnvironmentVariables,
    } from "#lib/domain/environment";
    import { maskEnvironmentValues } from "#lib/shared/ui/code-mirror-environment-values";
    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    interface DraftVariable extends EnvironmentVariable {
        id: string;
    }

    // Expected workspace-level environment API. These remote functions do not
    // exist yet, so access them through a namespace import: static imports
    // keep resolving today, and the section wires itself up once they land.
    interface WorkspaceEnvironmentApi {
        listWorkspaceEnvironmentVariables?: (
            workspaceId: string
        ) => Promise<EnvironmentVariable[]>;
        updateWorkspaceEnvironmentVariables?: (input: {
            variables: EnvironmentVariable[];
            workspaceId: string;
        }) => Promise<EnvironmentVariable[]>;
    }

    const workspaceEnvApi =
        workspacesRemote as unknown as WorkspaceEnvironmentApi;

    let { workspaceId }: { workspaceId: string } = $props();

    const view = useQueryState(
        "workspaceEnvView",
        parseAsStringLiteral(["editor", "list"] as const).withDefault("editor")
    );

    const createDraft = (name = "", value = ""): DraftVariable => ({
        id: crypto.randomUUID(),
        name,
        value,
    });

    // Starts empty: there is no workspace environment query to seed from yet.
    // applySaved() reseeds drafts after a successful save instead, so an
    // external refresh can never overwrite unsaved edits.
    let variables = $state<DraftVariable[]>([]);
    let envFile = $state("");
    let saving = $state(false);
    let showEnvironmentValues = $state(false);
    let editorLoading = $state(true);

    const applySaved = (rows: EnvironmentVariable[]): void => {
        variables = rows.map((variable) =>
            createDraft(variable.name, variable.value)
        );
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

        const updateFn = workspaceEnvApi.updateWorkspaceEnvironmentVariables;

        if (!updateFn) {
            snackbar("Workspace environment API isn't available yet");
            return;
        }

        saving = true;

        try {
            const saved = await updateFn({
                variables: nextVariables,
                workspaceId,
            });
            applySaved(saved ?? nextVariables);
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

    // dotenv language is duplicated from the resource environment editor on
    // purpose: that component lives under a route group and cannot be
    // imported cleanly from lib.
    const dotenvLanguage = new LanguageSupport(
        StreamLanguage.define<{ expectValue: boolean }>({
            name: "dotenv",
            startState: () => ({ expectValue: false }),
            token(stream, state) {
                if (stream.eatSpace()) {
                    return null;
                }

                if (stream.match(/#.*/u)) {
                    state.expectValue = false;
                    return "comment";
                }

                if (state.expectValue) {
                    state.expectValue = false;

                    if (
                        stream.match(/"(?:\\.|[^"\\])*"/u) ||
                        stream.match(/'(?:\\.|[^'\\])*'/u)
                    ) {
                        return "string";
                    }

                    stream.skipToEnd();
                    return "string";
                }

                if (stream.match(/export\b/u)) {
                    return "keyword";
                }

                if (stream.match(/[A-Za-z_][A-Za-z0-9_]*/u)) {
                    return "propertyName";
                }

                if (stream.eat("=")) {
                    state.expectValue = true;
                    return "operator";
                }

                stream.next();
                return null;
            },
        })
    );

    const editorExtensions = $derived([
        ...codeMirrorSearchExtensions,
        maskEnvironmentValues(showEnvironmentValues),
    ]);

    const editorStyles = {
        "&": {
            backgroundColor: "var(--m3c-surface-container-low)",
            color: "var(--m3c-on-surface)",
            minHeight: "12rem",
        },
        "&.cm-focused .cm-selectionBackground, ::selection": {
            backgroundColor: "var(--m3c-primary-container)",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor:
                "color-mix(in srgb, var(--m3c-primary) 12%, transparent)",
        },
        ".cm-content": { padding: "1rem 0" },
        ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--m3c-primary)",
        },
        ".cm-env-masked-value": {
            color: "var(--m3c-on-surface-variant)",
            cursor: "text",
            userSelect: "none",
        },
        ".cm-gutters": {
            backgroundColor: "var(--m3c-surface-container-low)",
            borderRight: "1px solid var(--m3c-outline-variant)",
            color: "var(--m3c-on-surface-variant)",
        },
        ".cm-scroller": {
            fontFamily: "var(--m3-font-mono, ui-monospace, monospace)",
        },
    };

    const envSyntaxHighlighting = {
        fallback: true,
        highlighter: HighlightStyle.define([
            {
                color: "var(--m3c-on-surface-variant)",
                fontStyle: "italic",
                tag: tags.comment,
            },
            {
                color: "var(--m3c-primary)",
                tag: [tags.propertyName, tags.keyword],
            },
            {
                color: "var(--m3c-tertiary)",
                tag: [tags.string, tags.special(tags.string)],
            },
            {
                color: "var(--m3c-on-surface-variant)",
                tag: [tags.operator, tags.punctuation],
            },
        ]),
    };

    const handleEditorReady = (): void => {
        editorLoading = false;
    };
</script>

<Card variant="elevated">
    <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
            <h2 class="m3-font-title-medium text-on-surface">Environment</h2>
            <p class="m3-font-body-medium text-on-surface-variant">
                Applied to every resource in this workspace on the next deploy.
                Resource variables with the same name override these.
            </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <ButtonGroup
                selected={view.current === "editor" ? 0 : 1}
                aria-label="Workspace environment view"
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
    </div>

    {#if view.current === "list"}
        {#if variables.length === 0}
            <div
                class="text-on-surface-variant flex min-h-32 flex-col items-center justify-center gap-3"
            >
                <Icon icon={variablesIcon} size={24} />
                <p class="m3-font-body-medium">No environment variables yet</p>
                <Button variant="tonal" iconType="left" onclick={addVariable}>
                    <Icon icon={addIcon} size={18} />
                    Add variable
                </Button>
            </div>
        {:else}
            <ul class="mt-4 flex flex-col gap-3">
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

                        <div class="min-w-0 flex-1 [&_.m3-container]:w-full">
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
    {:else}
        <div
            class="text-on-surface-variant mt-4 mb-2 flex flex-wrap items-center justify-between gap-3"
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
        <div
            class="relative min-h-56 overflow-hidden"
            aria-busy={editorLoading}
            aria-label="Workspace environment file editor"
        >
            <CodeMirror
                bind:value={envFile}
                lang={dotenvLanguage}
                syntaxHighlighting={envSyntaxHighlighting}
                styles={editorStyles}
                extensions={editorExtensions}
                foldGutter={false}
                closeBrackets={false}
                autocompletion={false}
                placeholder={"Add your stuff"}
                onready={handleEditorReady}
            />

            {#if editorLoading}
                <div
                    class="bg-surface-container-low absolute inset-0 z-10 flex items-center justify-center"
                    role="status"
                >
                    <LoadingIndicator aria-label="Loading code editor" />
                </div>
            {/if}
        </div>
    {/if}
</Card>
