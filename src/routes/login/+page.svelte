<script lang="ts">
  import { browser } from "$app/env";
  import { goto } from "$app/navigation";

  import { authClient } from "#lib/auth-client";

  const sessionResponse = browser ? await authClient.getSession() : null;

  if (browser && sessionResponse?.data) {
    await goto("/demo/better-auth", { replaceState: true });
  }

  let email = $state("");
  let password = $state("");
  let name = $state("");
  let errorMessage = $state("");
  let isSubmitting = $state(false);

  const signIn = async (): Promise<void> => {
    errorMessage = "";
    isSubmitting = true;

    const { error } = await authClient.signIn.email({
      email,
      password,
    });

    isSubmitting = false;

    if (error) {
      errorMessage = error.message ?? "Unable to sign in";
      return;
    }

    await goto("/demo/better-auth", { replaceState: true });
  };

  const signUp = async (): Promise<void> => {
    errorMessage = "";
    isSubmitting = true;

    const { error } = await authClient.signUp.email({
      callbackURL: "/demo/better-auth",
      email,
      name,
      password,
    });

    isSubmitting = false;

    if (error) {
      errorMessage = error.message ?? "Unable to register";
      return;
    }

    await goto("/demo/better-auth", { replaceState: true });
  };

  const handleSignIn = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    await signIn();
  };
</script>

<h1>Login</h1>
<form onsubmit={handleSignIn}>
  <label>
    Email
    <input bind:value={email} type="email" name="email" required />
  </label>
  <label>
    Password
    <input bind:value={password} type="password" name="password" required />
  </label>
  <label>
    Name (for registration)
    <input bind:value={name} name="name" />
  </label>
  <button
    type="submit"
    disabled={isSubmitting}
    class="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
  >
    Login
  </button>
  <button
    type="button"
    onclick={signUp}
    disabled={isSubmitting}
    class="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
  >
    Register
  </button>
</form>

{#if errorMessage}
  <p class="text-red-500">{errorMessage}</p>
{/if}
