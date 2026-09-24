import { ofetch, type FetchOptions as OfetchOptions, type ResponseType } from "ofetch";
import * as z from "zod";

import { errorResponseSchema, UcApiError } from "./errors";
import type { paths } from "./generated/schema";
import { readSseJson } from "./sse";
import type {
    DeployComposeEvent,
    ErrorResponse,
    LogEvent,
    MachineExecEvent,
    MachineExecRequest,
} from "./types";

export { UcApiError, unwrap } from "./errors";

export { readSseJson, readSseMessages, type SseMessage } from "./sse";

export type * from "./types";

export type { paths } from "./generated/schema";

export type UcClientOptions = {
    /**
     * Bearer token for the sidecar.
     *
     * Required in practice: the sidecar rejects every endpoint except
     * `/healthz` with a 401 without it. It is optional here only so a
     * health-probe client can be built without a credential.
     */
    token?: string;
    /** Custom fetch, mainly for tests. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Headers sent with every request. */
    headers?: Record<string, string>;
};

/** Shared options for the Server-Sent Event helpers. */
export type StreamOptions = {
    /** Abort the request and end the iterator. Always pass one for followed logs. */
    signal?: AbortSignal;
};

/** Query parameters for the log streaming endpoints. */
type LogQuery = NonNullable<paths["/api/v1/services/{id}/logs"]["get"]["parameters"]["query"]>;

export type ServiceLogsOptions = StreamOptions & LogQuery;

export type MachineLogsOptions = StreamOptions &
    NonNullable<paths["/api/v1/machines/{id}/logs"]["get"]["parameters"]["query"]>;

type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

type ParseAs = ResponseType;

type PathOperation<Path extends keyof paths, Method extends HttpMethod> = NonNullable<
    paths[Path][Method]
>;

type PathsWithMethod<Method extends HttpMethod> = {
    [Path in keyof paths]: [PathOperation<Path, Method>] extends [never] ? never : Path;
}[keyof paths];

type OperationParameter<Operation, Parameter extends "path" | "query"> = Operation extends {
    parameters: infer Parameters;
}
    ? Parameters extends { [Key in Parameter]?: infer Value }
        ? NonNullable<Value>
        : never
    : never;

type PathParameters<Operation> = OperationParameter<Operation, "path">;

type QueryParameters<Operation> = OperationParameter<Operation, "query">;

type RequestBody<Operation> = Operation extends { requestBody?: infer Body }
    ? NonNullable<Body> extends { content: infer Content }
        ? Content extends Record<string, infer Value>
            ? Value
            : never
        : never
    : never;

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

type ResponseContent<Response> = Response extends { content: infer Content }
    ? Content extends Record<string, infer Value>
        ? Value
        : never
    : never;

type SuccessContent<Responses> = Responses extends object
    ? ResponseContent<
          {
              [Status in keyof Responses]: Status extends SuccessStatus ? Responses[Status] : never;
          }[keyof Responses]
      >
    : never;

type SuccessPayload<Operation> = Operation extends { responses: infer Responses }
    ? SuccessContent<Responses> extends never
        ? unknown
        : SuccessContent<Responses>
    : unknown;

type ParsedPayload<Payload, Response extends ParseAs> = Response extends "json"
    ? Payload
    : Response extends "stream"
      ? ReadableStream<Uint8Array> | null
      : Response extends "text"
        ? string
        : Response extends "blob"
          ? Blob
          : Response extends "arrayBuffer"
            ? ArrayBuffer
            : Payload;

type ClientResult<Data> =
    | { data: Data; error?: never; response: Response }
    | { data?: never; error: ErrorResponse; response: Response };

type RequestParams<Operation> = [PathParameters<Operation>] extends [never]
    ? [QueryParameters<Operation>] extends [never]
        ? { params?: never }
        : { params?: { query?: QueryParameters<Operation> } }
    : { params: { path: PathParameters<Operation>; query?: QueryParameters<Operation> } };

type RequestBodyOption<Operation> = [RequestBody<Operation>] extends [never]
    ? { body?: never }
    : { body: RequestBody<Operation> };

