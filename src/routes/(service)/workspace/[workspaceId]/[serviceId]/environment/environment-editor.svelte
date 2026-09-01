<script lang="ts">
    // oxlint-disable unicorn/prefer-regexp-test
    import {
        HighlightStyle,
        LanguageSupport,
        StreamLanguage,
    } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { LoadingIndicator } from "m3-svelte";
    import CodeMirror from "svelte-codemirror-editor";

    import { codeMirrorSearchExtensions } from "#lib/shared/ui/code-mirror-search";

    interface Props {
        value?: string;
    }

    let { value = $bindable("") }: Props = $props();
    let editorLoading = $state(true);

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
            backgroundColor:
                "color-mix(in srgb, var(--m3c-primary) 12%, transparent)",
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

<div
    class="relative min-h-72 overflow-hidden"
    aria-busy={editorLoading}
    aria-label="Environment file editor"
>
    <CodeMirror
        bind:value
        lang={dotenvLanguage}
        syntaxHighlighting={envSyntaxHighlighting}
        styles={editorStyles}
        extensions={codeMirrorSearchExtensions}
        foldGutter={false}
        closeBrackets={false}
        autocompletion={false}
        placeholder={"DATABASE_URL=postgres://localhost:5432/app"}
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
