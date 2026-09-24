<script lang="ts">
    import { beforeNavigate, goto, onNavigate } from "$app/navigation";
    import { page } from "$app/state";
    import ConnectionDialog from "$lib/components/connections/connection-dialog.svelte";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Frame, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { Label } from "$lib/components/ui/label";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { connectionDialogParsers, connectionDialogUrl } from "$lib/git-query-params";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import { useQueryStates } from "nuqs-svelte";
    import { onDestroy, untrack } from "svelte";

    const params = useQueryStates(connectionDialogParsers, { history: "replace", shallow: true, scroll: false });

    const routeId = untrack(() => page.route.id);

    let active = true;

    let leaving = false;

    const connectionsQuery = createQuery(() => orpc.connections.list.queryOptions());

    const connections = $derived(connectionsQuery.data?.connections ?? []);

    const canManage = $derived(connectionsQuery.data?.canManage === true);

    const editingConnection = $derived(connections.find((connection) => connection.id === params.edit.current));

    const connectionDialogOpen = $derived(
        params.dialog.current === "add-connection" || params.dialog.current === "edit-connection",
    );

    const form = $derived.by(() => {
        if (!connectionsQuery.data || !canManage || !connectionDialogOpen) return null;

        if (params.dialog.current === "edit-connection" && !editingConnection) return null;

        return {
            connection: params.dialog.current === "edit-connection" ? editingConnection! : null,
            organizationId: connectionsQuery.data.organizationId,
        };
    });

    const formKey = $derived(form ? `${form.organizationId}:${form.connection?.id ?? "add"}` : "");

    const invalidDialog = $derived(
        connectionsQuery.isSuccess && connectionDialogOpen &&
        (!canManage || (params.dialog.current === "edit-connection" && !editingConnection)),
    );

    const selectedConnection = $derived(connections.find((connection) => connection.id === params.connectionId.current) ?? connections[0]);

    const repositoriesQuery = createQuery(() => {
        const requestedConnectionId = selectedConnection?.id ?? "";

        return orpc.connections.getRepositories.queryOptions({
            input: { connectionId: requestedConnectionId }, enabled: Boolean(requestedConnectionId), placeholderData: undefined,
            select: (result) => ({ ...result, connectionId: requestedConnectionId }),
        });
    });

    const repositoryData = $derived(repositoriesQuery.data?.connectionId === selectedConnection?.id ? repositoriesQuery.data : undefined);

    const repositories = $derived(selectedConnection && !repositoriesQuery.isError ? repositoryData?.repositories ?? [] : []);

    const providerNames = { github: "GitHub", forgejo: "Forgejo", generic: "Generic Git server" };

    const oauthErrors = {
        configuration: "OAuth is not configured for this server. In Add connection (or Edit), select OAuth and set up a new OAuth application. An organization administrator can complete setup there, or use an access token instead.",
        forbidden: "Only an organization administrator can authorize a Git account. Check your session and organization.",
        invalid_request: "Authorization was cancelled or the provider returned an invalid response. Try connecting again.",
        invalid_state: "The authorization session expired or could not be verified. Start authorization again.",
        connection_mismatch: "This OAuth application does not match the connection's provider and server.",
        token_exchange_failed: "The provider could not complete authorization. Try again or use an access token.",
        invalid_token: "The provider did not return usable authorization. Try connecting again.",
        account_failed: "The authorized account could not be verified. Check the OAuth application's permissions.",
        failed: "Git account authorization failed. Try again or use an access token.",
    };

    const oauthStatus = $derived(page.url.searchParams.get("oauth"));

    const oauthError = $derived.by(() => {
        if (!oauthStatus || oauthStatus === "success") return "";
        const reason = oauthStatus === "error" ? page.url.searchParams.get("reason") ?? "failed" : oauthStatus;

        return Object.entries(oauthErrors).find(([code]) => code === reason)?.[1] ?? oauthErrors.failed;
    });

    let pending = $state("");

    let error = $state("");

    let status = $state("");

    const disabled = $derived(Boolean(pending) || Boolean(form));

    beforeNavigate((navigation) => {
        if (pending) navigation.cancel();
    });

    onNavigate((navigation) => {
        leaving = navigation.to?.route.id !== routeId;
    });

    onDestroy(() => { active = false; });

    async function changeDialog(
        dialog: "add-connection" | "edit-connection" | null,
        edit: string | null = null,
        saved = false,
    ) {
        if (!active || leaving || page.route.id !== routeId) return;

        // goto keeps the mounted form's navigation guard alive until navigation is approved.
        try {
            const url = connectionDialogUrl(page.url, dialog, edit, saved);
            await goto(url, { replaceState: dialog === null, noScroll: true, keepFocus: true });

            if (saved && active && !leaving && page.route.id === routeId) {
                status = "Account connection saved and access verified. Push permissions and branch protections are checked only when pushing.";
            }
        } catch {
            // A navigation guard may cancel; leave the existing URL and form intact.
        }
    }

    async function remove(connection: (typeof connections)[number]) {
        if (disabled || !canManage || !window.confirm(`Delete connection "${connection.name}"? Deletion is blocked while any resource is attached. Detach those resources first.`)) return;
        pending = "Deleting account connection";
        error = status = "";

        try {
            await client.connections.delete({ connectionId: connection.id });
            await queryClient.invalidateQueries({ queryKey: orpc.connections.list.queryKey() });
            status = "Account connection deleted.";
        } catch (cause) {
            error = cause instanceof Error ? cause.message : "Unable to delete account connection.";
        } finally { pending = ""; }
    }
