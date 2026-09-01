<script lang="ts">
    import { invalidateAll } from "$app/navigation";
    import addBusinessIcon from "@ktibow/iconset-material-symbols/add-business";
    import checkIcon from "@ktibow/iconset-material-symbols/check";
    import domainIcon from "@ktibow/iconset-material-symbols/domain";
    import expandMoreIcon from "@ktibow/iconset-material-symbols/expand-more";
    import {
        Button,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuGroup,
        ExpressiveMenuItem,
        Icon,
        MenuDivider,
        Snackbar,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";

    import { authClient } from "#lib/auth/client";

    interface Organization {
        id: string;
        logo: string | null;
        name: string;
        slug: string;
    }

    const {
        activeOrganizationId,
        mode = "trigger",
        organizations,
        onClose,
    }: {
        activeOrganizationId: string | null;
        mode?: "menu" | "trigger";
        organizations: Organization[];
        onClose?: () => void;
    } = $props();

    let createDialogOpen = $state(false);
    let creating = $state(false);
    let menuOpen = $state(false);
    let name = $state("");
    let root = $state<HTMLDivElement>();
    let switchingOrganizationId = $state<string | null>(null);

    const activeOrganization = $derived(
        organizations.find(
            (organization) => organization.id === activeOrganizationId
        ) ?? organizations[0]
    );
    const organizationInitial = $derived(
        activeOrganization?.name.trim().charAt(0).toUpperCase() ?? "S"
    );

    const closeOnOutsideClick = ({ target }: MouseEvent): void => {
        if (target instanceof Node && !root?.contains(target)) {
            menuOpen = false;
        }
    };

    const handleKeydown = ({ key }: KeyboardEvent): void => {
        if (key === "Escape") {
            menuOpen = false;
            onClose?.();
        }
    };

    const closeMenu = (): void => {
        menuOpen = false;
        onClose?.();
    };

    const slugify = (value: string): string => {
        const slug = value
            .toLowerCase()
            .normalize("NFKD")
            .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
            .replaceAll(/^-+|-+$/gu, "")
            .slice(0, 24);

        return `${slug || "organization"}-${crypto.randomUUID().slice(0, 8)}`;
    };

    const switchOrganization = async (
        organizationId: string
    ): Promise<void> => {
        if (
            organizationId === activeOrganizationId ||
            switchingOrganizationId !== null
        ) {
            closeMenu();
            return;
        }

        switchingOrganizationId = organizationId;

        try {
            const { error } = await authClient.organization.setActive({
                organizationId,
            });

            if (error) {
                snackbar(error.message ?? "Unable to switch organization");
                return;
            }

            closeMenu();
            await invalidateAll();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to switch organization"
            );
        } finally {
            switchingOrganizationId = null;
        }
    };

    const openCreateDialog = (): void => {
        menuOpen = false;
        createDialogOpen = true;
    };

    const closeCreateDialog = (): void => {
        createDialogOpen = false;
        onClose?.();
    };

    const createOrganization = async (): Promise<void> => {
        const organizationName = name.trim();

        if (!organizationName || creating) {
            return;
        }

        creating = true;

        try {
            const { error } = await authClient.organization.create({
                name: organizationName,
                slug: slugify(organizationName),
            });

            if (error) {
                snackbar(error.message ?? "Unable to create organization");
                return;
            }

            name = "";
            createDialogOpen = false;
            onClose?.();
            snackbar("Organization created");
            await invalidateAll();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create organization"
            );
        } finally {
            creating = false;
        }
    };

    const handleCreateSubmit = async (event: SubmitEvent): Promise<void> => {
        event.preventDefault();
        await createOrganization();
    };
</script>

<svelte:window onclick={closeOnOutsideClick} onkeydown={handleKeydown} />

