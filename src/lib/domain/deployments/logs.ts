// oxlint-disable func-style
import { stripAnsi } from "#lib/domain/logs/ansi";

export interface DeploymentLogRecord {
    createdAt: Date;
    id: number;
    message: string;
    stream: string;
}

export interface ParsedDeploymentProgress {
    detail?: string;
    indeterminate: boolean;
    label: string;
    parent?: string;
    percent?: number;
    phase: string;
    status: string;
    target: string;
}

export type DeploymentLogSection = "complete" | "deploy" | "error" | "git" | "plan" | "prepare";

export type DeploymentLogEntry =
    | {
          kind: "progress";
          key: string;
          log: DeploymentLogRecord;
          progress: ParsedDeploymentProgress;
      }
    | {
          kind: "section";
          key: string;
          section: DeploymentLogSection;
          title: string;
      }
    | {
          debug: boolean;
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
    /(?<token>\/(?:[\w./-]+)+|\b(?:complete(?:d)?|success(?:ful)?|started|finished|ready|healthy|running|deployed|updated|removed|created|pulled|built|pushed|restarted|stopped)\b|\b(?:deploying|pulling|creating|starting|stopping|removing|building|pushing|wrote|service|compose|container|image|nginx|docker|machine|workspace|volume|network)\b|\b\d+(?:\.\d+)?(?:ms|[smh]|MB|GB|KB|TB|B|%)\b)/giu;

function classifyHighlight(text: string): LogHighlightKind {
    if (text.startsWith("/")) {
        return "path";
    }

    if (/^\d/u.test(text)) {
        return "number";
    }

    if (
        /complete|success|started|finished|ready|healthy|running|deployed|updated|removed|created|pulled|built|pushed|restarted|stopped/iu.test(
            text,
        )
    ) {
        return "success";
    }

    if (
        /deploying|pulling|creating|starting|stopping|removing|building|pushing|wrote/iu.test(text)
    ) {
        return "info";
    }

    return "keyword";
}

export function highlightLogMessage(message: string): HighlightedLogSegment[] {
    const cleanMessage = stripAnsi(message);

    if (!cleanMessage) {
        return [{ kind: "default", text: " " }];
    }

    const segments: HighlightedLogSegment[] = [];
    let lastIndex = 0;

    for (const match of cleanMessage.matchAll(LOG_HIGHLIGHT_PATTERN)) {
        const index = match.index ?? 0;

        if (index > lastIndex) {
            segments.push({
                kind: "default",
                text: cleanMessage.slice(lastIndex, index),
            });
        }

        const [text] = match;

        if (!text) {
            continue;
        }

        segments.push({ kind: classifyHighlight(text), text });
        lastIndex = index + text.length;
    }

    if (lastIndex < cleanMessage.length) {
        segments.push({ kind: "default", text: cleanMessage.slice(lastIndex) });
    }

    return segments.length > 0 ? segments : [{ kind: "default", text: cleanMessage }];
}

const DEBUG_LOG_PATTERNS: readonly RegExp[] = [
    /^ {2}Pushed /u,
    /^Added .+ to git index$/u,
    /^Changes detected:/u,
    /^Changes: \d+, insertions:/u,
    /^Checking git status in /u,
    /^Committed changes:/u,
    /^Deployment completed for service /u,
    /^Deployment queued for service /u,
    /^Deployment started for service /u,
    /^No changes to commit/u,
    /^Nothing to push/u,
    /^Parsed compose file with /u,
    /^Pushing changes to /u,
    /^Wrote compose file to /u,
];

const PLAN_PREFIX = "Plan: ";

const PLAN_ACTION_LABELS: Record<string, string> = {
    create: "Create",
    delete: "Remove",
    recreate: "Recreate",
    remove: "Remove",
    restart: "Restart",
    run: "Start",
    start: "Start",
    stop: "Stop",
    update: "Update",
};

const OLD_PLAN_OPERATION_PATTERN =
    /^(?<action>\S+)(?: service=(?<service>\S+))?(?: machine=(?<machine>\S+))?(?: image=(?<image>\S+))?(?: container=(?<container>\S+))?(?: order=(?<order>\S+))?$/u;

const SECTION_TITLES: Record<DeploymentLogSection, string> = {
    complete: "Finished",
    deploy: "Rolling out",
    error: "Errors",
    git: "Git",
    plan: "Plan",
    prepare: "Preparing",
};

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

interface ProgressDisplay {
    detail?: string;
    label: string;
}

export function isDebugDeploymentLog(
    log: Pick<DeploymentLogRecord, "message" | "stream">,
): boolean {
    if (log.stream === "stderr") {
        return false;
    }

    if (log.stream === "debug") {
        return true;
    }

    return DEBUG_LOG_PATTERNS.some((pattern) => pattern.test(stripAnsi(log.message)));
}

function formatPlanAction(action: string): string {
    const mapped = PLAN_ACTION_LABELS[action.toLowerCase()];

    if (mapped) {
        return mapped;
    }

    return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

function formatOldPlanOperation(operation: string): string {
    const trimmed = operation.trim();
    const match = OLD_PLAN_OPERATION_PATTERN.exec(trimmed);

    if (!match?.groups?.action || !trimmed.includes("=")) {
        return trimmed;
    }

    const parts: string[] = [formatPlanAction(match.groups.action)];

    if (match.groups.service) {
        parts.push(match.groups.service);
    } else if (match.groups.container) {
        parts.push(match.groups.container);
    }

    if (match.groups.machine) {
        parts.push(`on machine ${match.groups.machine}`);
    }

    if (match.groups.image) {
        parts.push(`(image ${match.groups.image})`);
    }

    return parts.join(" ");
}

export function formatDeploymentLogMessage(message: string): string {
    const cleanMessage = stripAnsi(message);

    if (cleanMessage === "Deploy complete: deployed") {
        return "Deployment finished";
    }

    if (cleanMessage.startsWith("Deploy complete: ")) {
        return `Deployment finished: ${cleanMessage.slice("Deploy complete: ".length)}`;
    }

    if (cleanMessage.startsWith(PLAN_PREFIX)) {
        const details = cleanMessage.slice(PLAN_PREFIX.length);
        const operations = details.includes("=")
            ? details.split(" | ").map(formatOldPlanOperation)
            : details.split(" | ");

        return operations.join("\n");
    }

    return cleanMessage;
}

export function formatDeployPlanMessage(
    operations: {
        action?: string;
        container?: string;
        containerId?: string;
        image?: string;
        machine?: string;
        service?: string;
    }[],
): string {
    if (operations.length === 0) {
        return "Deploy plan received with no operations";
    }

    const lines = operations.map((operation) => {
        const parts: string[] = [formatPlanAction(operation.action ?? "run")];
        const target = operation.service ?? operation.container ?? operation.containerId;

        if (target) {
            parts.push(target);
        }

        if (operation.machine) {
            parts.push(`on machine ${operation.machine}`);
        }

        if (operation.image) {
            parts.push(`(image ${operation.image})`);
        }

        return parts.join(" ");
    });

    return `${PLAN_PREFIX}${lines.join(" | ")}`;
}

export function getDeploymentLogSection(
    log: Pick<DeploymentLogRecord, "message" | "stream">,
): DeploymentLogSection {
    if (log.stream === "stderr") {
        return "error";
    }

    const message = stripAnsi(log.message);

    if (
        /^Deployment queued|^Deployment started|^Parsed compose|^Preparing deployment|^Wrote compose/u.test(
            message,
        )
    ) {
        return "prepare";
    }

    if (
        /^\s+Pushed |^Added .+ to git index|^Changes detected:|^Changes: |^Checking git status|^Committed changes:|^Compose file is already up to date|^No changes to commit|^Nothing to push|^Pushed configuration|^Pushing changes|^Saved compose changes/u.test(
            message,
        )
    ) {
        return "git";
    }

    if (/^Deploy plan|^Plan:/u.test(message)) {
        return "plan";
    }

    if (
        /^Deploy complete|^Deployed service|^Deployment completed|^Deployment finished/u.test(
            message,
        )
    ) {
        return "complete";
    }

    return "deploy";
}

export function insertLogSectionHeaders(entries: DeploymentLogEntry[]): DeploymentLogEntry[] {
    const grouped: DeploymentLogEntry[] = [];
    let currentSection: DeploymentLogSection | undefined;

    for (const [index, entry] of entries.entries()) {
        if (entry.kind === "section") {
            grouped.push(entry);
            continue;
        }

        const section = entry.kind === "progress" ? "deploy" : getDeploymentLogSection(entry.log);

        if (section !== currentSection) {
            currentSection = section;
            grouped.push({
                key: `section:${section}:${index}`,
                kind: "section",
                section,
                title: SECTION_TITLES[section],
            });
        }

        grouped.push(entry);
    }

    return grouped;
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

const IMAGE_TARGET_PATTERN = /^Image (?<name>.+?) on (?<machine>.+)$/u;
const CONTAINER_TARGET_PATTERN = /^Container (?<name>.+?) on (?<machine>.+)$/u;

const CONTAINER_STATUS_LABELS: Record<string, { done: string; pending: string }> = {
    created: { done: "Created container", pending: "Creating container" },
    dead: { done: "Container failed", pending: "Container failing" },
    exited: { done: "Stopped container", pending: "Stopping container" },
    paused: { done: "Paused container", pending: "Pausing container" },
    running: { done: "Started container", pending: "Starting container" },
    stopped: { done: "Stopped container", pending: "Stopping container" },
};

function formatImageDisplay(target: string, phase: string): ProgressDisplay {
    const match = IMAGE_TARGET_PATTERN.exec(target);

    if (!match?.groups?.name || !match.groups.machine) {
        return { label: target };
    }

    return {
        detail: `Machine: ${match.groups.machine}`,
        label:
            phase === "done"
                ? `Pulled image ${match.groups.name}`
                : `Pulling image ${match.groups.name}`,
    };
}

function formatContainerDisplay(target: string, status: string, phase: string): ProgressDisplay {
    const match = CONTAINER_TARGET_PATTERN.exec(target);

    if (!match?.groups?.name || !match.groups.machine) {
        return { label: target };
    }

    const labels = CONTAINER_STATUS_LABELS[status.toLowerCase()];
    const action = labels ? (phase === "done" ? labels.done : labels.pending) : "Container";

    return {
        detail: `Machine: ${match.groups.machine}`,
        label: `${action} ${match.groups.name}`,
    };
}

function formatProgressLabel(
    target: string,
    parent: string | undefined,
    status: string,
    kind: ProgressKind,
    phase: string,
): ProgressDisplay {
    if (kind === "image") {
        return formatImageDisplay(target, phase);
    }

    if (kind === "container") {
        return formatContainerDisplay(target, status, phase);
    }

    if (kind === "layer" && parent) {
        return formatImageDisplay(parent, phase);
    }

    return { label: parent ? `${target} (${parent})` : target };
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
    const line = stripAnsi(message).split("\n")[0] ?? "";
    const progressMatch = PROGRESS_LINE_PATTERN.exec(line);

    if (!progressMatch?.groups) {
        return null;
    }

    const { parent, target } = parseTargetAndParent(progressMatch.groups.rest ?? "");
    const phase = progressMatch.groups.phase ?? "unknown";
    const meta = parseProgressMeta(progressMatch.groups.status ?? "");
    const kind = getProgressKind(target, parent);
    const percent = parseStatusPercent(meta.status, meta.percent, meta.current, meta.total);
    const display = formatProgressLabel(target, parent, meta.status, kind, phase);
    const isDone = phase === "done";
    const resolvedPercent =
        percent ?? (isDone && (kind === "image" || kind === "container") ? 100 : undefined);

    return {
        detail: display.detail,
        indeterminate: resolvedPercent === undefined && !isDone,
        label: display.label,
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
                debug: isDebugDeploymentLog(log),
                kind: "text",
                lines: formatDeploymentLogMessage(log.message).split("\n"),
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
            const imageDisplay = formatImageDisplay(parsed.parent, parsed.phase);
            const imageProgress: ParsedDeploymentProgress = {
                detail: imageDisplay.detail,
                indeterminate: aggregatePercent === undefined && parsed.phase !== "done",
                label: imageDisplay.label,
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
                debug: true,
                kind: "text",
                lines: [formatDeploymentLogMessage(log.message)],
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
