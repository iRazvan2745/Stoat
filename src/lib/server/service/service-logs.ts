// oxlint-disable func-style no-await-in-loop promise/avoid-new
import { UNCLOUD_API } from "$app/env/private";

import { formatComposeFile } from "#lib/server/deployments/deployment-compose";
import type { ServiceContainerInfo } from "#lib/server/service/service-containers";
import { listServiceContainers } from "#lib/server/service/service-containers";
import { getService, serviceComposePrefix } from "#lib/server/service/services";
import { consumeSseJsonStream, isAbortError } from "#lib/server/shared/sse";
import type { ContainerLogRecord, ContainerLogSource } from "#lib/service/container-logs";
import {
  insertLogSorted,
  matchContainerId,
  parseContainerLogEvent,
  resolveContainerLabel,
  trimContainerLogs,
} from "#lib/service/container-logs";

const LOG_TAIL = 200;
const MAX_CONTAINER_LOGS = 5000;

export interface ServiceContainerLogsSnapshot {
  containers: ContainerLogSource[];
  error: string | null;
  following: boolean;
  logs: ContainerLogRecord[];
}

type QueueItem =
  | { kind: "end" }
  | { kind: "error"; message: string }
  | { kind: "log"; log: ContainerLogRecord };

class EventQueue {
  private closed = false;
  private readonly items: QueueItem[] = [];
  private readonly waiters: ((item: QueueItem | null) => void)[] = [];

  push(...items: QueueItem[]): void {
    for (const item of items) {
      if (this.closed) {
        return;
      }

      const waiter = this.waiters.shift();

      if (waiter) {
        waiter(item);
        continue;
      }

      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const waiter of this.waiters) {
      waiter(null);
    }

    this.waiters.length = 0;
  }

  tryNext(): QueueItem | null {
    return this.items.shift() ?? null;
  }

