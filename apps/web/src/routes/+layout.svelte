<script lang="ts">
    import { queryClient } from '$lib/orpc';
    import { QueryClientProvider } from '@tanstack/svelte-query';
    import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
    import { NuqsAdapter } from 'nuqs-svelte/adapters/svelte-kit';
    import '../app.css';

	const { children } = $props();
</script>

<QueryClientProvider client={queryClient}>
    <NuqsAdapter>
		{@render children()}
    </NuqsAdapter>
    <SvelteQueryDevtools />
</QueryClientProvider>
