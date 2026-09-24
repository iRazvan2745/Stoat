import { unwrap, type UcClient, type Service } from "@stoat/uncloud";
import { Schema } from "effect";

export class GreptimeResponseTooLargeError extends Error {
    constructor() {
        super("Monitoring database response exceeds 1 MiB.");
    }
}

export function readSqlRows(stdout: string): unknown[][] {
    const result = Schema.decodeUnknownSync(
        Schema.Struct({
            code: Schema.optionalKey(Schema.Number),
            error: Schema.optionalKey(Schema.String),
            output: Schema.optionalKey(
                Schema.Array(
                    Schema.Struct({
                        records: Schema.optionalKey(
                            Schema.Struct({
                                rows: Schema.optionalKey(
                                    Schema.Array(Schema.Array(Schema.Unknown)),
                                ),
                            }),
                        ),
                    }),
                ),
            ),
        }),
    )(JSON.parse(stdout));

    if (result.error || (result.code !== undefined && result.code !== 0) || !result.output)
        throw new Error("Monitoring database query failed.");

    return result.output.flatMap((output) => output.records?.rows?.map((row) => [...row]) ?? []);
}

export async function sql(
    uc: UcClient,
    service: Service,
    password: string,
    query: string,
    signal: AbortSignal,
) {
    const container = Schema.decodeUnknownSync(Schema.String)(service.containers[0]?.container.Id);
    // curl config input is not a shell, but still has its own quoting rules.
    const credential = password.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    if (/[\r\n\0]/u.test(credential)) throw new Error("Invalid monitoring credential.");

    const response = await uc.POST("/api/v1/services/{id}/containers/{container}/exec", {
        params: { path: { id: service.id, container } },
        body: {
            command: [
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "15",
                "--config",
                "-",
                "--data-urlencode",
                `sql=${query}`,
                "http://127.0.0.1:4000/v1/sql?db=public",
            ],
            stdin: `user = "stoat:${credential}"\n`,
        },
        parseAs: "stream",
        signal,
    });

    if (!response.response.ok) {
        await response.response.body?.cancel().catch(() => {});
        throw new Error("Monitoring database query failed.");
    }

    const stream = await unwrap(Promise.resolve(response));

    if (!stream) throw new Error("Monitoring database query failed.");
    const reader = stream.getReader();

    const cancel = () => {
        void reader.cancel().catch(() => {});
    };

    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
        for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();

            if (done) break;
            size += value.byteLength;

            if (size > 1024 * 1024) throw new GreptimeResponseTooLargeError();
            chunks.push(value);
        }
    } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }

    const result = Schema.decodeUnknownSync(
        Schema.Struct({
            exitCode: Schema.Number,
            truncated: Schema.Boolean,
            stdout: Schema.String,
        }),
    )(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    if (result.truncated) throw new GreptimeResponseTooLargeError();

    if (result.exitCode !== 0) throw new Error("Monitoring database query failed.");

    return readSqlRows(result.stdout);
}
