import { ALLOW_SIGNUP, BETTER_AUTH_SECRET, ORIGIN } from "$app/env/private";
import { getRequestEvent } from "$app/server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { sveltekitCookies } from "better-auth/svelte-kit";

import { db } from "#lib/db";

// Registration is closed by default; set ALLOW_SIGNUP=true to open it.
export const isSignupAllowed = (): boolean => ALLOW_SIGNUP;

export const auth = betterAuth({
  baseURL: ORIGIN,
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { disableSignUp: !isSignupAllowed(), enabled: true },
  plugins: [
    // Keep the cookie plugin last in the array.
    sveltekitCookies(getRequestEvent),
  ],
  secret: BETTER_AUTH_SECRET,
});
