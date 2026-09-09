import { describe, expect, it } from "vite-plus/test";

import { mergeEnvironmentVariables, validateEnvironmentVariables } from "#lib/domain/environment";
import { inlineEnvironmentVariables } from "#lib/server/deployments/deployment-compose";

describe("mergeEnvironmentVariables", () => {
    it("returns an empty list when both sides are empty", () => {
        expect(mergeEnvironmentVariables([], [])).toEqual([]);
    });

    it("returns workspace variables when the resource has none", () => {
        const workspaceVars = [
            { name: "SHARED", value: "workspace" },
            { name: "WORKSPACE_ONLY", value: "1" },
        ];

        expect(mergeEnvironmentVariables(workspaceVars, [])).toEqual(workspaceVars);
    });

    it("returns resource variables when the workspace has none", () => {
        const resourceVars = [{ name: "RESOURCE_ONLY", value: "1" }];

        expect(mergeEnvironmentVariables([], resourceVars)).toEqual(resourceVars);
    });

    it("lets resource values win on name collisions", () => {
        const merged = mergeEnvironmentVariables(
            [{ name: "SHARED", value: "workspace" }],
            [{ name: "SHARED", value: "resource" }],
        );

        expect(merged).toEqual([{ name: "SHARED", value: "resource" }]);
    });

    it("keeps overridden names at their workspace position and appends resource-only names", () => {
        const merged = mergeEnvironmentVariables(
            [
                { name: "FIRST", value: "w1" },
                { name: "SHARED", value: "workspace" },
                { name: "LAST", value: "w2" },
            ],
            [
                { name: "SHARED", value: "resource" },
                { name: "RESOURCE_ONLY", value: "s1" },
            ],
        );

        expect(merged).toEqual([
            { name: "FIRST", value: "w1" },
            { name: "SHARED", value: "resource" },
            { name: "LAST", value: "w2" },
            { name: "RESOURCE_ONLY", value: "s1" },
        ]);
    });

    it("does not mutate its inputs", () => {
        const workspaceVars = [{ name: "SHARED", value: "workspace" }];
        const resourceVars = [{ name: "SHARED", value: "resource" }];

        mergeEnvironmentVariables(workspaceVars, resourceVars);

        expect(workspaceVars).toEqual([{ name: "SHARED", value: "workspace" }]);
        expect(resourceVars).toEqual([{ name: "SHARED", value: "resource" }]);
    });
});

describe("workspace environment validation", () => {
    it("rejects duplicate names like resource environments do", () => {
        expect(
            validateEnvironmentVariables([
                { name: "FOO", value: "1" },
                { name: "FOO", value: "2" },
            ]),
        ).toEqual(['Duplicate name "FOO"']);
    });

    it("accepts unique names and an empty list", () => {
        expect(
            validateEnvironmentVariables([
                { name: "FOO", value: "1" },
                { name: "BAR", value: "2" },
            ]),
        ).toEqual([]);
        expect(validateEnvironmentVariables([])).toEqual([]);
    });
});

describe("inlineEnvironmentVariables with merged workspace input", () => {
    it("inlines the merged effective variables into every service", () => {
        const effective = mergeEnvironmentVariables(
            [
                { name: "SHARED", value: "workspace" },
                { name: "WORKSPACE_ONLY", value: "w1" },
            ],
            [{ name: "SHARED", value: "resource" }],
        );
        const yaml = inlineEnvironmentVariables(
            `services:
  web:
    image: nginx
  worker:
    image: nginx
`,
            effective,
        );

        expect(yaml).toContain("SHARED: resource");
        expect(yaml).not.toContain("SHARED: workspace");
        expect(yaml).toContain("WORKSPACE_ONLY: w1");
        expect(yaml.match(/SHARED: resource/gu)?.length).toBe(2);
        expect(yaml.match(/WORKSPACE_ONLY: w1/gu)?.length).toBe(2);
    });

    it("removes env_file from every service when inlining merged variables", () => {
        const effective = mergeEnvironmentVariables([{ name: "SHARED", value: "workspace" }], []);
        const yaml = inlineEnvironmentVariables(
            `services:
  web:
    image: nginx
    env_file: .env
  worker:
    image: nginx
    env_file: .env.production
`,
            effective,
        );

        expect(yaml).toContain("SHARED: workspace");
        expect(yaml).not.toContain("env_file");
    });
});
