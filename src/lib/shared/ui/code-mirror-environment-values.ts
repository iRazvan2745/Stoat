import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

interface EnvironmentValueRange {
    from: number;
    to: number;
}

class MaskedEnvironmentValue extends WidgetType {
    private readonly characterCount: number;

    constructor(characterCount: number) {
        super();
        this.characterCount = characterCount;
    }

    override eq(other: WidgetType): boolean {
        return (
            other instanceof MaskedEnvironmentValue && other.characterCount === this.characterCount
        );
    }

    override toDOM(): HTMLElement {
        const element = document.createElement("span");
        element.className = "cm-env-masked-value";
        element.textContent = "•".repeat(this.characterCount);
        element.setAttribute("aria-label", "Hidden environment value");
        element.title = "Click to edit";
        return element;
    }

    // oxlint-disable-next-line class-methods-use-this
    override ignoreEvent(): boolean {
        return false;
    }
}

const environmentValueRanges = (view: EditorView): EnvironmentValueRange[] => {
    const ranges: EnvironmentValueRange[] = [];

    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        const leadingWhitespace = line.text.search(/\S|$/u);
        const candidate = line.text.slice(leadingWhitespace);

        if (candidate === "" || candidate.startsWith("#")) {
            continue;
        }

        const assignmentStart = candidate.startsWith("export ")
            ? leadingWhitespace + "export ".length
            : leadingWhitespace;
        const assignment = line.text.slice(assignmentStart);
        const separatorIndex = assignment.indexOf("=");

        if (separatorIndex === -1) {
            continue;
        }

        const from = line.from + assignmentStart + separatorIndex + 1;

        if (from < line.to) {
            ranges.push({ from, to: line.to });
        }
    }

    return ranges;
};

const isEnvironmentValueBeingEdited = (
    view: EditorView,
    valueRange: EnvironmentValueRange,
): boolean => {
    if (!view.hasFocus) {
        return false;
    }

    return view.state.selection.ranges.some((selection) => {
        if (selection.empty) {
            return selection.from >= valueRange.from && selection.from <= valueRange.to;
        }

        return selection.from < valueRange.to && selection.to > valueRange.from;
    });
};

const createDecorations = (view: EditorView, showValues: boolean): DecorationSet => {
    if (showValues) {
        return Decoration.none;
    }

    const decorations = environmentValueRanges(view)
        .filter((valueRange) => !isEnvironmentValueBeingEdited(view, valueRange))
        .map((valueRange) =>
            Decoration.replace({
                widget: new MaskedEnvironmentValue(valueRange.to - valueRange.from),
            }).range(valueRange.from, valueRange.to),
        );

    return Decoration.set(decorations);
};

export function maskEnvironmentValues(showValues: boolean) {
    return ViewPlugin.define(
        (view) => {
            const plugin = {
                decorations: createDecorations(view, showValues),
                update(update: ViewUpdate): void {
                    if (update.docChanged || update.selectionSet || update.focusChanged) {
                        plugin.decorations = createDecorations(update.view, showValues);
                    }
                },
            };

            return plugin;
        },
        {
            decorations: (plugin) => plugin.decorations,
        },
    );
}
