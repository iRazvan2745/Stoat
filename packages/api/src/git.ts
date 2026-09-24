/* eslint-disable no-control-regex -- Reject control bytes at Git and credential boundaries. */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, opendir, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ORPCError } from "@orpc/server";
import { z } from "zod";

export type GitCredentials = {
    username?: string;
    password?: string;
    privateKey?: string;
    knownHosts?: string;
    oauthProviderId?: string;
    refreshToken?: string;
    expiresAt?: string;
};

export type GitRepository = { url: string; branch: string; credentials: GitCredentials };

const maxTextBytes = 1024 * 1024;

const maxTreeBytes = 4 * 1024 * 1024;

const maxFiles = 10_000;

const maxRepositoryBytes = 128 * 1024 * 1024;

const control = /[\x00-\x1f\x7f]/u;

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function invalid(message: string): never {
    throw new ORPCError("BAD_REQUEST", { message });
}

function allowedPrivateHost(host: string): boolean {
    // Exact hosts, not suffixes, wildcards, CIDRs, ports, or resolved-IP exceptions.
    return (process.env.STOAT_GIT_ALLOWED_HOSTS ?? "").split(",").some(
        (entry) =>
            entry
                .trim()
                .toLowerCase()
                .replace(/^\[|\]$/gu, "")
                .replace(/\.$/u, "") === host,
    );
}

function addressKind(address: string): "public" | "private" | "blocked" {
    if (isIP(address) === 4) {
        const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

        if (address === "168.63.129.16") return "blocked"; // Azure platform/metadata services.

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

    // Only global unicast; exclude mapped IPv4, NAT64, Teredo, 6to4 and documentation ranges.
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3fff) return "blocked";
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);

    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return "blocked";

    return "public";
}

function checkHost(host: string) {
    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "metadata.google.internal"
    ) {
        invalid("Git host is not permitted");
    }

    if (isIP(host)) {
        const kind = addressKind(host);

        if (kind === "blocked" || (kind === "private" && !allowedPrivateHost(host))) {
            invalid("Git host is not permitted");
        }
    }
}

export function validateGitUrl(url: string): string {
    if (!z.string().max(4096).safeParse(url).success || /[\s\x00-\x1f\x7f\\]/u.test(url)) {
        invalid("Invalid Git URL");
    }

    // SCP paths are home-relative unless explicitly absolute or tilde-prefixed.
    const scp = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9.-]+):(.+)$/u.exec(url);

    if (scp) {
        const path = scp[3]!;
        url = `ssh://${scp[1]}@${scp[2]}${path.startsWith("/") ? path : path.startsWith("~") ? `/${path}` : `/~/${path}`}`;
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return invalid("Invalid Git URL");
    }

    if (
        !["https:", "ssh:"].includes(parsed.protocol) ||
        parsed.search ||
        parsed.hash ||
        parsed.password ||
        (parsed.protocol === "https:" && parsed.username) ||
        (parsed.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(parsed.username)) ||
        !parsed.hostname ||
        parsed.port === "0"
    )
        invalid("Only HTTPS and SSH Git URLs without embedded secrets are supported");
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");

    if (
        !isIP(host) &&
        (host.length > 253 ||
            !host
                .split(".")
                .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    ) {
        invalid("Invalid Git host");
    }

    checkHost(host);
    let path: string;

    try {
        path = decodeURIComponent(parsed.pathname);
    } catch {
        return invalid("Invalid Git repository path");
    }

    if (
        !/^\/(?:[a-zA-Z0-9_.~@+-]+\/)*[a-zA-Z0-9_.~@+-]+\/?$/u.test(path) ||
        path.split("/").some((part) => part === "." || part === "..")
    ) {
        invalid("Invalid Git repository path");
    }

    parsed.pathname = path.replace(/\/$/u, "");

    return parsed.toString();
}

export function validateGitPath(path: string): string {
    if (
        !z.string().safeParse(path).success ||
        !path ||
        Buffer.byteLength(path) > 4096 ||
        control.test(path) ||
        /[\\:]/u.test(path) ||
        path.startsWith("/") ||
        !path.isWellFormed() ||
        path
            .split("/")
            .some(
                (part) =>
                    !part ||
                    part === "." ||
                    part === ".." ||
                    /^\.git$/iu.test(part) ||
                    /[. ]$/u.test(part),
            )
    )
        invalid("Invalid Git file path");

    return path;
}

