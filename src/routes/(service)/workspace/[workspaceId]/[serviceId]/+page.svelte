<script lang="ts">
    import { goto } from "$app/navigation";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import deployedCodeIcon from "@ktibow/iconset-material-symbols/deployed-code";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import {
        Button,
        Card,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        LoadingIndicator,
        Snackbar,
        snackbar,
    } from "m3-svelte";

    import {
        deleteService,
        deployService,
        getService,
        getServiceContainers,
    } from "#lib/api/services.remote";

    import ComposeEditor from "./compose-editor.svelte";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const service = getService(params.serviceId);
    // svelte-ignore state_referenced_locally
    const containers = getServiceContainers(params.serviceId);

    const svc = await service;
    let actionsMenuOpen = $state(false);
    let deleteDialogOpen = $state(false);
    let deleting = $state(false);
    let deploying = $state(false);

    const containerItems = $derived(containers.current?.items ?? []);

    const statusClasses = (status: string): string => {
        switch (status.toLowerCase()) {
            case "healthy":
            case "running": {
                return "bg-primary-container text-on-primary-container";
            }

            case "dead":
            case "exited":
            case "failed":
            case "unhealthy": {
                return "bg-error-container text-on-error-container";
            }

            default: {
                return "bg-secondary-container text-on-secondary-container";
            }
        }
    };

    const deploy = async (): Promise<void> => {
        if (!svc || deploying) {
            return;
        }

        deploying = true;

        try {
            const deployment = await deployService(svc.id);
            await goto(
                `/workspace/${params.workspaceId}/${params.serviceId}/deployments?view=${deployment.deploymentId}`
            );
            snackbar("Deployment queued");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to deploy service"
            );
        } finally {
            deploying = false;
        }
    };

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
        <Card variant="elevated">
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
                        aria-label="Deploy service"
                        disabled={deploying}
                        aria-busy={deploying}
                        onclick={deploy}
                    >
                        {#if deploying}
                            <LoadingIndicator
                                size={18}
                                center={false}
                                aria-label="Deploying service"
                            />
                            Deploying...
                        {:else}
                            Deploy
                        {/if}
                    </Button>

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

        <Card variant="elevated">
            <div class="flex items-center justify-between gap-3">
                <h2 class="text-on-surface text-base font-semibold">
                    Containers
                </h2>

                {#if !containers.loading && containerItems.length > 0}
                    <p class="text-on-surface-variant text-xs">
                        {containerItems.length}
                        {containerItems.length === 1
                            ? "container"
                            : "containers"}
                    </p>
                {/if}
            </div>

            {#if containers.loading}
                <div class="flex min-h-24 items-center justify-center">
                    <LoadingIndicator aria-label="Loading containers" />
                </div>
            {:else if containers.error}
                <p class="text-error text-sm">{containers.error.message}</p>
            {:else if containers.current?.error}
                <p class="text-error text-sm">{containers.current.error}</p>
            {:else if containerItems.length === 0}
                <p class="text-on-surface-variant text-sm">
                    No running containers. Deploy this service to start them.
                </p>
            {:else}
                <ul class="flex flex-col">
                    {#each containerItems as container (container.id)}
                        <li
                            class="border-outline-variant flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
                        >
                            <div class="flex min-w-0 items-center gap-3">
                                <div
                                    class={[
                                        "inline-flex shrink-0 items-center rounded-full p-1.5",
                                        statusClasses(container.status),
                                    ]}
                                >
                                    <Icon icon={deployedCodeIcon} size={18} />
                                </div>

                                <div class="min-w-0">
                                    <p
                                        class="text-on-surface truncate text-sm font-medium"
                                    >
                                        {container.name}
                                    </p>
                                    <p
                                        class="text-on-surface-variant truncate text-xs"
                                    >
                                        {container.image} · {container.machineName}
                                        · {container.shortId}
                                    </p>
                                </div>
                            </div>

                            <span
                                class={[
                                    "inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium capitalize",
                                    statusClasses(container.status),
                                ]}
                            >
                                {container.status}
                            </span>
                        </li>
                    {/each}
                </ul>
            {/if}
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
        <Button
            variant="text"
            disabled={deleting}
            onclick={() => (deleteDialogOpen = false)}
        >
            Cancel
        </Button>

        <Button disabled={deleting} aria-busy={deleting} onclick={remove}>
            {#if deleting}
                <LoadingIndicator
                    size={18}
                    center={false}
                    aria-label="Deleting service"
                />
                Deleting...
            {:else}
                Delete
            {/if}
        </Button>
    {/snippet}
</Dialog>

<Snackbar />