type RequestOptions<Operation, Response extends ParseAs = "json"> = RequestParams<Operation> &
    RequestBodyOption<Operation> &
    Omit<RequestInit, "body" | "headers" | "method"> & {
        headers?: RequestInit["headers"];
        parseAs?: Response;
    };

type RequestArguments<Operation, Response extends ParseAs> = [PathParameters<Operation>] extends [
    never,
]
    ? [RequestBody<Operation>] extends [never]
        ? [options?: RequestOptions<Operation, Response>]
        : [options: RequestOptions<Operation, Response>]
    : [options: RequestOptions<Operation, Response>];

type ClientMethod<Method extends HttpMethod> = <
    Path extends PathsWithMethod<Method>,
    Response extends ParseAs = "json",
>(
    path: Path,
    ...options: RequestArguments<PathOperation<Path, Method>, Response>
) => Promise<ClientResult<ParsedPayload<SuccessPayload<PathOperation<Path, Method>>, Response>>>;

type ClientRequest = <
    Method extends HttpMethod,
    Path extends PathsWithMethod<Method>,
    Response extends ParseAs = "json",
>(
    method: Method,
    path: Path,
    ...options: RequestArguments<PathOperation<Path, Method>, Response>
) => Promise<ClientResult<ParsedPayload<SuccessPayload<PathOperation<Path, Method>>, Response>>>;

type ParameterValue = string | number | boolean | null | undefined;

type QueryValue = ParameterValue | ParameterValue[] | Record<string, ParameterValue>;

type TransportOptions = Omit<RequestInit, "body" | "headers" | "method"> & {
    params?: { path?: Record<string, ParameterValue>; query?: Record<string, QueryValue> };
    body?: OfetchOptions["body"];
    parseAs?: ParseAs;
    headers?: RequestInit["headers"];
};

const queryRecordSchema = z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]),
);

function replacePathParameters(
    path: string,
    parameters: Record<string, ParameterValue> | undefined,
): string {
    return path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
        const value = parameters?.[name];

        if (value === undefined || value === null) {
            throw new TypeError(`Missing path parameter ${JSON.stringify(name)} for ${path}.`);
        }

        return encodeURIComponent(String(value));
    });
}

function appendQuery(path: string, query: Record<string, QueryValue> | undefined): string {
    if (!query) {
        return path;
    }

    const search: string[] = [];

    for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null) {
                    search.push(`${name}=${encodeURIComponent(String(item))}`);
                }
            }

            continue;
        }

        const record = queryRecordSchema.safeParse(value);

        if (record.success) {
            for (const [key, item] of Object.entries(record.data)) {
                if (item !== undefined && item !== null) {
                    search.push(`${name}[${key}]=${encodeURIComponent(String(item))}`);
                }
            }

            continue;
        }

        search.push(`${name}=${encodeURIComponent(String(value))}`);
    }

    if (search.length === 0) {
        return path;
    }

    return `${path}${path.includes("?") ? "&" : "?"}${search.join("&")}`;
}

/**
 * Validates a sidecar URL and strips any trailing slash.
 *
 * Worth doing eagerly: the URL now arrives at runtime (from a cluster record,
 * config, or an operator) rather than being checked once at boot, so a bad value
 * would otherwise surface as a confusing fetch failure much later. Restricting
 * the protocol also stops a stored value from reaching `file:` or similar.
 */
function normalizeSidecarUrl(sidecarUrl: string): string {
    const trimmed = sidecarUrl.trim();

    if (trimmed === "") {
        throw new TypeError("Sidecar URL is empty.");
    }

    let parsed: URL;

    try {
        parsed = new URL(trimmed);
    } catch {
        throw new TypeError(
            `Invalid sidecar URL: ${JSON.stringify(sidecarUrl)}. Expected an absolute URL such as "http://sidecar.internal".`,
        );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError(
            `Unsupported sidecar URL protocol ${JSON.stringify(parsed.protocol)}. Expected "http:" or "https:".`,
        );
    }

    return trimmed.replace(/\/+$/, "");
}

