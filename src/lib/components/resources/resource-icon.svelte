<script lang="ts">
    import widgetsIcon from "@ktibow/iconset-material-symbols/widgets-outline";
    import { Icon } from "m3-svelte";

    import { resolveResourceIcon } from "#lib/domain/resources/icon";

    let {
        alt = "",
        icon,
        size = 20,
        type,
    }: {
        alt?: string;
        icon: string | null | undefined;
        size?: number;
        type?: string | null;
    } = $props();

    let failedSrc = $state<string | null>(null);
    const src = $derived(resolveResourceIcon(icon, type));
    const showImage = $derived(Boolean(src) && failedSrc !== src);
</script>

{#if src && showImage}
    <img
        {src}
        {alt}
        class="object-contain"
        width={size}
        height={size}
        onerror={() => (failedSrc = src)}
    />
{:else}
    <Icon icon={widgetsIcon} {size} />
{/if}
