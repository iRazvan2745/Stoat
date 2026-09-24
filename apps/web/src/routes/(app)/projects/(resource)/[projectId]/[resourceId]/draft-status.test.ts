import { setHeaderActions } from "$lib/components/sidebar/header-actions";
import { orpc } from "$lib/orpc";
import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";
import { setContext } from "svelte";
import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import ResourcePage from "./+page.svelte";

it("restores the saved-draft message from loaded data without a successful save mutation", () => {
    const input = { projectId: "project", resourceId: "resource" };
    const spec = "services:\n  web:\n    image: nginx:alpine\n";
    const timestamp = new Date("2026-09-22T00:00:00Z");

    for (const [draftSpec, deployedSpec, hasDraft] of [
        [spec, null, true],
        [`${spec}# Updated draft\n`, spec, true],
        [spec, spec, false],
        [null, null, false],
    ] as const) {
        const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
        cache.setQueryData(orpc.projects.listProjects.queryKey(), [{
            id: input.projectId,
            name: "Project",
            description: null,
            clusterId: "cluster",
            resourceCount: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
        }]);
        cache.setQueryData(orpc.resources.getResource.queryKey({ input }), {
            id: input.resourceId,
            projectId: input.projectId,
            name: "Resource",
            description: null,
            icon: null,
            type: "compose",
            spec: deployedSpec,
            draftSpec,
            settings: null,
            gitConnectionId: null,
            gitSource: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        function PageWithContext(...args: Parameters<typeof ResourcePage>) {
            setQueryClientContext(cache);
            setHeaderActions({});
            setContext("__request__", { page: { params: input } });
            setContext(Symbol.for("nuqs-svelte-adapter"), {
                useAdapter: () => ({ searchParams: () => new URLSearchParams() }),
            });

            return ResourcePage(...args);
        }

        try {
            const { body } = render(PageWithContext);
            expect(body).toContain("Docker Compose");
            expect(body.includes("Draft saved. Not deployed.")).toBe(hasDraft);
            expect(cache.getMutationCache().getAll().every((mutation) => mutation.state.status === "idle")).toBe(true);
        } finally {
            cache.clear();
        }
    }
});
