import { mergeEnvironmentVariables } from "#lib/domain/environment";
import type {
    ResourceIngress,
    ResourceIngressInfo,
} from "#lib/domain/resources/ingresses";
import { getResourceDataSource } from "#lib/server/data-sources/data-sources";
import type { CaddyIngress } from "#lib/server/resources/compose-caddy";
import { listComposeCaddyIngresses } from "#lib/server/resources/compose-caddy";
import {
    listComposeServiceNames,
    listEditableComposeIngressRoutes,
} from "#lib/server/resources/compose-ingress-routes";
import { interpolateComposeVariables } from "#lib/server/resources/compose-interpolate";
import type { ComposePort } from "#lib/server/resources/compose-ports";
import { listComposePorts } from "#lib/server/resources/compose-ports";
import { listEnvironmentVariables } from "#lib/server/resources/resource-environment";
import {
    getResource,
    resourceComposePrefix,
} from "#lib/server/resources/resources";
import type { UncloudConnection } from "#lib/server/uncloud";
import { createUncloudClient } from "#lib/server/uncloud";
import { firstPublicHost } from "#lib/server/uncloud/public-host";
import { listWorkspaceEnvironmentVariables } from "#lib/server/workspaces/environment";

const getClusterDomain = async (
    connection: UncloudConnection
): Promise<string | undefined> => {
    try {
        const { data, response } = await createUncloudClient(connection).GET(
            "/api/v1/cluster/domain"
        );

        if (!response.ok || !data?.domain) {
            return undefined;
        }

        return data.domain;
    } catch {
        return undefined;
    }
};

const httpIngress = (
    port: ComposePort,
    deployedService: string,
    clusterDomain: string | undefined
): ResourceIngress => {
    const host =
        port.hostname ??
        (clusterDomain ? `${deployedService}.${clusterDomain}` : undefined);

    return {
        composeService: deployedService,
        containerPort: port.containerPort,
        mode: "ingress",
        protocol: port.protocol,
        ...(host === undefined ? {} : { host, url: `https://${host}` }),
    };
};

const hostPort = (
    port: ComposePort,
    deployedService: string,
    publicHost: string | undefined
): ResourceIngress => {
    const host = port.hostIp ?? port.hostname ?? publicHost;

    return {
        composeService: deployedService,
        containerPort: port.containerPort,
        mode: "host",
        protocol: port.protocol,
        ...(port.publishedPort === undefined
            ? {}
            : { publishedPort: port.publishedPort }),
        ...(host === undefined ? {} : { host }),
    };
};

const DEFAULT_CADDY_PORT = 80;

const isHttpProtocol = (protocol: string): boolean =>
    protocol === "http" || protocol === "https";

const caddyIngress = (
    route: CaddyIngress,
    deployedService: string
): ResourceIngress => {
    const urlPath = route.path?.replace(/\*$/u, "") ?? "";

    return {
        composeService: deployedService,
        containerPort: route.containerPort ?? DEFAULT_CADDY_PORT,
        host: route.host,
        mode: "ingress",
        protocol: route.protocol,
        url: `${route.protocol}://${route.host}${urlPath}`,
        ...(route.path === undefined ? {} : { path: route.path }),
    };
};

const resolveEditableHost = (
    route: ReturnType<typeof listEditableComposeIngressRoutes>[number],
    deployedService: string,
    clusterDomain: string | undefined,
    publicHost: string | undefined,
    resolveVariable: (name: string) => string | undefined
): string | undefined => {
    const configuredHost = route.hostname
        ? interpolateComposeVariables(route.hostname, resolveVariable)
        : undefined;

    if (configuredHost !== undefined) {
        return configuredHost;
    }

    if (isHttpProtocol(route.protocol)) {
        return clusterDomain
            ? `${deployedService}.${clusterDomain}`
            : undefined;
    }

    return publicHost;
};

