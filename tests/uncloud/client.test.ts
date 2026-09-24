import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { UcApiError, encodeComposeFile, ucClient, unwrap } from "../../packages/uncloud/src/index";

/**
 * Exercises the client against a real HTTP server rather than a mocked fetch, so
 * URL building, query serialisation and streaming are all covered end to end.
 */
let server: Server;

let baseUrl: string;

const received: { method: string; url: string; body: string; authorization: string }[] = [];

const testToken = "test-token-0123456789";

beforeAll(async () => {
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const url = req.url ?? "";
            received.push({
                method: req.method ?? "",
                url,
                body: Buffer.concat(chunks).toString("utf8"),
                authorization: req.headers.authorization ?? "",
            });
            const path = url.split("?")[0] ?? "";

            if (path === "/api/v1/machines") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ items: [{ id: "m1", name: "node-1", state: "up" }] }));

                return;
            }

            if (path === "/api/v1/services/missing") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "service not found" }));

                return;
            }

            if (path === "/api/v1/machines/nope/logs") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "unknown system service" }));

                return;
            }

            if (
                path.endsWith("/logs") ||
                path.endsWith("/exec/stream") ||
                path.endsWith("/compose")
            ) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write('data: {"stream":"stdout","timestamp":"2026-01-01T00:00:00Z"');
                res.write(',"message":"hello"}\n\n');
                res.write(
                    'data: {"stream":"stderr","timestamp":"2026-01-01T00:00:01Z","message":"bye"}\n\n',
                );
                res.end();

                return;
            }

            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unexpected route" }));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen above bound a TCP port, so address() cannot be a pipe path or null.
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
    );
});

function client() {
    return ucClient(`${baseUrl}/`, { token: testToken });
}

describe("ucClient", () => {
    it("strips a trailing slash from the base URL", () => {
        expect(client().baseUrl).toBe(baseUrl);
    });

    it("targets whichever sidecar URL it is given", async () => {
        // The URL is a parameter, so two clients in one process can address
        // different clusters independently.
        const a = ucClient("http://cluster-a.internal");
        const b = ucClient("https://cluster-b.internal:8443/");
        expect([a.baseUrl, b.baseUrl]).toEqual([
            "http://cluster-a.internal",
            "https://cluster-b.internal:8443",
        ]);
    });

    it.each([
        ["empty", ""],
        ["whitespace", "   "],
        ["relative", "/api/v1"],
        ["host only", "sidecar.internal"],
        ["unsupported protocol", "file:///etc/passwd"],
    ])("rejects an invalid sidecar URL (%s)", (_label, url) => {
        expect(() => ucClient(url)).toThrow(TypeError);
    });

    it("names the offending value in the error message", () => {
        expect(() => ucClient("sidecar.internal")).toThrow(/sidecar\.internal/);
    });

    it("performs a typed GET and returns data", async () => {
        const { data, error } = await client().GET("/api/v1/machines");
        expect(error).toBeUndefined();
        expect(data?.items[0]?.name).toBe("node-1");
    });

    it("sends the bearer token on every request", async () => {
        received.length = 0;
        await client().GET("/api/v1/machines");
        expect(received[0]?.authorization).toBe(`Bearer ${testToken}`);
    });

    it("sends the bearer token on streaming requests too", async () => {
        // Streams take a different code path through the client, so the default
        // header has to be verified separately.
        received.length = 0;

        for await (const _ of client().stream.serviceLogs("web", { tail: 1 })) {
            // drain
        }

        expect(received[0]?.authorization).toBe(`Bearer ${testToken}`);
    });

    it("omits the Authorization header when no token is given", async () => {
        received.length = 0;
        await ucClient(baseUrl).GET("/api/v1/machines");
        expect(received[0]?.authorization).toBe("");
    });

    it.each(["Authorization", "authorization"])(
        "lets an explicit %s header override the token",
        async (name) => {
            received.length = 0;
            await ucClient(baseUrl, {
                token: testToken,
                headers: { [name]: "Bearer override" },
            }).GET("/api/v1/machines");
            expect(received[0]?.authorization).toBe("Bearer override");
        },
    );

    it("serialises query parameters", async () => {
        received.length = 0;
        await client().GET("/api/v1/machines", {
            params: { query: { available: true, names: "node-1,node-2" } },
        });
        expect(received[0]?.url).toContain("available=true");
        expect(received[0]?.url).toContain("names=node-1%2Cnode-2");
    });

    it("returns errors as values rather than throwing", async () => {
        const { data, error } = await client().GET("/api/v1/services/{id}", {
            params: { path: { id: "missing" } },
        });

        expect(data).toBeUndefined();
        expect(error?.error).toBe("service not found");
    });

    it("normalizes malformed error bodies without reflecting their contents", async () => {
        const uc = ucClient(baseUrl, {
            fetch: async () => Response.json({ error: { token: "private" } }, { status: 502 }),
        });

        const result = await uc.GET("/api/v1/machines");

        expect(result.error).toEqual({ error: "Sidecar request failed: 502 " });
        expect(
            new UcApiError(result.response, { error: { token: "private" } }).body,
        ).toBeUndefined();
        await expect(unwrap(Promise.resolve(result))).rejects.toMatchObject({ status: 502 });
    });

    it("unwrap() throws UcApiError carrying the status and message", async () => {
        const promise = unwrap(
            client().GET("/api/v1/services/{id}", { params: { path: { id: "missing" } } }),
        );

        await expect(promise).rejects.toBeInstanceOf(UcApiError);
        await expect(promise).rejects.toMatchObject({
            status: 404,
            message: "service not found",
        });
    });

    it("unwrap() returns the payload on success", async () => {
        const data = await unwrap(client().GET("/api/v1/machines"));
        expect(data.items).toHaveLength(1);
    });
});

