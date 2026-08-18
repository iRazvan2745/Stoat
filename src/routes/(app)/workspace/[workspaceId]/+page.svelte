<script lang="ts">
    import { goto } from "$app/navigation";
    import addIcon from "@ktibow/iconset-material-symbols/add";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import widgetsIcon from "@ktibow/iconset-material-symbols/widgets-outline";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        Snackbar,
        TextField,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, parseAsString, useQueryState } from "nuqs-svelte";

    import {
        createService,
        getServicesInWorkspace,
    } from "#lib/api/services.remote";
    import {
        deleteWorkspace,
        getWorkspace,
        listWorkspaces,
    } from "#lib/api/workspace.remote";

    import type { PageProps } from "./$types";

    let { params }: PageProps = $props();

    // svelte-ignore state_referenced_locally
    const workspace = getWorkspace(params.workspaceId);
    // svelte-ignore state_referenced_locally
    const services = getServicesInWorkspace(params.workspaceId);

    let createDialogOpen = useQueryState(
        "createDialogOpen",
        parseAsBoolean.withDefault(false)
    );

    let compose = useQueryState("compose", parseAsString.withDefault(""));

    let serviceName = useQueryState(
        "serviceName",
        parseAsString.withDefault("")
    );

    let submitting = useQueryState(
        "submitting",
        parseAsBoolean.withDefault(false)
    );

    let actionsMenuOpen = $state(false);
    let deleteWorkspaceDialogOpen = $state(false);
    let deletingWorkspace = $state(false);

    const create = async (): Promise<void> => {
        if (!serviceName.current.trim()) {
            return;
        }

        submitting.current = true;

        try {
            await createService({
                name: serviceName.current.trim(),
                value: compose.current.trim(),
                workspaceId: params.workspaceId,
            });

            createDialogOpen.set(false);
            serviceName.set("");
            compose.set("");

            snackbar("Service created");

            await services.refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create service"
            );
        } finally {
            submitting.set(false);
        }
    };

    const removeWorkspace = async (): Promise<void> => {
        deletingWorkspace = true;

        try {
            await deleteWorkspace(params.workspaceId);
            await listWorkspaces().refresh();
            await goto("/workspace");
            snackbar("Workspace has been deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete workspace"
            );
        } finally {
            deletingWorkspace = false;
        }
    };
</script>

<div class="flex items-center justify-between gap-4">
    <h1 class="text-on-surface text-lg font-medium">
        {workspace.current?.name ?? "…"}
    </h1>

    <div class="flex items-center gap-2">
        <Button iconType="left" onclick={() => createDialogOpen.set(true)}>
            <Icon icon={addIcon} size={18} />
            Add service
        </Button>

        <Button
            variant="tonal"
            aria-label="Refresh workspace"
            onclick={async () => {
                await workspace.refresh();
                await services.refresh();
            }}
        >
            <Icon icon={refreshIcon} />
        </Button>

        <div class="relative">
            <Button
                variant="text"
                size="xs"
                aria-label="More workspace actions"
                aria-expanded={actionsMenuOpen}
                aria-haspopup="menu"
                style="anchor-name: --m3-menu-anchor"
                onclick={() => (actionsMenuOpen = !actionsMenuOpen)}
            >
                <Icon icon={moreVertIcon} />
            </Button>

            {#if actionsMenuOpen}
                <ExpressiveMenu
                    anchored
                    x="end"
                    y="down"
                    label="Workspace actions"
                >
                    <ExpressiveMenuItem
                        leadingIcon={deleteIcon}
                        label="Delete workspace"
                        onclick={() => {
                            actionsMenuOpen = false;
                            deleteWorkspaceDialogOpen = true;
                        }}
                    />
                </ExpressiveMenu>
            {/if}
        </div>
    </div>
</div>

<div id="services-card">
    {#if services.loading}
        <div class="flex min-h-32 items-center justify-center">
            <LoadingIndicator aria-label="Loading services" />
        </div>
    {:else if services.error}
        <div class="text-error p-6 text-sm">{services.error.message}</div>
    {:else if (services.current?.length ?? 0) === 0}
        <div class="text-on-surface-variant px-5 py-10 text-center text-sm">
            No services found. Paste a docker compose file to get started.
        </div>
    {:else}
        <div class="grid grid-cols-3 gap-2 py-2">
            {#each services.current ?? [] as service (service.id)}
                <Card
                    variant="elevated"
                    id="service-card"
                    onclick={() =>
                        goto(`/workspace/${params.workspaceId}/${service.id}`)}
                >
                    <div class="flex items-center gap-4">
                        <div>
                            <Icon
                                icon={widgetsIcon}
                                size={48}
                                class="bg-primary-container rounded-md p-2"
                            />
                        </div>
                        <div class="min-w-0">
                            <p
                                class="text-on-surface truncate text-sm font-medium"
                            >
                                {service.name ?? "Untitled"}
                            </p>

                            <p
                                class="text-on-surface-variant truncate font-mono text-xs"
                            >
                                {service.slug ?? "—"}
                            </p>
                        </div>
                    </div>

                    <!-- <pre class="service-compose">{service.value ?? "—"}</pre> -->
                </Card>
            {/each}
        </div>
    {/if}
</div>

<Dialog bind:open={createDialogOpen.current} headline="Add service">
    <div class="flex flex-col gap-4">
        <TextField
            bind:value={serviceName.current}
            label="Name"
            required
            placeholder="My Web App"
        />
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={() => createDialogOpen.set(false)}>
            Cancel
        </Button>

        <Button disabled={submitting.current} onclick={create}>Add</Button>
    {/snippet}
</Dialog>

<Dialog bind:open={deleteWorkspaceDialogOpen} headline="Delete workspace">
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Are you sure you want to delete this workspace?
        </p>

        <p class="text-on-surface-variant text-sm">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            onclick={() => (deleteWorkspaceDialogOpen = false)}>Cancel</Button
        >

        <Button disabled={deletingWorkspace} onclick={removeWorkspace}
            >Delete</Button
        >
    {/snippet}
</Dialog>

<Snackbar />

<style>
    :global(#services-card.m3-container) {
        padding: 0;
        overflow-x: hidden;
    }

    :global(#service-card.m3-container.elevated) {
        flex-direction: column;
        align-items: stretch;
        gap: 0.5rem;
        padding: 0.75rem;
        border-radius: var(--m3-shape-medium);
    }
</style>
