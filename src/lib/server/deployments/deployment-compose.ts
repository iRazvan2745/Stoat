// oxlint-disable func-style
import YAML, { isMap, isScalar, isSeq } from "yaml";
import type { YAMLMap, YAMLSeq } from "yaml";

import type { EnvironmentVariable } from "#lib/domain/environment";

export interface FormattedCompose {
    serviceCount: number;
    serviceNames: string[];
    yaml: string;
}

const ENV_FILE_NAME = ".env";

const prefixName = (name: string, prefix?: string): string => {
    if (!prefix) {
        return name;
    }

    return `${prefix}-${name}`;
};

const yamlString = (value: unknown): string | undefined => {
    if (isScalar(value) && typeof value.value === "string") {
        return value.value;
    }

    if (typeof value === "string") {
        return value;
    }

    return undefined;
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

const prefixVolumeMount = (node: unknown, rename: Rename): void => {
    if (isScalar(node) && typeof node.value === "string") {
        node.value = prefixShortVolumeSpec(node.value, rename);
        return;
    }

    if (!isMap(node)) {
        return;
    }

    const type = yamlString(node.get("type"));

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

    if (isScalar(source) && typeof source.value === "string" && isNamedVolumeSource(source.value)) {
        source.value = rename(source.value);
    }
};

const prefixServiceVolumes = (service: YAMLMap, rename: Rename): void => {
    const volumes = service.get("volumes", true);

    if (isSeq(volumes)) {
        for (const item of volumes.items) {
            prefixVolumeMount(item, rename);
        }
        return;
    }

    prefixVolumeMount(volumes, rename);
};

const prefixTopLevelVolumes = (volumes: unknown, rename: Rename): void => {
    if (!isMap(volumes)) {
        return;
    }

    for (const pair of volumes.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            continue;
        }

        pair.key.value = rename(pair.key.value);
    }
};

const prefixDependsOn = (service: YAMLMap, rename: Rename): void => {
    const dependsOn = service.get("depends_on", true);

    if (isSeq(dependsOn)) {
        for (const item of dependsOn.items) {
            if (isScalar(item) && typeof item.value === "string") {
                item.value = rename(item.value);
            }
        }
        return;
    }

    if (isMap(dependsOn)) {
        for (const pair of dependsOn.items) {
            if (isScalar(pair.key) && typeof pair.key.value === "string") {
                pair.key.value = rename(pair.key.value);
            }
        }
    }
};

const CADDY_UPSTREAMS_SERVICE = /(?<open>\{\{\s*upstreams\s+")(?<name>[^"]+)(?<close>")/gu;

const prefixCaddyUpstreams = (service: YAMLMap, rename: Rename): void => {
    const caddy = service.get("x-caddy", true);

    if (!isScalar(caddy) || typeof caddy.value !== "string") {
        return;
    }

    caddy.value = caddy.value.replace(
        CADDY_UPSTREAMS_SERVICE,
        (_match, open: string, name: string, close: string) => `${open}${rename(name)}${close}`,
    );
};

const environmentListKey = (item: unknown): string | undefined => {
    const entry = yamlString(item);

    if (entry === undefined) {
        return undefined;
    }

    const separatorIndex = entry.indexOf("=");
    return separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
};

const overlayEnvironment = (service: YAMLMap, variables: readonly EnvironmentVariable[]): void => {
    const existing = service.get("environment", true);

    if (isSeq(existing)) {
        for (const variable of variables) {
            const entry = `${variable.name}=${variable.value}`;
            const index = existing.items.findIndex(
                (item) => environmentListKey(item) === variable.name,
            );
            const item = index === -1 ? undefined : existing.items[index];

            if (isScalar(item)) {
                item.value = entry;
            } else if (index === -1) {
                existing.add(entry);
            } else {
                existing.set(index, entry);
            }
        }
        return;
    }

    if (isMap(existing)) {
        for (const variable of variables) {
            existing.set(variable.name, variable.value);
        }
        return;
    }

    service.set(
        "environment",
        Object.fromEntries(variables.map((variable) => [variable.name, variable.value])),
    );
};

const envFilePath = (node: unknown): string | undefined => {
    const direct = yamlString(node);

    if (direct !== undefined) {
        return direct;
    }

    if (!isMap(node)) {
        return undefined;
    }

    return yamlString(node.get("path"));
};

const isProjectEnvFile = (path: string): boolean =>
    path === ENV_FILE_NAME || path === `./${ENV_FILE_NAME}`;

const seqHasEnvFile = (seq: YAMLSeq): boolean =>
    seq.items.some((item) => {
        const path = envFilePath(item);
        return path !== undefined && isProjectEnvFile(path);
    });

const ensureEnvFile = (service: YAMLMap): void => {
    const existing = service.get("env_file", true);

    if (existing === undefined || existing === null) {
        service.set("env_file", ENV_FILE_NAME);
        return;
    }

    if (isScalar(existing) && typeof existing.value === "string") {
        if (isProjectEnvFile(existing.value)) {
            return;
        }

        service.set("env_file", [existing.value, ENV_FILE_NAME]);
        return;
    }

    if (isSeq(existing)) {
        if (!seqHasEnvFile(existing)) {
            existing.add(ENV_FILE_NAME);
        }
        return;
    }

    if (isMap(existing)) {
        const path = envFilePath(existing);

        if (path !== undefined && isProjectEnvFile(path)) {
            return;
        }

        service.set("env_file", [existing.toJSON(), ENV_FILE_NAME]);
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

    const serviceNames: string[] = [];

    for (const pair of serviceMap.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            throw new Error("Invalid service name");
        }

        const serviceName = rename(pair.key.value);
        pair.key.value = serviceName;
        serviceNames.push(serviceName);

        if (isMap(pair.value)) {
            prefixServiceVolumes(pair.value, rename);
            prefixDependsOn(pair.value, rename);
            prefixCaddyUpstreams(pair.value, rename);
        }
    }

    prefixTopLevelVolumes(doc.get("volumes", true), rename);

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
    // A Git edit may introduce two names that collapse to the same unprefixed key.
    if (YAML.parseDocument(result.yaml).errors.length > 0) {
        throw new Error("Compose names collide after removing the Stoat prefix");
    }
    return result.yaml;
}

export function applyEnvironmentVariables(
    compose: string,
    variables: readonly EnvironmentVariable[],
): string {
    if (variables.length === 0) {
        return compose;
    }

    const doc = YAML.parseDocument(compose);
    const serviceMap = doc.get("services", true);

    if (!isMap(serviceMap)) {
        return compose;
    }

    for (const pair of serviceMap.items) {
        const service = pair.value;

        if (!isMap(service)) {
            continue;
        }

        if (service.has("environment")) {
            overlayEnvironment(service, variables);
            continue;
        }

        ensureEnvFile(service);
    }

    return doc.toString();
}

export function inlineEnvironmentVariables(
    compose: string,
    variables: readonly EnvironmentVariable[],
): string {
    if (variables.length === 0) {
        return compose;
    }

    const doc = YAML.parseDocument(compose);
    const serviceMap = doc.get("services", true);

    if (!isMap(serviceMap)) {
        return compose;
    }

    for (const pair of serviceMap.items) {
        const service = pair.value;

        if (!isMap(service)) {
            continue;
        }

        if (service.has("env_file")) {
            service.delete("env_file");
        }

        overlayEnvironment(service, variables);
    }

    return doc.toString();
}
