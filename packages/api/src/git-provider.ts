/* eslint-disable no-control-regex -- Reject control bytes at URL and credential boundaries. */
import { lookup } from "node:dns/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { Agent, request } from "node:https";
import { isIP } from "node:net";

import { ORPCError } from "@orpc/server";
import { Predicate } from "effect";
import * as z from "zod";

import { validateGitBranch, validateGitUrl } from "./git";

export type GitProvider = "github" | "forgejo" | "generic";

export type GitAccount = { id: string; login: string; name: string | null };

export type GitDiscoveredRepository = { url: string; name: string; defaultBranch: string };

type AccountInput = {
    provider: Exclude<GitProvider, "generic">;
    serverUrl: string;
    token: string;
};

type RequestOptions = {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
};

const maxResponseBytes = 4 * 1024 * 1024;

const maxRepositories = 1000;

function invalid(): never {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid Git provider request" });
}

function badResponse(): never {
    throw new ORPCError("BAD_GATEWAY", { message: "Invalid Git provider response" });
}

function parseUrl(value: string, ssh = false, query = false): URL {
    if (
        !Predicate.isString(value) ||
        value.length > 4096 ||
        /[\s\x00-\x1f\x7f\\]/u.test(value) ||
        !/^\w+:\/\/[^/?#]+(?:\/|\?|#|$)/u.test(value) ||
        /^\w+:\/\/[^/?#]*@/u.test(value)
    )
        invalid();

    try {
        const url = new URL(value);

        if (
            !(url.protocol === "https:" || (ssh && url.protocol === "ssh:")) ||
            url.username ||
            url.password ||
            value.includes("#") ||
            (!query && value.includes("?"))
        )
            invalid();
        // Inspect the raw path before WHATWG URL parsing can erase dot segments.
        const rawPath = /^\w+:\/\/[^/?#]+([^?#]*)/u.exec(value)![1] || "/";
        const path = decodeURIComponent(rawPath);

        if (
            !/^\/(?:[a-zA-Z0-9_.~@+-]+\/)*[a-zA-Z0-9_.~@+-]*$/u.test(path) ||
            /%2f/iu.test(rawPath) ||
            path.split("/").some((part) => part === "." || part === "..")
        )
            invalid();
        // Reuse the existing literal-host policy without changing git.ts's exports.
        const checked = new URL(validateGitUrl(`${url.protocol}//${url.host}/server`));
        url.hostname = checked.hostname;
        url.pathname = path;

        return url;
    } catch {
        return invalid();
    }
}

export function validateGitServerUrl(value: string, provider: GitProvider): string {
    if (!["github", "forgejo", "generic"].includes(provider)) invalid();
    const url = parseUrl(value, provider === "generic");

    if (
        provider === "github" &&
        url.hostname === "github.com" &&
        (url.port || url.pathname !== "/")
    )
        invalid();

    return url.toString().replace(/\/$/u, "");
}

// Keep the DNS policy aligned with git.ts: an allowlist only permits private ranges,
// never metadata, loopback, link-local, transition or other special-use addresses.
function addressKind(address: string): "public" | "private" | "blocked" {
    if (isIP(address) === 4) {
        const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

        if (address === "168.63.129.16") return "blocked";

        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
            return "private";

        if (
            a === 0 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        )
            return "blocked";

        return "public";
    }

    if (isIP(address) !== 6) return "blocked";
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);

    if (normalized === "fd00:ec2::254" || normalized === "fd20:ce::254") return "blocked";

    if ((first & 0xfe00) === 0xfc00) return "private";

    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3fff) return "blocked";
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);

    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return "blocked";

    return "public";
}

async function pinnedAddress(host: string): Promise<string> {
    const allowPrivate = (process.env.STOAT_GIT_ALLOWED_HOSTS ?? "").split(",").some(
        (entry) =>
            entry
                .trim()
                .toLowerCase()
                .replace(/^\[|\]$/gu, "")
                .replace(/\.$/u, "") === host,
    );

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const addresses = isIP(host)
            ? [{ address: host }]
            : await Promise.race([
                  lookup(host, { all: true, verbatim: true }),
                  new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error()), 5000);
                  }),
              ]);

        if (!addresses.length || addresses.length > 64) invalid();

        for (const { address } of addresses) {
            const kind = addressKind(address);

            if (kind === "blocked" || (kind === "private" && !allowPrivate)) invalid();
        }

        return addresses[0]!.address;
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("BAD_GATEWAY", { message: "Unable to resolve Git provider host" });
    } finally {
        clearTimeout(timer);
    }
}

