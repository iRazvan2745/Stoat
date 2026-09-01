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
    import { onDestroy } from "svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import {
        previewServiceCompose,
        updateServiceCompose,
    } from "#lib/api/services.remote";
    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    interface Props {
        initialCompose?: string | null;
        serviceId: string;
    }

    const SAVE_DEBOUNCE_MS = 600;
    const { initialCompose = "", serviceId }: Props = $props();

    // The editor keeps its own draft after the service has loaded.
    // svelte-ignore state_referenced_locally
    let compose = $state(initialCompose ?? "");
    // svelte-ignore state_referenced_locally
    let lastSaved = $state(initialCompose ?? "");
    let editorLoading = $state(true);
    let saving = $state(false);
    let pendingSave = $state(false);
    let saveInFlight = false;
    let saveTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let previewOpen = $state(false);
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
        previewOpen = false;
    };

    const openPreview = async (): Promise<void> => {
        previewOpen = true;
        previewLoading = true;
        previewError = null;
        previewYaml = "";

        try {
            const formatted = await previewServiceCompose({
                compose,
                serviceId,
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
            await updateServiceCompose({ compose: draft, serviceId });
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

<div class="compose">
    <Card variant="elevated">
        <div class="compose-header">
            <h2 class="compose-title">Compose Editor</h2>

            <div class="compose-header-actions">
                <div class="compose-status" aria-live="polite">
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
            class="editor"
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
                <div class="editor-status" role="status">
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
        bind:open={previewOpen}
        onclose={closePreview}
    >
        {#if previewLoading}
            <div class="preview-status">
                <LoadingIndicator aria-label="Formatting compose" />
            </div>
        {:else if previewError}
            <p class="preview-error" role="alert">{previewError}</p>
        {:else}
            <pre class="preview-yaml">{previewYaml}</pre>
        {/if}

        {#snippet buttons()}
            <Button variant="tonal" onclick={closePreview}>Close</Button>
        {/snippet}
    </Dialog>
</div>

<style>
    .compose {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 12rem;
        height: 100%;
    }

    .compose > :global(.m3-container) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        height: 100%;
    }

    .compose-header {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-height: 2.5rem;
    }

    .compose-title {
        @apply --m3-title-small;
        margin: 0;
        color: var(--m3c-on-surface);
    }

    .compose-header-actions {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0.25rem;
    }

    .compose-status {
        display: grid;
        flex-shrink: 0;
        place-items: center;
        width: 3rem;
        height: 3rem;
        color: var(--m3c-primary);
    }

    .preview-status {
        display: flex;
        min-height: 12rem;
        align-items: center;
        justify-content: center;
    }

    .preview-error {
        @apply --m3-body-medium;
        margin: 0;
        color: var(--m3c-error);
    }

    .preview-yaml {
        @apply --m3-body-small;
        margin: 0;
        max-height: min(32rem, calc(100vh - 16rem));
        overflow: auto;
        padding: 1rem;
        border-radius: var(--m3-shape-medium);
        background-color: var(--m3c-surface-container);
        color: var(--m3c-on-surface);
        font-family: var(--m3-font-mono, ui-monospace, monospace);
        white-space: pre;
    }

    :global(#compose-preview-dialog.m3-container) {
        width: min(48rem, calc(100vw - 2rem));
        max-width: none;
    }

    .editor {
        position: relative;
        flex: 1;
        min-height: 0;
        margin: 0.5rem -1rem -1rem;
        overflow: hidden;
        border-radius: 0 0 var(--m3-shape-medium) var(--m3-shape-medium);
        background-color: transparent !important;
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

    .editor-status {
        position: absolute;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: transparent !important;
    }
</style>
