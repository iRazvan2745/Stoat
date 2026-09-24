<script lang="ts">
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { orpc } from "$lib/orpc";
    import { createQuery } from "@tanstack/svelte-query";

    let {
        connectionId = $bindable(""), repositoryUrl = $bindable(""), branch = $bindable(""), path = $bindable("."), disabled = false,
    }: { connectionId?: string; repositoryUrl?: string; branch?: string; path?: string; disabled?: boolean } = $props();

    const id = $props.id();

    const connectionsQuery = createQuery(() => orpc.connections.list.queryOptions());

    const connections = $derived(connectionsQuery.data?.connections ?? []);

    const selectedConnection = $derived(connections.find((connection) => connection.id === connectionId));

    const repositoriesQuery = createQuery(() => {
        const requestedConnectionId = connectionId;

        return orpc.connections.getRepositories.queryOptions({
            input: { connectionId: requestedConnectionId }, enabled: Boolean(requestedConnectionId), placeholderData: undefined,
            select: (result) => ({ ...result, connectionId: requestedConnectionId }),
        });
    });

    const repositoryData = $derived(repositoriesQuery.data?.connectionId === connectionId ? repositoriesQuery.data : undefined);

    const repositories = $derived(connectionId && !repositoriesQuery.isError ? repositoryData?.repositories ?? [] : []);
</script>

{#if connectionsQuery.isError}
    <Alert variant="error"><AlertDescription>Unable to load connections: {connectionsQuery.error.message}</AlertDescription></Alert>
    <Button variant="outline" size="sm" onclick={() => connectionsQuery.refetch()}>Retry</Button>
{/if}
<div class="grid gap-3 sm:grid-cols-2">
    <Field>
        <Label for="{id}-connection" required>Git connection</Label>
        <Select
            value={connectionId || null}
            items={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
            disabled={disabled || connectionsQuery.isPending}
            required
            onValueChange={(value) => {
                if ((value ?? "") !== connectionId) {
                    repositoryUrl = "";
                    branch = "";
                }
                connectionId = value ?? "";
            }}
        >
            <SelectTrigger id="{id}-connection" class="min-w-0">
                {#if selectedConnection}
                    <span class="flex min-w-0 items-center gap-2">
                        <ProviderIcon provider={selectedConnection.provider} />
                        <span class="truncate">{selectedConnection.name}</span>
                    </span>
                {:else}
                    <SelectValue placeholder={connectionsQuery.isPending ? "Loading..." : "Select connection"} />
                {/if}
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={null} label="Select connection" />
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
    <Field>
        <Label for="{id}-repository" required>Repository</Label>
        <Select
            value={repositoryUrl || null}
            itemToStringLabel={(value) => repositories.find((repo) => repo.url === value)?.name ?? `${value} (current source)`}
            disabled={disabled || !connectionId || repositoriesQuery.isPending}
            required
            onValueChange={(value) => {
                if ((value ?? "") !== repositoryUrl) branch = repositories.find((repo) => repo.url === value)?.defaultBranch ?? "";
                repositoryUrl = value ?? "";
            }}
        >
            <SelectTrigger id="{id}-repository" class="min-w-0">
                <SelectValue placeholder={connectionId && repositoriesQuery.isPending ? "Loading repositories..." : "Select repository"} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={null} label="Select repository" />
                {#if repositoryUrl && !repositories.some((repo) => repo.url === repositoryUrl)}
                    <SelectItem value={repositoryUrl} label={`${repositoryUrl} (current source)`} />
                {/if}
                {#each repositories as repo (repo.url)}<SelectItem value={repo.url} label={repo.name} />{/each}
            </SelectContent>
        </Select>
    </Field>
    <Field>
        <Label for="{id}-branch" required>Branch</Label>
        <Input id="{id}-branch" bind:value={branch} placeholder="main" required {disabled} />
    </Field>
    <Field>
        <Label for="{id}-path" required>Compose file or directory</Label>
        <Input id="{id}-path" bind:value={path} placeholder=". or deploy/" required {disabled} />
    </Field>
</div>
{#if connectionId}
    {#if repositoriesQuery.isError}
        <Alert variant="error"><AlertDescription>Unable to load repositories: {repositoriesQuery.error.message}</AlertDescription></Alert>
        <Button type="button" variant="outline" size="sm" disabled={disabled || repositoriesQuery.isFetching} onclick={() => repositoriesQuery.refetch()}>Retry repositories</Button>
    {:else if !repositoriesQuery.isPending && repositories.length === 0}
        <p class="text-sm text-muted-foreground">No accessible repositories found. Check this account's permissions or configure known repositories for a generic server.</p>
    {/if}
    {#if !repositoriesQuery.isError && repositoryData?.truncated}<p class="text-xs text-muted-foreground">The provider returned a partial repository list. A missing repository may be outside the returned results or this account's access.</p>{/if}
{/if}
<p class="text-xs text-muted-foreground">
    Use a file path, <code>.</code>, or a directory such as <code>deploy/</code>.
    Directories resolve compose.yaml, compose.yml, docker-compose.yml, or docker-compose.yaml.
    Only the Compose file is imported; relative build contexts and other repository files are not deployed.
</p>
{#if !connectionsQuery.isPending && !connectionsQuery.isError && connections.length === 0}
    <p class="text-sm text-muted-foreground">No Git connections available. Ask an administrator to <a class="underline" href="/git">add a connection</a>.</p>
{/if}
