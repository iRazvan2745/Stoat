// oxlint-disable func-style no-use-before-define
import type { DeploymentLogEntry, DeploymentLogRecord } from "#lib/deployment-logs";
import {
  buildDeploymentLogEntries,
  insertLogSectionHeaders,
  isDebugDeploymentLog,
} from "#lib/deployment-logs";

export type LogFilter = "all" | "stderr" | "stdout";

export interface ChangeSummary {
  changes: number;
  deletions: number;
  insertions: number;
}

export interface DeploymentLogView {
  allCount: number;
  debugCount: number;
  filteredLogEntries: DeploymentLogEntry[];
  stderrCount: number;
  stdoutCount: number;
  visibleLogEntries: DeploymentLogEntry[];
  visibleLogsCount: number;
}

const CHANGE_SUMMARY_PATTERN =
  /^Changes: (?<changes>\d+), insertions: (?<insertions>\d+), deletions: (?<deletions>\d+)$/u;

export function getChangeSummary(message: string): ChangeSummary | null {
  const groups = CHANGE_SUMMARY_PATTERN.exec(message)?.groups;

  if (!groups?.changes || !groups.insertions || !groups.deletions) {
    return null;
  }

  return {
    changes: Number(groups.changes),
    deletions: Number(groups.deletions),
    insertions: Number(groups.insertions),
  };
}

export function getEmptyLogFilterMessage(
  logFilter: LogFilter,
  debugCount: number,
  showDebugLogs: boolean,
): string {
  if (logFilter === "stderr") {
    return "No errors in this deployment.";
  }

  if (debugCount > 0 && !showDebugLogs) {
    return "No output to show. Enable debug logs to see internal details.";
  }

  return "No output in this deployment.";
}

export function buildDeploymentLogView(
  logs: DeploymentLogRecord[],
  options: { logFilter: LogFilter; showDebugLogs: boolean },
): DeploymentLogView {
  const { logFilter, showDebugLogs } = options;
  const debugCount = logs.filter(isDebugDeploymentLog).length;
  const streamFilteredLogs = filterLogsByStream(logs, logFilter);
  const builtLogEntries = buildDeploymentLogEntries(streamFilteredLogs);
  const filteredLogEntries = showDebugLogs
    ? builtLogEntries
    : builtLogEntries.filter((entry) => entry.kind !== "text" || !entry.debug);

  return {
    allCount: logs.filter((log) => showDebugLogs || !isDebugDeploymentLog(log)).length,
    debugCount,
    filteredLogEntries,
    stderrCount: logs.filter((log) => log.stream === "stderr").length,
    stdoutCount: logs.filter((log) => {
      if (log.stream === "stderr") {
        return false;
      }

      return showDebugLogs || !isDebugDeploymentLog(log);
    }).length,
    visibleLogEntries: insertLogSectionHeaders(filteredLogEntries),
    visibleLogsCount: filteredLogEntries.length,
  };
}

function filterLogsByStream(
  logs: DeploymentLogRecord[],
  logFilter: LogFilter,
): DeploymentLogRecord[] {
  if (logFilter === "all") {
    return logs;
  }

  if (logFilter === "stderr") {
    return logs.filter((log) => log.stream === "stderr");
  }

  return logs.filter((log) => log.stream !== "stderr");
}
