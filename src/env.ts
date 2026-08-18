import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  BETTER_AUTH_SECRET: {
    description:
      "Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).",
  },
  DATABASE_URL: { description: "The database connection string." },
  DATA_DIR: {
    description: "This is optional, youre not gonna use this.",
  },
  ORIGIN: {
    description: "The app origin (base URL), e.g. `http://localhost:5173`.",
  },
  UNCLOUD_API: {
    description: "The Uncloud API origin, without the `/api/v1` path`.",
  },
});
