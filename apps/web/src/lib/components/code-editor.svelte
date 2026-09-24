<script lang="ts">
    import { minimalSetup } from "codemirror";
    import { Compartment, EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
    import { Decoration, EditorView, lineNumbers } from "@codemirror/view";
    import { yaml } from "@codemirror/lang-yaml";
    import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { onMount } from "svelte";

    let { value = $bindable(""), language = "yaml", label = "Docker Compose YAML", hideEnvValues = false, readOnly = false }: { value?: string; language?: "yaml" | "env"; label?: string; hideEnvValues?: boolean; readOnly?: boolean } = $props();

    let container: HTMLDivElement;

    let editor = $state<EditorView>();

    const editability = new Compartment();

    function envDecorations(state: EditorState) {
        const ranges = new RangeSetBuilder<Decoration>();
        const mark = Decoration.mark({ class: "cm-env-value" });
        let quote = "";

        for (let n = 1; n <= state.doc.lines; n++) {
            const line = state.doc.line(n);
            let start = 0;
            let scan = 0;

            if (!quote) {
                const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/.exec(line.text);

                if (!assignment) continue;
                start = assignment[0].length;
                scan = start;

                while (/\s/.test(line.text[scan] ?? "") && scan < line.text.length) scan++;
                const first = line.text[scan];

                if (first === '"' || first === "'" || first === "`") {
                    quote = first;
                    scan++;
                }
            }

            // Continuation lines belong to the quoted value, even when they resemble assignments.
            if (start < line.length) ranges.add(line.from + start, line.to, mark);

            if (quote) {
                let escaped = false;

                for (; scan < line.text.length; scan++) {
                    const char = line.text[scan];

                    if (escaped) escaped = false;
                    else if (char === "\\") escaped = true;
                    else if (char === quote) {
                        quote = "";
                        break;
                    }
                }
            }
        }

        return ranges.finish();
    }

    const envValues = StateField.define({
        create: envDecorations,
        update: (decorations, transaction) => transaction.docChanged ? envDecorations(transaction.state) : decorations,
        provide: (field) => EditorView.decorations.from(field),
    });

    onMount(() => {
        const view = new EditorView({
            parent: container,
            doc: value,
            extensions: [
                minimalSetup,
                editability.of([
                    EditorState.readOnly.of(readOnly),
                    EditorView.editable.of(!readOnly),
                    EditorView.contentAttributes.of({ "aria-readonly": String(readOnly), tabindex: "0" }),
                ]),
                lineNumbers(),
                language === "yaml" ? yaml() : envValues,
                syntaxHighlighting(HighlightStyle.define([
                    { tag: tags.propertyName, color: "color-mix(in srgb, var(--chart-1) 45%, var(--code-foreground))" },
                    { tag: tags.string, color: "color-mix(in srgb, var(--chart-2) 60%, var(--code-foreground))" },
                    { tag: [tags.number, tags.bool, tags.null], color: "color-mix(in srgb, var(--chart-3) 55%, var(--code-foreground))" },
                    { tag: [tags.keyword, tags.meta, tags.typeName], color: "color-mix(in srgb, var(--chart-4) 45%, var(--code-foreground))" },
                    { tag: [tags.comment, tags.punctuation], color: "var(--muted-foreground)" },
                ])),
                EditorState.tabSize.of(2),
                EditorView.contentAttributes.of({ "aria-label": label }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) value = update.state.doc.toString();
                }),
                EditorView.theme({
                    "&": { backgroundColor: "transparent", color: "var(--code-foreground)" },
                    "&.cm-focused": { outline: "none" },
                    ".cm-scroller": {
                        fontFamily: "var(--font-mono)",
                        fontSize: "13px",
                        lineHeight: "24px",
                        minHeight: "22rem",
                        maxHeight: "32rem",
                        overflow: "auto",
                    },
                    ".cm-content": { padding: "16px 0", caretColor: "var(--primary)" },
                    ".cm-gutters": {
                        backgroundColor: "transparent",
                        color: "var(--muted-foreground)",
                        borderRight: "1px solid var(--border)",
                    },
                    ".cm-cursor": { borderLeftColor: "var(--primary)" },
                    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
                        backgroundColor: "color-mix(in srgb, var(--primary) 25%, transparent)",
                    },
                }),
            ],
        });

        editor = view;

        return () => view.destroy();
    });

    $effect(() => {
        editor?.dispatch({ effects: editability.reconfigure([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            EditorView.contentAttributes.of({ "aria-readonly": String(readOnly), tabindex: "0" }),
        ]) });
    });

    $effect(() => {
        if (editor && value !== editor.state.doc.toString()) {
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
        }
    });
</script>

<div bind:this={container} class:hide-env-values={language === "env" && hideEnvValues}></div>

<style>
    .hide-env-values :global(.cm-env-value) {
        filter: blur(5px);
    }
</style>
