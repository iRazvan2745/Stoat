import { stripVTControlCharacters } from "node:util";
import { encodeComposeFile, UcApiError, type UcClient } from "@stoat/uncloud";
import { Predicate } from "effect";
import { parse } from "yaml";

export class DeploymentError extends Error {}

export type DeploymentLogger = (
    text: string,
    level: "info" | "debug" | "error",
    event: string,
) => Promise<void>;

export async function deployCompose(
    uc: UcClient,
    compose: string,
    signal: AbortSignal,
    onLog: DeploymentLogger,
    services?: string[],
    credentials: string[] = [],
) {
    const values = new Set<string>();

    function add(value: string) {
        if (!value) return;
        values.add(stripVTControlCharacters(value));

        if (value.trim()) values.add(stripVTControlCharacters(value.trim()));

        if (URL.canParse(value)) {
            const url = new URL(value);

            if (url.password) {
                values.add(url.password);

                try {
                    values.add(decodeURIComponent(url.password));
                } catch {
                    // The literal credential is still masked if its escaping is invalid.
                }
            }
        }
    }

    for (const value of credentials) add(value);
    const config: unknown = parse(compose, { merge: true, maxAliasCount: 100 });

    if (Predicate.isObject(config) && Predicate.isObject(config.services)) {
        for (const service of Object.values(config.services)) {
            if (!Predicate.isObject(service)) continue;

            for (const environment of [
                service.environment,
                Predicate.isObject(service.build) ? service.build.args : undefined,
            ]) {
                if (Predicate.isObject(environment) && !Array.isArray(environment)) {
                    for (const value of Object.values(environment)) {
                        if (
                            Predicate.isString(value) ||
                            Predicate.isNumber(value) ||
                            Predicate.isBoolean(value)
                        )
                            add(String(value));
                    }
                } else if (Array.isArray(environment)) {
                    for (const entry of environment) {
                        if (!Predicate.isString(entry)) continue;
                        const separator = entry.indexOf("=");

                        if (separator !== -1) add(entry.slice(separator + 1));
                    }
                }
            }
        }
    }

    if (Predicate.isObject(config) && Predicate.isObject(config.secrets)) {
        for (const secret of Object.values(config.secrets)) {
            if (Predicate.isObject(secret) && Predicate.isString(secret.content))
                add(secret.content);
        }
    }

    values.delete("");

    const secrets = new RegExp(
        [...values]
            .sort((a, b) => b.length - a.length)
            .map(RegExp.escape)
            .join("|"),
        "g",
    );

    const redact = (text: string) => {
        const plain = stripVTControlCharacters(text);

        // The sidecar also masks values resolved from secret:// and its own environment.
        return values.size ? plain.replace(secrets, "[REDACTED]") : plain;
    };

    const log: DeploymentLogger = (text, level, event) => onLog(redact(text), level, event);
    let complete = false;
    let failure: string | undefined;

    try {
        for await (const event of uc.stream.deployCompose(
            encodeComposeFile(compose),
            { services, skipHealth: false },
            { signal },
        )) {
            signal.throwIfAborted();

            if (!Predicate.isObject(event)) throw new Error("Invalid Uncloud deployment event.");

            switch (event.type) {
                case "plan": {
                    const operations = Array.isArray(event.operations) ? event.operations : [];
                    await log(
                        `Deployment plan: ${operations.length} operation(s).`,
                        "info",
                        "plan",
                    );

                    for (const op of operations) {
                        if (!Predicate.isObject(op)) continue;

                        const detail = [
                            op.action,
                            op.resource,
                            op.name,
                            op.service,
                            op.image,
                            op.containerId,
                            op.machine,
                            op.order,
                        ]
                            .filter(Predicate.isString)
                            .join(" ");

                        if (detail) await log(detail, "info", "plan");
                    }

                    break;
                }

                case "progress": {
                    const detail = [
                        ...new Set(
                            [event.parentId, event.id, event.text, event.statusText].filter(
                                Predicate.isString,
                            ),
                        ),
                    ]
                        .filter(Boolean)
                        .join(" | ");

                    const phase =
                        ["working", "done", "warning", "error"].find(
                            (phase) => phase === event.phase,
                        ) ?? "unknown";

                    const percent = Number.isFinite(event.percent) ? ` (${event.percent}%)` : "";

                    const size =
                        Number.isFinite(event.current) && Number.isFinite(event.total)
                            ? ` [${event.current}/${event.total}]`
                            : "";

                    await log(
                        `${detail || phase}${percent}${size}`,
                        phase === "error" ? "error" : "info",
                        "progress",
                    );

                    // Error progress can precede a more useful terminal error; drain the stream.
                    if (phase === "error")
                        failure = detail || "Uncloud reported deployment failure.";
                    break;
                }

                case "error":
                    failure =
                        Predicate.isString(event.error) && event.error.trim()
                            ? event.error
                            : "Uncloud reported deployment failure.";
                    await log(failure, "error", "error");
                    break;
                case "complete":
                    complete = true;
                    await log(
                        Predicate.isString(event.status) ? event.status : "Deployment complete.",
                        "info",
                        "complete",
                    );
                    break;
                default:
                    await log("Unrecognized Uncloud deployment event.", "debug", "unknown");
            }
        }
    } catch (error) {
        signal.throwIfAborted();

        const reason = redact(
            error instanceof UcApiError
                ? `Uncloud HTTP ${error.status}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : "Uncloud deployment request failed.",
        );

        await onLog(reason, "error", "error");
        throw new DeploymentError(reason);
    }

    signal.throwIfAborted();

    if (failure) throw new DeploymentError(redact(failure));

    if (!complete) {
        const reason = "Uncloud stream ended without deployment completion confirmation.";
        await log(reason, "error", "error");
        throw new DeploymentError(reason);
    }
}