/**
 * Creates a typed client for a specific Uncloud sidecar.
 *
 * The sidecar URL is a parameter rather than ambient configuration, so one
 * process can talk to many clusters — pass whichever URL belongs to the cluster
 * you are acting on.
 *
 * Server-side only. The bearer token is a root-equivalent credential — the
 * sidecar exposes arbitrary command execution on cluster hosts (`execMachine`,
 * `execContainer`) and has no users, roles, or scopes, so anyone holding the
 * token can do everything. Never construct this in browser code, never ship the
 * token to a client, and never expose it through an unauthenticated route.
 *
 * The returned object is an OpenAPI-typed client (`GET`/`POST`/`PATCH`/`DELETE`,
 * each returning `{ data, error, response }`) plus a `stream` namespace for the
 * four `text/event-stream` endpoints.
 *
 * Construction is cheap — it allocates a closure and does no I/O — so calling it
 * per request is fine and avoids stale URLs.
 *
 * ```ts
 * const uc = ucClient("http://sidecar.internal", { token: env.SIDECAR_TOKEN });
 *
 * const { data, error } = await uc.GET("/api/v1/machines", {
 *     params: { query: { available: true } },
 * });
 *
 * for await (const event of uc.stream.serviceLogs("web", { follow: true, tail: 100 })) {
 *     console.log(event.message);
 * }
 * ```
 *
 * @param sidecarUrl Base URL of the sidecar, e.g. `http://sidecar.internal`.
 *   A trailing slash is fine. Must be `http:` or `https:`.
 * @throws {TypeError} If the URL is unparseable or uses an unsupported protocol.
 */
