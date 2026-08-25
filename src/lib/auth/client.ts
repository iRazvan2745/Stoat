import { createAuthClient } from "better-auth/svelte";

export const authClient = createAuthClient({});

export const { signIn, signUp, useSession } = authClient;