const matchesEditableRoute = (
    candidate: ResourceIngress,
    route: ReturnType<typeof listEditableComposeIngressRoutes>[number],
    deployedService: string,
    resolvedHost: string | undefined
): boolean => {
    const requiresPublishedPort = !isHttpProtocol(route.protocol);

    return (
        candidate.editableRouteId === undefined &&
        candidate.composeService === deployedService &&
        candidate.containerPort === route.containerPort &&
        candidate.host === resolvedHost &&
        (!requiresPublishedPort ||
            candidate.publishedPort === route.publishedPort) &&
        candidate.protocol === route.protocol
    );
};

const annotateEditableIngresses = (
    ingresses: ResourceIngress[],
    editableRoutes: ReturnType<typeof listEditableComposeIngressRoutes>,
    deployedName: (name: string) => string,
    clusterDomain: string | undefined,
    publicHost: string | undefined,
    resolveVariable: (name: string) => string | undefined
): void => {
    for (const editableRoute of editableRoutes) {
        const deployedService = deployedName(editableRoute.composeService);
        const resolvedHost = resolveEditableHost(
            editableRoute,
            deployedService,
            clusterDomain,
            publicHost,
            resolveVariable
        );
        const ingress = ingresses.find((candidate) =>
            matchesEditableRoute(
                candidate,
                editableRoute,
                deployedService,
                resolvedHost
            )
        );

        if (!ingress) {
            continue;
        }

        ingress.editableComposeService = editableRoute.composeService;
        ingress.editableRouteId = editableRoute.id;

        if (editableRoute.hostname !== undefined) {
            ingress.editableHostname = editableRoute.hostname;
        }

        if (editableRoute.publishedPort !== undefined) {
            ingress.editablePublishedPort = editableRoute.publishedPort;
        }
    }
};

export async function listResourceIngresses(
    resourceId: string
): Promise<ResourceIngressInfo | null> {
    const resource = await getResource(resourceId);

    if (!resource) {
        return null;
    }

    const [workspaceVars, resourceVars] = await Promise.all([
        listWorkspaceEnvironmentVariables(resource.workspaceId),
        listEnvironmentVariables(resourceId),
    ]);
    const environment = mergeEnvironmentVariables(workspaceVars, resourceVars);
    const variables = new Map(
        environment.map((variable) => [variable.name, variable.value])
    );
    const resolveVariable = (name: string): string | undefined =>
        variables.get(name);
    const rawCompose = resource.value ?? "";
    const compose = interpolateComposeVariables(rawCompose, resolveVariable);

    const ports = listComposePorts(compose);
    const editableRoutes = listEditableComposeIngressRoutes(rawCompose);
    const prefix = resourceComposePrefix(resource);
    const deployedName = (name: string): string =>
        prefix ? `${prefix}-${name}` : name;

    const needsDomain = ports.some(
        (port) => isHttpProtocol(port.protocol) && !port.hostname
    );
    const needsPublicHost = ports.some(
        (port) =>
            (port.protocol === "tcp" || port.protocol === "udp") &&
            port.publishedPort !== undefined &&
            !port.hostIp &&
            !port.hostname
    );

    const connection =
        needsDomain || needsPublicHost
            ? await getResourceDataSource(resourceId)
            : undefined;
    const clusterDomain =
        needsDomain && connection
            ? await getClusterDomain(connection)
            : undefined;
    const publicHost =
        needsPublicHost && connection
            ? await firstPublicHost(connection)
            : undefined;

    const ingresses = [
        ...ports
            .filter(
                (port) =>
                    isHttpProtocol(port.protocol) ||
                    port.publishedPort !== undefined
            )
            .map((port) =>
                isHttpProtocol(port.protocol)
                    ? httpIngress(
                          port,
                          deployedName(port.serviceName),
                          clusterDomain
                      )
                    : hostPort(port, deployedName(port.serviceName), publicHost)
            ),
        ...listComposeCaddyIngresses(compose).map((route) =>
            caddyIngress(route, deployedName(route.upstreamService))
        ),
    ];

    annotateEditableIngresses(
        ingresses,
        editableRoutes,
        deployedName,
        clusterDomain,
        publicHost,
        resolveVariable
    );

    return {
        composeServices: listComposeServiceNames(rawCompose),
        ingresses,
        resourceName: resource.name ?? resource.slug ?? resource.id,
        ...(clusterDomain === undefined ? {} : { clusterDomain }),
    };
}
