<script lang="ts">
    import { NavigationRail } from "m3-svelte";
    import type { Snippet } from "svelte";

    import RailFooter from "#lib/components/rail-footer.svelte";

    interface User {
        email: string;
        image?: string | null;
        name: string;
    }

    interface Organization {
        id: string;
        logo: string | null;
        name: string;
        slug: string;
    }

    interface SidebarProps {
        activeOrganizationId?: string | null;
        children: Snippet;
        fab?: Snippet<[open: boolean]>;
        initialGravatarUrl?: string | null;
        initialUser?: User | null;
        organizations?: Organization[];
    }

    let {
        activeOrganizationId,
        children,
        fab,
        initialGravatarUrl,
        initialUser,
        organizations,
    }: SidebarProps = $props();

    let railOpen = $state(false);
</script>

<aside class="relative z-10 h-svh shrink-0">
    <NavigationRail bind:open={railOpen} {fab}>
        {@render children()}
    </NavigationRail>

    <RailFooter
        {activeOrganizationId}
        {initialGravatarUrl}
        {initialUser}
        {organizations}
        open={railOpen}
    />
</aside>