export function validateGitBranch(branch: string): string {
    if (
        !z.string().safeParse(branch).success ||
        !branch ||
        Buffer.byteLength(branch) > 255 ||
        branch === "HEAD" ||
        branch.startsWith("-") ||
        branch.startsWith("refs/") ||
        /[\s\x00-\x1f\x7f~^:?*[\\]/u.test(branch) ||
        branch.includes("..") ||
        branch.includes("@{") ||
        branch === "@" ||
        !branch.isWellFormed() ||
        branch
            .split("/")
            .some(
                (part) =>
                    !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
            )
    )
        invalid("Invalid Git branch");

    return branch;
}

async function pinnedAddress(host: string): Promise<string> {
    checkHost(host);
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

        if (!addresses.length || addresses.length > 64) invalid("Git host is not permitted");

        for (const { address } of addresses) {
            const kind = addressKind(address);

            if (kind === "blocked" || (kind === "private" && !allowedPrivateHost(host)))
                invalid("Git host is not permitted");
        }

        return addresses[0]!.address;
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("BAD_GATEWAY", { message: "Unable to resolve Git host" });
    } finally {
        clearTimeout(timer);
    }
}

type Run = (
    args: string[],
    input?: Buffer | string,
    limit?: number,
    extraEnv?: Record<string, string>,
) => Promise<Buffer>;

type Entry = { mode: string; oid: string; size: number; path: string };

async function repositorySize(directory: string): Promise<void> {
    let bytes = 0;
    let count = 0;
    const pending = [directory];

    while (pending.length) {
        const parent = pending.pop()!;

        for await (const entry of await opendir(parent)) {
            if (++count > 40_000) throw new Error();
            const path = join(parent, entry.name);

            if (entry.isDirectory()) pending.push(path);
            else if (entry.isFile()) {
                try {
                    bytes += (await stat(path)).size;
                } catch (error) {
                    // Git atomically renames lock files and temporary packs while we scan.
                    if (error instanceof Error && "code" in error && error.code === "ENOENT")
                        continue;
                    throw error;
                }

                if (bytes > maxRepositoryBytes) throw new Error();
            } else throw new Error();
        }
    }
}

