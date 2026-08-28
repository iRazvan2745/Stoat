import { ALLOW_SIGNUP, BETTER_AUTH_SECRET, ORIGIN } from "$app/env/private";
import { getRequestEvent } from "$app/server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin, organization } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";

import { db } from "#lib/db";

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
  baseURL: ORIGIN,
  database: drizzleAdapter(db, { provider: "pg" }),
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
            console.error(`Failed to provision default organization for user ${user.id}`, error);
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
  secret: BETTER_AUTH_SECRET,
});
