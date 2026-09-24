<script lang="ts">
    import { invalidateAll } from "$app/navigation";
    import { authClient } from "$lib/auth-client";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "$lib/components/ui/card";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { onMount } from "svelte";

    let { data } = $props();

    let name = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    let saved = $state(false);

    onMount(() => { name = data.user.name; ready = true; });

    async function save(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";
        saved = false;

        try {
            const result = await authClient.updateUser({ name: name.trim() });

            if (result.error) { error = result.error.message ?? "Unable to update your profile.";

 return; }

            await invalidateAll();
            saved = true;
        } catch { error = "Unable to save your profile. Try again."; }
        finally { pending = false; }
    }
</script>

<svelte:head><title>Settings / Stoat</title></svelte:head>
<div class="mx-auto max-w-2xl space-y-6 py-6">
    <div><h1 class="text-2xl font-semibold">Settings</h1><p class="mt-2 text-sm text-muted-foreground">Manage your account profile.</p></div>
    <Card>
        <CardHeader>
            <CardTitle class="text-base">Profile</CardTitle>
            <CardDescription>Your name appears in your organizations.</CardDescription>
        </CardHeader>
        <CardPanel>
            <form method="POST" onsubmit={save} class="space-y-4" aria-busy={pending}>
                <Field><Label for="profile-name">Full name</Label><Input id="profile-name" autocomplete="name" bind:value={name} required maxlength={100} pattern=".*\S.*" disabled={!ready || pending} /></Field>
                <Field><Label for="profile-email">Email</Label><Input id="profile-email" type="email" value={data.user.email} readonly /></Field>
                {#if error}
                    <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
                {/if}
                {#if saved}
                    <Alert variant="success" role="status"><AlertDescription>Profile updated.</AlertDescription></Alert>
                {/if}
                <Button type="submit" disabled={!ready || name.trim() === data.user.name} loading={pending}>Save changes</Button>
            </form>
        </CardPanel>
    </Card>
</div>
