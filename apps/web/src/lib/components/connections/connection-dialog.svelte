<script lang="ts">
    import { beforeNavigate } from "$app/navigation";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "$lib/components/ui/dialog";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { Textarea } from "$lib/components/ui/textarea";
    import { connectionFormParsers } from "$lib/git-query-params";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { parseAsStringLiteral, useQueryStates } from "nuqs-svelte";
    import { watch } from "runed";
    import { onDestroy, untrack } from "svelte";

    type Provider = "forgejo" | "github" | "generic";

    const providerOptions: { value: Provider; label: string }[] = [
        { value: "forgejo", label: "Forgejo" },
        { value: "github", label: "GitHub" },
        { value: "generic", label: "Generic Git server" },
    ];

    type Repository = { url: string; name: string; defaultBranch: string };

    type Account = { id: string; login: string; name: string | null };

    type OAuthProvider = { id: string; name: string; provider: Provider; serverUrl: string };

    let { connection, organizationId, oauthProviders, ondone, oncancel }: {
        organizationId: string;
        connection: { id: string; name: string; provider: Provider; serverUrl: string; authType: "token" | "oauth"; account: Account | null; repositories: Repository[]; hasCredentials: boolean } | null;
        oauthProviders: OAuthProvider[];
        ondone: () => void;
        oncancel: () => void;
    } = $props();

    const initial = untrack(() => connection);

    const initialOrganizationId = untrack(() => organizationId);

    const id = $props.id();

    const initialRepositories = initial?.repositories.map((repo) => repo.url).join("\n") ?? "";

    const fields = useQueryStates(
        {
            ...connectionFormParsers,
            name: connectionFormParsers.name.withDefault(initial?.name ?? ""),
            provider: (initial
                ? parseAsStringLiteral([initial.provider])
                : connectionFormParsers.provider
            ).withDefault(initial?.provider ?? "github"),
            authMode: connectionFormParsers.authMode.withDefault(initial?.authType ?? "token"),
            credentialType: connectionFormParsers.credentialType.withDefault("https"),
            oauthProviderId: connectionFormParsers.oauthProviderId.withDefault(""),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    // A crafted URL must not enable OAuth for a generic server.
    const authMode = $derived(fields.provider.current === "generic" ? "token" : fields.authMode.current);

    const providerLabel = $derived(providerOptions.find((option) => option.value === fields.provider.current)?.label ?? fields.provider.current);

    const authOptions = $derived([
        { value: "token", label: `Access token${fields.provider.current === "generic" ? " / SSH credentials" : ""}` },
        { value: "oauth", label: "OAuth" },
    ]);

    const credentialOptions = $derived([
        { value: "keep", label: `Keep current credentials${initial?.hasCredentials ? " (stored)" : " (none stored)"}` },
        { value: "replace", label: "Replace credentials" },
        ...(fields.provider.current === "generic" ? [{ value: "clear", label: "Clear credentials (public repositories)" }] : []),
    ]);

    const credentialTypeOptions = [
        { value: "https", label: "HTTPS access token" },
        { value: "ssh", label: "SSH private key / known hosts" },
    ];

    let serverUrl = $state(untrack(() => {
        if (initial) return initial.serverUrl;
        const providers = oauthProviders.filter((option) => option.provider === fields.provider.current);

        return providers.find((option) => option.id === fields.oauthProviderId.current)?.serverUrl
            ?? (fields.provider.current === "github" ? "https://github.com" : providers[0]?.serverUrl ?? "");
    }));

    let credentialAction = $state(initial ? "keep" : "replace");

    let username = $state("");

    let password = $state("");

    let privateKey = $state("");

    let knownHosts = $state("");

    let repositoryUrls = $state(initialRepositories);

    let addedProviders = $state<OAuthProvider[]>([]);

    let clientId = $state("");

    let clientSecret = $state("");

    let setupError = $state("");

    let setupStatus = $state("");

    let copyStatus = $state("");

    let copyError = $state("");

    let copying = $state(false);

    let open = $state(true);

    let formElement: HTMLFormElement;

    let pending = $state<"" | "test" | "save" | "oauth" | "app">("");

    const busy = $derived(Boolean(pending));

    let error = $state("");

    let testError = $state("");

    let testResult = $state<{ account: Account | null; repositoryCount: number; truncated: boolean } | null>(null);

    let configVersion = 0;

    let active = true;

    const oauthSetupQuery = createQuery(() => orpc.connections.oauthSetup.queryOptions({ enabled: authMode === "oauth" && open }));

    const availableOAuthProviders = $derived([...oauthProviders, ...addedProviders.filter((added) => !oauthProviders.some((option) => option.id === added.id))]);

    const matchingOAuthProviders = $derived(availableOAuthProviders.filter((option) => option.provider === fields.provider.current && (!initial || sameServer(option.serverUrl, initial.serverUrl))));

    const oauthOptions = $derived(matchingOAuthProviders.map((option) => ({ value: option.id, label: `${option.name} (${option.serverUrl})` })));

    const oauthServerUrl = $derived.by(() => {
        const raw = serverUrl.trim();

        // eslint-disable-next-line no-control-regex -- Reject controls before URL parsing can discard them.
        if (fields.provider.current === "generic" || raw.length > 2048 || /[\s\x00-\x1f\x7f\\]/u.test(raw)) return "";
        const match = /^https:\/\/[^/?#@]+(\/[^?#]*)?$/iu.exec(raw);

        if (!match) return "";

        try {
            const url = new URL(raw);
            const path = decodeURIComponent(match[1] || "/");

            if (url.username || url.password || !/^\/(?:[a-zA-Z0-9_.~@+-]+\/)*[a-zA-Z0-9_.~@+-]*$/u.test(path) || /%2f/iu.test(match[1] || "") || path.split("/").some((part) => part === "." || part === "..")) return "";
            url.pathname = path;

            if (fields.provider.current === "github" && url.hostname === "github.com" && (url.port || path !== "/")) return "";

            return url.href.replace(/\/$/u, "");
        } catch { return ""; }
    });

    const registrationUrl = $derived(oauthServerUrl ? `${oauthServerUrl.replace(/\/+$/, "")}${fields.provider.current === "github" ? "/settings/applications/new" : "/user/settings/applications"}` : "");

    const oauthProvider = $derived(oauthServerUrl ? matchingOAuthProviders.find((option) => option.id === fields.oauthProviderId.current && sameServer(option.serverUrl, oauthServerUrl)) ?? matchingOAuthProviders.find((option) => sameServer(option.serverUrl, oauthServerUrl)) : undefined);

    const setupOpen = $derived(fields.setupExpanded.current ?? !oauthProvider);

    const appName = $derived(fields.name.current.trim() || `${Match.value(fields.provider.current).pipe(
        Match.when("github", () => "GitHub"),
        Match.orElse(() => "Forgejo"),
    )} OAuth`);

    const setupReady = $derived(Boolean(oauthServerUrl && oauthSetupQuery.isSuccess && appName.length <= 100 && clientId.trim() && clientId.length <= 2048 && clientSecret.trim() && clientSecret.length <= 8192));

    const keepOAuth = $derived(authMode === "oauth" && initial?.authType === "oauth");

    watch.pre(
        () => [fields.provider.current, authMode, serverUrl, fields.oauthProviderId.current],
        (current, previous) => {
            if (!previous || current.every((value, index) => value === previous[index])) return;
            const [provider, , , oauthProviderId] = current;
            const [previousProvider, , , previousOAuthProviderId] = previous;

            if (!initial && (provider !== previousProvider || oauthProviderId !== previousOAuthProviderId)) {
                const selected = matchingOAuthProviders.find((option) => option.id === oauthProviderId);

                if (selected) serverUrl = selected.serverUrl;
                else if (provider !== previousProvider) {
                    serverUrl = provider === "github" ? "https://github.com" : matchingOAuthProviders[0]?.serverUrl ?? "";
                }
            }

            clientId = clientSecret = copyStatus = copyError = setupError = setupStatus = "";
        },
        { lazy: true },
    );

    // Watch the actual configuration, not DOM events: URL navigation also invalidates in-flight tests.
    watch.pre(
        () => [
            fields.name.current, fields.provider.current, fields.authMode.current,
            fields.credentialType.current, fields.oauthProviderId.current, fields.setupExpanded.current,
            serverUrl, credentialAction, repositoryUrls,
            username, password, privateKey, knownHosts, clientId, clientSecret,
        ],
        (current, previous) => {
            if (previous && current.every((value, index) => value === previous[index])) return;
            configVersion += 1;
            testResult = null;
            testError = error = "";
        },
    );

    onDestroy(() => {
        active = false;
        configVersion += 1;
        clearSecrets();
    });

    function sameServer(left: string, right: string) {
        try { return new URL(left).href.replace(/\/+$/, "") === new URL(right).href.replace(/\/+$/, ""); }
        catch { return false; }
    }

    beforeNavigate((navigation) => {
        // Block in-app navigation during requests, without triggering browser unload prompts.
        if (busy && !navigation.willUnload) navigation.cancel();
    });

    function clearSecrets() {
        password = privateKey = knownHosts = username = clientId = clientSecret = "";
    }

    function changeOpen(next: boolean) {
        if (!active || next || busy) return;
        clearSecrets();
        open = false;
        oncancel();
    }

    async function copyCallback() {
        const callbackUrl = oauthSetupQuery.data?.callbackUrl;

        if (busy || copying || !callbackUrl || !oauthSetupQuery.isSuccess) return;
        const version = configVersion;
        copying = true;
        copyStatus = copyError = "";

        try {
            await navigator.clipboard.writeText(callbackUrl);

            if (version === configVersion) copyStatus = "Callback URL copied.";
        } catch {
            if (version === configVersion) copyError = "Could not copy. Select and copy the callback URL manually.";
        } finally { copying = false; }
    }

    async function saveOAuthProvider(event: SubmitEvent) {
        event.preventDefault();

        if (busy || authMode !== "oauth" || fields.provider.current === "generic" || !setupReady) return;
        pending = "app";
        setupError = setupStatus = "";
        const version = configVersion;

        try {
            const saved = await client.connections.createOAuthProvider({ organizationId: initialOrganizationId, name: appName, provider: fields.provider.current, serverUrl: oauthServerUrl, clientId: clientId.trim(), clientSecret });
            void queryClient.invalidateQueries({ queryKey: orpc.connections.list.queryKey() });

            if (!active || version !== configVersion) return;
            addedProviders = [...addedProviders, saved];
            serverUrl = saved.serverUrl;
            clientId = clientSecret = "";
            await fields.set({ oauthProviderId: saved.id, setupExpanded: false });

            if (!active || fields.oauthProviderId.current !== saved.id) return;
            setupStatus = "OAuth application saved and selected. Credentials are not verified yet; continue with OAuth to verify them during authorization and connect your account.";
        } catch (cause) {
            if (active && version === configVersion) setupError = cause instanceof Error ? cause.message : "Unable to save the OAuth application. Try again.";
        } finally { pending = ""; }
    }

    function startOAuth(event: SubmitEvent) {
        if (busy || !oauthProvider || !fields.name.current.trim() || !formElement.reportValidity()) {
            event.preventDefault();

            return;
        }

        clearSecrets();
        pending = "oauth";
    }

    async function run(action: "test" | "save") {
        if (busy || (authMode === "oauth" && (action === "test" || !keepOAuth))) return;

        for (const field of formElement.elements) {
            if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;

            if (action === "test" && field.id === `${id}-name`) continue;

            if (!field.reportValidity()) return;
        }

        if (!serverUrl.trim() || (action === "save" && !fields.name.current.trim())) return;
        error = testError = "";
        testResult = null;
        const repositories: Repository[] = [];

        if (fields.provider.current === "generic") {
            for (const raw of new Set(repositoryUrls.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))) {
                try {
                    const parsed = new URL(raw);

                    if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.password || (parsed.protocol === "https:" && parsed.username)) throw new Error();
                    const stored = initial?.repositories.find((repo) => repo.url === raw);
                    repositories.push(stored ?? { url: raw, name: parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || parsed.hostname, defaultBranch: "main" });
                } catch {
                    error = "Enter one valid HTTPS or SSH repository URL per line, without embedded tokens or passwords.";

                    return;
                }
            }

            if (repositories.length === 0) {
                error = "Add at least one known repository URL so this generic connection can be verified.";

                return;
            }
        }

        pending = action;
        const version = configVersion;

        const credentials = keepOAuth || (initial && credentialAction === "keep" && authMode === initial.authType) ? undefined
            : credentialAction === "clear" ? {}
            : fields.provider.current === "generic" && fields.credentialType.current === "ssh" ? { username: username || undefined, privateKey, knownHosts }
            : { username: username || undefined, password: password || undefined };

        const repositoryInput = fields.provider.current === "generic" ? { repositories } : {};

        try {
            if (action === "test") {
                const result = await client.connections.testConnection(initial
                    ? { connectionId: initial.id, credentials, ...repositoryInput }
                    : { provider: fields.provider.current, serverUrl: serverUrl.trim(), credentials: credentials ?? {}, ...repositoryInput });

                if (version === configVersion) testResult = result;

                return;
            }

            if (initial) {
                await client.connections.update({ connectionId: initial.id, name: fields.name.current.trim(), credentials, ...repositoryInput });
            } else {
                await client.connections.create({ name: fields.name.current.trim(), provider: fields.provider.current, serverUrl: serverUrl.trim(), credentials: credentials ?? {}, ...repositoryInput });
            }

            void queryClient.invalidateQueries({ queryKey: orpc.connections.list.queryKey() });
            void queryClient.invalidateQueries({ queryKey: orpc.connections.getRepositories.key() });

            if (!active || version !== configVersion) return;
            clearSecrets();
            open = false;
            pending = "";
            ondone();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Unable to verify the Git account connection.";

            if (action === "test") {
                if (version === configVersion) testError = message;
            } else if (active && version === configVersion) error = message;
        } finally { pending = ""; }
    }
</script>

<svelte:window onpageshow={(event) => { if (event.persisted && pending === "oauth") pending = ""; }} />

<Dialog bind:open={() => open, changeOpen}>
    <DialogContent class="max-w-2xl" closeProps={{ disabled: busy }}>
        <DialogHeader>
            <DialogTitle>{initial ? "Edit connection" : "Add connection"}</DialogTitle>
            <DialogDescription>Connect an account on a Git server. Choose repositories later when configuring resources.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <form id="{id}-form" bind:this={formElement} class="space-y-4" onsubmit={(event) => { event.preventDefault(); void run("save"); }} oninput={() => { setupError = setupStatus = ""; }} aria-busy={busy}>
                <div class="grid gap-4 sm:grid-cols-2">
                    <Field><Label for="{id}-name" required>Connection name</Label><Input id="{id}-name" bind:value={fields.name.current} maxlength={100} required disabled={busy} /></Field>
                    <Field>
                        <Label for="{id}-provider" required>Provider</Label>
                        <Select
                            value={fields.provider.current}
                            items={providerOptions}
                            disabled={busy || Boolean(initial)}
                            onValueChange={(next) => {
                                if (!next || next === fields.provider.current) return;
                                const provider = next as Provider;
                                void fields.set({ provider, oauthProviderId: null, setupExpanded: null, authMode: provider === "generic" ? "token" : authMode });
                            }}
                        >
                            <SelectTrigger id="{id}-provider">
                                <span class="flex min-w-0 items-center gap-2">
                                    <ProviderIcon provider={fields.provider.current} />
                                    <span class="truncate">{providerLabel}</span>
                                </span>
                            </SelectTrigger>
                            <SelectContent>
                                {#each providerOptions as option (option.value)}
                                    <SelectItem value={option.value} label={option.label}>
                                        <span class="flex min-w-0 items-center gap-2">
                                            <ProviderIcon provider={option.value} />
                                            <span class="truncate">{option.label}</span>
                                        </span>
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field class="sm:col-span-2"><Label for="{id}-server" required>Git server URL</Label><Input id="{id}-server" type="url" bind:value={serverUrl} oninput={() => { void fields.set({ oauthProviderId: null, setupExpanded: null }); }} maxlength={authMode === "oauth" ? 2048 : 4096} placeholder={fields.provider.current === "generic" ? "https://git.example.com or ssh://git.example.com" : "https://git.example.com"} required disabled={busy || Boolean(initial)} /></Field>
                </div>
                <p class="text-xs text-muted-foreground">Enter the server address, not a repository URL. Never put tokens or passwords in URLs.{initial ? " Provider and server cannot be changed on an existing connection." : ""}</p>
                <Field>
                    <Label for="{id}-auth">Authorization</Label>
                    <Select value={authMode} items={authOptions} disabled={busy} onValueChange={(next) => {
                        if (!next) return;
                        void fields.set({ authMode: fields.provider.current === "generic" ? "token" : next as "token" | "oauth", setupExpanded: null });
                    }}>
                        <SelectTrigger id="{id}-auth" class="min-w-0"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {#each authOptions as option (option.value)}
                                <SelectItem value={option.value} label={option.label} disabled={option.value === "oauth" && fields.provider.current === "generic"} />
                            {/each}
                        </SelectContent>
                    </Select>
                </Field>
                {#if authMode === "oauth"}
                    {#if matchingOAuthProviders.length > 0}
                        <Field>
                            <Label for="{id}-oauth">Configured OAuth application</Label>
                            <Select value={oauthProvider?.id ?? null} items={oauthOptions} disabled={busy} onValueChange={(next) => {
                                if (!next) return;
                                void fields.set({ oauthProviderId: next, setupExpanded: null });
                            }}>
                                <SelectTrigger id="{id}-oauth" class="min-w-0"><SelectValue placeholder="Select an OAuth application" /></SelectTrigger>
                                <SelectContent class="max-w-[calc(100vw-2rem)]">
                                    {#each oauthOptions as option (option.value)}
                                        <SelectItem value={option.value} label={option.label}><span class="min-w-0 break-all">{option.label}</span></SelectItem>
                                    {/each}
                                </SelectContent>
                            </Select>
                        </Field>
                    {/if}
                    <div class="space-y-3 rounded-lg border border-border p-4">
                        {#if oauthSetupQuery.isError}
                            <Alert variant="error"><AlertDescription>Unable to load the OAuth callback URL. {oauthSetupQuery.error.message}</AlertDescription></Alert>
                            <Button type="button" variant="outline" size="sm" loading={oauthSetupQuery.isFetching} disabled={busy || oauthSetupQuery.isFetching} onclick={() => { copyStatus = copyError = ""; void oauthSetupQuery.refetch(); }}>Retry callback URL</Button>
                        {:else if oauthSetupQuery.isPending}
                            <p class="text-sm text-muted-foreground" role="status">Loading OAuth callback URL...</p>
                        {:else}
                            <Field>
                                <Label for="{id}-callback">OAuth callback URL</Label>
                                <InputGroup>
                                    <InputGroupInput id="{id}-callback" value={oauthSetupQuery.data.callbackUrl} readonly disabled={busy} aria-describedby={copyError ? `${id}-copy-error` : undefined} />
                                    <InputGroupAddon align="inline-end" class="shrink-0">
                                        <Button type="button" variant="ghost" size="sm" loading={copying} disabled={busy || copying} onclick={copyCallback}>Copy URL</Button>
                                    </InputGroupAddon>
                                </InputGroup>
                            </Field>
                        {/if}
                        {#if copyStatus}<p class="text-xs text-muted-foreground" role="status">{copyStatus}</p>{/if}
                        {#if copyError}<Alert id="{id}-copy-error" variant="error"><AlertDescription>{copyError}</AlertDescription></Alert>{/if}
                        <Button type="button" variant="outline" class="h-auto whitespace-normal" aria-expanded={setupOpen} aria-controls="{id}-oauth-setup" disabled={busy} onclick={() => { fields.setupExpanded.current = !setupOpen; clientId = clientSecret = setupError = setupStatus = ""; }}>{setupOpen ? "Hide OAuth application setup" : "Set up a new OAuth application"}</Button>
                        <div id="{id}-oauth-setup" hidden={!setupOpen} class="space-y-3">
                            {#if setupOpen}
                                <p class="text-sm text-muted-foreground">Register an OAuth application with your Git provider once, using the callback URL above. Then save its client credentials here for reuse in this organization. No environment editing or restart is needed.</p>
                                {#if fields.provider.current === "forgejo"}
                                    <ol class="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                                        <li>Open your server's applications settings below and find <strong>Create a new OAuth2 Application</strong>.</li>
                                        <li>Name it <strong>Stoat</strong>, paste the callback URL as its <strong>Redirect URI</strong>, and enable <strong>Confidential Client</strong>.</li>
                                        <li>Create the application, then enter its client ID and secret below. Save, then continue with OAuth to authorize your account.</li>
                                    </ol>
                                {/if}
                                {#if registrationUrl}
                                    <a class="inline-block break-all text-sm underline underline-offset-4" href={registrationUrl} target="_blank" rel="noopener noreferrer">Register an OAuth application on {oauthServerUrl} (opens a new tab)</a>
                                {:else}
                                    <p class="text-sm text-muted-foreground">Enter a valid HTTPS Git server URL without credentials, a query, or a fragment to register and save an application.</p>
                                {/if}
                                <div class="grid gap-3 sm:grid-cols-2">
                                    <Field><Label for="{id}-client-id" required>Client ID</Label><Input id="{id}-client-id" form="{id}-oauth-setup-form" type="password" bind:value={clientId} maxlength={2048} autocomplete="off" spellcheck={false} required disabled={busy} /></Field>
                                    <Field><Label for="{id}-client-secret" required>Client secret</Label><Input id="{id}-client-secret" form="{id}-oauth-setup-form" type="password" bind:value={clientSecret} maxlength={8192} autocomplete="new-password" spellcheck={false} required disabled={busy} /></Field>
                                </div>
                                <Button type="submit" form="{id}-oauth-setup-form" class="h-auto whitespace-normal" loading={pending === "app"} disabled={busy || !setupReady}>Save OAuth application</Button>
                            {/if}
                        </div>
                        {#if setupError}<Alert variant="error"><AlertDescription>OAuth application not saved. {setupError}</AlertDescription></Alert>{/if}
                        {#if setupStatus}<p class="text-sm text-muted-foreground" role="status">{setupStatus}</p>{/if}
                    </div>
                    {#if !oauthProvider}<p class="text-sm text-muted-foreground">Set up an OAuth application for this provider and server above, or use an access token instead.</p>{/if}
                    {#if keepOAuth}<p class="text-sm text-muted-foreground">Currently authorized{initial?.account ? ` as ${initial.account.login}` : ""}. Save keeps this authorization; reconnect to authorize again.</p>{/if}
                    <p class="text-xs text-muted-foreground">Continue to the provider to authorize your account. The callback verifies your identity and repository access before saving. No separate test is needed before authorization.</p>
                {:else}
                    {#if initial && initial.authType === "token"}
                        <Field>
                            <Label for="{id}-credentials">Stored credentials</Label>
                            <Select value={credentialAction} items={credentialOptions} disabled={busy} onValueChange={(next) => { if (next) credentialAction = next; }}>
                                <SelectTrigger id="{id}-credentials" class="min-w-0"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {#each credentialOptions as option (option.value)}
                                        <SelectItem value={option.value} label={option.label} />
                                    {/each}
                                </SelectContent>
                            </Select>
                        </Field>
                    {/if}
                    {#if !initial || initial.authType === "oauth" || credentialAction === "replace"}
                        <div class="grid gap-4 sm:grid-cols-2">
                            {#if fields.provider.current === "generic"}
                                <Field class="sm:col-span-2">
                                    <Label for="{id}-type">Credential type</Label>
                                    <Select value={fields.credentialType.current} items={credentialTypeOptions} disabled={busy} onValueChange={(next) => { if (next) fields.credentialType.current = next as "https" | "ssh"; }}>
                                        <SelectTrigger id="{id}-type" class="min-w-0"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {#each credentialTypeOptions as option (option.value)}
                                                <SelectItem value={option.value} label={option.label} />
                                            {/each}
                                        </SelectContent>
                                    </Select>
                                </Field>
                            {/if}
                            <Field><Label for="{id}-username">Username (optional)</Label><Input id="{id}-username" bind:value={username} autocomplete="off" disabled={busy} /></Field>
                            {#if fields.provider.current === "generic" && fields.credentialType.current === "ssh"}
                                <Field class="sm:col-span-2"><Label for="{id}-key" required>SSH private key</Label><Textarea id="{id}-key" bind:value={privateKey} rows={5} autocomplete="off" spellcheck={false} required disabled={busy} /></Field>
                                <Field class="sm:col-span-2"><Label for="{id}-hosts" required>Known hosts</Label><Textarea id="{id}-hosts" bind:value={knownHosts} rows={3} autocomplete="off" spellcheck={false} required disabled={busy} /></Field>
                                <p class="text-xs text-muted-foreground sm:col-span-2">Use an unencrypted key and verified known_hosts entries. For custom SSH ports use <code>[hostname]:port</code>. Existing SSH credentials can also be kept unchanged.</p>
                            {:else}
                                <Field><Label for="{id}-token" required={fields.provider.current !== "generic"}>Access token</Label><Input id="{id}-token" type="password" bind:value={password} autocomplete="new-password" required={fields.provider.current !== "generic"} disabled={busy} /></Field>
                            {/if}
                        </div>
                        <p class="text-xs text-muted-foreground">Stored secrets are never displayed.{fields.provider.current === "generic" ? " Leave the token empty only for public repositories." : " The token must permit account and repository discovery."}{initial?.authType === "oauth" ? " Saving a token replaces the existing OAuth authorization." : ""}</p>
                    {/if}
                {/if}
                {#if fields.provider.current === "generic"}
                    <Field><Label for="{id}-repositories" required>Known repositories</Label><Textarea id="{id}-repositories" bind:value={repositoryUrls} rows={4} placeholder="https://git.example.com/team/repository.git" required disabled={busy} /></Field>
                    <p class="text-xs text-muted-foreground">Generic Git servers cannot auto-discover repositories or account identities. Enter one repository URL per line; at least one is required to verify read access. New entries default to branch <code>main</code>; choose the resource branch when importing.</p>
                {/if}
                <p class="text-xs text-muted-foreground">{authMode === "token" ? "Test connection verifies access without saving. Adding or saving always revalidates; a separate test is optional. " : ""}Push permissions and branch protections are not verified until a push is attempted.</p>
                <div role="status" class="space-y-2 text-sm">
                    {#if busy}<p class="text-muted-foreground">{pending === "oauth" ? "Redirecting to authorization..." : pending === "app" ? "Saving OAuth application..." : pending === "test" ? "Testing connection..." : "Testing and saving..."}</p>{/if}
                    {#if testResult}
                        <Alert><AlertDescription><span class="block font-medium">{testResult.account ? `Account verified: ${testResult.account.login}.` : "Known repository read access checked."} Nothing saved.</span><span class="block">{testResult.repositoryCount} accessible {testResult.repositoryCount === 1 ? "repository" : "repositories"}.{testResult.truncated ? " The provider returned a partial repository list." : ""}</span></AlertDescription></Alert>
                    {/if}
                    {#if testError}<Alert variant="error"><AlertDescription>Connection test failed. Nothing saved. {testError}</AlertDescription></Alert>{/if}
                    {#if error}<Alert variant="error"><AlertDescription>Connection not saved. {error}</AlertDescription></Alert>{/if}
                </div>
            </form>
            {#if authMode === "oauth"}
                <!-- App credentials use a separate form so they never block connection authorization or saving. -->
                <form id="{id}-oauth-setup-form" onsubmit={saveOAuthProvider}></form>
                <form id="{id}-oauth-form" method="POST" action="/git/oauth/start" onsubmit={startOAuth}>
                    <input type="hidden" name="organizationId" value={initialOrganizationId} />
                    <input type="hidden" name="providerId" value={oauthProvider?.id ?? ""} />
                    <input type="hidden" name="name" value={fields.name.current.trim()} />
                    {#if initial}<input type="hidden" name="connectionId" value={initial.id} />{/if}
                </form>
            {/if}
        </DialogPanel>
        <DialogFooter class="sm:flex-wrap">
            {#if authMode === "token"}<Button type="button" variant="outline" class="sm:mr-auto" loading={pending === "test"} disabled={busy || !serverUrl.trim()} onclick={() => run("test")}>Test connection</Button>{/if}
            <Button type="button" variant="outline" disabled={busy} onclick={() => changeOpen(false)}>Cancel</Button>
            {#if authMode === "oauth"}<Button type="submit" form="{id}-oauth-form" variant={keepOAuth ? "outline" : "default"} loading={pending === "oauth"} disabled={busy || !fields.name.current.trim() || !oauthProvider}>{keepOAuth ? "Reconnect with OAuth" : "Continue with OAuth"}</Button>{/if}
            {#if authMode === "token" || keepOAuth}<Button type="submit" form="{id}-form" loading={pending === "save"} disabled={busy || !fields.name.current.trim() || !serverUrl.trim()}>{initial ? "Save connection" : "Add connection"}</Button>{/if}
        </DialogFooter>
    </DialogContent>
</Dialog>
