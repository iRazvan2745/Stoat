import type { RequestLogger } from "evlog";
import { useLogger } from "evlog/sveltekit";

export type RemoteFunctionType = "command" | "query" | "query.live" | "unknown";

type RemoteLogPhase = "completed" | "failed" | "requested" | "responded" | "started";
type RemoteTransport = "form" | "get" | "json" | "other";

export interface RemoteInputSummary {
    counts?: Record<string, number>;
    identifiers?: Record<string, string>;
    keys?: string[];
    length?: number;
    nestedKeys?: Record<string, string[]>;
    stringLengths?: Record<string, number>;
    type: "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined";
}

export interface RemoteInvocation {
    functionId: string;
    functionName: string;
    hasAdditionalArguments: boolean;
    method: string;
    moduleHash: string;
    pagePath?: string;
    transport: RemoteTransport;
}

export interface RemoteResponseInspection {
    message?: string;
    outcome: "error" | "success";
    status: number;
}

export interface RemoteLoggingOptions {
    /** Wrap a scalar input in a named object so a safe identifier can be recorded. */
    inputKey?: string;
}

type RemoteLogger = RequestLogger;
type MaybePromise<Value> = Value | PromiseLike<Value>;

const REMOTE_PATH_MARKER = "/remote/";
const MAX_IDENTIFIER_LENGTH = 128;
const SAFE_IDENTIFIER_KEYS = new Set([
    "appId",
    "dataSourceId",
    "deploymentId",
    "id",
    "resourceId",
    "serviceId",
    "version",
    "workspaceId",
]);
const SENSITIVE_KEY_PATTERN = /authorization|cookie|credential|password|private|secret|token/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const clippedIdentifier = (value: string): string =>
    value.length <= MAX_IDENTIFIER_LENGTH ? value : `${value.slice(0, 32)}…${value.slice(-16)}`;

const decodePathSegment = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const getPathname = (requestUrl: string): string => {
    try {
        return new URL(requestUrl).pathname;
    } catch {
        return requestUrl.split("?")[0] ?? requestUrl;
    }
};

const getTransport = (request: Pick<Request, "headers" | "method">): RemoteTransport => {
    if (request.method === "GET") {
        return "get";
    }

    const contentType = request.headers.get("content-type")?.toLowerCase();

    if (
        contentType?.includes("application/x-www-form-urlencoded") ||
        contentType?.includes("multipart/form-data")
    ) {
        return "form";
    }

    if (contentType?.includes("application/json")) {
        return "json";
    }

    return "other";
};

const addSummaryField = <Key extends keyof RemoteInputSummary>(
    summary: RemoteInputSummary,
    key: Key,
    value: RemoteInputSummary[Key],
): void => {
    if (
        value === undefined ||
        (Array.isArray(value) && value.length === 0) ||
        (isRecord(value) && Object.keys(value).length === 0)
    ) {
        return;
    }

    summary[key] = value;
};

/**
 * Return useful input shape information without recording arbitrary payloads.
 * Compose files and environment values are represented by their shape/length,
 * while resource identifiers are retained because they make a trace actionable.
 */
export const summarizeRemoteInput = (input: unknown): RemoteInputSummary => {
    if (input === undefined) {
        return { type: "undefined" };
    }

    if (input === null) {
        return { type: "null" };
    }

    if (typeof input === "string") {
        return { length: input.length, type: "string" };
    }

    if (typeof input === "number" || typeof input === "boolean") {
        return { type: typeof input === "number" ? "number" : "boolean" };
    }

    if (Array.isArray(input)) {
        return { length: input.length, type: "array" };
    }

    if (!isRecord(input)) {
        return { type: "object" };
    }

    const summary: RemoteInputSummary = {
        keys: Object.keys(input).toSorted(),
        type: "object",
    };
    const counts: Record<string, number> = {};
    const identifiers: Record<string, string> = {};
    const nestedKeys: Record<string, string[]> = {};
    const stringLengths: Record<string, number> = {};

    for (const [key, value] of Object.entries(input)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            continue;
        }

        if (
            SAFE_IDENTIFIER_KEYS.has(key) &&
            (typeof value === "string" || typeof value === "number")
        ) {
            identifiers[key] = clippedIdentifier(String(value));
            continue;
        }

        if (Array.isArray(value)) {
            counts[key] = value.length;
            continue;
        }

        if (isRecord(value)) {
            nestedKeys[key] = Object.keys(value).toSorted();
            continue;
        }

        if (typeof value === "string") {
            stringLengths[key] = value.length;
        }
    }

    addSummaryField(summary, "counts", counts);
    addSummaryField(summary, "identifiers", identifiers);
    addSummaryField(summary, "nestedKeys", nestedKeys);
    addSummaryField(summary, "stringLengths", stringLengths);

    return summary;
};