/** JSON-only transport for API calls and OAuth exchanges. Never follows redirects. */
export async function gitProviderRequest(
    url: string,
    options: RequestOptions = {},
): Promise<z.JSONType> {
    const parsed = parseUrl(url, false, true);
    const method = options.method ?? "GET";

    if (
        !["GET", "POST"].includes(method) ||
        (options.body !== undefined &&
            (method !== "POST" ||
                !Predicate.isString(options.body) ||
                Buffer.byteLength(options.body) > 64 * 1024))
    )
        invalid();

    const headers: Record<string, string> = {};
    headers.accept = "application/json";
    headers["user-agent"] = "Stoat";

    try {
        let size = 0;

        for (const [key, value] of Object.entries(options.headers ?? {})) {
            validateHeaderName(key);
            validateHeaderValue(key, value);
            const name = key.toLowerCase();

            if (
                !Predicate.isString(value) ||
                /^(?:host|connection|proxy-.*|content-length|transfer-encoding|upgrade|te|trailer)$/u.test(
                    name,
                )
            )
                invalid();
            size += Buffer.byteLength(key) + Buffer.byteLength(value);

            if (size > 32 * 1024) invalid();
            headers[name] = value;
        }
    } catch {
        invalid();
    }

    headers["accept-encoding"] = "identity";

    if (options.body !== undefined)
        headers["content-length"] = String(Buffer.byteLength(options.body));
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    const address = await pinnedAddress(host);
    // A fresh explicit agent avoids global-agent proxy settings and reused sockets.
    const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    let req: ReturnType<typeof request> | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await new Promise<z.JSONType>((resolve, reject) => {
            let settled = false;

            const fail = (
                code: "BAD_GATEWAY" | "TIMEOUT" | "PAYLOAD_TOO_LARGE" = "BAD_GATEWAY",
            ) => {
                if (settled) return;
                settled = true;
                reject(new ORPCError(code, { message: "Git provider request failed" }));
                response?.destroy();
                req?.destroy();
            };

            timer = setTimeout(() => fail("TIMEOUT"), 15_000);
            req = request(
                parsed,
                {
                    method,
                    headers,
                    agent,
                    rejectUnauthorized: true,
                    maxHeaderSize: 16 * 1024,
                    family: isIP(address),
                    lookup: (_hostname, lookupOptions, callback) => {
                        const family = isIP(address);

                        if (lookupOptions.all) callback(null, [{ address, family }]);
                        else callback(null, address, family);
                    },
                },
                (res) => {
                    response = res;
                    res.on("error", () => fail());
                    res.on("aborted", () => fail());
                    res.on("close", () => {
                        if (!res.complete) fail();
                    });

                    if (settled) {
                        res.destroy();

                        return;
                    }

                    if (
                        !res.statusCode ||
                        res.statusCode < 200 ||
                        res.statusCode >= 300 ||
                        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(
                            res.headers["content-type"] ?? "",
                        ) ||
                        (res.headers["content-encoding"] &&
                            res.headers["content-encoding"] !== "identity")
                    ) {
                        fail();

                        return;
                    }

                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    res.on("data", (chunk: Buffer) => {
                        if (settled) return;
                        bytes += chunk.length;

                        if (bytes > maxResponseBytes) fail("PAYLOAD_TOO_LARGE");
                        else chunks.push(chunk);
                    });
                    res.on("end", () => {
                        if (settled) return;

                        try {
                            const text = new TextDecoder("utf-8", { fatal: true }).decode(
                                Buffer.concat(chunks),
                            );

                            const data = z.json().parse(JSON.parse(text));
                            settled = true;
                            resolve(data);
                        } catch {
                            fail();
                        }
                    });
                },
            );
            req.on("error", () => fail());
            req.end(options.body);
        });
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("BAD_GATEWAY", { message: "Git provider request failed" });
    } finally {
        clearTimeout(timer);
        response?.destroy();
        req?.destroy();
        agent.destroy();
    }
}