  async next(): Promise<QueueItem | null> {
    const item = this.tryNext();

    if (item) {
      return item;
    }

    if (this.closed) {
      return null;
    }

    return await new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Unable to stream container logs.";

const snapshotOf = (
  containers: ContainerLogSource[],
  logs: ContainerLogRecord[],
  following: boolean,
  error: string | null,
): ServiceContainerLogsSnapshot => ({
  containers: [...containers],
  error,
  following,
  logs: [...logs],
});

const relabelContainers = (containers: ContainerLogSource[], prefix?: string): void => {
  for (const container of containers) {
    container.label = resolveContainerLabel(
      {
        id: container.id,
        machineName: container.machineName,
        name: container.name,
        serviceName: container.serviceName,
        shortId: container.id.slice(0, 12),
      },
      containers,
      prefix,
    );
  }
};

const toLogSource = (
  container: ServiceContainerInfo,
  siblings: ServiceContainerInfo[],
  prefix?: string,
): ContainerLogSource => ({
  id: container.id,
  label: resolveContainerLabel(container, siblings, prefix),
  machineName: container.machineName,
  name: container.name,
  serviceName: container.serviceName,
});

const upsertLogSource = (
  containers: ContainerLogSource[],
  event: {
    containerId: string;
    machineName: string;
    serviceName: string;
  },
  prefix?: string,
): ContainerLogSource => {
  const existing = matchContainerId(containers, event.containerId);

  if (existing) {
    return existing;
  }

  const source: ContainerLogSource = {
    id: event.containerId,
    label: "",
    machineName: event.machineName,
    name: event.serviceName || event.containerId.slice(0, 12),
    serviceName: event.serviceName || event.containerId.slice(0, 12),
  };

  containers.push(source);
  relabelContainers(containers, prefix);

  return source;
};

const buildServiceLogsUrl = (uncloudServiceId: string): string => {
  const base = UNCLOUD_API.replace(/\/$/u, "");
  const url = new URL(`${base}/api/v1/services/${encodeURIComponent(uncloudServiceId)}/logs`);

  url.searchParams.set("follow", "true");
  url.searchParams.set("tail", String(LOG_TAIL));

  return url.toString();
};

const openServiceLogStream = async (
  uncloudServiceId: string,
  signal: AbortSignal,
): Promise<Response | null> => {
  try {
    const response = await fetch(buildServiceLogsUrl(uncloudServiceId), {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Uncloud logs API returned HTTP ${response.status} for ${uncloudServiceId}.`);
    }

    return response;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return null;
    }

    throw error;
  }
};

type PreparedServiceLogs =
  | { ok: false; snapshot: ServiceContainerLogsSnapshot }
  | {
      ok: true;
      containers: ContainerLogSource[];
      listedError: string | null;
      prefix?: string;
      serviceNames: string[];
    };

interface LogQueueState {
  containers: ContainerLogSource[];
  logs: ContainerLogRecord[];
  openStreams: number;
}

interface ConsumeLogContext {
  containers: ContainerLogSource[];
  nextLogId: { value: number };
  prefix?: string;
  queue: EventQueue;
  signal: AbortSignal;
}

const prepareServiceLogContext = async (serviceId: string): Promise<PreparedServiceLogs> => {
  const svc = await getService(serviceId);

  if (!svc) {
    return {
      ok: false,
      snapshot: snapshotOf([], [], false, "Service not found"),
    };
  }

  if (!svc.value) {
    return {
      ok: false,
      snapshot: snapshotOf([], [], false, "This service does not have a compose file yet."),
    };
  }

  const prefix = serviceComposePrefix(svc);
  let formatted;

  try {
    formatted = formatComposeFile(svc.value, prefix);
  } catch {
    return {
      ok: false,
      snapshot: snapshotOf([], [], false, "Compose file is invalid."),
    };
  }

  const listed = await listServiceContainers(serviceId);

  return {
    containers: listed.items.map((container) => toLogSource(container, listed.items, prefix)),
    listedError: listed.error,
    ok: true,
    prefix,
    serviceNames: formatted.serviceNames,
  };
};

const collectOpenStreams = (
  connections: PromiseSettledResult<Response | null>[],
  listedError: string | null,
): { lastError: string | null; streams: Response[] } => {
  const streams: Response[] = [];
  let lastError = listedError;

  for (const connection of connections) {
    if (connection.status === "rejected") {
      lastError = getErrorMessage(connection.reason);
      continue;
    }

    if (connection.value) {
      streams.push(connection.value);
    }
  }

  return { lastError, streams };
};

const consumeLogResponse = async (
  response: Response,
  context: ConsumeLogContext,
): Promise<void> => {
  const { containers, nextLogId, queue, prefix, signal } = context;

  if (!response.body) {
    queue.push(
      {
        kind: "error",
        message: "Log stream did not include a body.",
      },
      { kind: "end" },
    );
    return;
  }

  try {
    await consumeSseJsonStream(
      response.body,
      (_eventName, payload): Promise<void> => {
        const parsed = parseContainerLogEvent(payload);

        if (!parsed) {
          return Promise.resolve();
        }

        const source = upsertLogSource(containers, parsed, prefix);

        queue.push({
          kind: "log",
          log: {
            containerId: source.id,
            containerLabel: source.label,
            id: nextLogId.value,
            machineName: parsed.machineName || source.machineName,
            message: parsed.message,
            stream: parsed.stream,
            timestamp: parsed.timestamp,
          },
        });
        nextLogId.value += 1;
        return Promise.resolve();
      },
      signal,
    );
  } catch (error) {
    if (!(signal.aborted || isAbortError(error))) {
      queue.push({
        kind: "error",
        message: getErrorMessage(error),
      });
    }
  } finally {
    queue.push({ kind: "end" });
  }
};

const isFatalStreamError = (state: LogQueueState): boolean =>
  state.logs.length === 0 && state.openStreams <= 1;

const applyQueueItem = (
  state: LogQueueState,
  item: QueueItem,
): ServiceContainerLogsSnapshot | null => {
  if (item.kind === "log") {
    insertLogSorted(state.logs, item.log);
    trimContainerLogs(state.logs, MAX_CONTAINER_LOGS);
    return null;
  }

  if (item.kind === "end") {
    state.openStreams = Math.max(0, state.openStreams - 1);
    return null;
  }

  if (item.kind === "error" && isFatalStreamError(state)) {
    return snapshotOf(state.containers, state.logs, false, item.message);
  }

  return null;
};

function* drainPendingQueue(
  queue: EventQueue,
  state: LogQueueState,
): Generator<ServiceContainerLogsSnapshot> {
  let queued = queue.tryNext();

  while (queued) {
    const errorSnapshot = applyQueueItem(state, queued);

    if (errorSnapshot) {
      yield errorSnapshot;
    }

    queued = queue.tryNext();
  }

  yield snapshotOf(state.containers, state.logs, state.openStreams > 0, null);
}

async function* iterateLogEvents(
  queue: EventQueue,
  state: LogQueueState,
  signal: AbortSignal,
): AsyncGenerator<ServiceContainerLogsSnapshot> {
  while (!signal.aborted) {
    const item = await queue.next();

    if (!item) {
      break;
    }

    if (item.kind === "log") {
      applyQueueItem(state, item);
      yield* drainPendingQueue(queue, state);

      if (state.openStreams === 0) {
        break;
      }

      continue;
    }

    if (item.kind === "error" && isFatalStreamError(state)) {
      yield snapshotOf(state.containers, state.logs, false, item.message);
      continue;
    }

    if (item.kind !== "end") {
      continue;
    }

    state.openStreams = Math.max(0, state.openStreams - 1);

    if (state.openStreams === 0) {
      yield snapshotOf(state.containers, state.logs, false, null);
      break;
    }
  }
}

export async function* streamServiceContainerLogs(
  serviceId: string,
  signal?: AbortSignal,
): AsyncGenerator<ServiceContainerLogsSnapshot> {
  const controller = new AbortController();
  const logs: ContainerLogRecord[] = [];
  const nextLogId = { value: 1 };
  const queue = new EventQueue();
  const onAbort = (): void => {
    controller.abort();
    queue.close();
  };

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const prepared = await prepareServiceLogContext(serviceId);

    if (!prepared.ok) {
      yield prepared.snapshot;
      return;
    }

    const { containers, listedError, serviceNames, prefix } = prepared;

    yield snapshotOf(containers, logs, false, null);

    if (serviceNames.length === 0) {
      yield snapshotOf(containers, logs, false, "Compose file has no services.");
      return;
    }

    const connections = await Promise.allSettled(
      serviceNames.map((uncloudServiceId) =>
        openServiceLogStream(uncloudServiceId, controller.signal),
      ),
    );
    const { lastError, streams } = collectOpenStreams(connections, listedError);

    if (streams.length === 0) {
      yield snapshotOf(
        containers,
        logs,
        false,
        lastError ?? "No running containers to stream logs from.",
      );
      return;
    }

    for (const response of streams) {
      void consumeLogResponse(response, {
        containers,
        nextLogId,
        prefix,
        queue,
        signal: controller.signal,
      });
    }

    yield snapshotOf(containers, logs, true, null);
    yield* iterateLogEvents(
      queue,
      { containers, logs, openStreams: streams.length },
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted || isAbortError(error)) {
      return;
    }

    yield snapshotOf([], [], false, getErrorMessage(error));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
    queue.close();
  }
}