{#if mode === "menu"}
    <ExpressiveMenuGroup>
        {#each organizations as organization (organization.id)}
            <ExpressiveMenuItem
                leadingIcon={domainIcon}
                trailingIcon={organization.id === activeOrganization?.id
                    ? checkIcon
                    : undefined}
                label={organization.name}
                details={organization.slug}
                selected={organization.id === activeOrganization?.id}
                disabled={switchingOrganizationId !== null}
                onclick={() => switchOrganization(organization.id)}
            />
        {/each}
    </ExpressiveMenuGroup>
    <MenuDivider />
    <ExpressiveMenuItem
        leadingIcon={addBusinessIcon}
        label="Create organization"
        onclick={openCreateDialog}
    />
{:else}
    <div bind:this={root} class="organization-picker">
        <button
            type="button"
            class="organization-trigger m3-layer"
            style="anchor-name: --m3-menu-anchor"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Organization: ${activeOrganization?.name ?? "Stoat"}`}
            onclick={() => (menuOpen = !menuOpen)}
        >
            <span class="organization-avatar" aria-hidden="true">
                {#if activeOrganization?.logo}
                    <img src={activeOrganization.logo} alt="" />
                {:else}
                    {organizationInitial}
                {/if}
            </span>

            <span class="organization-copy">
                <span class="organization-label">Organization</span>
                <span class="organization-name">
                    {activeOrganization?.name ?? "Stoat"}
                </span>
            </span>
            <Icon icon={expandMoreIcon} size={20} />
        </button>

        {#if menuOpen}
            <div class="organization-menu">
                <ExpressiveMenu anchored x="end" y="down" label="Organizations">
                    <ExpressiveMenuGroup>
                        {#each organizations as organization (organization.id)}
                            <ExpressiveMenuItem
                                leadingIcon={domainIcon}
                                trailingIcon={organization.id ===
                                activeOrganization?.id
                                    ? checkIcon
                                    : undefined}
                                label={organization.name}
                                details={organization.slug}
                                selected={organization.id ===
                                    activeOrganization?.id}
                                disabled={switchingOrganizationId !== null}
                                onclick={() =>
                                    switchOrganization(organization.id)}
                            />
                        {/each}
                    </ExpressiveMenuGroup>
                    <MenuDivider />
                    <ExpressiveMenuItem
                        leadingIcon={addBusinessIcon}
                        label="Create organization"
                        onclick={openCreateDialog}
                    />
                </ExpressiveMenu>
            </div>
        {/if}
    </div>
{/if}

<Dialog bind:open={createDialogOpen} headline="Create organization">
    <form class="create-form" onsubmit={handleCreateSubmit}>
        <p>
            Organizations keep workspaces and data sources separated for each
            team.
        </p>
        <div class="name-field">
            <TextFieldOutlined
                bind:value={name}
                label="Organization name"
                name="organization-name"
                autocomplete="organization"
                leadingIcon={domainIcon}
                required
                disabled={creating}
            />
        </div>
    </form>

    {#snippet buttons()}
        <Button variant="text" disabled={creating} onclick={closeCreateDialog}
            >Cancel</Button
        >
        <Button
            disabled={creating || !name.trim()}
            onclick={createOrganization}
        >
            {creating ? "Creating..." : "Create"}
        </Button>
    {/snippet}
</Dialog>

<Snackbar />

<style>
    .organization-picker {
        position: relative;
    }

    .organization-trigger {
        @apply --m3-focus-inward;
        display: flex;
        width: min(15rem, 100%);
        min-height: 48px;
        align-items: center;
        gap: 10px;
        overflow: hidden;
        border: 0;
        border-radius: var(--m3-shape-full);
        background: var(--m3c-surface-container-high);
        color: var(--m3c-on-surface);
        cursor: pointer;
        font: inherit;
        padding: 4px 10px 4px 4px;
        text-align: left;
        transition: background-color var(--m3-easing-fast);
    }

    .organization-trigger:hover,
    .organization-trigger[aria-expanded="true"] {
        background: var(--m3c-secondary-container);
        color: var(--m3c-on-secondary-container);
    }

    .organization-avatar {
        @apply --m3-title-small;
        display: grid;
        width: 40px;
        height: 40px;
        flex: 0 0 40px;
        place-items: center;
        overflow: hidden;
        border-radius: var(--m3-shape-medium);
        background: var(--m3c-primary-container);
        color: var(--m3c-on-primary-container);
        font-weight: 600;
    }

    .organization-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .organization-copy {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        overflow: hidden;
    }

    .organization-label {
        @apply --m3-label-small;
        color: var(--m3c-on-surface-variant);
    }

    .organization-name {
        @apply --m3-title-small;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    :global(.organization-menu > .m3-container.expressive-menu.anchored) {
        max-height: min(28rem, calc(100svh - 2rem));
    }

    .create-form {
        display: flex;
        width: min(24rem, calc(100vw - 4rem));
        flex-direction: column;
        gap: 20px;
    }

    .create-form p {
        @apply --m3-body-medium;
        color: var(--m3c-on-surface-variant);
    }

    .name-field :global(.m3-container) {
        width: 100%;
    }
</style>
