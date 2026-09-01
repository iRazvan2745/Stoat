// oxlint-disable func-style
export interface DeploymentFailureCheck {
    id: string;
    matches: (message: string) => boolean;
    summary: string;
}

export interface DeploymentFailureLog {
    message: string;
    stream?: string;
}

export interface DetectedDeploymentFailure {
    checkId: string;
    message: string;
    summary: string;
}

export const DEPLOYMENT_FAILURE_CHECKS: readonly DeploymentFailureCheck[] = [
    {
        id: "unsupported-ingress-protocol",
        matches: (message) => /unsupported protocol for ingress port \d+:\s*\w+/iu.test(message),
        summary: "Ingress port uses an unsupported protocol",
    },
    {
        id: "invalid-service-spec",
        matches: (message) => /invalid service spec/iu.test(message),
        summary: "Service spec is invalid",
    },
    {
        id: "create-deployment-plan",
        matches: (message) => /create deployment plan for service/iu.test(message),
        summary: "Unable to create a deployment plan",
    },
    {
        id: "invalid-deployment",
        matches: (message) => /invalid deployment/iu.test(message),
        summary: "Deployment is invalid",
    },
    {
        id: "deploy-error",
        matches: (message) => message.startsWith("Deploy error:"),
        summary: "Deploy stream reported an error",
    },
    {
        id: "deploy-request-failed",
        matches: (message) => /Failed to deploy service/u.test(message),
        summary: "Deploy request failed",
    },
    {
        id: "invalid-compose",
        matches: (message) => /Invalid compose YAML|the compose is invalid/iu.test(message),
        summary: "Compose file is invalid",
    },
];

export function detectDeploymentFailure(
    logs: Iterable<DeploymentFailureLog>,
): DetectedDeploymentFailure | null {
    for (const log of logs) {
        for (const check of DEPLOYMENT_FAILURE_CHECKS) {
            if (check.matches(log.message)) {
                return {
                    checkId: check.id,
                    message: log.message,
                    summary: check.summary,
                };
            }
        }
    }

    return null;
}
