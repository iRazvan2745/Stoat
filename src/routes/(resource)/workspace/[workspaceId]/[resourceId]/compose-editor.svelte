<script lang="ts">
    import { yaml } from "@codemirror/lang-yaml";
    import { HighlightStyle } from "@codemirror/language";
    import previewIcon from "@ktibow/iconset-material-symbols/preview-outline";
    import { tags } from "@lezer/highlight";
    import {
        Button,
        Card,
        Dialog,
        Icon,
        LoadingIndicator,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import { onDestroy } from "svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import {
        previewResourceCompose,
        updateResourceCompose,
    } from "#lib/api/resources.remote";
    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    interface Props {
        initialCompose?: string | null;
        resourceId: string;
    }

    const SAVE_DEBOUNCE_MS = 600;
    const { initialCompose = "", resourceId }: Props = $props();

    // The editor keeps its own draft after the resource has loaded.
    // svelte-ignore state_referenced_locally
    let compose = $state(initialCompose ?? "");
    // svelte-ignore state_referenced_locally
    let lastSaved = $state(initialCompose ?? "");
    let editorLoading = $state(true);
    let saving = $state(false);
    let pendingSave = $state(false);
    let saveInFlight = false;
    let saveTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let previewOpen = useQueryState(
        "previewOpen",
        parseAsBoolean.withDefault(false)
    );
    let previewLoading = $state(false);
    let previewYaml = $state("");
    let previewError = $state<string | null>(null);
    const isSaving = $derived(saving || pendingSave);
    const composeLanguage = yaml();
    const lineHighlight =
        "color-mix(in srgb, var(--m3c-on-surface) 8%, transparent)";

    const editorStyles = {
        "&": {
            backgroundColor: "transparent",
            color: "var(--m3c-on-surface)",
            colorScheme: "inherit",
            height: "100%",
            minHeight: "12rem",
        },
        "&.cm-focused .cm-selectionBackground": {
            backgroundColor: "var(--m3c-primary-container) !important",
        },
        ".cm-activeLine": {
            backgroundColor: `${lineHighlight} !important`,
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

    const composeSyntaxHighlighting = {
        fallback: false,
        highlighter: HighlightStyle.define([
            {
                color: "var(--m3c-on-surface-variant)",
                fontStyle: "italic",
                tag: [tags.comment, tags.lineComment, tags.meta],
            },
            {
                color: "var(--m3c-primary)",
                tag: [
                    tags.propertyName,
                    tags.definition(tags.propertyName),
                    tags.keyword,
                ],
            },
            {
                color: "var(--m3c-on-surface)",
                tag: [tags.content, tags.literal, tags.atom],
            },
            {
                color: "var(--m3c-tertiary)",
                tag: [
                    tags.string,
                    tags.special(tags.string),
                    tags.attributeValue,
                ],
            },
            {
                color: "var(--m3c-secondary)",
                tag: [tags.number, tags.bool, tags.typeName, tags.labelName],
            },
            {
                color: "var(--m3c-on-surface-variant)",
                tag: [
                    tags.separator,
                    tags.punctuation,
                    tags.squareBracket,
                    tags.brace,
                    tags.operator,
                    tags.bracket,
                ],
            },
        ]),
    };

    const handleEditorReady = (): void => {
        editorLoading = false;
    };

    const closePreview = (): void => {
        previewOpen.set(false);
    };

    const openPreview = async (): Promise<void> => {
        previewOpen.set(true);
        previewLoading = true;
        previewError = null;
        previewYaml = "";

        try {
            const formatted = await previewResourceCompose({
                compose,
                resourceId,
            });
            previewYaml = formatted.yaml;
        } catch (error) {
            previewError =
                error instanceof Error
                    ? error.message
                    : "Unable to preview compose";
        } finally {
            previewLoading = false;
        }
    };

    const persist = async (): Promise<void> => {
        if (saveInFlight) {
            return;
        }

        const draft = compose;

        if (draft === lastSaved) {
            return;
        }

        saveInFlight = true;
        saving = true;
        let saved = false;

        try {
            await updateResourceCompose({ compose: draft, resourceId });
            lastSaved = draft;
            saved = true;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save compose"
            );
        } finally {
            saveInFlight = false;
            saving = false;

            if (saved && compose !== lastSaved) {
                void persist();
            }
        }
    };

    const scheduleSave = (draft: string): void => {
        clearTimeout(saveTimeoutId);

        if (draft === lastSaved) {
            pendingSave = false;
            return;
        }

        pendingSave = true;
        saveTimeoutId = setTimeout(() => {
            pendingSave = false;
            void persist();
        }, SAVE_DEBOUNCE_MS);
    };

    onDestroy(() => {
        clearTimeout(saveTimeoutId);
    });
</script>

<div class="compose flex h-full min-h-48 min-w-0 flex-col">
    <Card variant="elevated">
        <div class="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2">
            <h2 class="m3-font-title-small text-on-surface m-0 min-w-0">Compose Editor</h2>

            <div class="flex shrink-0 items-center gap-1">
                <div class="text-primary grid size-12 shrink-0 place-items-center" aria-live="polite">
                    {#if isSaving}
                        <LoadingIndicator
                            size={32}
                            center={false}
                            aria-label="Saving compose"
                        />
                    {/if}
                </div>
                <Button
                    variant="text"
                    size="s"
                    iconType="left"
                    onclick={openPreview}
                >
                    <Icon icon={previewIcon} />
                    Preview compose
                </Button>
            </div>
        </div>

        <div
            class="editor relative -mx-4 -mb-4 mt-2 min-h-0 flex-1 overflow-hidden rounded-b-md bg-transparent!"
            aria-busy={editorLoading || isSaving}
            aria-label="Compose YAML editor"
        >
            <CodeMirror
                bind:value={compose}
                onchange={scheduleSave}
                lang={composeLanguage}
                syntaxHighlighting={composeSyntaxHighlighting}
                styles={editorStyles}
                extensions={codeMirrorSearchExtensions}
                lineNumbers={false}
                foldGutter={false}
                highlight={{
                    activeLine: true,
                    activeLineGutter: false,
                    selectionMatches: false,
                    specialChars: true,
                }}
                onready={handleEditorReady}
            />

            {#if editorLoading}
                <div class="absolute inset-0 z-10 flex items-center justify-center bg-transparent!" role="status">
                    <LoadingIndicator aria-label="Loading code editor" />
                </div>
            {/if}
        </div>
    </Card>
</div>

<div class="max-w-none">
    <Dialog
        headline="Compose preview"
        id="compose-preview-dialog"
        bind:open={previewOpen.current}
        onclose={() => previewOpen.set(false)}
    >
        {#if previewLoading}
            <div class="flex min-h-48 items-center justify-center">
                <LoadingIndicator aria-label="Formatting compose" />
            </div>
        {:else if previewError}
            <p class="m3-font-body-medium text-error m-0" role="alert">{previewError}</p>
        {:else}
            <pre class="m3-font-body-small bg-surface-container text-on-surface m-0 max-h-[min(32rem,calc(100vh-16rem))] overflow-auto rounded-md p-4 font-mono whitespace-pre">{previewYaml}</pre>
        {/if}

        {#snippet buttons()}
            <Button variant="tonal" onclick={closePreview}>Close</Button>
        {/snippet}
    </Dialog>
</div>

<style>
    .compose > :global(.m3-container) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        height: 100%;
    }

    :global(#compose-preview-dialog.m3-container) {
        width: min(48rem, calc(100vw - 2rem));
        max-width: none;
    }

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