export function ucClient(sidecarUrl: string, options: UcClientOptions = {}) {
    const baseUrl = normalizeSidecarUrl(sidecarUrl);

    // The token is merged into the default headers rather than passed per call,
    // so no call site can forget it. An explicit Authorization header in
    // `options.headers` still wins.
    const headers = new Headers(options.headers);

    if (options.token && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${options.token}`);
    }

    const fetchClient = ofetch.create(
        {
            baseURL: baseUrl,
            headers,
            // The previous client did not retry requests, so keep that behavior here.
            retry: false,
        },
        options.fetch ? { fetch: options.fetch } : undefined,
    );

    async function requestPath<
        Method extends HttpMethod,
        Path extends PathsWithMethod<Method>,
        Response extends ParseAs = "json",
    >(
        method: Method,
        path: Path,
        options: RequestOptions<PathOperation<Path, Method>, Response> | undefined,
    ): Promise<ClientResult<ParsedPayload<SuccessPayload<PathOperation<Path, Method>>, Response>>> {
        // SAFETY: generated operations use scalar path/query values and JSON request bodies.
        // This shared transport preserves the path-specific contract on the public methods.
        const {
            params,
            body,
            parseAs,
            headers: requestHeaders,
            ...requestInit
        } = (options ?? {}) as TransportOptions;

        const fetchOptions: OfetchOptions<Response> = {
            ...requestInit,
            method: method.toUpperCase(),
            ignoreResponseError: true,
        };

        if (body !== undefined) fetchOptions.body = body;

        if (parseAs) {
            // SAFETY: parseAs came from RequestOptions<Operation, Response> above.
            fetchOptions.responseType = parseAs as Response;
        }

        if (requestHeaders) fetchOptions.headers = requestHeaders;

        const response = await fetchClient.raw<
            ParsedPayload<SuccessPayload<PathOperation<Path, Method>>, Response>,
            Response
        >(
            appendQuery(replacePathParameters(String(path), params?.path), params?.query),
            fetchOptions,
        );

        if (response.ok) {
            return {
                // SAFETY: ofetch's response mode and the generated operation select this payload.
                data: response._data as ParsedPayload<
                    SuccessPayload<PathOperation<Path, Method>>,
                    Response
                >,
                response,
            };
        }

        return {
            error: errorResponseSchema.safeParse(response._data).data ?? {
                error: `Sidecar request failed: ${response.status} ${response.statusText}`,
            },
            response,
        };
    }

    function createMethod<Method extends HttpMethod>(method: Method): ClientMethod<Method> {
        return (path, ...[requestOptions]) => requestPath(method, path, requestOptions);
    }

    const request: ClientRequest = (method, path, ...[requestOptions]) =>
        requestPath(method, path, requestOptions);

    const client = {
        request,
        GET: createMethod("get"),
        PUT: createMethod("put"),
        POST: createMethod("post"),
        DELETE: createMethod("delete"),
        OPTIONS: createMethod("options"),
        HEAD: createMethod("head"),
        PATCH: createMethod("patch"),
        TRACE: createMethod("trace"),
    };

    /**
     * Issues a request whose response is an event stream and returns typed events.
     *
     * `ofetch` detects `text/event-stream` and leaves the response body readable while
     * preserving typed paths, path params and query params.
     */
    async function* stream<T>(
        method: HttpMethod,
        path: string,
        options: Pick<TransportOptions, "params" | "body" | "signal"> = {},
    ): AsyncGenerator<T, void, undefined> {
        const response = await fetchClient.raw(
            appendQuery(replacePathParameters(path, options.params?.path), options.params?.query),
            {
                method: method.toUpperCase(),
                body: options.body,
                headers: sseHeaders,
                signal: options.signal,
                ignoreResponseError: true,
            },
        );

        if (!response.ok) {
            // `ofetch` has already parsed JSON error bodies into `_data`, so the
            // body is drained and must not be read again here.
            throw new UcApiError(response, response._data);
        }

        if (!response.body) {
            throw new UcApiError(response, { error: "Sidecar returned an empty stream" });
        }

        yield* readSseJson<T>(response.body);
    }

    const sseHeaders = { Accept: "text/event-stream" } as const;

    return {
        ...client,

        /** Base URL this client targets, useful for logging. */
        baseUrl,

        stream: {
            /**
             * Streams logs for a service. Set `follow: true` to tail; pass a `signal`
             * to stop, otherwise the request stays open indefinitely.
             */
            serviceLogs(id: string, options: ServiceLogsOptions = {}) {
                const { signal, ...query } = options;

                return stream<LogEvent>("get", "/api/v1/services/{id}/logs", {
                    params: { path: { id }, query },
                    signal,
                });
            },

            /** Streams logs for a system service (`uncloud`, `docker`, ...) on a machine. */
            machineLogs(id: string, options: MachineLogsOptions) {
                const { signal, ...query } = options;

                return stream<LogEvent>("get", "/api/v1/machines/{id}/logs", {
                    params: { path: { id }, query },
                    signal,
                });
            },

            /**
             * Runs a command on a machine host, streaming stdout/stderr as it arrives.
             *
             * This executes on the host, not in a container. Never build the command
             * from unvalidated input.
             */
            machineExec(id: string, body: MachineExecRequest, options: StreamOptions = {}) {
                return stream<MachineExecEvent>("post", "/api/v1/machines/{id}/exec/stream", {
                    params: { path: { id } },
                    body,
                    signal: options.signal,
                });
            },

            /**
             * Deploys a Compose file, streaming plan and progress events.
             *
             * `compose` must be the base64-encoded file contents; use
             * `encodeComposeFile()` rather than encoding by hand.
             */
            deployCompose(
                compose: string,
                deployOptions?: paths["/api/v1/services/deploy/compose"]["post"]["requestBody"]["content"]["application/json"]["options"],
                options: StreamOptions = {},
            ) {
                return stream<DeployComposeEvent>("post", "/api/v1/services/deploy/compose", {
                    body: { compose, options: deployOptions },
                    signal: options.signal,
                });
            },
        },
    };
}

export type UcClient = ReturnType<typeof ucClient>;

/**
 * Base64-encodes Compose file contents for `stream.deployCompose()`.
 *
 * The spec types `compose` as `format: byte`, which the sidecar expects as
 * base64. Encoding via UTF-8 bytes keeps non-ASCII values correct.
 */
export function encodeComposeFile(contents: string): string {
    return Buffer.from(contents, "utf8").toString("base64");
}
