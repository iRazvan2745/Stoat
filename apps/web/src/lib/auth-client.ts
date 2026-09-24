import { createAuthClient } from "better-auth/svelte";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [organizationClient()],
});
