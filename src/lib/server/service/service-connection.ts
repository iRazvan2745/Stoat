// oxlint-disable func-style
import { ucClient } from "#lib/api/client";
import { findPublishedTcpPort, listComposePorts } from "#lib/compose-ports";
import {
  DEFAULT_POSTGRES_PORT,
  buildPostgresUrl,
  internalHostname,
  postgresConnectionParts,
} from "#lib/database-url";
import type { PostgresConnectionUrl } from "#lib/database-url";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import { listEnvironmentVariables } from "#lib/server/service/service-environment";
import { getService, serviceComposePrefix } from "#lib/server/service/services";

export interface PostgresConnectionInfo {
  database: string;
  external: PostgresConnectionUrl | null;
  internal: PostgresConnectionUrl;
  password: string;
  user: string;
}

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

const externalHost = async (
  hostIp: string | undefined,
  hostname: string | undefined,
): Promise<string | undefined> => hostIp ?? hostname ?? (await firstPublicHost());

export async function getPostgresConnection(
  serviceId: string,
): Promise<PostgresConnectionInfo | null> {
  const svc = await getService(serviceId);

  if (!svc || svc.type !== "postgresql") {
    return null;
  }

  const variables = await listEnvironmentVariables(serviceId);
  const parts = postgresConnectionParts(variables);
  const compose = svc.value ?? "";
  let formattedNames: string[] = [];

  if (svc.value) {
    try {
      formattedNames = formatComposeFile(svc.value, serviceComposePrefix(svc)).serviceNames;
    } catch {
      formattedNames = [];
    }
  }

  const serviceName = formattedNames[0] ?? svc.slug ?? svc.id;
  const published = findPublishedTcpPort(listComposePorts(compose), DEFAULT_POSTGRES_PORT);
  const internalPort = published?.containerPort ?? DEFAULT_POSTGRES_PORT;
  const internal = {
    host: internalHostname(serviceName),
    port: internalPort,
    url: buildPostgresUrl(parts, {
      host: internalHostname(serviceName),
      port: internalPort,
    }),
  };

  if (published?.publishedPort === undefined) {
    return {
      database: parts.database,
      external: null,
      internal,
      password: parts.password,
      user: parts.user,
    };
  }

  const host = await externalHost(published.hostIp, published.hostname);

  if (!host) {
    return {
      database: parts.database,
      external: null,
      internal,
      password: parts.password,
      user: parts.user,
    };
  }

  return {
    database: parts.database,
    external: {
      host,
      port: published.publishedPort,
      url: buildPostgresUrl(parts, {
        host,
        port: published.publishedPort,
      }),
    },
    internal,
    password: parts.password,
    user: parts.user,
  };
}
