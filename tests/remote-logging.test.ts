import { setTimeout as wait } from "node:timers/promises";

import { initLogger } from "evlog";
import { createEvlogHooks } from "evlog/sveltekit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
    inspectRemoteResponse,
    parseRemoteInvocation,
    summarizeRemoteInput,
    withRemoteLiveLogging,
    withRemoteLogging,
} from "#lib/api/remote-logging";

afterEach(() => {
    initLogger({ env: { service: "app" }, redact: true });
});

const streamDeploymentLogs = async function* streamDeploymentLogs(): AsyncGenerator<string> {
    yield "deployment started";
};

describe("summarizeRemoteInput", () => {
    it("keeps identifiers and shape while omitting payload values", () => {
        const summary = summarizeRemoteInput({
            compose: "services:\n  web:\n    image: example/web",
            password: "do-not-log",
            serviceId: "service-123",
            settings: { autoDeploy: true },
            variables: [{ name: "TOKEN", value: "do-not-log" }],
        });

        expect(summary).toEqual({
            counts: { variables: 1 },
            identifiers: { serviceId: "service-123" },
            keys: ["compose", "password", "serviceId", "settings", "variables"],
            nestedKeys: { settings: ["autoDeploy"] },
            stringLengths: { compose: 39 },
            type: "object",
        });
    });

    it("describes scalar inputs without recording their value", () => {
        expect(summarizeRemoteInput("service-123")).toEqual({
            length: 11,
            type: "string",
        });
    });
});

describe("parseRemoteInvocation", () => {
    it("extracts the generated remote function identity and transport", () => {
        const request = new Request(
            "https://stoat.example/_app/remote/abc123/listServices?payload=private",
            {
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );

        expect(parseRemoteInvocation(request, "/cluster/services")).toEqual({
            functionId: "abc123/listServices",
            functionName: "listServices",
            hasAdditionalArguments: false,
            method: "POST",
            moduleHash: "abc123",
            pagePath: "/cluster/services",
            transport: "json",
        });
    });

    it("does not expose keyed remote arguments", () => {
        const request = new Request(
            "https://stoat.example/_app/remote/abc123/deleteWorkspace/%22workspace-123%22",
            { method: "GET" },
        );

        expect(parseRemoteInvocation(request)).toMatchObject({
            functionName: "deleteWorkspace",
            hasAdditionalArguments: true,
            transport: "get",
        });
        expect(parseRemoteInvocation(request)).not.toHaveProperty("workspace-123");
    });
});

describe("inspectRemoteResponse", () => {
    it("finds protocol errors even when the HTTP response is 200", async () => {
        const response = Response.json({
            error: { message: "Forbidden" },
            status: 403,
            type: "error",
        });

        await expect(inspectRemoteResponse(response)).resolves.toEqual({
            message: "Forbidden",
            outcome: "error",
            status: 403,
        });
    });

    it("leaves streaming responses alone", async () => {
        const response = new Response("data: live\n\n", {
            headers: { "content-type": "text/event-stream" },
        });

        await expect(inspectRemoteResponse(response)).resolves.toEqual({
            outcome: "success",
            status: 200,
        });
        await expect(response.text()).resolves.toBe("data: live\n\n");
    });
});

describe("withRemoteLogging", () => {
    it("records completion context in the request wide event", async () => {
        const events: Record<string, unknown>[] = [];
        initLogger({
            drain: ({ event }) => {
                events.push(event);
            },
            env: { environment: "test", service: "remote-logging-test" },
            pretty: false,
            redact: false,
            silent: true,
        });
        const hooks = createEvlogHooks({ redact: false });
        const run = withRemoteLogging(
            "resources.getResource",
            "query",
            (resourceId: string) => resourceId,
            { inputKey: "resourceId" },
        );
        const event = {
            locals: {},
            request: new Request("https://stoat.example/remote"),
            url: new URL("https://stoat.example/services"),
        };

        await hooks.handle({
            event,
            resolve: async () => {
                await run("resource-123");
                return new Response("ok");
            },
        });

        expect(events).toHaveLength(1);
        expect(events[0]?.remoteCalls).toEqual([
            {
                input: {
                    identifiers: { resourceId: "resource-123" },
                    keys: ["resourceId"],
                    type: "object",
                },
                operation: "resources.getResource",
                phase: "started",
                type: "query",
            },
            {
                input: {
                    identifiers: { resourceId: "resource-123" },
                    keys: ["resourceId"],
                    type: "object",
                },
                operation: "resources.getResource",
                phase: "completed",
                type: "query",
            },
        ]);
    });

    it("marks the wide event as an error and preserves the failure", async () => {
        const events: Record<string, unknown>[] = [];
        initLogger({
            drain: ({ event }) => {
                events.push(event);
            },
            env: { environment: "test", service: "remote-logging-test" },
            pretty: false,
            redact: false,
            silent: true,
        });
        const hooks = createEvlogHooks({ redact: false });
        const run = withRemoteLogging(
            "resources.deleteResource",
            "command",
            (resourceId: string) => {
                throw new Error(`Unable to delete ${resourceId}`);
            },
            { inputKey: "resourceId" },
        );
        const event = {
            locals: {},
            request: new Request("https://stoat.example/remote"),
            url: new URL("https://stoat.example/services"),
        };

        await expect(
            hooks.handle({
                event,
                resolve: async () => {
                    await run("resource-123");
                    return new Response("ok");
                },
            }),
        ).rejects.toThrow("Unable to delete resource-123");

        expect(events[0]?.level).toBe("error");
        expect(events[0]?.error).toMatchObject({
            message: "Unable to delete resource-123",
        });
        expect(events[0]?.remoteCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    operation: "resources.deleteResource",
                    phase: "failed",
                    type: "command",
                }),
            ]),
        );
    });

    it("keeps the request logger for a stream consumed after the handler returns", async () => {
        const events: Record<string, unknown>[] = [];
        initLogger({
            drain: ({ event }) => {
                events.push(event);
            },
            env: { environment: "test", service: "remote-logging-test" },
            pretty: false,
            redact: false,
            silent: true,
        });
        const hooks = createEvlogHooks({ redact: false });
        const run = withRemoteLiveLogging(
            "deployments.streamDeploymentLogs",
            () => streamDeploymentLogs(),
            { inputKey: "deploymentId" },
        );
        let iterator: AsyncGenerator<string> | undefined;
        const event = {
            isRemoteRequest: true,
            locals: {},
            request: new Request("https://stoat.example/_app/remote/hash/logs"),
            url: new URL("https://stoat.example/services"),
        };

        const response = await hooks.handle({
            event,
            resolve: () => {
                iterator = run("deployment-123");
                const body = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        const result = await iterator?.next();

                        if (!result || result.done) {
                            controller.close();
                            return;
                        }

                        controller.enqueue(new TextEncoder().encode(`data: ${result.value}\n\n`));
                    },
                });

                return new Response(body, {
                    headers: { "content-type": "text/event-stream" },
                });
            },
        });

        await expect(response.text()).resolves.toContain("deployment started");
        await wait(0);

        expect(events[0]?.remoteCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    input: {
                        identifiers: { deploymentId: "deployment-123" },
                        keys: ["deploymentId"],
                        type: "object",
                    },
                    operation: "deployments.streamDeploymentLogs",
                    phase: "started",
                    type: "query.live",
                }),
                expect.objectContaining({
                    operation: "deployments.streamDeploymentLogs",
                    phase: "completed",
                    type: "query.live",
                }),
            ]),
        );
    });
});
