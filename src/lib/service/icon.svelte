<script lang="ts">
    import widgetsIcon from "@ktibow/iconset-material-symbols/widgets-outline";
    import { Icon } from "m3-svelte";

    import { resolveServiceIcon } from "#lib/service/icon";

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

    let failed = $state(false);
    const src = $derived(resolveServiceIcon(icon, type));
    const showImage = $derived(Boolean(src) && !failed);
</script>

{#if src && showImage}
    <img
        {src}
        {alt}
        class="object-contain"
        width={size}
        height={size}
        onerror={() => (failed = true)}
    />
{:else}
    <Icon icon={widgetsIcon} {size} />
{/if}
