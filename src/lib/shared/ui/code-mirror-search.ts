import {
    SearchQuery,
    closeSearchPanel,
    findNext,
    findPrevious,
    getSearchQuery,
    replaceAll,
    replaceNext,
    search,
    selectMatches,
    setSearchQuery,
} from "@codemirror/search";
import type { Panel, ViewUpdate } from "@codemirror/view";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { ComponentProps } from "svelte";
import { mount, unmount } from "svelte";

import CodeMirrorSearchPanel from "#lib/components/code-mirror-search-panel.svelte";

export interface SearchPanelQuery {
    search: string;
    replace: string;
    caseSensitive: boolean;
    literal: boolean;
    regexp: boolean;
    wholeWord: boolean;
}

interface CodeMirrorSearchPanelExports {
    setQuery: (query: SearchPanelQuery) => void;
}

type CodeMirrorSearchPanelProps = ComponentProps<typeof CodeMirrorSearchPanel>;

const toPanelQuery = (query: SearchQuery): SearchPanelQuery => ({
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    replace: query.replace,
    search: query.search,
    wholeWord: query.wholeWord,
});

const createM3SearchPanel = (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "stoat-search-panel";

    let panel: CodeMirrorSearchPanelExports | undefined = mount<
        CodeMirrorSearchPanelProps,
        CodeMirrorSearchPanelExports
    >(CodeMirrorSearchPanel, {
        props: {
            initialQuery: toPanelQuery(getSearchQuery(view.state)),
            onClose: () => closeSearchPanel(view),
            onNext: () => findNext(view),
            onPrevious: () => findPrevious(view),
            onQueryChange: (query: SearchPanelQuery) => {
                const nextQuery = new SearchQuery(query);

                if (!nextQuery.eq(getSearchQuery(view.state))) {
                    view.dispatch({
                        effects: setSearchQuery.of(nextQuery),
                    });
                }
            },
            onReplace: () => replaceNext(view),
            onReplaceAll: () => replaceAll(view),
            onSelectMatches: () => selectMatches(view),
            readOnly: view.state.readOnly,
        },
        target: dom,
    });
    dom.querySelector('input[name="search"]')?.setAttribute("main-field", "true");

    const onKeydown = (event: KeyboardEvent): void => {
        if (runScopeHandlers(view, event, "search-panel")) {
            event.preventDefault();
            return;
        }

        if (event.key !== "Enter") {
            return;
        }

        if (event.target === dom.querySelector("[main-field]")) {
            event.preventDefault();
            (event.shiftKey ? findPrevious : findNext)(view);
            return;
        }

        if (event.target === dom.querySelector('input[name="replace"]')) {
            event.preventDefault();
            replaceNext(view);
        }
    };

    dom.addEventListener("keydown", onKeydown);

    return {
        destroy() {
            dom.removeEventListener("keydown", onKeydown);
            const mountedPanel = panel;
            panel = undefined;

            if (mountedPanel) {
                void unmount(mountedPanel);
            }
        },
        dom,
        update(update: ViewUpdate) {
            panel?.setQuery(toPanelQuery(getSearchQuery(update.state)));
        },
    };
};

const m3SearchTheme = EditorView.theme({
    ".cm-panel.stoat-search-panel": {
        backgroundColor: "var(--m3c-surface-container) !important",
        borderTop: "1px solid var(--m3c-outline-variant) !important",
        color: "var(--m3c-on-surface) !important",
        padding: "0 !important",
    },
    ".cm-searchMatch": {
        backgroundColor: "var(--m3c-tertiary-container-subtle) !important",
    },
    ".cm-searchMatch-selected": {
        backgroundColor: "var(--m3c-primary-container) !important",
        color: "var(--m3c-on-primary-container) !important",
    },
});

export const codeMirrorSearchExtensions = [
    m3SearchTheme,
    search({ createPanel: createM3SearchPanel }),
];
