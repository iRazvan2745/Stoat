// Ported from stoat-old's src/lib/server/deployments/deployment-compose.ts:
// only the formatting/prefixing core, shared by previews and deployment workers.

import YAML, { isAlias, isMap, isNode, isScalar, isSeq } from "yaml";
import type { Node, YAMLMap } from "yaml";
import { Predicate } from "effect";

export interface FormattedCompose {
    serviceCount: number;
    serviceNames: string[];
    yaml: string;
}

/**
 * Deployment prefix for a resource compose spec:
 * `<first 8 of project id>-<first 8 of resource id>`, e.g. `a1b2c3d4-e5f6a7b8-web`.
 * Short enough to stay readable, unique enough that Uncloud treats each
 * resource's services and volumes as distinct. Returns undefined when the
 * resource opted out via `settings.prefixNames === false`.
 */
export function resourceComposePrefix(resource: {
    projectId: string;
    id: string;
    settings: unknown;
}): string | undefined {
    if (Predicate.isObject(resource.settings) && resource.settings.prefixNames === false) {
        return undefined;
    }

    return `${resource.projectId.slice(0, 8)}-${resource.id.slice(0, 8)}`;
}

const prefixName = (name: string, prefix?: string): string => {
    if (!prefix) {
        return name;
    }

    return `${prefix}-${name}`;
};

const isNamedVolumeSource = (source: string): boolean => {
    if (source === "") {
        return false;
    }

    if (
        source.startsWith("/") ||
        source.startsWith("./") ||
        source.startsWith("../") ||
        source.startsWith("~")
    ) {
        return false;
    }

    return !/^[A-Za-z]:[\\/]/u.test(source);
};

type Rename = (name: string) => string;

const prefixShortVolumeSpec = (spec: string, rename: Rename): string => {
    const separatorIndex = spec.indexOf(":");

    if (separatorIndex <= 0) {
        return spec;
    }

    const source = spec.slice(0, separatorIndex);

    if (!isNamedVolumeSource(source)) {
        return spec;
    }

    return `${rename(source)}${spec.slice(separatorIndex)}`;
};

const prefixVolumeMount = (node: Node, rename: Rename): void => {
    if (isScalar(node) && Predicate.isString(node.value)) {
        node.value = prefixShortVolumeSpec(node.value, rename);

        return;
    }

    if (!isMap(node)) {
        return;
    }

    const type = node.get("type");

    if (
        type === "bind" ||
        type === "tmpfs" ||
        type === "npipe" ||
        type === "cluster" ||
        type === "image"
    ) {
        return;
    }

    const source = node.get("source", true);

    if (isScalar(source) && Predicate.isString(source.value) && isNamedVolumeSource(source.value)) {
        source.value = rename(source.value);
    }
};

const prefixServiceVolumes = (service: YAMLMap, rename: Rename): void => {
    const volumes = service.get("volumes", true);

    if (isSeq(volumes)) {
        for (const item of volumes.items) {
            if (isNode(item)) prefixVolumeMount(item, rename);
        }

        return;
    }

    if (isNode(volumes)) prefixVolumeMount(volumes, rename);
};

const prefixTopLevelNames = (entries: YAMLMap, rename: Rename): void => {
    for (const pair of entries.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            continue;
        }

        pair.key.value = rename(pair.key.value);
    }
};

const prefixServiceConfigs = (service: YAMLMap, rename: Rename): void => {
    const configs = service.get("configs", true);

    if (configs === undefined || configs === null) {
        return;
    }

    if (isSeq(configs)) {
        for (const item of configs.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
                continue;
            }

            if (isMap(item)) {
                const source = item.get("source", true);

                if (isScalar(source) && Predicate.isString(source.value)) {
                    source.value = rename(source.value);
                }

                continue;
            }

            throw new Error("Invalid configs entry");
        }

        return;
    }

    if (isScalar(configs) && Predicate.isString(configs.value)) {
        configs.value = rename(configs.value);

        return;
    }

    if (isMap(configs)) {
        const source = configs.get("source", true);

        if (isScalar(source) && Predicate.isString(source.value)) {
            source.value = rename(source.value);
        }

        return;
    }

    throw new Error("Invalid configs entry");
};

const prefixColonRef = (value: string, rename: Rename): string => {
    const separatorIndex = value.indexOf(":");

    if (separatorIndex === -1) {
        return rename(value);
    }

    return `${rename(value.slice(0, separatorIndex))}${value.slice(separatorIndex)}`;
};

const prefixServiceLinks = (service: YAMLMap, rename: Rename): void => {
    const links = service.get("links", true);

    if (!isSeq(links)) {
        return;
    }

    for (const item of links.items) {
        if (isScalar(item) && Predicate.isString(item.value)) {
            item.value = prefixColonRef(item.value, rename);
        }
    }
};

const prefixServiceExtends = (service: YAMLMap, rename: Rename): void => {
    const extendsNode = service.get("extends", true);

    if (!isMap(extendsNode)) {
        return;
    }

    const target = extendsNode.get("service", true);

    if (isScalar(target) && Predicate.isString(target.value)) {
        target.value = rename(target.value);
    }
};

