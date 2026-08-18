// oxlint-disable func-style
export interface DeploymentLogRecord {
  createdAt: Date;
  id: number;
  message: string;
  stream: string;
}

export interface ParsedDeploymentProgress {
  indeterminate: boolean;
  label: string;
  parent?: string;
  percent?: number;
  phase: string;
  status: string;
  target: string;
}

export type DeploymentLogEntry =
  | {
      kind: "progress";
      key: string;
      log: DeploymentLogRecord;
      progress: ParsedDeploymentProgress;
    }
  | {
      kind: "text";
      lines: string[];
      log: DeploymentLogRecord;
    };

export type LogHighlightKind = "default" | "info" | "keyword" | "number" | "path" | "success";

export interface HighlightedLogSegment {
  kind: LogHighlightKind;
  text: string;
}

const LOG_HIGHLIGHT_PATTERN =
  /(\/(?:[\w./-]+)+|\b(?:complete(?:d)?|success(?:ful)?|started|finished|ready|healthy|running|deployed|updated|removed|created|pulled|built|pushed|restarted|stopped)\b|\b(?:deploying|pulling|creating|starting|stopping|removing|building|pushing|wrote|service|compose|container|image|nginx|docker|machine|workspace|volume|network)\b|\b\d+(?:\.\d+)?(?:ms|[smh]|MB|GB|KB|TB|B|%)\b)/gi;

function classifyHighlight(text: string): LogHighlightKind {
  if (text.startsWith("/")) {
    return "path";
  }

  if (/^\d/u.test(text)) {
    return "number";
  }

  if (
    /complete|success|started|finished|ready|healthy|running|deployed|updated|removed|created|pulled|built|pushed|restarted|stopped/i.test(
      text,
    )
  ) {
    return "success";
  }

  if (/deploying|pulling|creating|starting|stopping|removing|building|pushing|wrote/i.test(text)) {
    return "info";
  }

  return "keyword";
}

export function highlightLogMessage(message: string): HighlightedLogSegment[] {
  if (!message) {
    return [{ kind: "default", text: " " }];
  }

  const segments: HighlightedLogSegment[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(LOG_HIGHLIGHT_PATTERN)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({
        kind: "default",
        text: message.slice(lastIndex, index),
      });
    }

    const text = match[0];
    segments.push({ kind: classifyHighlight(text), text });
    lastIndex = index + text.length;
  }

  if (lastIndex < message.length) {
    segments.push({ kind: "default", text: message.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "default", text: message }];
}

const BYTE_PROGRESS_PATTERN =
  /^\[(?<bar>[=>\s.]+)\]\s+(?<current>[\d.]+)\s*(?<currentUnit>[KMGT]?B)\/(?<total>[\d.]+)\s*(?<totalUnit>[KMGT]?B)$/u;

const PROGRESS_META_PATTERN =
  /\|(?<meta>(?:p=(?:\d+(?:\.\d+)?|undefined))(?:\|c=(?:\d+(?:\.\d+)?|undefined))?(?:\|t=(?:\d+(?:\.\d+)?|undefined))?)$/u;

const PROGRESS_LINE_PATTERN = /^Progress: (?<rest>.+?) phase=(?<phase>\w+) status=(?<status>.+)$/u;

const BYTE_MULTIPLIERS: Record<string, number> = {
  B: 1,
  GB: 1024 ** 3,
  KB: 1024,
  MB: 1024 ** 2,
  TB: 1024 ** 4,
};

type ProgressKind = "container" | "image" | "layer" | "other";

interface LayerProgress {
  current: number;
  total: number;
}

function parseBytes(value: string, unit: string): number {
  const multiplier = BYTE_MULTIPLIERS[unit.toUpperCase()] ?? 1;

  return Number(value) * multiplier;
}

