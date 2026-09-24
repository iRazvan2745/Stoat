<script lang="ts">
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { authClient } from "$lib/auth-client";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar";
    import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel, MenuLinkItem, MenuItem, MenuSeparator } from "$lib/components/ui/menu";
    import { sidebarMenuButtonVariants } from "$lib/components/ui/sidebar/sidebar-menu-button.svelte";
    import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
    import UserIcon from "@lucide/svelte/icons/user";
    import LogOut from "@lucide/svelte/icons/log-out";
    import { watch } from "runed";

    let { user }: { user: { name: string; email: string; image?: string | null } } = $props();

    const sidebar = useSidebar();

    let open = $state(false);

    function closeMenu() { open = false; sidebar.setOpenMobile(false); }

    // Link items don't auto-close, and SPA navigation keeps the layout (and
    // its portals) mounted, so close on every route change as a fallback.
    const pathname = $derived(page.url.pathname);

    watch(
        () => pathname,
        (currentPathname) => {
            // Track the route so an open menu never survives navigation.
            if (currentPathname) open = false;
        },
    );

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    onMount(() => { ready = true; });

    const initials = $derived(user.name.trim().slice(0, 2).toUpperCase() || user.email.slice(0, 2).toUpperCase());

    async function signOut() {
        if (pending) return;
        pending = true;
        error = "";

        try {
            const result = await authClient.signOut();

            if (result.error) { error = result.error.message ?? "Unable to log out.";

 return; }

            window.location.assign("/login");
        } catch { error = "Unable to connect. Try again."; }
        finally { pending = false; }
    }
</script>

{#snippet identity(collapsible = false)}
    <Avatar class={collapsible ? "size-8 rounded-lg group-data-[collapsible=icon]:size-6" : "size-8"}>
        {#if user.image}<AvatarImage src={user.image} alt="" />{/if}
        <AvatarFallback class={collapsible ? "rounded-lg" : ""}>{initials}</AvatarFallback>
    </Avatar>
    <div class={"grid min-w-0 flex-1 text-left text-sm leading-tight " + (collapsible ? "group-data-[collapsible=icon]:hidden" : "")}>
        <span class="truncate font-semibold">{user.name}</span>
        <span class="truncate text-xs">{user.email}</span>
    </div>
{/snippet}

<Menu bind:open>
    <MenuTrigger
        class={sidebarMenuButtonVariants({ size: "lg", class: "data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center" })}
        disabled={!ready || pending}
        aria-label={pending ? "Logging out" : `Account menu for ${user.name}`}
        title={`${user.name} (${user.email})`}
    >
        {@render identity(true)}
        <ChevronsUpDown class="ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" aria-hidden="true" />
    </MenuTrigger>
    <MenuPopup class="w-(--anchor-width) min-w-56 max-w-[calc(100vw-2rem)]" side="bottom" align="end" sideOffset={4}>
        <MenuGroup>
            <MenuGroupLabel class="p-0 font-normal text-foreground">
                <div class="flex items-center gap-2 px-1 py-1.5">{@render identity()}</div>
            </MenuGroupLabel>
            <MenuSeparator />
            <MenuLinkItem closeOnClick onclick={closeMenu} href="/settings"><UserIcon aria-hidden="true" />Settings</MenuLinkItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem variant="destructive" disabled={pending} onclick={signOut}><LogOut aria-hidden="true" />Log out</MenuItem>
    </MenuPopup>
</Menu>
{#if error}
    <Alert variant="error" class="mx-2 p-2 text-xs">
        <AlertDescription>{error}</AlertDescription>
    </Alert>
{/if}
