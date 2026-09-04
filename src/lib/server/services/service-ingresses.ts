import type { ServiceIngress, ServiceIngressInfo } from "#lib/domain/services/ingresses";
import { getServiceDataSource } from "#lib/server/data-sources/data-sources";
import type { CaddyIngress } from "#lib/server/services/compose-caddy";
import { listComposeCaddyIngresses } from "#lib/server/services/compose-caddy";
import {
    listComposeServiceNames,
    listEditableComposeIngressRoutes,
} from "#lib/server/services/compose-ingress-routes";
import { interpolateComposeVariables } from "#lib/server/services/compose-interpolate";
import type { ComposePort } from "#lib/server/services/compose-ports";
import { listComposePorts } from "#lib/server/services/compose-ports";
import { listEnvironmentVariables } from "#lib/server/services/service-environment";
import { getService, serviceComposePrefix } from "#lib/server/services/services";
import type { UncloudConnection } from "#lib/server/uncloud";
import { createUncloudClient } from "#lib/server/uncloud";
import { firstPublicHost } from "#lib/server/uncloud/public-host";

const getClusterDomain = async (connection: UncloudConnection): Promise<string | undefined> => {
    try {
        const { data, response } =
            await createUncloudClient(connection).GET("/api/v1/cluster/domain");

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
    clusterDomain: string | undefined,
): ServiceIngress => {
    const host =
        port.hostname ?? (clusterDomain ? `${deployedService}.${clusterDomain}` : undefined);

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
    publicHost: string | undefined,
): ServiceIngress => {
    const host = port.hostIp ?? port.hostname ?? publicHost;

    return {
        composeService: deployedService,
        containerPort: port.containerPort,
        mode: "host",
        protocol: port.protocol,
        ...(port.publishedPort === undefined ? {} : { publishedPort: port.publishedPort }),
        ...(host === undefined ? {} : { host }),
    };
};

const DEFAULT_CADDY_PORT = 80;

const caddyIngress = (route: CaddyIngress, deployedService: string): ServiceIngress => {
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

export async function listServiceIngresses(serviceId: string): Promise<ServiceIngressInfo | null> {
    const svc = await getService(serviceId);

    if (!svc) {
        return null;
    }

    const environment = await listEnvironmentVariables(serviceId);
    const variables = new Map(environment.map((variable) => [variable.name, variable.value]));
    const resolveVariable = (name: string): string | undefined => variables.get(name);
    const rawCompose = svc.value ?? "";
    const compose = interpolateComposeVariables(rawCompose, resolveVariable);

    const ports = listComposePorts(compose);
    const editableRoutes = listEditableComposeIngressRoutes(rawCompose);
    const prefix = serviceComposePrefix(svc);
    const deployedName = (name: string): string => (prefix ? `${prefix}-${name}` : name);

    const needsDomain = ports.some(
        (port) => (port.protocol === "http" || port.protocol === "https") && !port.hostname,
    );
    const needsPublicHost = ports.some(
        (port) =>
            (port.protocol === "tcp" || port.protocol === "udp") &&
            port.publishedPort !== undefined &&
            !port.hostIp &&
            !port.hostname,
    );

    const connection =
        needsDomain || needsPublicHost ? await getServiceDataSource(serviceId) : undefined;
    const clusterDomain =
        needsDomain && connection ? await getClusterDomain(connection) : undefined;
    const publicHost =
        needsPublicHost && connection ? await firstPublicHost(connection) : undefined;

    const ingresses = [
        ...ports
            .filter(
                (port) =>
                    port.protocol === "http" ||
                    port.protocol === "https" ||
                    port.publishedPort !== undefined,
            )
            .map((port) =>
                port.protocol === "http" || port.protocol === "https"
                    ? httpIngress(port, deployedName(port.serviceName), clusterDomain)
                    : hostPort(port, deployedName(port.serviceName), publicHost),
            ),
        ...listComposeCaddyIngresses(compose).map((route) =>
            caddyIngress(route, deployedName(route.upstreamService)),
        ),
    ];

    for (const editableRoute of editableRoutes) {
        const deployedService = deployedName(editableRoute.composeService);
        const configuredHost = editableRoute.hostname
            ? interpolateComposeVariables(editableRoute.hostname, resolveVariable)
            : undefined;
        const resolvedHost =
            configuredHost ??
            (editableRoute.protocol === "http" || editableRoute.protocol === "https"
                ? clusterDomain
                    ? `${deployedService}.${clusterDomain}`
                    : undefined
                : publicHost);
        const ingress = ingresses.find(
            (candidate) =>
                candidate.editableRouteId === undefined &&
                candidate.composeService === deployedService &&
                candidate.containerPort === editableRoute.containerPort &&
                candidate.host === resolvedHost &&
                (editableRoute.protocol === "http" || editableRoute.protocol === "https"
                    ? true
                    : candidate.publishedPort === editableRoute.publishedPort) &&
                candidate.protocol === editableRoute.protocol,
        );

        if (ingress) {
            ingress.editableComposeService = editableRoute.composeService;
            ingress.editableRouteId = editableRoute.id;

            if (editableRoute.hostname !== undefined) {
                ingress.editableHostname = editableRoute.hostname;
            }

            if (editableRoute.publishedPort !== undefined) {
                ingress.editablePublishedPort = editableRoute.publishedPort;
            }
        }
    }

    return {
        composeServices: listComposeServiceNames(rawCompose),
        ingresses,
        serviceName: svc.name ?? svc.slug ?? svc.id,
        ...(clusterDomain === undefined ? {} : { clusterDomain }),
    };
}
