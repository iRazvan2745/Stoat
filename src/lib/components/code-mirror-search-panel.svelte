<script lang="ts">
    import closeIcon from "@ktibow/iconset-material-symbols/close";
    import findInPageIcon from "@ktibow/iconset-material-symbols/find-in-page";
    import findReplaceIcon from "@ktibow/iconset-material-symbols/find-replace";
    import keyboardArrowDownIcon from "@ktibow/iconset-material-symbols/keyboard-arrow-down";
    import keyboardArrowUpIcon from "@ktibow/iconset-material-symbols/keyboard-arrow-up";
    import selectAllIcon from "@ktibow/iconset-material-symbols/select-all";
    import { Button, Checkbox, Icon, TextFieldOutlined } from "m3-svelte";

    import type { SearchPanelQuery } from "#lib/shared/ui/code-mirror-search";

    interface Props {
        initialQuery: SearchPanelQuery;
        onQueryChange: (query: SearchPanelQuery) => void;
        onNext: () => void;
        onPrevious: () => void;
        onSelectMatches: () => void;
        onReplace: () => void;
        onReplaceAll: () => void;
        onClose: () => void;
        readOnly: boolean;
    }

    let {
        initialQuery,
        onQueryChange,
        onNext,
        onPrevious,
        onSelectMatches,
        onReplace,
        onReplaceAll,
        onClose,
        readOnly,
    }: Props = $props();

    // These values intentionally seed local form state; the panel synchronizes
    // later changes through the exported setQuery method.
    // svelte-ignore state_referenced_locally
    let search = $state(initialQuery.search);
    // svelte-ignore state_referenced_locally
    let replace = $state(initialQuery.replace);
    // svelte-ignore state_referenced_locally
    let caseSensitive = $state(initialQuery.caseSensitive);
    // svelte-ignore state_referenced_locally
    let literal = $state(initialQuery.literal);
    // svelte-ignore state_referenced_locally
    let regexp = $state(initialQuery.regexp);
    // svelte-ignore state_referenced_locally
    let wholeWord = $state(initialQuery.wholeWord);

    const currentQuery = (): SearchPanelQuery => ({
        caseSensitive,
        literal,
        regexp,
        replace,
        search,
        wholeWord,
    });

    const commit = (): void => {
        onQueryChange(currentQuery());
    };

    const updateText =
        (field: "search" | "replace") =>
        (event: Event): void => {
            const { currentTarget } = event;

            if (!(currentTarget instanceof HTMLInputElement)) {
                return;
            }

            if (field === "search") {
                search = currentTarget.value;
            } else {
                replace = currentTarget.value;
            }

            commit();
        };

    const updateOption =
        (option: "caseSensitive" | "regexp" | "wholeWord") =>
        (event: Event): void => {
            const { currentTarget } = event;

            if (!(currentTarget instanceof HTMLInputElement)) {
                return;
            }

            if (option === "caseSensitive") {
                caseSensitive = currentTarget.checked;
            } else if (option === "regexp") {
                regexp = currentTarget.checked;
            } else {
                wholeWord = currentTarget.checked;
            }

            commit();
        };

    export function setQuery(query: SearchPanelQuery): void {
        const {
            caseSensitive: nextCaseSensitive,
            literal: nextLiteral,
            regexp: nextRegexp,
            replace: nextReplace,
            search: nextSearch,
            wholeWord: nextWholeWord,
        } = query;

        search = nextSearch;
        replace = nextReplace;
        caseSensitive = nextCaseSensitive;
        literal = nextLiteral;
        regexp = nextRegexp;
        wholeWord = nextWholeWord;
    }
</script>

<div
    class="bg-surface-container text-on-surface box-border flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
    role="search"
    aria-label="Find in editor"
>
    <div
        class="flex flex-[1_1_30rem] flex-wrap gap-2 min-w-[min(100%,30rem)] max-[60rem]:min-w-full max-[60rem]:basis-full max-[40rem]:w-full"
    >
        <div class="search-field min-w-[min(15rem,100%)] flex-[1_1_15rem]">
            <TextFieldOutlined
                label="Find"
                name="search"
                autocomplete="off"
                spellcheck={false}
                leadingIcon={findInPageIcon}
                value={search}
                oninput={updateText("search")}
            />
        </div>

        {#if !readOnly}
            <div
                class="search-field min-w-[min(15rem,100%)] flex-[1_1_15rem]"
            >
                <TextFieldOutlined
                    label="Replace"
                    name="replace"
                    autocomplete="off"
                    spellcheck={false}
                    leadingIcon={findReplaceIcon}
                    value={replace}
                    oninput={updateText("replace")}
                />
            </div>
        {/if}
    </div>

    <div
        class="flex flex-[0_1_auto] flex-wrap items-center gap-1 max-[40rem]:w-full"
        role="group"
        aria-label="Search actions"
    >
        <Button variant="text" size="s" iconType="left" onclick={onPrevious}>
            <Icon icon={keyboardArrowUpIcon} />
            Previous
        </Button>
        <Button variant="text" size="s" iconType="left" onclick={onNext}>
            <Icon icon={keyboardArrowDownIcon} />
            Next
        </Button>
        <Button
            variant="text"
            size="s"
            iconType="left"
            onclick={onSelectMatches}
        >
            <Icon icon={selectAllIcon} />
            All
        </Button>

        {#if !readOnly}
            <Button variant="text" size="s" iconType="left" onclick={onReplace}>
                <Icon icon={findReplaceIcon} />
                Replace
            </Button>
            <Button
                variant="text"
                size="s"
                iconType="left"
                onclick={onReplaceAll}
            >
                <Icon icon={findReplaceIcon} />
                Replace all
            </Button>
        {/if}
    </div>

    <div
        class="flex flex-[0_1_auto] flex-wrap items-center gap-y-1 gap-x-3 max-[40rem]:w-full"
        role="group"
        aria-label="Search options"
    >
        <label
            class="option m3-font-label-large text-on-surface-variant inline-flex min-h-10 cursor-pointer items-center gap-1 whitespace-nowrap"
        >
            <Checkbox>
                <input
                    type="checkbox"
                    name="case"
                    checked={caseSensitive}
                    onchange={updateOption("caseSensitive")}
                />
            </Checkbox>
            <span>Match case</span>
        </label>
        <label
            class="option m3-font-label-large text-on-surface-variant inline-flex min-h-10 cursor-pointer items-center gap-1 whitespace-nowrap"
        >
            <Checkbox>
                <input
                    type="checkbox"
                    name="regexp"
                    checked={regexp}
                    onchange={updateOption("regexp")}
                />
            </Checkbox>
            <span>Regex</span>
        </label>
        <label
            class="option m3-font-label-large text-on-surface-variant inline-flex min-h-10 cursor-pointer items-center gap-1 whitespace-nowrap"
        >
            <Checkbox>
                <input
                    type="checkbox"
                    name="whole-word"
                    checked={wholeWord}
                    onchange={updateOption("wholeWord")}
                />
            </Checkbox>
            <span>Whole word</span>
        </label>
    </div>

    <div class="ms-auto max-[40rem]:ms-0">
        <Button
            variant="text"
            size="s"
            iconType="full"
            square
            aria-label="Close search"
            title="Close search"
            onclick={onClose}
        >
            <Icon icon={closeIcon} />
        </Button>
    </div>
</div>

<style>
    .search-field {
        --m3v-background: var(--m3c-surface-container);

        :global(.m3-container) {
            width: 100%;
            min-width: 0;
        }
    }

    .option {
        :global(.m3-container) {
            flex: 0 0 1.125rem;
        }
    }
</style>
