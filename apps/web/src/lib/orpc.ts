import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@stoat/api/routers/index";
import { QueryCache, QueryClient } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      console.error(`Error: ${error.message}`);
    },
  }),
});

export const link = new RPCLink({
  url: () => {
    if (typeof window === "undefined") {
      throw new Error("This link is not allowed on the server side.");
    }

    return `${window.location.origin}/rpc`;
  },
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: "include",
    });
  },
});

export const client: AppRouterClient = globalThis.$client ?? createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
