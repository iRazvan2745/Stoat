import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { fetchUncloud, fetchUncloudStream } from "#lib/server/uncloud/fetch";

const listen = async (): Promise<{
    close: () => Promise<void>;
    url: string;
}> => {
    const server = createServer(() => {
        // Leave the socket open so the client hits the timeout.
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { port } = server.address() as AddressInfo;

    return {
        close: async () => {
            server.close();
            await once(server, "close");
        },
        url: `http://127.0.0.1:${port}/`,
    };
};

describe("fetchUncloud", () => {
    it("fails instead of hanging when Uncloud never responds", async () => {
        const server = await listen();

        try {
            await expect(fetchUncloud(new Request(server.url), 50)).rejects.toThrow(
                "Uncloud API timed out.",
            );
        } finally {
            await server.close();
        }
    });
});

describe("fetchUncloudStream", () => {
    it("fails when Uncloud never sends response headers", async () => {
        const server = await listen();

        try {
            await expect(fetchUncloudStream(new Request(server.url), 50)).rejects.toThrow(
                "Uncloud API timed out.",
            );
        } finally {
            await server.close();
        }
    });

    it("keeps streaming bodies alive past the headers timeout", async () => {
        const server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("first\n");
            setTimeout(() => {
                response.end("second\n");
            }, 150);
        });

        server.listen(0, "127.0.0.1");
        await once(server, "listening");

        const { port } = server.address() as AddressInfo;

        try {
            const response = await fetchUncloudStream(new Request(`http://127.0.0.1:${port}/`), 50);
            const body = await response.text();

            expect(body).toBe("first\nsecond\n");
        } finally {
            server.close();
            await once(server, "close");
        }
    });
});