const prefixServiceVolumesFrom = (service: YAMLMap, rename: Rename): void => {
    const volumesFrom = service.get("volumes_from", true);

    if (!isSeq(volumesFrom)) {
        return;
    }

    for (const item of volumesFrom.items) {
        if (isScalar(item) && Predicate.isString(item.value)) {
            item.value = prefixColonRef(item.value, rename);
        }
    }
};

const NETWORK_MODE_SERVICE_PREFIX = "service:";

const prefixServiceNetworkMode = (service: YAMLMap, rename: Rename): void => {
    const mode = service.get("network_mode", true);

    if (!isScalar(mode) || !Predicate.isString(mode.value)) {
        return;
    }

    if (mode.value.startsWith(NETWORK_MODE_SERVICE_PREFIX)) {
        mode.value = `${NETWORK_MODE_SERVICE_PREFIX}${rename(mode.value.slice(NETWORK_MODE_SERVICE_PREFIX.length))}`;
    }
};

const prefixServiceSecrets = (service: YAMLMap, rename: Rename): void => {
    const secrets = service.get("secrets", true);

    if (secrets === undefined || secrets === null) {
        return;
    }

    if (isSeq(secrets)) {
        for (const item of secrets.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
                continue;
            }

            if (isMap(item)) {
                const source = item.get("source", true);

                if (isScalar(source) && Predicate.isString(source.value)) {
                    source.value = rename(source.value);
                }

                continue;
            }

            throw new Error("Invalid secrets entry");
        }

        return;
    }

    if (isScalar(secrets) && Predicate.isString(secrets.value)) {
        secrets.value = rename(secrets.value);

        return;
    }

    if (isMap(secrets)) {
        const source = secrets.get("source", true);

        if (isScalar(source) && Predicate.isString(source.value)) {
            source.value = rename(source.value);
        }

        return;
    }

    throw new Error("Invalid secrets entry");
};

const prefixDependsOn = (service: YAMLMap, rename: Rename): void => {
    const dependsOn = service.get("depends_on", true);

    if (isSeq(dependsOn)) {
        for (const item of dependsOn.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
            }
        }

        return;
    }

    if (isMap(dependsOn)) {
        for (const pair of dependsOn.items) {
            if (isScalar(pair.key) && Predicate.isString(pair.key.value)) {
                pair.key.value = rename(pair.key.value);
            }
        }
    }
};

