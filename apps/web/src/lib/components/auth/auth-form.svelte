<script lang="ts">
    import { authClient } from "$lib/auth-client";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Field, FieldDescription } from "$lib/components/ui/field";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import AtSign from "@lucide/svelte/icons/at-sign";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Lock from "@lucide/svelte/icons/lock";
    import User from "@lucide/svelte/icons/user";
    import { onMount } from "svelte";

    let { signup = false }: { signup?: boolean } = $props();

    let name = $state("");

    let email = $state("");

    let password = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    onMount(() => { ready = true; });

    async function submit(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";

        try {
            const credentials = { email: email.trim(), password };

            const result = signup
                ? await authClient.signUp.email({ ...credentials, name: name.trim() })
                : await authClient.signIn.email(credentials);

            if (result.error) {
                error = result.error.message ?? "Unable to continue. Please try again.";

                return;
            }

            // A full navigation also clears data cached for a previous account.
            window.location.assign("/");
        } catch {
            error = "We couldn't connect. Check your connection and try again.";
        } finally {
            pending = false;
        }
    }
</script>

<svelte:head>
    <title>{signup ? "Create your account" : "Log in"} / Stoat</title>
    <meta name="description" content="Your infrastructure, together. Access your Stoat organization." />
</svelte:head>

<main class="relative mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-8 p-6 md:p-8">
    <div class="flex flex-col gap-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-600">
        <a href="/" class="flex w-fit items-center gap-2" aria-label="Stoat home">
            <Boxes class="size-10" aria-hidden="true" />
            <span class="text-lg font-semibold">Stoat</span>
        </a>
        <div class="flex flex-col gap-1">
            <h1 class="text-2xl font-bold tracking-wide">{signup ? "Create your account" : "Welcome back"}</h1>
            <p class="text-base text-muted-foreground">{signup ? "Get started with your own organization." : "Log in to your Stoat workspace."}</p>
        </div>
        <form method="POST" onsubmit={submit} class="flex flex-col gap-2" aria-busy={pending}>
            {#if signup}
                <Field>
                    <Label for="name" class="sr-only">Full name</Label>
                    <InputGroup>
                        <InputGroupInput id="name" name="name" autocomplete="name" placeholder="Full name" bind:value={name} required maxlength={100} pattern=".*\S.*" disabled={!ready || pending} />
                        <InputGroupAddon align="inline-start"><User aria-hidden="true" /></InputGroupAddon>
                    </InputGroup>
                </Field>
            {/if}
            <Field>
                <Label for="email" class="sr-only">Email</Label>
                <InputGroup>
                    <InputGroupInput id="email" name="email" type="email" autocomplete="email" placeholder="your.email@example.com" bind:value={email} required disabled={!ready || pending} />
                    <InputGroupAddon align="inline-start"><AtSign aria-hidden="true" /></InputGroupAddon>
                </InputGroup>
            </Field>
            <Field>
                <Label for="password" class="sr-only">Password</Label>
                <InputGroup>
                    <InputGroupInput id="password" name="password" type="password" placeholder="Password" autocomplete={signup ? "new-password" : "current-password"} bind:value={password} required minlength={signup ? 8 : undefined} maxlength={128} disabled={!ready || pending} aria-describedby={signup ? "password-hint" : undefined} />
                    <InputGroupAddon align="inline-start"><Lock aria-hidden="true" /></InputGroupAddon>
                </InputGroup>
                {#if signup}<FieldDescription id="password-hint">Use at least 8 characters.</FieldDescription>{/if}
            </Field>
            {#if error}
                <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
            {/if}
            <Button type="submit" disabled={!ready} class="mt-3 w-full" size="sm" loading={pending}>{signup ? "Create account" : "Log in"}</Button>
        </form>
    </div>
    <p class="text-center text-sm text-muted-foreground">
        {signup ? "Already have an account?" : "New to Stoat?"}
        <a class="ml-1 underline underline-offset-4 hover:text-primary" href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Create an account"}</a>
    </p>
</main>
