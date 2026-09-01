import { ALLOW_SIGNUP, APP_SECRET, APP_URL } from "$app/env/private";
import { getRequestEvent } from "$app/server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin, organization } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { log as evlog } from "evlog";

import { db } from "#lib/db";
import * as schema from "#lib/db/schema";

// Registration is closed by default; set ALLOW_SIGNUP=true to open it.
export const isSignupAllowed = (): boolean => ALLOW_SIGNUP;

const slugify = (value: string): string =>
    value
        .toLowerCase()
        .normalize("NFKD")
        .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
        // oxlint-disable-next-line require-unicode-regexp
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 32);

export const auth = betterAuth({
    baseURL: APP_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    databaseHooks: {
        user: {
            create: {
                // Provision a personal organization (with an owner membership) for
                // every newly created user. Failures are logged, not thrown, so
                // signup itself never breaks.
                after: async (user) => {
                    const base = slugify(user.name) || "user";
                    try {
                        await auth.api.createOrganization({
                            body: {
                                name: `${user.name}'s Org`,
                                slug: `${base}-${crypto.randomUUID().slice(0, 8)}`,
                                userId: user.id,
                            },
                        });
                    } catch (error) {
                        evlog.error({
                            action: "auth.provision_default_organization",
                            error: error instanceof Error ? error.message : String(error),
                            outcome: "failed",
                            userId: user.id,
                        });
                    }
                },
            },
        },
    },
    emailAndPassword: { disableSignUp: !isSignupAllowed(), enabled: true },
    plugins: [
        organization(),
        admin(),
        // Keep the cookie plugin last in the array.
        sveltekitCookies(getRequestEvent),
    ],
    secret: APP_SECRET,
});