describe("stream helpers", () => {
    it("streams typed service log events", async () => {
        const events = [];

        for await (const event of client().stream.serviceLogs("web", { follow: true, tail: 10 })) {
            events.push(event);
        }

        expect(events.map((e) => e.message)).toEqual(["hello", "bye"]);
        expect(events[0]?.stream).toBe("stdout");
    });

    it("passes the service id in the path and options as query params", async () => {
        received.length = 0;

        for await (const _ of client().stream.serviceLogs("web", { tail: 10 })) {
            // drain
        }

        expect(received[0]?.url).toContain("/api/v1/services/web/logs");
        expect(received[0]?.url).toContain("tail=10");
    });

    it("streams machine exec events and sends the command body", async () => {
        received.length = 0;
        const events = [];

        for await (const event of client().stream.machineExec("m1", { command: ["uptime"] })) {
            events.push(event);
        }

        expect(events).toHaveLength(2);
        expect(JSON.parse(received[0]?.body ?? "{}")).toEqual({ command: ["uptime"] });
    });

    it("sends base64 compose content and deploy options", async () => {
        received.length = 0;
        const compose = encodeComposeFile("services:\n  web:\n    image: nginx\n");

        for await (const _ of client().stream.deployCompose(compose, { recreate: true })) {
            // drain
        }

        const body = JSON.parse(received[0]?.body ?? "{}");
        expect(Buffer.from(body.compose, "base64").toString("utf8")).toContain("image: nginx");
        expect(body.options).toEqual({ recreate: true });
    });

    it("throws UcApiError carrying the JSON error body when a stream endpoint fails", async () => {
        const iterate = async () => {
            for await (const _ of client().stream.machineLogs("nope", { service: "bogus" })) {
                // never reached
            }
        };

        await expect(iterate()).rejects.toBeInstanceOf(UcApiError);
        await expect(iterate()).rejects.toMatchObject({
            status: 400,
            message: "unknown system service",
        });
    });

    it("stops when the abort signal fires", async () => {
        const controller = new AbortController();

        const iterate = async () => {
            for await (const _ of client().stream.serviceLogs("web", {
                signal: controller.signal,
            })) {
                controller.abort();
            }
        };

        await expect(iterate()).rejects.toThrow();
    });
});

describe("encodeComposeFile", () => {
    it("round-trips non-ASCII content", () => {
        const original = "# café ☕\nservices: {}\n";
        expect(Buffer.from(encodeComposeFile(original), "base64").toString("utf8")).toBe(original);
    });
});