async function withRepository<T>(
    repo: Omit<GitRepository, "branch"> & { branch?: string },
    action: (run: Run, revision: string, url: string, branch: string) => Promise<T>,
    fetchSnapshot = true,
): Promise<T> {
    const url = new URL(validateGitUrl(repo.url));
    const branch = fetchSnapshot ? validateGitBranch(repo.branch ?? "") : "";
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const credentials = repo.credentials;

    for (const value of Object.values(credentials)) {
        if (
            value !== undefined &&
            (!z.string().safeParse(value).success ||
                Buffer.byteLength(value) > 128 * 1024 ||
                value.includes("\0"))
        )
            invalid("Invalid Git credentials");
    }

    if (
        url.protocol === "ssh:" &&
        (!credentials.privateKey?.trim() ||
            !credentials.knownHosts?.trim() ||
            credentials.password !== undefined)
    ) {
        invalid("SSH requires a private key and explicit known_hosts, without a password");
    }

    if (
        url.protocol === "https:" &&
        (credentials.privateKey !== undefined || credentials.knownHosts !== undefined)
    )
        invalid("HTTPS requires token or basic credentials");
    const username = credentials.username ?? url.username ?? "git";

    if (url.protocol === "ssh:" && username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(username))
        invalid("Invalid SSH username");

    if (url.protocol === "https:" && credentials.username?.includes(":"))
        invalid("Invalid HTTPS username");
    const address = await pinnedAddress(host);
    const directory = await mkdtemp(join(tmpdir(), "stoat-git-"));
    const deadline = Date.now() + 120_000;

    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        TMPDIR: directory,
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "false",
        SSH_ASKPASS: "false",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_ALLOW_PROTOCOL: url.protocol === "https:" ? "https" : "ssh",
        GIT_ATTR_NOSYSTEM: "1",
    };

    const configFile = join(directory, "transport.config");
    const gitDirectory = join(directory, "repo.git");
    const base = ["--git-dir", gitDirectory, "-c", `include.path=${configFile}`];

    const run: Run = (args, input, limit = maxTreeBytes, extraEnv = {}) =>
        new Promise((resolve, reject) => {
            const remaining = Math.min(30_000, deadline - Date.now());

            if (remaining <= 0)
                return reject(new ORPCError("TIMEOUT", { message: "Git operation timed out" }));

            const child = spawn("git", [...base, ...args], {
                cwd: directory,
                env: { ...env, ...extraEnv },
                shell: false,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });

            const chunks: Buffer[] = [];
            let length = 0;
            let stderrBytes = 0;
            let failure: ORPCError<string, unknown> | undefined;
            let closed = false;
            let scanning: Promise<void> | undefined;

            const stop = (code: "TIMEOUT" | "PAYLOAD_TOO_LARGE" | "BAD_GATEWAY") => {
                failure ??= new ORPCError(code, {
                    message: {
                        TIMEOUT: "Git operation timed out",
                        PAYLOAD_TOO_LARGE: "Git repository exceeds operation limits",
                        BAD_GATEWAY: "Git operation failed",
                    }[code],
                });

                if (!closed && child.pid) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    } catch {
                        child.kill("SIGKILL");
                    }
                }
            };

            const timer = setTimeout(() => stop("TIMEOUT"), remaining);

            // Fetch always retains packs. Poll disk usage too, including temporary packs; this is
            // a best-effort disk bound, not a replacement for container memory/disk quotas.
            const monitor = setInterval(() => {
                if (!scanning)
                    scanning = repositorySize(directory)
                        .catch(() => stop("PAYLOAD_TOO_LARGE"))
                        .finally(() => {
                            scanning = undefined;
                        });
            }, 100);

            child.stdout.on("data", (chunk: Buffer) => {
                length += chunk.length;

                if (length > limit) stop("PAYLOAD_TOO_LARGE");
                else chunks.push(chunk);
            });
            child.stderr.on("data", (chunk: Buffer) => {
                stderrBytes += chunk.length;

                if (stderrBytes > 1024 * 1024) stop("PAYLOAD_TOO_LARGE");
            });
            child.on("error", () => stop("BAD_GATEWAY"));
            child.stdin.on("error", () => {
                /* EPIPE is handled by the exit status. */
            });
            child.on("close", async (code) => {
                closed = true;
                clearTimeout(timer);
                clearInterval(monitor);
                await scanning;

                try {
                    await repositorySize(directory);
                } catch {
                    stop("PAYLOAD_TOO_LARGE");
                }

                const output = Buffer.concat(chunks);

                if (failure) reject(failure);
                else if (code !== 0) {
                    const conflict =
                        args[0] === "push" &&
                        /^!\t[^\n]*\t(?:\[rejected\]|\[remote rejected\] \((?:failed to update ref|cannot lock ref)[^\n]*\))/mu.test(
                            output.toString("utf8"),
                        );

                    reject(
                        new ORPCError(conflict ? "CONFLICT" : "BAD_GATEWAY", {
                            message: conflict
                                ? "Git branch changed; reload before saving"
                                : "Git operation failed; verify repository access and credentials",
                        }),
                    );
                } else resolve(output);
            });
            child.stdin.end(input);
        });

    try {
        let config = `[core]\n hooksPath = /dev/null\n attributesFile = /dev/null\n commitGraph = false\n[credential]\n helper =\n interactive = false\n[protocol]\n allow = never\n[protocol "${url.protocol.slice(0, -1)}"]\n allow = always\n[http]\n followRedirects = false\n proxy =\n sslVerify = true\n lowSpeedLimit = 1024\n lowSpeedTime = 15\n[fetch]\n recurseSubmodules = false\n unpackLimit = 1\n fsckObjects = true\n uriProtocols =\n[transfer]\n bundleURI = false\n fsckObjects = true\n[gc]\n auto = 0\n[maintenance]\n auto = false\n[commit]\n gpgSign = false\n[push]\n gpgSign = false\n followTags = false\n`;

        if (url.protocol === "https:") {
            // No '+' expiry prefix: curl must never fall back to a second DNS lookup.
            const ip = isIP(address) === 6 ? `[${address}]` : address;
            config += "[http]\n";

            // Literal IP URLs already pin their destination (including on older libcurl).
            if (!isIP(host)) config += ` curloptResolve = "${host}:${url.port || "443"}:${ip}"\n`;

            if (credentials.password !== undefined) {
                const basic = Buffer.from(
                    `${credentials.username || "git"}:${credentials.password}`,
                ).toString("base64");

                config += ` extraHeader = "Authorization: Basic ${basic}"\n`;
            }
        } else {
            const keyPath = join(directory, "identity");
            const hostsPath = join(directory, "known_hosts");
            const sshPath = join(directory, "ssh_config");
            // OpenSSH uses HostKeyAlias verbatim, without appending a non-default port.
            const hostKeyAlias = url.port && url.port !== "22" ? `[${host}]:${url.port}` : host;
            await writeFile(keyPath, credentials.privateKey!, { mode: 0o600 });
            await writeFile(hostsPath, credentials.knownHosts!, { mode: 0o600 });

            const quote = (value: string) =>
                `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

            await writeFile(
                sshPath,
                `Host *\n Hostname ${address}\n HostKeyAlias ${hostKeyAlias}\n User ${username || "git"}\n Port ${url.port || "22"}\n IdentityFile ${quote(keyPath)}\n UserKnownHostsFile ${quote(hostsPath)}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n CheckHostIP no\n VerifyHostKeyDNS no\n UpdateHostKeys no\n KnownHostsCommand none\n BatchMode yes\n IdentitiesOnly yes\n IdentityAgent none\n PreferredAuthentications publickey\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n ForwardAgent no\n ClearAllForwardings yes\n ProxyCommand none\n ProxyJump none\n PermitLocalCommand no\n CanonicalizeHostname no\n ConnectTimeout 10\n ConnectionAttempts 1\n ServerAliveInterval 5\n ServerAliveCountMax 3\n`,
                { mode: 0o600 },
            );
            // Git's SSH command parser receives only a server-generated, shell-quoted path.
            env.GIT_SSH_COMMAND = `ssh -F '${sshPath.replace(/'/gu, "'\\''")}'`;
            env.GIT_SSH_VARIANT = "ssh";
            url.username = "";
        }

        // Git sends '~/path' literally for ssh://host/~/path. SCP spelling preserves
        // the plain home-relative argument accepted by restricted hosts such as GitHub.
        // The SSH config still supplies the pinned IP, user, port and host-key alias.
        const remoteUrl =
            url.protocol === "ssh:" && url.pathname.startsWith("/~/")
                ? `${url.hostname}:${url.pathname.slice(3)}`
                : url.toString();

        await writeFile(configFile, config, { mode: 0o600 });

        const version = (await run(["--version"]))
            .toString("utf8")
            .match(/^git version (\d+)\.(\d+)/u);

        if (
            !version ||
            Number(version[1]) < 2 ||
            (Number(version[1]) === 2 && Number(version[2]) < 43)
        ) {
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: "Git 2.43 or newer is required",
            });
        }

        await run(["init", "--bare", "--template=", gitDirectory]);

        if (!fetchSnapshot) return await action(run, "", remoteUrl, "");
        await run([
            "fetch",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            remoteUrl,
            `refs/heads/${branch}:refs/heads/snapshot`,
        ]);

        const revision = (await run(["rev-parse", "--verify", "refs/heads/snapshot^{commit}"]))
            .toString("utf8")
            .trim();

        if (!oidPattern.test(revision)) throw new Error();

        return await action(run, revision, remoteUrl, branch);
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("BAD_GATEWAY", { message: "Git operation failed" });
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: "Unable to clean up Git operation",
            });
        });
    }
}