function accountConfig(input: AccountInput) {
    if (
        !["github", "forgejo"].includes(input.provider) ||
        !Predicate.isString(input.token) ||
        !/^[\x21-\x7e]{1,16384}$/u.test(input.token)
    )
        invalid();
    const server = validateGitServerUrl(input.serverUrl, input.provider);

    const api =
        input.provider === "github"
            ? server === "https://github.com"
                ? "https://api.github.com"
                : `${server}/api/v3`
            : `${server}/api/v1`;

    // Forgejo accepts Bearer for both personal access and OAuth tokens.
    const headers = { authorization: `Bearer ${input.token}` };

    return { server, api, headers };
}

function record(value: z.JSONType) {
    const result = z.record(z.string(), z.json()).safeParse(value);

    if (!result.success) badResponse();

    return result.data;
}

function safeText(value: unknown, limit: number): value is string {
    return (
        Predicate.isString(value) &&
        value.length > 0 &&
        value.length <= limit &&
        value.isWellFormed() &&
        !/[\x00-\x1f\x7f]/u.test(value)
    );
}

export async function getGitAccount(input: AccountInput): Promise<GitAccount> {
    const { api, headers } = accountConfig(input);
    const data = record(await gitProviderRequest(`${api}/user`, { headers }));

    const id =
        Predicate.isNumber(data.id) && Number.isSafeInteger(data.id) && data.id > 0
            ? String(data.id)
            : data.id;

    if (
        !Predicate.isString(id) ||
        !/^[1-9][0-9]{0,63}$/u.test(id) ||
        !Predicate.isString(data.login) ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,254}$/u.test(data.login)
    )
        badResponse();
    const name = input.provider === "github" ? data.name : data.full_name;

    return { id, login: data.login, name: safeText(name, 256) ? name : null };
}

export async function listGitRepositories(input: AccountInput): Promise<{
    repositories: GitDiscoveredRepository[];
    truncated: boolean;
}> {
    const { server, api, headers } = accountConfig(input);
    const base = new URL(server);
    const prefix = `${base.pathname.replace(/\/$/u, "")}/`;
    const repositories: GitDiscoveredRepository[] = [];
    const seen = new Set<string>();
    let count = 0;

    // Do not trust Link URLs or assume the server honors the requested page size.
    // The extra empty-page probe distinguishes exactly 1000 results from truncation.
    for (let page = 1; page <= 100; page++) {
        const url = new URL(`${api}/user/repos`);
        url.searchParams.set("page", String(page));
        url.searchParams.set(input.provider === "github" ? "per_page" : "limit", "100");

        if (input.provider === "github")
            url.searchParams.set("affiliation", "owner,collaborator,organization_member");
        const data = await gitProviderRequest(url.toString(), { headers });

        if (!Array.isArray(data)) badResponse();

        if (data.length === 0) return { repositories, truncated: false };

        for (const item of data) {
            if (count++ >= maxRepositories) return { repositories, truncated: true };
            const repo = record(item);

            try {
                if (
                    !Predicate.isString(repo.clone_url) ||
                    (repo.default_branch !== null && !Predicate.isString(repo.default_branch))
                )
                    badResponse();
                const clone = parseUrl(repo.clone_url);

                if (
                    clone.search ||
                    repo.clone_url.includes("?") ||
                    clone.origin !== base.origin ||
                    !clone.pathname.startsWith(prefix) ||
                    clone.pathname === prefix
                )
                    badResponse();
                const normalized = validateGitUrl(clone.toString());
                const name = repo.full_name ?? repo.name;

                if (!safeText(name, 512) || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?$/u.test(name))
                    badResponse();
                let defaultBranch = "";

                try {
                    if (repo.default_branch !== null)
                        defaultBranch = validateGitBranch(repo.default_branch);
                } catch {
                    // Unusable default-branch metadata must not hide accessible repositories.
                }

                if (!seen.has(normalized)) {
                    seen.add(normalized);
                    repositories.push({ url: normalized, name, defaultBranch });
                }
            } catch {
                badResponse();
            }
        }
    }

    return { repositories, truncated: true };
}