export const parseRemoteInvocation = (
    request: Pick<Request, "headers" | "method" | "url">,
    pagePath?: string,
): RemoteInvocation | null => {
    const pathname = getPathname(request.url);
    const markerIndex = pathname.lastIndexOf(REMOTE_PATH_MARKER);

    if (markerIndex === -1) {
        return null;
    }

    const [rawModuleHash, rawFunctionName, ...additionalArguments] = pathname
        .slice(markerIndex + REMOTE_PATH_MARKER.length)
        .split("/");

    if (!rawModuleHash || !rawFunctionName) {
        return null;
    }

    const moduleHash = decodePathSegment(rawModuleHash);
    const functionName = decodePathSegment(rawFunctionName);

    return {
        functionId: `${moduleHash}/${functionName}`,
        functionName,
        hasAdditionalArguments: additionalArguments.length > 0,
        method: request.method,
        moduleHash,
        ...(pagePath ? { pagePath } : {}),
        transport: getTransport(request),
    };
};

export const getRemoteLogger = (): RemoteLogger | undefined => {
    try {
        return useLogger();
    } catch {
        // Remote functions can also run during tooling/prerendering without
        // the request hook. Logging must never make the function fail.
        return undefined;
    }
};

export const hasRemoteFailure = (logger: RemoteLogger | undefined): boolean => {
    const remoteCalls = logger?.getContext().remoteCalls;

    return (
        Array.isArray(remoteCalls) &&
        remoteCalls.some((call) => isRecord(call) && call.phase === "failed")
    );
};

export const hasRemoteHandlerRun = (logger: RemoteLogger | undefined): boolean => {
    const remoteCalls = logger?.getContext().remoteCalls;

    return (
        Array.isArray(remoteCalls) &&
        remoteCalls.some((call) => isRecord(call) && call.phase === "started")
    );
};

const getInputSummary = <Input>(
    input: Input,
    inputKey: string | undefined,
): RemoteInputSummary | undefined => {
    if (input === undefined && inputKey === undefined) {
        return undefined;
    }

    return summarizeRemoteInput(inputKey === undefined ? input : { [inputKey]: input });
};

const normalizeError = (caught: unknown): Error => {
    if (caught instanceof Error) {
        return caught;
    }

    if (isRecord(caught) && typeof caught.message === "string") {
        return new Error(caught.message);
    }

    if (typeof caught === "string" && caught.length > 0) {
        return new Error(caught);
    }

    return new Error("Remote function failed.");
};

interface RemoteLogEntry {
    error?: unknown;
    input?: unknown;
    inputKey?: string;
    operation: string;
    phase: RemoteLogPhase;
    responseStatus?: number;
    type: RemoteFunctionType;
}

const responseStatusFields = (responseStatus: number | undefined): { responseStatus?: number } =>
    responseStatus === undefined ? {} : { responseStatus };

const logRemoteEntry = (logger: RemoteLogger | undefined, entry: RemoteLogEntry): void => {
    if (!logger) {
        return;
    }

    const input = getInputSummary(entry.input, entry.inputKey);
    const call = {
        operation: entry.operation,
        phase: entry.phase,
        ...(input ? { input } : {}),
        ...responseStatusFields(entry.responseStatus),
        type: entry.type,
    };
    const context = {
        operation: `remote.${entry.operation}`,
        remote: {
            operation: entry.operation,
            ...responseStatusFields(entry.responseStatus),
            type: entry.type,
        },
        remoteCalls: [call],
    };

    if (entry.phase === "failed") {
        logger.error(normalizeError(entry.error), context);
        return;
    }

    logger.info(`remote.${entry.phase}`, context);
};

export const logRemoteRequest = (
    logger: RemoteLogger | undefined,
    invocation: RemoteInvocation,
): void => {
    if (!logger) {
        return;
    }

    logger.info("remote.requested", {
        operation: `remote.${invocation.functionName}`,
        remote: invocation,
        remoteCalls: [
            {
                functionId: invocation.functionId,
                functionName: invocation.functionName,
                phase: "requested",
                transport: invocation.transport,
                type: "unknown",
            },
        ],
    });
};