export async function inspectGitRemote(
    repo: Omit<GitRepository, "branch">,
): Promise<{ defaultBranch: string }> {
    return withRepository(
        repo,
        async (run, _revision, url) => {
            const output = await run(["ls-remote", "--symref", url, "HEAD"], undefined, 16 * 1024);

            try {
                const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                    output,
                );

                const heads = [...decoded.matchAll(/^ref: refs\/heads\/([^\r\n]+)\tHEAD$/gmu)];

                if (heads.length !== 1) throw new Error();

                return { defaultBranch: validateGitBranch(heads[0]![1]!) };
            } catch {
                throw new ORPCError("BAD_GATEWAY", {
                    message:
                        "Unable to determine the Git default branch; initialize the repository and configure its remote HEAD to point to a valid branch",
                });
            }
        },
        false,
    );
}

function text(buffer: Buffer): string {
    if (buffer.length > maxTextBytes) invalid("Git files must be at most 1 MiB");

    try {
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);

        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content))
            invalid("Git file must be UTF-8 text");

        return content;
    } catch {
        return invalid("Git file must be UTF-8 text");
    }
}

async function entries(run: Run, revision: string): Promise<Entry[]> {
    const output = await run(
        ["ls-tree", "-r", "-t", "-l", "-z", revision],
        undefined,
        maxTreeBytes,
    );

    let decoded: string;

    try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
    } catch {
        return invalid("Git paths must be UTF-8");
    }

    const records = decoded.split("\0");

    if (records.pop() !== "" || records.length > maxFiles * 2)
        invalid("Git tree exceeds operation limits");
    let files = 0;

    return records.map((record) => {
        const match =
            /^(\d{6}) (?:blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|\d+)\t([\s\S]+)$/u.exec(
                record,
            );

        if (!match) return invalid("Invalid Git tree");
        const mode = match[1]!;
        const oid = match[2]!;
        const size = match[3]!;
        const path = match[4]!;

        if ((mode === "100644" || mode === "100755") && ++files > maxFiles)
            invalid("Git file list exceeds operation limits");

        return { mode, oid, size: Number(size), path };
    });
}

