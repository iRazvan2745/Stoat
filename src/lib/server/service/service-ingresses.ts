import type { ComposePort, ComposePortProtocol } from "#lib/server/service/compose-ports";
import { listComposePorts } from "#lib/server/service/compose-ports";
import { getService, serviceComposePrefix } from "#lib/server/service/services";
import { ucClient } from "#lib/server/uncloud";

export interface ServiceIngress {
  /** Compose service name as written in the file (unprefixed). */
  composeService: string;
  containerPort: number;
  /** Resolved public host (hostname or IP), when known. */
  host?: string;
  mode: "host" | "ingress";
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

const firstPublicHost = async (): Promise<string | undefined> => {
  try {
    const { data, response } = await ucClient.GET("/api/v1/machines");

    if (!response.ok || !data) {
      return undefined;
    }

    for (const machine of data.items) {
      if (machine.publicIp) {
        return machine.publicIp;
      }
    }

    return data.items[0]?.hostname ?? data.items[0]?.name;
  } catch {
    return undefined;
  }
};

const httpIngress = (
  port: ComposePort,
  deployedName: string,
  clusterDomain: string | undefined,
): ServiceIngress => {
  const host = port.hostname ?? (clusterDomain ? `${deployedName}.${clusterDomain}` : undefined);

  return {
    composeService: port.serviceName,
    containerPort: port.containerPort,
    mode: "ingress",
    protocol: port.protocol,
    ...(host === undefined ? {} : { host, url: `https://${host}` }),
  };
};

const hostPort = (port: ComposePort, publicHost: string | undefined): ServiceIngress => {
  const host = port.hostIp ?? port.hostname ?? publicHost;

  return {
    composeService: port.serviceName,
    containerPort: port.containerPort,
    mode: "host",
    protocol: port.protocol,
    ...(port.publishedPort === undefined ? {} : { publishedPort: port.publishedPort }),
    ...(host === undefined ? {} : { host }),
  };
};

export async function listServiceIngresses(serviceId: string): Promise<ServiceIngressInfo | null> {
  const svc = await getService(serviceId);

  if (!svc) {
    return null;
  }

  const ports = listComposePorts(svc.value ?? "");
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

  const ingresses = ports
    .filter(
      (port) =>
        port.protocol === "http" || port.protocol === "https" || port.publishedPort !== undefined,
    )
    .map((port) =>
      port.protocol === "http" || port.protocol === "https"
        ? httpIngress(port, deployedName(port.serviceName), clusterDomain)
        : hostPort(port, publicHost),
    );

  return {
    ingresses,
    serviceName: svc.name ?? svc.slug ?? svc.id,
    ...(clusterDomain === undefined ? {} : { clusterDomain }),
  };
}
