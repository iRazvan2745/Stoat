<script lang="ts">
    import { NuqsAdapter } from "nuqs-svelte/adapters/svelte-kit";

    import "./layout.css";

    let { children } = $props();
</script>

<svelte:head>
    <title>Stoat</title>
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="manifest" href="/site.webmanifest" />
</svelte:head>

<NuqsAdapter>
    <div class="bg-surface-container h-svh min-h-svh">
        {@render children()}
    </div>
</NuqsAdapter>
