import type { FormattedCompose } from "#lib/server/deployments/deployment-compose";
import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import { getService, serviceComposePrefix } from "#lib/server/service/services";
// oxlint-disable func-style
import { ucClient } from "#lib/server/uncloud";

import type { components } from "../../../../schema";

export interface ServiceContainerInfo {
  id: string;
  image: string;
  machineName: string;
  name: string;
  serviceName: string;
  shortId: string;
  status: string;
}

type UncloudService = components["schemas"]["Service"];

interface DockerContainerInspect {
  id?: string;
  image?: string;
  name?: string;
  status?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readInspect = (value: unknown): DockerContainerInspect => {
  if (!isRecord(value)) {
    return {};
  }

  const state = isRecord(value.State) ? value.State : undefined;
  const health = state && isRecord(state.Health) ? readString(state.Health.Status) : undefined;
  const status = readString(state?.Status) ?? "unknown";
  const config = isRecord(value.Config) ? value.Config : undefined;

  return {
    id: readString(value.Id) ?? readString(value.ID),
    image: readString(config?.Image) ?? readString(value.Image),
    name: readString(value.Name)?.replace(/^\//u, ""),
    status: status === "running" && health ? health : status,
  };
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Unable to load containers.";

const inspectUncloudService = async (
  id: string,
): Promise<{ error: string | null; service: UncloudService | null }> => {
  try {
    const { data, response } = await ucClient.GET("/api/v1/services/{id}", {
      params: { path: { id } },
    });

    if (response.status === 404) {
      return { error: null, service: null };
    }

    if (!response.ok) {
      return {
        error: `Uncloud API returned HTTP ${response.status}.`,
        service: null,
      };
    }

    if (!data) {
      return {
        error: "Uncloud API returned an empty response.",
        service: null,
      };
    }

    return { error: null, service: data };
  } catch (error) {
    return { error: getErrorMessage(error), service: null };
  }
};

const toContainerInfo = (service: UncloudService): ServiceContainerInfo[] =>
  service.containers.map((container) => {
    const inspect = readInspect(container.container);
    const id = inspect.id ?? `${container.machineId}-${inspect.name ?? service.name}`;

    return {
      id,
      image: inspect.image ?? "unknown",
      machineName: container.machineName,
      name: inspect.name ?? service.name,
      serviceName: service.name,
      shortId: id.slice(0, 12),
      status: inspect.status ?? "unknown",
    };
  });

export async function listServiceContainers(
  serviceId: string,
): Promise<{ error: string | null; items: ServiceContainerInfo[] }> {
  try {
    const svc = await getService(serviceId);

    if (!svc) {
      throw new Error("Service not found");
    }

    if (!svc.value) {
      return { error: null, items: [] };
    }

    let formatted: FormattedCompose;

    try {
      formatted = formatComposeFile(svc.value, serviceComposePrefix(svc));
    } catch {
      return { error: null, items: [] };
    }

    const { serviceNames } = formatted;

    if (serviceNames.length === 0) {
      return { error: null, items: [] };
    }

    const inspections = await Promise.all(serviceNames.map((id) => inspectUncloudService(id)));

    const items: ServiceContainerInfo[] = [];
    let lastError: string | null = null;

    for (const inspection of inspections) {
      if (inspection.error) {
        lastError = inspection.error;
        continue;
      }

      if (!inspection.service) {
        continue;
      }

      items.push(...toContainerInfo(inspection.service));
    }

    if (items.length === 0 && lastError) {
      return { error: lastError, items: [] };
    }

    return { error: null, items };
  } catch (error) {
    return { error: getErrorMessage(error), items: [] };
  }
}
