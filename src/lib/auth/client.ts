import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/svelte";

export const authClient = createAuthClient({
    plugins: [organizationClient(), adminClient()],
});

export const { signIn, signUp, useSession } = authClient;
