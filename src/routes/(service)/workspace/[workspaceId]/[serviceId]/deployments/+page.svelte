<script lang="ts">
    // oxlint-disable func-style
    import { Snackbar, snackbar } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import {
        cancelDeployment,
        deleteDeployment,
        getDeploymentLogBatch,
        listDeployments,
    } from "#lib/api/deployments.remote";
    import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";

    import { isDeploymentActive } from "./deployment";
    import DeploymentActionsMenu from "./deployment-actions-menu.svelte";
    import DeploymentCancelDialog from "./deployment-cancel-dialog.svelte";
    import DeploymentDeleteDialog from "./deployment-delete-dialog.svelte";
    import DeploymentList from "./deployment-list.svelte";
    import DeploymentLogsDialog from "./deployment-logs-dialog.svelte";

    let { params } = $props();

    // svelte-ignore state_referenced_locally
    const deploymentsQuery = listDeployments(params.serviceId);
    const deployments = $derived(deploymentsQuery.current ?? []);

    const view = useQueryState("view", parseAsString.withDefault(""));
    let logs = $state<DeploymentLogRecord[]>([]);
    let logsLoading = $state(false);
    let logsError = $state<{ message: string }>();

    const waitForNextLogBatch = (): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });

    $effect(() => {
        const deploymentId = view.current;
        logs = [];
        logsError = undefined;
        logsLoading = Boolean(deploymentId);
        if (!deploymentId) {return;}
        let disposed = false;
        let afterId = 0;
        const consume = async (): Promise<void> => {
            try {
                while (!disposed) {
                    // Each request carries the cursor it owns. Refresh the
                    // ordinary query because an unchanged cursor is a valid
                    // poll and must still reach the server.
                    // oxlint-disable-next-line no-await-in-loop
                    const batchQuery = getDeploymentLogBatch({
                        afterId,
                        deploymentId,
                    });
                    // oxlint-disable-next-line no-await-in-loop
                    await batchQuery.refresh();
                    // oxlint-disable-next-line no-await-in-loop
                    const batch = await batchQuery;
                    if (disposed) {break;}

                    for (const log of batch.logs) {
                        if (log.id > afterId) {
                            logs.push(log);
                        }
                    }
                    afterId = Math.max(afterId, batch.nextCursor);
                    logsLoading = false;

                    if (batch.done) {break;}

                    // A full batch may have more history ready immediately;
                    // otherwise wait for the next deployment log update.
                    if (!batch.hasMore) {
                        // oxlint-disable-next-line no-await-in-loop
                        await waitForNextLogBatch();
                    }
                }
            } catch (error) {
                if (!disposed)
                    {logsError = {
                        message:
                            error instanceof Error
                                ? error.message
                                : "Unable to load deployment logs",
                    };}
            } finally {
                if (!disposed) {logsLoading = false;}
            }
        };
        void consume();
        return () => {
            disposed = true;
        };
    });

    const selectedDeployment = $derived(
        deployments.find((deployment) => deployment.id === view.current)
    );

    let actionsMenuOpenFor = $state<string | null>(null);
    const actionsMenuDeployment = $derived(
        deployments.find((deployment) => deployment.id === actionsMenuOpenFor)
    );
    const actionsMenuDeploymentActive = $derived(
        actionsMenuDeployment
            ? isDeploymentActive(
                  actionsMenuDeployment,
                  view.current === actionsMenuDeployment.id ? logs : undefined
              )
            : false
    );

    const cancelDialogDeploymentId = useQueryState(
        "cancel",
        parseAsString.withDefault("")
    );
    const deleteDialogDeploymentId = useQueryState(
        "delete",
        parseAsString.withDefault("")
    );
    let cancelling = $state(false);
    let deleting = $state(false);

    const cancelDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === cancelDialogDeploymentId.current
        )
    );
    const deleteDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === deleteDialogDeploymentId.current
        )
    );

    function openLogs(deploymentId: string): void {
        void view.set(deploymentId);
    }

    function closeLogs(): void {
        void view.set("");
    }

    function closeActionsMenu(): void {
        actionsMenuOpenFor = null;
    }

    function toggleActionsMenu(deploymentId: string): void {
        actionsMenuOpenFor =
            actionsMenuOpenFor === deploymentId ? null : deploymentId;
    }

    function handleWindowPointerDown(event: PointerEvent): void {
        if (!actionsMenuOpenFor) {
            return;
        }

        const { target } = event;

        if (!(target instanceof Element)) {
            return;
        }

        if (
            target.closest("[data-deployment-actions-trigger]") ||
            target.closest(".m3-container.expressive-menu")
        ) {
            return;
        }

        closeActionsMenu();
    }

    function openCancelDialog(deploymentId: string): void {
        closeActionsMenu();
        void cancelDialogDeploymentId.set(deploymentId);
    }

    function openDeleteDialog(deploymentId: string): void {
        closeActionsMenu();
        void deleteDialogDeploymentId.set(deploymentId);
    }

    const forceCancel = async (): Promise<void> => {
        const deploymentId = cancelDialogDeploymentId.current;

        if (!deploymentId || cancelling) {
            return;
        }

        cancelling = true;

        try {
            await cancelDeployment(deploymentId);
            void cancelDialogDeploymentId.set("");
            snackbar("Deployment cancelled");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to cancel deployment"
            );
        } finally {
            cancelling = false;
        }
    };

    const removeDeployment = async (): Promise<void> => {
        const deploymentId = deleteDialogDeploymentId.current;

        if (!deploymentId || deleting) {
            return;
        }

        deleting = true;

        try {
            await deleteDeployment(deploymentId);

            if (view.current === deploymentId) {
                closeLogs();
            }

            void deleteDialogDeploymentId.set("");
            snackbar("Deployment deleted");
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to delete deployment"
            );
        } finally {
            deleting = false;
        }
    };
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="mx-auto w-full max-w-6xl">
    <header class="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-1">
            <h1 class="m3-font-headline-small text-on-surface">Deployments</h1>
            <p class="m3-font-body-medium text-on-surface-variant">
                Deploy history and logs for this service.
            </p>
        </div>

        {#if deployments.length > 0}
            <div
                class="bg-secondary-container text-on-secondary-container m3-font-label-medium inline-flex h-6 shrink-0 items-center rounded-full px-2.5"
            >
                {deployments.length} total
            </div>
        {/if}
    </header>

    <main>
        <DeploymentList
            {deployments}
            {actionsMenuOpenFor}
            loading={deploymentsQuery.loading}
            {logs}
            logsLoadingFor={logsLoading ? view.current : null}
            onOpenLogs={openLogs}
            onToggleActions={toggleActionsMenu}
            selectedDeploymentId={view.current}
        />
    </main>
</div>

<DeploymentActionsMenu
    active={actionsMenuDeploymentActive}
    deployment={actionsMenuDeployment}
    onCancel={openCancelDialog}
    onDelete={openDeleteDialog}
/>

<DeploymentLogsDialog
    {cancelling}
    {deleting}
    deployment={selectedDeployment}
    error={logsError}
    loading={logsLoading}
    {logs}
    onCancel={openCancelDialog}
    onclose={closeLogs}
    onDelete={openDeleteDialog}
    open={Boolean(view.current)}
/>

<DeploymentCancelDialog
    {cancelling}
    deployment={cancelDialogDeployment}
    onCancel={() => cancelDialogDeploymentId.set("")}
    onConfirm={forceCancel}
    open={cancelDialogDeploymentId.current !== ""}
/>

<DeploymentDeleteDialog
    {deleting}
    deployment={deleteDialogDeployment}
    onCancel={() => deleteDialogDeploymentId.set("")}
    onConfirm={removeDeployment}
    open={deleteDialogDeploymentId.current !== ""}
/>

<Snackbar />
