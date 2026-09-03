<script lang="ts">
    import { goto } from "$app/navigation";
    import deployIcon from "@ktibow/iconset-material-symbols/anchor";
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import deployedCodeIcon from "@ktibow/iconset-material-symbols/deployed-code-outline";
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
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import type { Attachment } from "svelte/attachments";

    import {
        deleteService,
        deployService,
        getService,
        listServiceContainers,
    } from "#lib/api/services.remote";
    import ServiceIcon from "#lib/components/services/service-icon.svelte";

    import ComposeEditor from "./compose-editor.svelte";
    import DatabaseConnection from "./database-connection.svelte";

    const CONTAINER_POLL_INTERVAL_MS = 5000;

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const service = getService(params.serviceId);
    // svelte-ignore state_referenced_locally
    const containers = listServiceContainers(params.serviceId);

    const svc = await service;
    let actionsMenuOpen = $state(false);
    const deleteDialogOpen = useQueryState(
        "deleteDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let deleting = $state(false);
    let deploying = $state(false);

    const containerItems = $derived(containers.current?.items ?? []);
    const containersReady = $derived(containers.current !== undefined);
    const logsHref = (containerId: string): string =>
        `/workspace/${params.workspaceId}/${params.serviceId}/logs?containers=${containerId}`;

    const isHealthyStatus = (status: string): boolean => {
        const normalized = status.toLowerCase();
        return normalized === "healthy" || normalized === "running";
    };

    const isUnhealthyStatus = (status: string): boolean => {
        const normalized = status.toLowerCase();
        return (
            normalized === "dead" ||
            normalized === "exited" ||
            normalized === "failed" ||
            normalized === "unhealthy"
        );
    };

    const serviceHealth = $derived.by(() => {
        if (!containersReady || containerItems.length === 0) {
            return "unknown";
        }

        if (
            containerItems.every((container) =>
                isHealthyStatus(container.status)
            )
        ) {
            return "healthy";
        }

        if (
            containerItems.some((container) =>
                isUnhealthyStatus(container.status)
            )
        ) {
            return "unhealthy";
        }

        return "unknown";
    });

    const healthLabel = $derived.by(() => {
        switch (serviceHealth) {
            case "healthy": {
                return "Healthy";
            }

            case "unhealthy": {
                return "Unhealthy";
            }

            default: {
                return "Unknown";
            }
        }
    });

    const healthClasses = $derived.by(() => {
        switch (serviceHealth) {
            case "healthy": {
                return "bg-primary-container text-on-primary-container";
            }

            case "unhealthy": {
                return "bg-error-container text-on-error-container";
            }

            default: {
                return "bg-secondary-container text-on-secondary-container";
            }
        }
    });

    const runningCount = $derived(
        containerItems.filter((container) => isHealthyStatus(container.status))
            .length
    );

    const statusClasses = (status: string): string => {
        if (isHealthyStatus(status)) {
            return "bg-primary-container-subtle text-on-primary-container-subtle";
        }

        if (isUnhealthyStatus(status)) {
            return "bg-error-container-subtle text-on-error-container-subtle";
        }

        return "bg-secondary-container-subtle text-on-secondary-container-subtle";
    };

    const containerIconClasses = (status: string): string => {
        if (isHealthyStatus(status)) {
            return "bg-primary-container text-on-primary-container";
        }

        if (isUnhealthyStatus(status)) {
            return "bg-error-container text-on-error-container";
        }

        return "bg-secondary-container text-on-secondary-container";
    };

    const pollContainers: Attachment = () => {
        let cancelled = false;
        let timeoutId = 0;

        const refresh = async (): Promise<void> => {
            if (!cancelled && !containers.loading) {
                await containers.refresh();
            }

            if (cancelled) {
                return;
            }

            timeoutId = window.setTimeout(() => {
                void refresh();
            }, CONTAINER_POLL_INTERVAL_MS);
        };

        timeoutId = window.setTimeout(() => {
            void refresh();
        }, CONTAINER_POLL_INTERVAL_MS);

        return (): void => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
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

{#if svc}
    <div
        class="x:h-full x:overflow-hidden flex min-h-full min-w-0 flex-col gap-4"
    >
        <header
            class="flex min-h-10 flex-wrap items-center justify-between gap-2"
        >
            <div class="flex min-w-0 items-center gap-3">
                <div
                    class="bg-surface-container-high text-on-surface grid size-16 shrink-0 place-items-center rounded-lg"
                    aria-hidden="true"
                >
                    <ServiceIcon
                        icon={svc.icon}
                        type={svc.type}
                        size={48}
                        alt=""
                    />
                </div>

                <div class="min-w-0">
                    <h1 class="m3-font-headline-small text-on-surface truncate">
                        {svc.name ?? "Unnamed service"}
                    </h1>

                    <div class="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                        {#if svc.slug}
                            <p
                                class="m3-font-label-small text-on-surface-variant truncate font-mono"
                            >
                                {svc.slug}
                            </p>
                        {/if}

                        <span
                            class={[
                                "m3-font-label-medium inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5",
                                healthClasses,
                            ]}
                        >
                            <span
                                class="size-1.5 rounded-full bg-current"
                                aria-hidden="true"
                            ></span>
                            {healthLabel}
                        </span>
                    </div>
                </div>
            </div>

            <div class="flex shrink-0 items-center gap-2">
                <Button
                    variant="filled"
                    iconType="left"
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
                        <Icon icon={deployIcon} />
                        Deploy
                    {/if}
                </Button>

                <div class="relative">
                    <Button
                        variant="text"
                        id="service-actions-menu-button"
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
                                    void deleteDialogOpen.set(true);
                                }}
                            />
                        </ExpressiveMenu>
                    {/if}
                </div>
            </div>
        </header>

        <div
            class="x:grid x:grid-cols-[22.5rem_minmax(0,1fr)] x:items-stretch x:gap-6 flex min-h-0 min-w-0 flex-1 flex-col gap-4"
            {@attach pollContainers}
        >
            <div
                class="x:h-full x:min-h-0 x:overflow-hidden flex min-w-0 flex-col gap-4"
            >
                {#if svc.type === "postgresql"}
                    <div class="flex-none [&>.m3-container]:w-full">
                        <DatabaseConnection serviceId={svc.id} />
                    </div>
                {/if}

                <div
                    class="x:flex x:flex-none x:flex-col min-w-0 [&>.m3-container]:flex [&>.m3-container]:min-h-0 [&>.m3-container]:w-full [&>.m3-container]:flex-col"
                >
                    <Card variant="elevated">
                        <div
                            class="flex min-h-10 items-center justify-between gap-2"
                        >
                            <h2 class="m3-font-title-small text-on-surface">
                                Containers
                            </h2>

                            {#if containersReady && containerItems.length > 0}
                                <span
                                    class="bg-secondary-container text-on-secondary-container m3-font-label-medium inline-flex h-6 shrink-0 items-center rounded-full px-2.5"
                                >
                                    {runningCount} of {containerItems.length} running
                                </span>
                            {/if}
                        </div>

                        {#if !containersReady && containers.loading}
                            <div class="flex justify-center py-2">
                                <LoadingIndicator
                                    aria-label="Loading containers"
                                />
                            </div>
                        {:else if containers.error || containers.current?.error}
                            <div
                                class="bg-error-container-subtle text-on-error-container-subtle mt-2 rounded-lg px-3 py-2"
                                role="status"
                            >
                                <p class="m3-font-body-small">
                                    {containers.error?.message ??
                                        containers.current?.error}
                                </p>
                            </div>
                        {:else if containerItems.length === 0}
                            <div
                                class="text-on-surface-variant flex min-h-32 flex-col items-center justify-center gap-1 py-4 text-center"
                            >
                                <Icon icon={deployedCodeIcon} size={28} />
                                <p class="m3-font-body-medium mt-1">
                                    No running containers
                                </p>
                                <p class="m3-font-body-small">
                                    Deploy this service to start them.
                                </p>
                            </div>
                        {:else}
                            <ul class="mt-1 flex flex-col gap-2">
                                {#each containerItems as container (container.id)}
                                    <li class="min-w-0 flex-1">
                                        <a
                                            href={logsHref(container.id)}
                                            class="hover:bg-on-surface/8 focus-visible:bg-on-surface/8 flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors"
                                            aria-label={`View logs for ${container.name}`}
                                            title="View container logs"
                                        >
                                            <div
                                                class={[
                                                    "grid size-8 shrink-0 place-items-center rounded-full",
                                                    containerIconClasses(
                                                        container.status
                                                    ),
                                                ]}
                                            >
                                                <Icon
                                                    icon={deployedCodeIcon}
                                                    size={18}
                                                />
                                            </div>

                                            <div class="min-w-0 flex-1">
                                                <p
                                                    class="m3-font-label-large text-on-surface truncate"
                                                >
                                                    {container.name}
                                                </p>
                                                <p
                                                    class="m3-font-label-small text-on-surface-variant truncate"
                                                >
                                                    {container.image} ·
                                                    {container.machineName} ·
                                                    {container.shortId}
                                                </p>
                                            </div>

                                            <span
                                                class={[
                                                    "m3-font-label-small inline-flex h-5 shrink-0 items-center rounded-full px-2 capitalize",
                                                    statusClasses(
                                                        container.status
                                                    ),
                                                ]}
                                            >
                                                {container.status}
                                            </span>
                                        </a>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </Card>
                </div>
            </div>

            <div
                class="x:h-full x:min-h-0 flex min-h-48 min-w-0 flex-1 flex-col"
            >
                <ComposeEditor serviceId={svc.id} initialCompose={svc.value} />
            </div>
        </div>
    </div>
{/if}

<Dialog
    bind:open={deleteDialogOpen.current}
    headline="Delete service"
    onclose={() => deleteDialogOpen.set(false)}
>
    <div class="flex flex-col gap-2">
        <p class="m3-font-body-large text-on-surface">
            Are you sure you want to delete this service?
        </p>

        <p class="m3-font-label-small text-on-surface-variant">
            This action cannot be undone.
        </p>
    </div>

    {#snippet buttons()}
        <Button
            variant="text"
            disabled={deleting}
            onclick={() => deleteDialogOpen.set(false)}
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