export async function listGitFiles(
    repo: GitRepository,
): Promise<{ revision: string; files: string[] }> {
    return withRepository(repo, async (run, revision) => ({
        revision,
        files: (await entries(run, revision)).flatMap((entry) =>
            entry.mode === "100644" || entry.mode === "100755" ? [entry.path] : [],
        ),
    }));
}

export async function readGitFile(
    repo: GitRepository,
    path: string,
): Promise<{ revision: string; path: string; content: string }> {
    validateGitPath(path);

    return withRepository(repo, async (run, revision) => {
        const entry = (await entries(run, revision)).find((item) => item.path === path);

        if (!entry) throw new ORPCError("NOT_FOUND", { message: "Git file not found" });

        if (entry.mode !== "100644" && entry.mode !== "100755")
            invalid("Only regular Git files are supported");

        if (entry.size > maxTextBytes) invalid("Git files must be at most 1 MiB");
        const content = text(await run(["cat-file", "blob", entry.oid], undefined, maxTextBytes));

        return { revision, path, content };
    });
}

export async function pushGitFile(
    repo: GitRepository,
    input: {
        path: string;
        content: string;
        expectedRevision: string;
        message: string;
        author: { name: string; email: string };
    },
): Promise<{ revision: string }> {
    const path = validateGitPath(input.path);

    if (!z.string().safeParse(input.content).success || !input.content.isWellFormed())
        invalid("Git file must be UTF-8 text");

    if (Buffer.byteLength(input.content) > maxTextBytes) invalid("Git files must be at most 1 MiB");
    const content = Buffer.from(input.content);
    text(content);

    if (!oidPattern.test(input.expectedRevision)) invalid("Invalid expected Git revision");

    if (
        !z.string().safeParse(input.message).success ||
        !input.message.trim() ||
        Buffer.byteLength(input.message) > 4096 ||
        input.message.includes("\0") ||
        !input.message.isWellFormed()
    )
        invalid("Invalid Git commit message");

    for (const value of [input.author.name, input.author.email]) {
        if (
            !z.string().safeParse(value).success ||
            !value.trim() ||
            Buffer.byteLength(value) > 256 ||
            /[<>\x00-\x1f\x7f]/u.test(value) ||
            !value.isWellFormed()
        )
            invalid("Invalid Git author");
    }

    return withRepository(repo, async (run, current, url, branch) => {
        if (current !== input.expectedRevision)
            throw new ORPCError("CONFLICT", {
                message: "Git branch changed; reload before saving",
            });
        const tree = await entries(run, current);
        const existing = tree.find((entry) => entry.path === path);

        if (existing && existing.mode !== "100644" && existing.mode !== "100755")
            invalid("Only regular Git files are supported");

        if (tree.some((entry) => path.startsWith(`${entry.path}/`) && entry.mode !== "040000"))
            invalid("Git file parent is not a directory");

        if (
            !existing &&
            tree.filter((entry) => entry.mode === "100644" || entry.mode === "100755").length >=
                maxFiles
        )
            invalid("Git file list exceeds operation limits");
        await run(["read-tree", current]);

        const blob = (await run(["hash-object", "-w", "--stdin", "--no-filters"], content))
            .toString("utf8")
            .trim();

        if (!oidPattern.test(blob)) throw new Error();
        await run(
            ["update-index", "-z", "--index-info"],
            `${existing?.mode ?? "100644"} ${blob}\t${path}\0`,
        );
        const treeId = (await run(["write-tree"])).toString("utf8").trim();

        if (!oidPattern.test(treeId)) throw new Error();

        // The exact-OID lease below is safe only because current is the sole parent:
        // a successful push can only append, never replace the expected history.
        const revision = (
            await run(["commit-tree", treeId, "-p", current], input.message, undefined, {
                GIT_AUTHOR_NAME: input.author.name,
                GIT_AUTHOR_EMAIL: input.author.email,
                GIT_COMMITTER_NAME: input.author.name,
                GIT_COMMITTER_EMAIL: input.author.email,
            })
        )
            .toString("utf8")
            .trim();

        if (!oidPattern.test(revision)) throw new Error();
        await run([
            "push",
            "--porcelain",
            "--no-verify",
            "--no-follow-tags",
            `--force-with-lease=refs/heads/${branch}:${current}`,
            url,
            `${revision}:refs/heads/${branch}`,
        ]);

        return { revision };
    });
}
