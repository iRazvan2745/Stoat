// oxlint-disable func-style
export interface ContainerLogSource {
  id: string;
  label: string;
  machineName: string;
  name: string;
  serviceName: string;
}

export interface ContainerLogRecord {
  containerId: string;
  containerLabel: string;
  id: number;
  machineName: string;
  message: string;
  stream: "stderr" | "stdout";
  timestamp: string;
}

export interface ParsedContainerLogEvent {
  containerId: string;
  machineName: string;
  message: string;
  serviceName: string;
  stream: "stderr" | "stdout";
  timestamp: string;
}

const HEARTBEAT_STREAM = "heartbeat";

export function composeServiceName(uncloudServiceName: string, serviceSlug?: string): string {
  if (!serviceSlug) {
    return uncloudServiceName;
  }

  const prefix = `${serviceSlug}-`;

  if (uncloudServiceName.startsWith(prefix)) {
    return uncloudServiceName.slice(prefix.length);
  }

  return uncloudServiceName;
}

export function resolveContainerLabel(
  container: {
    id: string;
    machineName: string;
    name: string;
    serviceName: string;
    shortId?: string;
  },
  siblings: Iterable<{
    id: string;
    machineName: string;
    serviceName: string;
  }>,
  serviceSlug?: string,
): string {
  const base = composeServiceName(container.serviceName, serviceSlug);
  const sameBase: {
    id: string;
    machineName: string;
    serviceName: string;
  }[] = [];

  for (const sibling of siblings) {
    if (composeServiceName(sibling.serviceName, serviceSlug) === base) {
      sameBase.push(sibling);
    }
  }

  if (sameBase.length <= 1) {
    return base || container.name;
  }

  const sameMachine = sameBase.filter((sibling) => sibling.machineName === container.machineName);

  if (sameMachine.length <= 1) {
    return `${base}@${container.machineName}`;
  }

  return `${base}@${container.shortId ?? container.id.slice(0, 12)}`;
}

export function parseContainerLogEvent(payload: unknown): ParsedContainerLogEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const stream = typeof payload.stream === "string" ? payload.stream : "unknown";

  if (stream === HEARTBEAT_STREAM) {
    return null;
  }

  const message =
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.error === "string"
        ? payload.error
        : "";

  if (!message) {
    return null;
  }

  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const containerId =
    readString(metadata.containerId) ?? readString(metadata.serviceId) ?? "unknown";
  const timestamp =
    typeof payload.timestamp === "string" && payload.timestamp.length > 0
      ? payload.timestamp
      : new Date().toISOString();

  return {
    containerId,
    machineName: readString(metadata.machineName) ?? "",
    message,
    serviceName: readString(metadata.serviceName) ?? "",
    stream: stream === "stderr" ? "stderr" : "stdout",
    timestamp,
  };
}

export function insertLogSorted(logs: ContainerLogRecord[], log: ContainerLogRecord): void {
  const last = logs.at(-1);

  if (last === undefined || compareLogOrder(last, log) <= 0) {
    logs.push(log);
    return;
  }

  let low = 0;
  let high = logs.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    const current = logs[mid];

    if (current && compareLogOrder(current, log) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  logs.splice(low, 0, log);
}

export function trimContainerLogs(logs: ContainerLogRecord[], maxLines: number): void {
  if (logs.length <= maxLines) {
    return;
  }

  logs.splice(0, logs.length - maxLines);
}

export function filterContainerLogs(
  logs: ContainerLogRecord[],
  selectedIds: readonly string[],
): ContainerLogRecord[] {
  if (selectedIds.length === 0) {
    return logs;
  }

  const selected = new Set(selectedIds);

  return logs.filter((log) => selected.has(log.containerId));
}

export function matchContainerId(
  containers: readonly ContainerLogSource[],
  containerId: string,
): ContainerLogSource | undefined {
  return containers.find(
    (container) =>
      container.id === containerId ||
      container.id.startsWith(containerId) ||
      containerId.startsWith(container.id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareLogOrder(left: ContainerLogRecord, right: ContainerLogRecord): number {
  if (left.timestamp === right.timestamp) {
    return left.id - right.id;
  }

  return left.timestamp < right.timestamp ? -1 : 1;
}
