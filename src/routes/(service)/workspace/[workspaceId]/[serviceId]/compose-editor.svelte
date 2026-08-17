<script lang="ts">
    import { yaml } from "@codemirror/lang-yaml";
    import { HighlightStyle } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { Button, Card, LoadingIndicator } from "m3-svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import { updateCompose } from "#lib/api/services.remote";

    interface Props {
        initialCompose?: string | null;
        serviceId: string;
    }

    let { initialCompose = "", serviceId }: Props = $props();

    // The editor keeps its own draft after the service has loaded.
    // svelte-ignore state_referenced_locally
    let compose = $state(initialCompose ?? "");
    let editorLoading = $state(true);
    let saving = $state(false);
    const composeLanguage = yaml();

    const editorStyles = {
        "&": {
            backgroundColor: "var(--m3c-surface-container-low)",
            color: "var(--m3c-on-surface)",
            minHeight: "18rem",
        },
        "&.cm-focused .cm-selectionBackground, ::selection": {
            backgroundColor: "var(--m3c-primary-container)",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: "var(--m3c-surface-container-high)",
        },
        ".cm-content": { padding: "1rem 0" },
        ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--m3c-primary)",
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

    const composeSyntaxHighlighting = {
        fallback: true,
        highlighter: HighlightStyle.define([
            {
                color: "var(--m3c-on-surface-variant)",
                fontStyle: "italic",
                tag: tags.comment,
            },
            {
                color: "var(--m3c-primary)",
                tag: [tags.propertyName, tags.definition(tags.variableName)],
            },
            {
                color: "var(--m3c-tertiary)",
                tag: [tags.string, tags.special(tags.string)],
            },
            {
                color: "var(--m3c-secondary)",
                tag: [tags.number, tags.bool, tags.atom],
            },
            {
                color: "var(--m3c-on-surface-variant)",
                tag: [tags.operator, tags.punctuation, tags.bracket],
            },
        ]),
    };

    const handleEditorReady = (): void => {
        editorLoading = false;
    };

    const save = async (): Promise<void> => {
        if (saving) {
            return;
        }

        saving = true;

        try {
            await updateCompose({ compose, id: serviceId });
        } finally {
            saving = false;
        }
    };
</script>

<Card variant="outlined">
    <p class="text-on-surface-variant mb-2 text-sm">Compose YAML</p>

    <div
        class="relative min-h-72"
        aria-busy={editorLoading || saving}
        aria-label="Compose YAML editor"
    >
        <CodeMirror
            bind:value={compose}
            lang={composeLanguage}
            syntaxHighlighting={composeSyntaxHighlighting}
            styles={editorStyles}
            onready={handleEditorReady}
        />

        {#if editorLoading || saving}
            <div
                class="bg-surface-container-low absolute inset-0 z-10 flex items-center justify-center"
                role="status"
            >
                <LoadingIndicator
                    aria-label={editorLoading
                        ? "Loading code editor"
                        : "Saving compose"}
                />
            </div>
        {/if}
    </div>

    <div class="mt-2 flex justify-end">
        <Button disabled={saving} onclick={save}>
            {#if saving}
                <LoadingIndicator
                    size={20}
                    center={false}
                    aria-label="Saving compose"
                />
                Saving...
            {:else}
                Save
            {/if}
        </Button>
    </div>
</Card>
