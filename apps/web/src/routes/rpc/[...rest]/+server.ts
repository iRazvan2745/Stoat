import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { appRouter } from "@stoat/api/routers/index";
import type { RequestHandler } from "@sveltejs/kit";

import { createContext } from "../../../context";

const rpcHandler = new RPCHandler(appRouter, {
    interceptors: [
        onError((error) => {
            console.error(error);
        }),
    ],
});

const openAPIGenerator = new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter(), new ValibotToJsonSchemaConverter()],
});

const apiHandler = new OpenAPIHandler(appRouter, {
    plugins: [
        new OpenAPIReferenceHandlerPlugin({
            spec: () =>
                openAPIGenerator.generate(appRouter, {
                    version: "3.1.1",
                    base: {
                        info: {
                            title: "Stoat API",
                            version: "1.0.0",
                        },
                    },
                }),
        }),
    ],
    interceptors: [
        onError((error) => {
            console.error(error);
        }),
    ],
});

const handle: RequestHandler = async ({ request }) => {
    const context = await createContext({
        headers: request.headers,
    });

    const rpcResult = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context,
    });

    if (rpcResult.response) return rpcResult.response;

    const apiResult = await apiHandler.handle(request, {
        prefix: "/rpc/api-reference",
        context,
    });

    if (apiResult.response) return apiResult.response;

    return new Response("Not found", { status: 404 });
};

export const HEAD = handle;

export const GET = handle;

export const POST = handle;

export const PUT = handle;

export const PATCH = handle;

export const DELETE = handle;
