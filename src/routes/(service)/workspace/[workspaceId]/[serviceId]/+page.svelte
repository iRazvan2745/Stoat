<script lang="ts">
    import { goto } from "$app/navigation";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        Snackbar,
        snackbar,
    } from "m3-svelte";

    import {
        deleteService,
        deployService,
        getService,
    } from "#lib/api/services.remote";

    import ComposeEditor from "./compose-editor.svelte";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const service = getService(params.serviceId);

    const svc = await service;
    let actionsMenuOpen = $state(false);
    let deleteDialogOpen = $state(false);
    let deleting = $state(false);

    const remove = async (): Promise<void> => {
        if (!svc) {
            return;
        }

        deleting = true;

        try {
            await deleteService(svc.id);
            await goto(`/workspace/${params.workspaceId}`);
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete service"
            );
        } finally {
            deleting = false;
        }
    };
</script>

<main class="space-y-4 p-4">
    {#if svc}
        <Card variant="outlined">
            <div class="flex items-center justify-between">
                <!-- Service -->
                <div class="flex min-w-0 items-center gap-3">
                    <div
                        class="bg-surface-container-high text-on-surface relative grid size-9 shrink-0
                           place-items-center rounded-lg"
                    >
                        <svg
                            class="size-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <ellipse cx="12" cy="5" rx="7" ry="3" />
                            <path d="M5 5v6c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
                            <path d="M5 11v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
                        </svg>

                        <span
                            class="border-surface absolute -top-0.5 -right-0.5 size-2.5
                               rounded-full border-2 bg-green-500"
                        ></span>
                    </div>

                    <div class="min-w-0">
                        <h1
                            class="text-on-surface truncate text-base leading-tight font-semibold"
                        >
                            {svc.name ?? "Unnamed service"}
                        </h1>

                        {#if svc.slug}
                            <p
                                class="text-on-surface-variant mt-0.5 truncate text-xs"
                            >
                                {svc.slug}
                            </p>
                        {/if}
                    </div>
                </div>

                <!-- Actions -->
                <div class="flex shrink-0 items-center gap-1">
                    <Button
                        aria-label="Edit service"
                        onclick={async () => await deployService(svc.id)}
                        >Deploy</Button
                    >

                    <div class="relative">
                        <Button
                            variant="tonal"
                            square
                            aria-label="More service actions"
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
                                label="Service actions"
                            >
                                <ExpressiveMenuItem
                                    leadingIcon={deleteIcon}
                                    label="Delete service"
                                    onclick={() => {
                                        actionsMenuOpen = false;
                                        deleteDialogOpen = true;
                                    }}
                                />
                            </ExpressiveMenu>
                        {/if}
                    </div>
                </div>
            </div>
        </Card>
        <ComposeEditor serviceId={svc.id} initialCompose={svc.value} />
    {/if}
</main>

<Dialog bind:open={deleteDialogOpen} headline="Delete service">
    <div class="flex flex-col gap-2">
        <p class="text-on-surface">
            Are you sure you want to delete this service?
        </p>

        <p class="text-on-surface-variant text-sm">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button variant="text" onclick={() => (deleteDialogOpen = false)}>
            Cancel
        </Button>

        <Button disabled={deleting} onclick={remove}>Delete</Button>
    {/snippet}
</Dialog>

<Snackbar />
