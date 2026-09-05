import YAML, { isMap, isScalar, isSeq, YAMLSeq } from "yaml";
import type { YAMLMap } from "yaml";

import type { ServiceIngressProtocol } from "#lib/domain/services/ingresses";
import { parseComposePortSpec } from "#lib/server/services/compose-ports";

const EDITABLE_PROTOCOLS = ["http", "https", "tcp", "udp"] as const;

export interface ComposeIngressRouteInput {
    composeService: string;
    containerPort: number;
    hostname?: string;
    protocol: ServiceIngressProtocol;
    publishedPort?: number;
}

export interface EditableComposeIngressRoute extends ComposeIngressRouteInput {
    id: string;
}

interface RouteReference {
    index: number;
    serviceName: string;
    spec: string;
}

const isEditableProtocol = (
    protocol: ServiceIngressProtocol,
): protocol is ComposeIngressRouteInput["protocol"] =>
    EDITABLE_PROTOCOLS.includes(protocol as ComposeIngressRouteInput["protocol"]);

const routeId = (reference: RouteReference): string =>
    JSON.stringify(["x-ports", reference.serviceName, reference.index, reference.spec]);

const parseRouteId = (id: string): RouteReference => {
    let value: unknown;

    try {
        value = JSON.parse(id);
    } catch {
        throw new Error("Invalid ingress route identifier");
    }

    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== "x-ports" ||
        typeof value[1] !== "string" ||
        !Number.isInteger(value[2]) ||
        typeof value[3] !== "string"
    ) {
        throw new Error("Invalid ingress route identifier");
    }

    return { index: value[2] as number, serviceName: value[1], spec: value[3] };
};

const composeDocument = (compose: string) => {
    const document = YAML.parseDocument(compose);

    if (document.errors.length > 0) {
        throw new Error("Invalid compose YAML");
    }

    const services = document.get("services", true);

    if (!isMap(services)) {
        throw new Error("Compose file must define services");
    }

    return { document, services };
};

const serviceMap = (services: YAMLMap, serviceName: string): YAMLMap => {
    const service = services.get(serviceName, true);

    if (!isMap(service)) {
        throw new Error(`Compose service ${serviceName} was not found`);
    }

    return service;
};

const xPortsSequence = (service: YAMLMap, create: boolean): YAMLSeq | undefined => {
    const current = service.get("x-ports", true);

    if (current === undefined && create) {
        service.set("x-ports", new YAMLSeq());
        const created = service.get("x-ports", true);

        if (isSeq(created)) {
            return created;
        }
    }

    if (current === undefined) {
        return undefined;
    }

    if (!isSeq(current)) {
        if (!create) {
            return undefined;
        }

        const sequence = new YAMLSeq();
        sequence.add(current);
        service.set("x-ports", sequence);
        return sequence;
    }

    return current;
};

const routeSpec = (route: ComposeIngressRouteInput): string => {
    const hostname = route.hostname?.trim();

    if (hostname && /[\s/:]/u.test(hostname)) {
        throw new Error("Domain must not contain spaces, slashes, or ports");
    }

    const isHostPort = route.protocol === "tcp" || route.protocol === "udp";

    if (isHostPort && route.publishedPort === undefined) {
        throw new Error("Published port is required for TCP and UDP routes");
    }

    const { publishedPort } = route;
    const portSpec =
        publishedPort === undefined
            ? String(route.containerPort)
            : `${publishedPort}:${route.containerPort}`;
    const prefix = hostname ? `${hostname}:` : "";
    return `${prefix}${portSpec}/${route.protocol}`;
};

const routeSequence = (services: YAMLMap, reference: RouteReference): YAMLSeq => {
    const service = serviceMap(services, reference.serviceName);
    const sequence = xPortsSequence(service, false);
    const item = sequence?.items[reference.index];

    if (!sequence || !isScalar(item) || String(item.value) !== reference.spec) {
        throw new Error(
            "This ingress route changed since the page was loaded. Refresh and try again.",
        );
    }

    return sequence;
};

export const listComposeServiceNames = (compose: string): string[] => {
    const { services } = composeDocument(compose);

    return services.items.flatMap((pair) =>
        isScalar(pair.key) && typeof pair.key.value === "string" ? [pair.key.value] : [],
    );
};

export const listEditableComposeIngressRoutes = (
    compose: string,
): EditableComposeIngressRoute[] => {
    const { services } = composeDocument(compose);
    const routes: EditableComposeIngressRoute[] = [];

    for (const pair of services.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isMap(pair.value)) {
            continue;
        }

        const composeService = pair.key.value;
        const sequence = xPortsSequence(pair.value, false);

        if (!sequence) {
            continue;
        }

        for (const [index, item] of sequence.items.entries()) {
            if (!isScalar(item)) {
                continue;
            }

            const spec = String(item.value);
            const port = parseComposePortSpec(spec, composeService);

            if (!port || !isEditableProtocol(port.protocol)) {
                continue;
            }

            routes.push({
                composeService,
                containerPort: port.containerPort,
                id: routeId({ index, serviceName: composeService, spec }),
                protocol: port.protocol,
                ...(port.hostname === undefined ? {} : { hostname: port.hostname }),
                ...(port.publishedPort === undefined ? {} : { publishedPort: port.publishedPort }),
            });
        }
    }

    return routes;
};

export const addComposeIngressRoute = (
    compose: string,
    route: ComposeIngressRouteInput,
): string => {
    const { document, services } = composeDocument(compose);
    const service = serviceMap(services, route.composeService);
    const sequence = xPortsSequence(service, true);

    if (!sequence) {
        throw new Error("Unable to create the x-ports list");
    }

    sequence.add(routeSpec(route));
    return document.toString();
};

export const updateComposeIngressRoute = (
    compose: string,
    id: string,
    route: ComposeIngressRouteInput,
): string => {
    const reference = parseRouteId(id);
    const { document, services } = composeDocument(compose);
    const sequence = routeSequence(services, reference);

    if (reference.serviceName === route.composeService) {
        sequence.set(reference.index, routeSpec(route));
    } else {
        sequence.delete(reference.index);

        if (sequence.items.length === 0) {
            serviceMap(services, reference.serviceName).delete("x-ports");
        }

        const target = xPortsSequence(serviceMap(services, route.composeService), true);

        if (!target) {
            throw new Error("Unable to create the target x-ports list");
        }

        target.add(routeSpec(route));
    }

    return document.toString();
};

export const deleteComposeIngressRoute = (compose: string, id: string): string => {
    const reference = parseRouteId(id);
    const { document, services } = composeDocument(compose);
    const service = serviceMap(services, reference.serviceName);
    const sequence = routeSequence(services, reference);

    sequence.delete(reference.index);

    if (sequence.items.length === 0) {
        service.delete("x-ports");
    }

    return document.toString();
};
