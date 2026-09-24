import { expect, it, vi } from "vite-plus/test";
import { render } from "svelte/server";
import ResourceLogs from "./resource-logs.svelte";

const { createQuery } = vi.hoisted(() => ({ createQuery: vi.fn() }));

vi.mock("@tanstack/svelte-query", async (importOriginal) => ({
    ...await importOriginal<typeof import("@tanstack/svelte-query")>(),
    createQuery,
}));

it("keeps the logs workspace skeleton until both queries are ready", () => {
    for (const [resourcePending, servicesPending] of [[true, true], [true, false], [false, true], [false, false]]) {
        createQuery.mockReturnValueOnce({ isPending: resourcePending });
        createQuery.mockReturnValueOnce({ isPending: servicesPending, data: { services: [] } });

        const { body } = render(ResourceLogs, { props: { projectId: "project", resourceId: "resource" } });

        if (resourcePending || servicesPending) {
            expect(body).toContain('loading-label="Loading logs"');
            expect(body).toContain('data-slot="frame"');
            expect(body).toContain('aria-label="Filter loaded logs"');
            expect(body).toContain('aria-label="Log activity"');
            expect(body.match(/class="log-row /g)).toHaveLength(16);
            expect(body).not.toContain("No deployed services");
        } else {
            expect(body).toContain("No deployed services");
            expect(body).not.toContain("<phantom-ui");
        }
    }
});
