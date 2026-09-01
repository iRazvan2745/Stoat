import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { createUncloudClient } from "#lib/server/uncloud";

describe("createUncloudClient", () => {
    it("uses the data source URL and token", async () => {
        let authorization: string | undefined;
        let requestPath: string | undefined;
        const server = createServer((request, response) => {
            ({ authorization } = request.headers);
            requestPath = request.url;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ domain: "example.internal" }));
        });

        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const { port } = server.address() as AddressInfo;

        try {
            const client = createUncloudClient({
                uncloudToken: "workspace-token",
                uncloudUrl: `127.0.0.1:${port}`,
            });
            const { data, response } = await client.GET("/api/v1/cluster/domain");

            expect(response.status).toBe(200);
            expect(data?.domain).toBe("example.internal");
            expect(requestPath).toBe("/api/v1/cluster/domain");
            expect(authorization).toBe("Bearer workspace-token");
        } finally {
            server.close();
            await once(server, "close");
        }
    });
});