function parseProgressMeta(message: string): {
  current?: number;
  percent?: number;
  status: string;
  total?: number;
} {
  const metaMatch = PROGRESS_META_PATTERN.exec(message);

  if (!metaMatch?.groups?.meta) {
    return { status: message };
  }

  const status = message.slice(0, metaMatch.index);
  const parts: Record<string, number | undefined> = {};

  for (const part of metaMatch.groups.meta.split("|")) {
    const [key, value] = part.split("=");
    const num = Number(value);

    if (key && Number.isFinite(num)) {
      parts[key] = num;
    }
  }

  return {
    current: parts.c,
    percent: parts.p,
    status,
    total: parts.t,
  };
}

function parseTargetAndParent(rest: string): {
  parent?: string;
  target: string;
} {
  const parentMarker = " parent=";
  const parentIndex = rest.indexOf(parentMarker);

  if (parentIndex === -1) {
    return { target: rest };
  }

  return {
    parent: rest.slice(parentIndex + parentMarker.length),
    target: rest.slice(0, parentIndex),
  };
}

function getProgressKind(target: string, parent?: string): ProgressKind {
  if (target.startsWith("Image ")) {
    return "image";
  }

  if (target.startsWith("Container ")) {
    return "container";
  }

  if (parent?.startsWith("Image ")) {
    return "layer";
  }

  return "other";
}

function formatImageLabel(target: string): string {
  const match = /^Image (?<image>.+?) on (?<machine>.+)$/u.exec(target);

  if (!match?.groups?.image || !match.groups.machine) {
    return target;
  }

  return `Pulling ${match.groups.image} on ${match.groups.machine}`;
}

function formatContainerLabel(target: string): string {
  const match = /^Container (?<container>.+?) on (?<machine>.+)$/u.exec(target);

  if (!match?.groups?.container || !match.groups.machine) {
    return target;
  }

  return `${match.groups.container} on ${match.groups.machine}`;
}

function formatProgressLabel(
  target: string,
  parent: string | undefined,
  status: string,
  kind: ProgressKind,
): string {
  if (kind === "image") {
    return formatImageLabel(target);
  }

  if (kind === "container") {
    return formatContainerLabel(target);
  }

  if (kind === "layer" && parent) {
    return formatImageLabel(parent);
  }

  return parent ? `${target} (${parent})` : target;
}

function parseStatusPercent(
  status: string,
  percent?: number,
  current?: number,
  total?: number,
): number | undefined {
  if (percent !== undefined && Number.isFinite(percent)) {
    return Math.min(100, Math.max(0, percent));
  }

  if (
    current !== undefined &&
    total !== undefined &&
    total > 0 &&
    Number.isFinite(current) &&
    Number.isFinite(total)
  ) {
    return Math.min(100, Math.max(0, (current / total) * 100));
  }

  const byteMatch = BYTE_PROGRESS_PATTERN.exec(status);

  if (
    !byteMatch?.groups?.current ||
    !byteMatch.groups.currentUnit ||
    !byteMatch.groups.total ||
    !byteMatch.groups.totalUnit
  ) {
    return undefined;
  }

  const parsedCurrent = parseBytes(byteMatch.groups.current, byteMatch.groups.currentUnit);
  const parsedTotal = parseBytes(byteMatch.groups.total, byteMatch.groups.totalUnit);

  if (parsedTotal <= 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, (parsedCurrent / parsedTotal) * 100));
}

function aggregateImagePercent(layers: Map<string, LayerProgress> | undefined): number | undefined {
  if (!layers || layers.size === 0) {
    return undefined;
  }

  let current = 0;
  let total = 0;

  for (const layer of layers.values()) {
    current += layer.current;
    total += layer.total;
  }

  if (total <= 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, (current / total) * 100));
}

export function parseDeploymentProgress(message: string): ParsedDeploymentProgress | null {
  const line = message.split("\n")[0] ?? "";
  const progressMatch = PROGRESS_LINE_PATTERN.exec(line);

  if (!progressMatch?.groups) {
    return null;
  }

  const { parent, target } = parseTargetAndParent(progressMatch.groups.rest ?? "");
  const phase = progressMatch.groups.phase ?? "unknown";
  const meta = parseProgressMeta(progressMatch.groups.status ?? "");
  const kind = getProgressKind(target, parent);
  const percent = parseStatusPercent(meta.status, meta.percent, meta.current, meta.total);
  const label = formatProgressLabel(target, parent, meta.status, kind);
  const isDone = phase === "done";
  const resolvedPercent =
    percent ?? (isDone && (kind === "image" || kind === "container") ? 100 : undefined);

  return {
    indeterminate: resolvedPercent === undefined && !isDone,
    label,
    parent,
    percent: resolvedPercent,
    phase,
    status: meta.status,
    target,
  };
}