export const logRemoteResponse = (
    logger: RemoteLogger | undefined,
    operation: string,
    response: RemoteResponseInspection,
): void => {
    if (!logger) {
        return;
    }

    // Keep the handler's fully-qualified operation and type when one exists.
    // The request hook only knows the generated export name.
    logger.info("remote.responded", {
        remote: {
            ...(response.message ? { responseMessage: response.message } : {}),
            responseStatus: response.status,
        },
        remoteCalls: [
            {
                operation,
                phase: "responded",
                responseStatus: response.status,
                type: "unknown",
            },
        ],
    });
};

export const logRemoteError = (
    logger: RemoteLogger | undefined,
    operation: string,
    error: unknown,
    responseStatus?: number,
): void => {
    logRemoteEntry(logger, {
        error,
        operation,
        phase: "failed",
        ...responseStatusFields(responseStatus),
        type: "unknown",
    });
};

export function withRemoteLogging<Output>(
    operation: string,
    type: Exclude<RemoteFunctionType, "unknown">,
    fn: () => MaybePromise<Output>,
    options?: RemoteLoggingOptions,
): () => Promise<Output>;
export function withRemoteLogging<Input, Output>(
    operation: string,
    type: Exclude<RemoteFunctionType, "unknown">,
    fn: (input: Input) => MaybePromise<Output>,
    options?: RemoteLoggingOptions,
): (input: Input) => Promise<Output>;
export function withRemoteLogging<Input, Output>(
    operation: string,
    type: Exclude<RemoteFunctionType, "unknown">,
    fn: (input: Input) => MaybePromise<Output>,
    options?: RemoteLoggingOptions,
): (input: Input) => Promise<Output> {
    return async (input: Input): Promise<Output> => {
        const logger = getRemoteLogger();
        logRemoteEntry(logger, {
            input,
            inputKey: options?.inputKey,
            operation,
            phase: "started",
            type,
        });

        try {
            const result = await fn(input);
            logRemoteEntry(logger, {
                input,
                inputKey: options?.inputKey,
                operation,
                phase: "completed",
                type,
            });
            return result;
        } catch (error) {
            logRemoteEntry(logger, {
                error,
                input,
                inputKey: options?.inputKey,
                operation,
                phase: "failed",
                type,
            });
            throw error;
        }
    };
}

export const withRemoteLiveLogging =
    <Input, Output>(
        operation: string,
        fn: (input: Input) => AsyncIterable<Output> | PromiseLike<AsyncIterable<Output>>,
        options?: RemoteLoggingOptions,
    ): ((input: Input) => AsyncGenerator<Output>) =>
    (input: Input): AsyncGenerator<Output> => {
        // SvelteKit starts consuming query.live generators from a stream pull,
        // after the request handler has returned. Capture the logger now while
        // the request's AsyncLocalStorage context is still active.
        const logger = getRemoteLogger();

        return (async function* remoteFunction(): AsyncGenerator<Output> {
            logRemoteEntry(logger, {
                input,
                inputKey: options?.inputKey,
                operation,
                phase: "started",
                type: "query.live",
            });

            try {
                const iterable = await fn(input);

                for await (const value of iterable) {
                    yield value;
                }

                logRemoteEntry(logger, {
                    input,
                    inputKey: options?.inputKey,
                    operation,
                    phase: "completed",
                    type: "query.live",
                });
            } catch (error) {
                logRemoteEntry(logger, {
                    error,
                    input,
                    inputKey: options?.inputKey,
                    operation,
                    phase: "failed",
                    type: "query.live",
                });
                throw error;
            }
        })();
    };

export const inspectRemoteResponse = async (
    response: Response,
    inspectProtocolBody = true,
): Promise<RemoteResponseInspection> => {
    const { status: responseStatus, statusText } = response;
    const contentType = response.headers.get("content-type")?.toLowerCase();

    if (inspectProtocolBody && contentType?.includes("application/json")) {
        try {
            const payload: unknown = await response.clone().json();

            if (isRecord(payload) && payload.type === "error") {
                const { error: payloadError, status: payloadStatus } = payload;
                const status = typeof payloadStatus === "number" ? payloadStatus : responseStatus;
                let message = "Remote function returned an error.";

                if (typeof payloadError === "string") {
                    message = payloadError;
                } else if (isRecord(payloadError)) {
                    const { message: errorMessage } = payloadError;

                    if (typeof errorMessage === "string") {
                        message = errorMessage;
                    }
                }

                return { message, outcome: "error", status };
            }
        } catch {
            // A response with an unreadable body is still handled by the normal
            // HTTP status check below.
        }
    }

    if (responseStatus >= 400) {
        return {
            message: statusText || "Remote request failed.",
            outcome: "error",
            status: responseStatus,
        };
    }

    return { outcome: "success", status: responseStatus };
};
