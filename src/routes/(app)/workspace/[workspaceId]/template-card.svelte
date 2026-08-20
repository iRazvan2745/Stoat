<script lang="ts">
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import chevronRightIcon from "@ktibow/iconset-material-symbols/chevron-right";
    import { Icon } from "m3-svelte";

    import type { ServiceTemplate } from "#lib/templates";

    interface Props {
        selected: boolean;
        template: ServiceTemplate;
        onclick: () => void;
    }

    let { selected, template, onclick }: Props = $props();

    const version = $derived(template.versions[0]?.version ?? "latest");

    let failedLogoSrc = $state<string | null>(null);

    const showLogo = $derived(
        Boolean(template.logoSrc) && template.logoSrc !== failedLogoSrc
    );
</script>

<button
    type="button"
    class={[
        "template-card flex h-full min-h-64 cursor-pointer flex-col items-start gap-3 rounded-[1.25rem] border p-5 text-left",
        selected
            ? "border-primary bg-primary-container-subtle"
            : "border-outline-variant bg-surface-container hover:bg-surface-container-high",
    ]}
    aria-pressed={selected}
    {onclick}
>
    <div class="flex items-center gap-2">
        {#if template.logoSrc && showLogo}
            <img
                src={template.logoSrc}
                alt=""
                class="size-16 shrink-0 rounded-lg object-contain"
                onerror={() => (failedLogoSrc = template.logoSrc)}
            />
        {:else}
            <div
                class="bg-primary-container text-on-primary-container grid size-10 shrink-0 place-items-center rounded-lg"
                aria-hidden="true"
            >
                <Icon icon={addIcon} size={24} />
            </div>
        {/if}

        <h3 class="name text-on-surface m-0">
            {template.name}
        </h3>
    </div>

    <p class="description text-on-surface-variant m-0 line-clamp-3 flex-1">
        {template.description}
    </p>

    {#if template.tags.length > 0}
        <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {#each template.tags as tag (tag)}
                <li
                    class="tag bg-secondary-container text-on-secondary-container rounded-full px-[0.55rem] py-[0.2rem]"
                >
                    {tag}
                </li>
            {/each}
        </ul>
    {/if}

    <div
        class="text-on-surface-variant mt-auto flex w-full items-center justify-between"
    >
        <span class="m3-font-label-medium">{version}</span>
        <Icon icon={chevronRightIcon} size={18} />
    </div>
</button>

<style>
    .template-card {
        color: var(--m3c-on-surface);
        @apply --m3-focus-inward;
    }

    .name {
        @apply --m3-title-medium;
    }

    .description {
        @apply --m3-body-medium;
    }

    .tag {
        @apply --m3-label-small;
    }
</style>