function updateLayerProgress(
  layersByImage: Map<string, Map<string, LayerProgress>>,
  parent: string,
  layerId: string,
  status: string,
  percent?: number,
  current?: number,
  total?: number,
): void {
  const parsedPercent = parseStatusPercent(status, percent, current, total);

  if (parsedPercent === undefined) {
    return;
  }

  const layers = layersByImage.get(parent) ?? new Map<string, LayerProgress>();
  const byteMatch = BYTE_PROGRESS_PATTERN.exec(status);
  const layerTotal =
    total ??
    (byteMatch?.groups?.total && byteMatch.groups.totalUnit
      ? parseBytes(byteMatch.groups.total, byteMatch.groups.totalUnit)
      : 100);
  const layerCurrent =
    current ??
    (byteMatch?.groups?.current && byteMatch.groups.currentUnit
      ? parseBytes(byteMatch.groups.current, byteMatch.groups.currentUnit)
      : (parsedPercent / 100) * layerTotal);

  layers.set(layerId, { current: layerCurrent, total: layerTotal });
  layersByImage.set(parent, layers);
}

export function buildDeploymentLogEntries(logs: DeploymentLogRecord[]): DeploymentLogEntry[] {
  const entries: DeploymentLogEntry[] = [];
  const progressIndexes = new Map<string, number>();
  const layersByImage = new Map<string, Map<string, LayerProgress>>();

  for (const log of logs) {
    const parsed = parseDeploymentProgress(log.message);

    if (!parsed) {
      entries.push({
        kind: "text",
        lines: log.message.split("\n"),
        log,
      });
      continue;
    }

    const kind = getProgressKind(parsed.target, parsed.parent);

    if (kind === "layer") {
      if (!parsed.parent) {
        continue;
      }

      const progressLine = log.message.split("\n")[0] ?? "";
      const progressMatch = PROGRESS_LINE_PATTERN.exec(progressLine);
      const meta = progressMatch?.groups?.status
        ? parseProgressMeta(progressMatch.groups.status)
        : { status: parsed.status };
      updateLayerProgress(
        layersByImage,
        parsed.parent,
        parsed.target,
        parsed.status,
        meta.percent,
        meta.current,
        meta.total,
      );

      const aggregatePercent = aggregateImagePercent(layersByImage.get(parsed.parent));
      const imageProgress: ParsedDeploymentProgress = {
        indeterminate: aggregatePercent === undefined && parsed.phase !== "done",
        label: formatImageLabel(parsed.parent),
        parent: parsed.parent,
        percent: aggregatePercent ?? (parsed.phase === "done" ? 100 : undefined),
        phase: parsed.phase,
        status: parsed.status,
        target: parsed.parent,
      };
      const key = `image:${parsed.parent}`;
      const existingIndex = progressIndexes.get(key);
      const entry: DeploymentLogEntry = {
        key,
        kind: "progress",
        log,
        progress: imageProgress,
      };

      if (existingIndex === undefined) {
        progressIndexes.set(key, entries.length);
        entries.push(entry);
      } else {
        entries[existingIndex] = entry;
      }

      continue;
    }

    if (kind === "other") {
      entries.push({
        kind: "text",
        lines: [log.message],
        log,
      });
      continue;
    }

    const key = `${kind}:${parsed.target}`;
    const existingIndex = progressIndexes.get(key);
    const entry: DeploymentLogEntry = {
      key,
      kind: "progress",
      log,
      progress: parsed,
    };

    if (existingIndex === undefined) {
      progressIndexes.set(key, entries.length);
      entries.push(entry);
    } else {
      entries[existingIndex] = entry;
    }
  }

  return entries;
}
