import { Schema } from "effect";
import { expect, it, vi } from "vite-plus/test";

import { createDeploymentSnapshot } from "../src/lib/server/deployments/deployment-snapshot";
import type { DeploymentSnapshot } from "../src/lib/server/deployments/deployment-snapshot";

vi.mock("#lib/db", () => ({ db: {} }));

it("serializes enqueue data before later configuration edits", () => {
    const record: Omit<DeploymentSnapshot, "environment"> = {
        git: {
            authMethod: "token",
            id: "git-old",
            name: "Old Git",
            organizationId: "org",
            password: null,
            sshKnownHosts: null,
            sshPassphrase: null,
            sshPrivateKey: null,
            token: "old-git-token",
            url: "https://old.example/repository.git",
            username: "git",
        },
        service: {
            groupName: null,
            icon: "old-icon",
            id: "service",
            name: "Old service",
            settings: {},
            slug: "old-service",
            type: "compose",
            value: "services:\n  old:\n    image: old:1\n",
            workspaceId: "workspace",
        },
        source: {
            gitSourceId: "git-old",
            id: "source-old",
            organizationId: "org",
            uncloudToken: "old-uncloud-token",
            uncloudUrl: "https://old.uncloud.example",
        },
        workspace: {
            dataSourceId: "source-old",
            id: "workspace",
            name: "Old workspace",
            organizationId: "org",
            slug: "old-workspace",
        },
    };
    const variable = { name: "DEPLOY_TARGET", value: "old-target" };
    const environment: DeploymentSnapshot["environment"] = [variable];

    const snapshot = createDeploymentSnapshot(record, environment);
    const encoded = Schema.encodeSync(Schema.toCodecJson(Schema.Unknown))(snapshot);
    const queued = JSON.parse(JSON.stringify(encoded)) as DeploymentSnapshot;

    record.git.url = "https://new.example/repository.git";
    record.service.value = "services:\n  new:\n    image: new:2\n";
    record.source.uncloudToken = "new-uncloud-token";
    record.source.uncloudUrl = "https://new.uncloud.example";
    variable.value = "new-target";

    expect(queued.service.value).toContain("old:1");
    expect(queued.environment).toEqual([{ name: "DEPLOY_TARGET", value: "old-target" }]);
    expect(queued.source).toMatchObject({
        uncloudToken: "old-uncloud-token",
        uncloudUrl: "https://old.uncloud.example",
    });
    expect(queued.git.url).toBe("https://old.example/repository.git");
    expect(snapshot).toEqual(queued);
});
