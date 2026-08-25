<script lang="ts">
    import { goto } from "$app/navigation";
    import logoutIcon from "@ktibow/iconset-material-symbols/logout";
    import { ExpressiveMenu, ExpressiveMenuItem } from "m3-svelte";

    import { authClient } from "#lib/auth/client";
    import { getGravatarUrl } from "#lib/gravatar";

    interface User {
        email: string;
        image?: string | null;
        name: string;
    }

    const {
        open,
        initialUser,
        initialGravatarUrl,
    }: {
        initialGravatarUrl?: string | null;
        initialUser?: User | null;
        open: boolean;
    } = $props();

    const session = authClient.useSession();
    const user = $derived(
        $session.isPending
            ? (initialUser ?? $session.data?.user)
            : $session.data?.user
    );

    let menuOpen = $state(false);
    let root = $state<HTMLDivElement>();

    const closeOnOutsideClick = ({ target }: MouseEvent): void => {
        if (target instanceof Node && !root?.contains(target)) {
            menuOpen = false;
        }
    };

    const logout = async (): Promise<void> => {
        menuOpen = false;
        await authClient.signOut();
        await goto("/login", { replaceState: true });
    };
</script>

<svelte:window onclick={closeOnOutsideClick} />

<div class="absolute inset-x-0 bottom-2 z-20 flex justify-center px-3">
    <div bind:this={root} class="relative {open ? 'w-full' : ''}">
        <button
            type="button"
            class="flex items-center gap-3 rounded-full p-1 text-start {open
                ? 'w-full'
                : ''}"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={user?.name}
            onclick={() => (menuOpen = !menuOpen)}
        >
            {#if user?.image}
                <img
                    src={user.image}
                    alt=""
                    class="size-10 shrink-0 rounded-full object-cover"
                />
            {:else if user?.email && $session.isPending && initialGravatarUrl}
                <img
                    src={initialGravatarUrl}
                    alt=""
                    class="size-10 shrink-0 rounded-full object-cover"
                />
            {:else if user?.email}
                {#await getGravatarUrl(user.email) then src}
                    <img
                        {src}
                        alt=""
                        class="size-10 shrink-0 rounded-full object-cover"
                    />
                {/await}
            {:else if $session.isPending}
                <span
                    class="bg-secondary-container text-on-secondary-container grid size-10 shrink-0 place-items-center rounded-full text-sm font-medium"
                    aria-hidden="true"
                ></span>
            {:else}
                <span
                    class="bg-secondary-container text-on-secondary-container grid size-10 shrink-0 place-items-center rounded-full text-sm font-medium"
                >
                    {user?.name?.charAt(0) ?? "?"}
                </span>
            {/if}

            {#if open}
                <span class="flex min-w-0 flex-col">
                    <span class="text-on-surface truncate text-sm font-medium">
                        {user?.name}
                    </span>
                    <span class="text-on-surface-variant truncate text-xs">
                        {user?.email}
                    </span>
                </span>
            {/if}
        </button>

        {#if menuOpen}
            <div class="absolute bottom-0 left-[calc(100%+4px)]">
                <ExpressiveMenu label={user?.name ?? "Account"}>
                    <ExpressiveMenuItem
                        leadingIcon={logoutIcon}
                        label="Log out"
                        onclick={logout}
                    />
                </ExpressiveMenu>
            </div>
        {/if}
    </div>
</div>