const CADDY_UPSTREAMS_SERVICE = /(?<open>\{\{\s*upstreams\s+")(?<name>[^"]+)(?<close>")/gu;

const prefixCaddyUpstreams = (service: YAMLMap, rename: Rename): void => {
    const caddy = service.get("x-caddy", true);

    if (!isScalar(caddy) || !Predicate.isString(caddy.value)) {
        return;
    }

    caddy.value = caddy.value.replace(
        CADDY_UPSTREAMS_SERVICE,
        (_match, open: string, name: string, close: string) => `${open}${rename(name)}${close}`,
    );
};

const prefixServiceFragment = (
    service: YAMLMap,
    rename: Rename,
    serviceNames: ReadonlySet<string>,
): void => {
    prefixServiceVolumes(service, rename);
    prefixServiceConfigs(service, rename);
    prefixServiceSecrets(service, rename);
    prefixDependsOn(service, rename);
    prefixServiceLinks(service, rename);
    prefixServiceExtends(service, rename);
    prefixServiceVolumesFrom(service, rename);
    prefixServiceNetworkMode(service, rename);
    prefixCaddyUpstreams(service, rename);
    rewriteServiceEnvironment(service, serviceNames, rename);
};

/**
 * Prefix service-style references inside YAML anchors merged into services
 * (e.g. `x-base: &base` + `<<: *base`). Anchors are resolved
 * precisely through their aliases so unrelated `x-*` extensions are untouched.
 */
const prefixMergedAnchors = (
    doc: ReturnType<typeof YAML.parseDocument>,
    serviceMap: YAMLMap,
    rename: Rename,
    serviceNames: ReadonlySet<string>,
): void => {
    const seen = new Set<string>();

    const collectMergeAliases = (node: Node): void => {
        if (isAlias(node)) {
            if (seen.has(node.source)) {
                return;
            }

            seen.add(node.source);
            const target = node.resolve(doc);

            if (isMap(target)) {
                prefixServiceFragment(target, rename, serviceNames);
                const merged = target.get("<<", true);

                if (isNode(merged)) collectMergeAliases(merged);
            }

            return;
        }

        if (isSeq(node)) {
            for (const item of node.items) {
                if (isNode(item)) collectMergeAliases(item);
            }
        }
    };

    for (const pair of serviceMap.items) {
        if (isMap(pair.value)) {
            const merged = pair.value.get("<<", true);

            if (isNode(merged)) collectMergeAliases(merged);
        }
    }
};

/**
 * Rewrite a single environment value so inter-service references keep working
 * after prefixing. Only exact matches are rewritten: a value that is exactly
 * a service name (`DB_HOST=db`), or a URL whose authority host is exactly a
 * service name (`DATABASE_URL=postgres://user:pass@db:5432/app`). Substrings,
 * external hosts, ports, paths, and credentials are left byte-identical.
 * Exported so future deploy-time env merging (DB-backed vars, .env files)
 * can apply the same rename.
 */
export const rewriteComposeHostname = (
    value: string,
    serviceNames: ReadonlySet<string>,
    rename: Rename,
): string => {
    if (serviceNames.has(value)) {
        return rename(value);
    }

    const schemeIndex = value.indexOf("://");

    if (schemeIndex === -1) {
        return value;
    }

    const authorityStart = schemeIndex + "://".length;
    let authorityEnd = value.length;

    for (const end of ["/", "?", "#"]) {
        const index = value.indexOf(end, authorityStart);

        if (index !== -1) {
            authorityEnd = Math.min(authorityEnd, index);
        }
    }

    const authority = value.slice(authorityStart, authorityEnd);
    const atIndex = authority.lastIndexOf("@");
    const hostWithPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);

    // Service names never contain ":" or brackets; strip a :port suffix but
    // leave [ipv6] literals alone (they can never match a service name).
    let host = hostWithPort;

    if (!host.startsWith("[") && host.includes(":")) {
        host = host.slice(0, host.indexOf(":"));
    }

    if (!serviceNames.has(host)) {
        return value;
    }

    const hostStart = authorityStart + atIndex + 1 + hostWithPort.indexOf(host);

    return `${value.slice(0, hostStart)}${rename(host)}${value.slice(hostStart + host.length)}`;
};

const rewriteServiceEnvironment = (
    service: YAMLMap,
    serviceNames: ReadonlySet<string>,
    rename: Rename,
): void => {
    const environment = service.get("environment", true);

    if (isSeq(environment)) {
        for (const item of environment.items) {
            if (!isScalar(item) || !Predicate.isString(item.value)) {
                continue;
            }

            // Bare `KEY` entries expose a host variable with no value to rewrite.
            const separatorIndex = item.value.indexOf("=");

            if (separatorIndex === -1) {
                continue;
            }

            const rewritten = rewriteComposeHostname(
                item.value.slice(separatorIndex + 1),
                serviceNames,
                rename,
            );

            if (rewritten !== item.value.slice(separatorIndex + 1)) {
                item.value = `${item.value.slice(0, separatorIndex + 1)}${rewritten}`;
            }
        }

        return;
    }

    if (isMap(environment)) {
        for (const pair of environment.items) {
            if (isScalar(pair.value) && Predicate.isString(pair.value.value)) {
                pair.value.value = rewriteComposeHostname(pair.value.value, serviceNames, rename);
            }
        }
    }
};

function transformComposeNames(compose: string, rename: Rename): FormattedCompose {
    const doc = YAML.parseDocument(compose);

    if (doc.errors.length > 0) {
        throw new Error("Invalid compose YAML");
    }

    const serviceMap = doc.get("services", true);

    if (!isMap(serviceMap)) {
        throw new Error('Compose must contain a "services" map');
    }

    // Collect raw names first: environment values are matched against this
    // set, so it must be complete before any renaming happens.
    const rawNames = new Set<string>();

    for (const pair of serviceMap.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            throw new Error("Invalid service name");
        }

        rawNames.add(pair.key.value);
    }

    const serviceNames: string[] = [];

    for (const pair of serviceMap.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            throw new Error("Invalid service name");
        }

        const serviceName = rename(pair.key.value);
        pair.key.value = serviceName;
        serviceNames.push(serviceName);

        if (isMap(pair.value)) {
            prefixServiceFragment(pair.value, rename, rawNames);
        }
    }

    prefixMergedAnchors(doc, serviceMap, rename, rawNames);

    for (const key of ["volumes", "configs", "secrets"]) {
        const entries = doc.get(key, true);

        if (isMap(entries)) prefixTopLevelNames(entries, rename);
    }

    return {
        serviceCount: serviceNames.length,
        serviceNames,
        yaml: doc.toString(),
    };
}

export function formatComposeFile(compose: string, prefix?: string): FormattedCompose {
    return transformComposeNames(compose, (name) => prefixName(name, prefix));
}

/** Undo only the transformations made by formatComposeFile; keep user YAML intact. */
export function unformatComposeFile(compose: string, prefix?: string): string {
    const separator = prefix ? `${prefix}-` : undefined;

    const result = transformComposeNames(compose, (name) =>
        separator && name.startsWith(separator) ? name.slice(separator.length) : name,
    );

    // A redeploy may introduce two names that collapse to the same unprefixed key.
    if (YAML.parseDocument(result.yaml).errors.length > 0) {
        throw new Error("Compose names collide after removing the Stoat prefix");
    }

    return result.yaml;
}
