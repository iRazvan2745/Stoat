<script lang="ts">
    // oxlint-disable func-style
    import { Snackbar, snackbar } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import {
        cancelDeployment,
        deleteDeployment,
        getDeploymentLogs,
        getDeployments,
    } from "#lib/api/deployments.remote";

    import { isDeploymentActive } from "./deployment";
    import DeploymentActionsMenu from "./deployment-actions-menu.svelte";
    import DeploymentCancelDialog from "./deployment-cancel-dialog.svelte";
    import DeploymentDeleteDialog from "./deployment-delete-dialog.svelte";
    import DeploymentList from "./deployment-list.svelte";
    import DeploymentLogsDialog from "./deployment-logs-dialog.svelte";

    let { params } = $props();

    // svelte-ignore state_referenced_locally
    const deploymentsQuery = getDeployments(params.serviceId);
    const deployments = $derived(deploymentsQuery.current ?? []);

    const view = useQueryState("view", parseAsString.withDefault(""));
    const deploymentLogsQuery = $derived.by(() => {
        const deploymentId = view.current;

        return deploymentId ? getDeploymentLogs(deploymentId) : undefined;
    });

    const logs = $derived(deploymentLogsQuery?.current ?? []);
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

    let cancelDialogDeploymentId = $state<string | null>(null);
    let deleteDialogDeploymentId = $state<string | null>(null);
    let cancelling = $state(false);
    let deleting = $state(false);

    const cancelDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === cancelDialogDeploymentId
        )
    );
    const deleteDialogDeployment = $derived(
        deployments.find(
            (deployment) => deployment.id === deleteDialogDeploymentId
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
        cancelDialogDeploymentId = deploymentId;
    }

    function openDeleteDialog(deploymentId: string): void {
        closeActionsMenu();
        deleteDialogDeploymentId = deploymentId;
    }

    const forceCancel = async (): Promise<void> => {
        if (!cancelDialogDeploymentId || cancelling) {
            return;
        }

        cancelling = true;

        try {
            await cancelDeployment(cancelDialogDeploymentId);
            cancelDialogDeploymentId = null;
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
        if (!deleteDialogDeploymentId || deleting) {
            return;
        }

        deleting = true;

        try {
            await deleteDeployment(deleteDialogDeploymentId);

            if (view.current === deleteDialogDeploymentId) {
                closeLogs();
            }

            deleteDialogDeploymentId = null;
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
    <header class="mb-4 flex items-center justify-between gap-4">
        <div>
            <h1 class="text-on-surface">Deployments</h1>
        </div>

        {#if deployments.length > 0}
            <div
                class="bg-secondary-container text-on-secondary-container shrink-0 rounded-full px-3 py-1 text-xs font-medium"
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
            logsLoadingFor={deploymentLogsQuery?.loading ? view.current : null}
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
    error={deploymentLogsQuery?.error}
    loading={deploymentLogsQuery?.loading === true}
    {logs}
    onCancel={openCancelDialog}
    onclose={closeLogs}
    onDelete={openDeleteDialog}
    open={Boolean(view.current)}
/>

<DeploymentCancelDialog
    {cancelling}
    deployment={cancelDialogDeployment}
    onCancel={() => (cancelDialogDeploymentId = null)}
    onConfirm={forceCancel}
    open={cancelDialogDeploymentId !== null}
/>

<DeploymentDeleteDialog
    {deleting}
    deployment={deleteDialogDeployment}
    onCancel={() => (deleteDialogDeploymentId = null)}
    onConfirm={removeDeployment}
    open={deleteDialogDeploymentId !== null}
/>

<Snackbar />
