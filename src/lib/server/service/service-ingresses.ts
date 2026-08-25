import type { CaddyIngress } from "#lib/server/service/compose-caddy";
import { listComposeCaddyIngresses } from "#lib/server/service/compose-caddy";
import { interpolateComposeVariables } from "#lib/server/service/compose-interpolate";
import type { ComposePort, ComposePortProtocol } from "#lib/server/service/compose-ports";
import { listComposePorts } from "#lib/server/service/compose-ports";
import { listEnvironmentVariables } from "#lib/server/service/service-environment";
import { getService, serviceComposePrefix } from "#lib/server/service/services";
import { ucClient } from "#lib/server/uncloud";
import { firstPublicHost } from "#lib/server/uncloud/public-host";

export interface ServiceIngress {
  /** Deployed compose service name (prefixed when service prefixing is enabled). */
  composeService: string;
  containerPort: number;
  /** Resolved public host (hostname or IP), when known. */
  host?: string;
  mode: "host" | "ingress";
  /** Path matcher for caddy routes (e.g. "/sdoc-server/*"). */
  path?: string;
  protocol: ComposePortProtocol;
  publishedPort?: number;
  /** Clickable URL for HTTP(S) ingresses. */
  url?: string;
}

export interface ServiceIngressInfo {
  clusterDomain?: string;
  ingresses: ServiceIngress[];
  serviceName: string;
}

const getClusterDomain = async (): Promise<string | undefined> => {
  try {
    const { data, response } = await ucClient.GET("/api/v1/cluster/domain");

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
  const host = port.hostname ?? (clusterDomain ? `${deployedService}.${clusterDomain}` : undefined);

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
  const compose = interpolateComposeVariables(svc.value ?? "", (name) => variables.get(name));

  const ports = listComposePorts(compose);
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

  const clusterDomain = needsDomain ? await getClusterDomain() : undefined;
  const publicHost = needsPublicHost ? await firstPublicHost() : undefined;

  const ingresses = [
    ...ports
      .filter(
        (port) =>
          port.protocol === "http" || port.protocol === "https" || port.publishedPort !== undefined,
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

  return {
    ingresses,
    serviceName: svc.name ?? svc.slug ?? svc.id,
    ...(clusterDomain === undefined ? {} : { clusterDomain }),
  };
}
