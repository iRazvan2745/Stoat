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
    <div bind:this={root} class="relative">
        <button
            type="button"
            class="organization-trigger m3-layer flex min-h-12 w-[min(15rem,100%)] cursor-pointer items-center gap-2.5 overflow-hidden rounded-full border-0 bg-surface-container-high py-1 pr-2.5 pl-1 text-left font-inherit text-on-surface transition-colors hover:bg-secondary-container hover:text-on-secondary-container aria-expanded:bg-secondary-container aria-expanded:text-on-secondary-container"
            style="anchor-name: --m3-menu-anchor"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Organization: ${activeOrganization?.name ?? "Stoat"}`}
            onclick={() => (menuOpen = !menuOpen)}
        >
            <span
                class="m3-font-title-small bg-primary-container text-on-primary-container grid size-10 shrink-0 grow-0 basis-10 place-items-center overflow-hidden rounded-md"
                aria-hidden="true"
            >
                {#if activeOrganization?.logo}
                    <img
                        src={activeOrganization.logo}
                        alt=""
                        class="h-full w-full object-cover"
                    />
                {:else}
                    {organizationInitial}
                {/if}
            </span>

            <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
                <span
                    class="m3-font-label-small text-on-surface-variant"
                    >Organization</span
                >
                <span
                    class="m3-font-title-small overflow-hidden text-ellipsis whitespace-nowrap"
                >
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
    <form
        class="flex w-[min(24rem,calc(100vw-4rem))] flex-col gap-5"
        onsubmit={handleCreateSubmit}
    >
        <p class="m3-font-body-medium text-on-surface-variant">
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
    .organization-trigger {
        @apply --m3-focus-inward;
    }

    :global(.organization-menu > .m3-container.expressive-menu.anchored) {
        max-height: min(28rem, calc(100svh - 2rem));
    }

    .name-field :global(.m3-container) {
        width: 100%;
    }
</style>
