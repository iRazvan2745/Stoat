import { defineEnvVars } from "@sveltejs/kit/env";
import * as v from "valibot";

export const variables = defineEnvVars({
    ALLOW_SIGNUP: {
        description: "Whether to allow signup. Set to `true` to allow signup.",
        schema: v.pipe(
            v.optional(v.string(), "false"),
            v.transform((value) => value === "true"),
        ),
    },
    APP_SECRET: {
        description:
            "Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).",
    },
    APP_URL: {
        description: "The public URL of the Stoat application.",
    },
    DATABASE_URL: { description: "The database connection string." },
    DATA_DIR: {
        description: "Optional root directory for local-development data sources.",
        schema: v.optional(v.string()),
    },
});