</script>

<svelte:head><title>Git / Stoat</title></svelte:head>

<div class="w-full min-w-0 space-y-6 py-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0"><h1 class="text-2xl font-semibold">Git</h1><p class="mt-1 text-sm text-muted-foreground">Connect Git server accounts and choose their repositories when configuring resources.</p></div>
        {#if canManage}<Button {disabled} onclick={() => changeDialog("add-connection")}>Add connection</Button>{/if}
    </div>
    {#if connectionsQuery.isError}
        <Alert variant="error"><AlertDescription>Unable to load account connections: {connectionsQuery.error.message}</AlertDescription></Alert>
        <Button variant="outline" disabled={disabled || connectionsQuery.isFetching} onclick={() => connectionsQuery.refetch()}>Retry</Button>
    {/if}
    {#if oauthStatus === "success"}<Alert><AlertDescription>Git account authorized and connection saved. Choose a repository when configuring a resource.</AlertDescription></Alert>{/if}
    {#if oauthError}<Alert variant="error"><AlertDescription>{oauthError}</AlertDescription></Alert>{/if}
    {#if error}<Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>{/if}
    {#if invalidDialog}
        <Alert variant="error"><AlertDescription>{canManage ? "This connection is unavailable. It may have been deleted or belong to another organization." : "Only organization owners and administrators can manage account connections."}</AlertDescription></Alert>
        <Button variant="outline" onclick={() => changeDialog(null)}>Dismiss</Button>
    {/if}
    <p class="text-sm text-muted-foreground" role="status">{pending ? `${pending}...` : status}</p>
    {#if form && canManage}
        {#key formKey}
            {@const identity = formKey}
            <ConnectionDialog connection={form.connection} organizationId={form.organizationId} oauthProviders={connectionsQuery.data?.oauthProviders ?? []} ondone={() => { if (identity === formKey) void changeDialog(null, null, true); }} oncancel={() => { if (identity === formKey) void changeDialog(null); }} />
        {/key}
    {/if}
    <Frame class="min-w-0">
        <FrameHeader><FrameTitle>Account connections</FrameTitle></FrameHeader>
        <FramePanel class="min-w-0 space-y-4">
            {#if connectionsQuery.isPending}
                <p class="text-sm text-muted-foreground">Loading account connections...</p>
            {:else if selectedConnection}
                <Field class="w-full min-w-0 sm:max-w-sm">
                    <Label for="git-connection">Git account connection</Label>
                    <Select
                        value={selectedConnection.id}
                        items={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
                        {disabled}
                        onValueChange={(value) => { params.connectionId.current = value; }}
                    >
                        <SelectTrigger id="git-connection" class="min-w-0">
                            <span class="flex min-w-0 items-center gap-2">
                                <ProviderIcon provider={selectedConnection.provider} />
                                <span class="truncate">{selectedConnection.name}</span>
                            </span>
                        </SelectTrigger>
                        <SelectContent>
                            {#each connections as connection (connection.id)}
                                <SelectItem value={connection.id} label={connection.name}>
                                    <span class="flex min-w-0 items-center gap-2">
                                        <ProviderIcon provider={connection.provider} />
                                        <span class="truncate">{connection.name}</span>
                                    </span>
                                </SelectItem>
                            {/each}
                        </SelectContent>
                    </Select>
                </Field>
                <dl class="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
                    <div><dt class="text-xs text-muted-foreground">Provider</dt><dd class="flex items-center gap-2"><ProviderIcon provider={selectedConnection.provider} /><span>{providerNames[selectedConnection.provider]}</span></dd></div>
                    <div class="min-w-0"><dt class="text-xs text-muted-foreground">Server</dt><dd class="break-all">{selectedConnection.serverUrl}</dd></div>
                    <div class="min-w-0"><dt class="text-xs text-muted-foreground">Account</dt><dd class="break-all">{selectedConnection.account?.login ?? "Account discovery unavailable"}{selectedConnection.account?.name ? ` (${selectedConnection.account.name})` : ""}</dd></div>
                    <div><dt class="text-xs text-muted-foreground">Authorization</dt><dd>{selectedConnection.authType === "oauth" ? "OAuth" : selectedConnection.hasCredentials ? "Stored token / credentials" : "No credentials stored"}</dd></div>
                </dl>
                {#if canManage}
                    <div class="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" {disabled} onclick={() => changeDialog("edit-connection", selectedConnection.id)}>Edit</Button>
                        <Button size="sm" variant="ghost" {disabled} onclick={() => remove(selectedConnection)}>Delete</Button>
                    </div>
                {:else if !connectionsQuery.isError}
                    <p class="text-xs text-muted-foreground">Read-only. Only organization owners and administrators can manage account connections.</p>
                {/if}
                {#key selectedConnection.id}
                    <div class="space-y-2 border-t border-border pt-4">
                        {#if repositoriesQuery.isError}
                            <Alert variant="error"><AlertDescription>Unable to load repositories: {repositoriesQuery.error.message}</AlertDescription></Alert>
                            <Button type="button" variant="outline" size="sm" disabled={disabled || repositoriesQuery.isFetching} onclick={() => repositoriesQuery.refetch()}>Retry repositories</Button>
                        {:else if repositoriesQuery.isPending || !repositoryData}
                            <p class="text-sm text-muted-foreground" role="status">Loading repositories...</p>
                        {:else}
                            <Field class="w-full min-w-0 sm:max-w-lg">
                                <Label for="account-repositories">Accessible repositories ({repositories.length}{repositoryData.truncated ? "+" : ""})</Label>
                                <Select items={repositories.map((repo) => ({ value: repo.url, label: `${repo.name} (${repo.defaultBranch})` }))} disabled={disabled || repositories.length === 0}>
                                    <SelectTrigger id="account-repositories" class="min-w-0">
                                        <SelectValue placeholder={repositories.length ? "Browse repositories" : "No repositories available"} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={null} label="Browse repositories" />
                                        {#each repositories as repo (repo.url)}<SelectItem value={repo.url} label={`${repo.name} (${repo.defaultBranch})`} />{/each}
                                    </SelectContent>
                                </Select>
                            </Field>
                            {#if repositoryData.truncated}<p class="text-xs text-muted-foreground">This is a partial repository list returned by the provider. Not all accessible repositories may be shown.</p>{/if}
                        {/if}
                        <p class="text-xs text-muted-foreground">{selectedConnection.provider === "generic" ? "Generic servers cannot auto-discover repositories. Edit the connection to maintain known repository URLs." : "Repositories are discovered using this account's permissions. Select a repository and branch when configuring a resource."}</p>
                    </div>
                {/key}
            {:else if !connectionsQuery.isError}
                <p class="text-sm text-muted-foreground">No Git account connections yet. An administrator can add a connection using OAuth or an access token.</p>
            {/if}
        </FramePanel>
    </Frame>
</div>
