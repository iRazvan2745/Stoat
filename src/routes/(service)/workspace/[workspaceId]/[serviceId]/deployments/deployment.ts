// oxlint-disable func-style default-case
import type { DeploymentFailureLog } from "#lib/deployments/failure";
import { detectDeploymentFailure } from "#lib/deployments/failure";
import type { ServiceSettings } from "#lib/service/settings";

export interface Deployment {
  createdAt: Date;
  finishedAt: Date | null;
  id: string;
  jobId: string | null;
  outcome: string | null;
  queuedAt: Date | null;
  serviceId: string;
  settings?: ServiceSettings;
  startedAt: Date | null;
  updatedAt: Date;
}

export type DeploymentPhase = "finished" | "pending" | "queued" | "started";

export type DeploymentDisplayStatus = "cancelled" | "deployed" | "failed" | DeploymentPhase;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

const timeFormatter = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function getPhase(deployment: Deployment): DeploymentPhase {
  if (deployment.finishedAt) {
    return "finished";
  }

  if (deployment.startedAt) {
    return "started";
  }

  if (deployment.queuedAt) {
    return "queued";
  }

  return "pending";
}

export function getDisplayStatus(
  deployment: Deployment,
  selectedLogs?: Iterable<DeploymentFailureLog> | null,
): DeploymentDisplayStatus {
  if (deployment.outcome === "cancelled") {
    return "cancelled";
  }

  if (deployment.outcome === "failed") {
    return "failed";
  }

  if (selectedLogs && detectDeploymentFailure(selectedLogs)) {
    return "failed";
  }

  const phase = getPhase(deployment);

  if (phase !== "finished") {
    return phase;
  }

  return "deployed";
}

export function isDeploymentActive(
  deployment: Deployment,
  selectedLogs?: Iterable<DeploymentFailureLog> | null,
): boolean {
  return (
    getPhase(deployment) !== "finished" && getDisplayStatus(deployment, selectedLogs) !== "failed"
  );
}

export function getStatusLabel(status: DeploymentDisplayStatus): string {
  switch (status) {
    case "deployed": {
      return "Deployed";
    }

    case "failed": {
      return "Failed";
    }

    case "cancelled": {
      return "Cancelled";
    }

    case "started": {
      return "Deploying";
    }

    case "queued": {
      return "Queued";
    }

    case "pending": {
      return "Pending";
    }

    case "finished": {
      return "Finished";
    }
  }
}

export function getStatusClasses(status: DeploymentDisplayStatus): string {
  switch (status) {
    case "deployed": {
      return "bg-primary-container text-on-primary-container";
    }

    case "failed": {
      return "bg-error-container-subtle text-on-error-container-subtle";
    }

    case "cancelled": {
      return "bg-surface-container-high text-on-surface-variant";
    }

    case "started": {
      return "bg-tertiary-container text-on-tertiary-container";
    }

    case "queued": {
      return "bg-secondary-container text-on-secondary-container";
    }

    case "pending":
    case "finished": {
      return "bg-surface-container-high text-on-surface-variant";
    }
  }
}

export function formatDate(date: Date | null): string | null {
  return date ? dateFormatter.format(date) : null;
}

export function formatTime(date: Date | null): string | null {
  return date ? timeFormatter.format(date) : null;
}

export function getDuration(deployment: Deployment): string | null {
  if (!deployment.startedAt || !deployment.finishedAt) {
    return null;
  }

  const seconds = Math.max(
    0,
    Math.round((deployment.finishedAt.getTime() - deployment.startedAt.getTime()) / 1000),
  );

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function getShortId(id: string): string {
  return id.slice(0, 7);
}
