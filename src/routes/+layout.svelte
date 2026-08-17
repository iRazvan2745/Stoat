<script lang="ts">
    import { NuqsAdapter } from "nuqs-svelte/adapters/svelte-kit";

    import favicon from "#lib/assets/favicon.svg";

    import "./layout.css";

    let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<NuqsAdapter>
    <div class="bg-surface-container">
        {@render children()}
    </div>
</NuqsAdapter>
