import { describe, expect, it } from "vite-plus/test";

import { detectDeploymentFailure } from "#lib/deployments/failure";

describe("detectDeploymentFailure", () => {
  it("detects unsupported ingress protocol errors", () => {
    const failure = detectDeploymentFailure([
      {
        message:
          "Deploy error: create deployment plan for service 'nginx-f7gzq-nginx': invalid deployment: invalid service spec: unsupported protocol for ingress port 80: tcp",
        stream: "stderr",
      },
    ]);

    expect(failure).toEqual({
      checkId: "unsupported-ingress-protocol",
      message:
        "Deploy error: create deployment plan for service 'nginx-f7gzq-nginx': invalid deployment: invalid service spec: unsupported protocol for ingress port 80: tcp",
      summary: "Ingress port uses an unsupported protocol",
    });
  });

  it("detects the same failure without the deploy-error prefix", () => {
    const failure = detectDeploymentFailure([
      {
        message:
          "create deployment plan for service 'nginx-f7gzq-nginx': invalid deployment: invalid service spec: unsupported protocol for ingress port 80: tcp",
        stream: "stderr",
      },
    ]);

    expect(failure?.checkId).toBe("unsupported-ingress-protocol");
  });

  it("detects invalid compose files", () => {
    const failure = detectDeploymentFailure([
      { message: "the compose is invalid", stream: "stderr" },
    ]);

    expect(failure?.checkId).toBe("invalid-compose");
  });

  it("returns null when logs do not match a failure check", () => {
    expect(
      detectDeploymentFailure([
        {
          message: "Deployment started for service nginx",
          stream: "stdout",
        },
        {
          message: "Wrote compose file to /tmp/compose.yaml",
          stream: "stdout",
        },
      ]),
    ).toBeNull();
  });
});
