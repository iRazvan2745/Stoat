<script lang="ts">
    import { goto } from "$app/navigation";
    import lockIcon from "@ktibow/iconset-material-symbols/lock-outline";
    import mailIcon from "@ktibow/iconset-material-symbols/mail-outline";
    import personIcon from "@ktibow/iconset-material-symbols/person-outline";
    import visibilityIcon from "@ktibow/iconset-material-symbols/visibility";
    import visibilityOffIcon from "@ktibow/iconset-material-symbols/visibility-off";
    import {
        Button,
        Card,
        LoadingIndicator,
        Tabs,
        TextFieldOutlined,
    } from "m3-svelte";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";

    import stoatLogo from "#lib/assets/stoat.png";
    import { authClient } from "#lib/auth/client";

    const POST_AUTH_PATH = "/workspace";
    const MIN_PASSWORD_LENGTH = 8;

    let { data } = $props();

    let mode = useQueryState(
        "mode",
        parseAsStringLiteral(["sign-in", "register"]).withDefault("sign-in")
    );
    let email = $state("");
    let password = $state("");
    let name = $state("");
    let errorMessage = $state("");
    let isSubmitting = $state(false);
    let showPassword = $state(false);

    const isRegister = $derived(
        data.allowSignup && mode.current === "register"
    );
    const passwordType = $derived(showPassword ? "text" : "password");
    const passwordAutocomplete = $derived(
        isRegister ? "new-password" : "current-password"
    );
    const submitLabel = $derived(isRegister ? "Create account" : "Sign in");
    const submittingLabel = $derived(
        isRegister ? "Creating account" : "Signing in"
    );

    const handleModeChange = (): void => {
        errorMessage = "";
        showPassword = false;
    };

    const submit = async (): Promise<void> => {
        errorMessage = "";
        isSubmitting = true;

        try {
            if (isRegister) {
                const { error } = await authClient.signUp.email({
                    callbackURL: POST_AUTH_PATH,
                    email,
                    name: name.trim(),
                    password,
                });

                if (error) {
                    errorMessage = error.message ?? "Unable to create account";
                    return;
                }
            } else {
                const { error } = await authClient.signIn.email({
                    email,
                    password,
                });

                if (error) {
                    errorMessage = error.message ?? "Unable to sign in";
                    return;
                }
            }

            await goto(POST_AUTH_PATH, { replaceState: true });
        } finally {
            isSubmitting = false;
        }
    };

    const handleSubmit = async (event: SubmitEvent): Promise<void> => {
        event.preventDefault();
        await submit();
    };
</script>

<svelte:head>
    <title>Stoat</title>
</svelte:head>

<div class="flex min-h-svh items-center justify-center p-4">
    <div class="login-card w-[min(24rem,100%)]">
        <Card variant="elevated">
            <div class="flex flex-col items-center text-center">
                <img
                    src={stoatLogo}
                    alt=""
                    width="80"
                    height="80"
                    class="size-20 rounded-xl object-cover"
                />
                <h1 class="m3-font-headline-medium text-on-surface mt-4">Stoat</h1>
                <p class="m3-font-body-medium text-on-surface-variant mt-1">
                    {isRegister
                        ? "Create an account to get started"
                        : "Sign in to continue"}
                </p>
            </div>

            {#if data.allowSignup}
                <div class="tabs">
                    <Tabs
                        secondary
                        bind:tab={mode.current}
                        items={[
                            { name: "Sign in", value: "sign-in" },
                            { name: "Create account", value: "register" },
                        ]}
                        onchange={handleModeChange}
                    />
                </div>
            {/if}

            <form class="flex flex-col gap-4" onsubmit={handleSubmit}>
                {#if isRegister}
                    <div class="field">
                        <TextFieldOutlined
                            bind:value={name}
                            label="Name"
                            name="name"
                            autocomplete="name"
                            leadingIcon={personIcon}
                            required
                            disabled={isSubmitting}
                        />
                    </div>
                {/if}

                <div class="field">
                    <TextFieldOutlined
                        bind:value={email}
                        label="Email"
                        name="email"
                        type="email"
                        autocomplete="email"
                        leadingIcon={mailIcon}
                        required
                        spellcheck="false"
                        disabled={isSubmitting}
                        error={Boolean(errorMessage)}
                    />
                </div>

                <div class="field">
                    <TextFieldOutlined
                        bind:value={password}
                        label="Password"
                        name="password"
                        type={passwordType}
                        autocomplete={passwordAutocomplete}
                        leadingIcon={lockIcon}
                        minlength={MIN_PASSWORD_LENGTH}
                        required
                        disabled={isSubmitting}
                        error={Boolean(errorMessage)}
                        trailing={{
                            "aria-label": showPassword
                                ? "Hide password"
                                : "Show password",
                            icon: showPassword
                                ? visibilityOffIcon
                                : visibilityIcon,
                            onclick: () => (showPassword = !showPassword),
                        }}
                    />
                </div>

                {#if errorMessage}
                    <p class="m3-font-body-small text-error" role="alert">{errorMessage}</p>
                {/if}

                <div class="submit">
                    <Button disabled={isSubmitting} aria-busy={isSubmitting}>
                        {#if isSubmitting}
                            <LoadingIndicator
                                size={18}
                                center={false}
                                aria-label={submittingLabel}
                            />
                            {submittingLabel}...
                        {:else}
                            {submitLabel}
                        {/if}
                    </Button>
                </div>
            </form>
        </Card>
    </div>
</div>

<style>
    .login-card > :global(.m3-container) {
        gap: 1.5rem;
        padding: 2rem;
    }

    .tabs :global(.m3-container) {
        width: 100%;
        background-color: transparent;
    }

    .field :global(.m3-container),
    .submit :global(.m3-container) {
        width: 100%;
        min-width: 0;
    }
</style>
