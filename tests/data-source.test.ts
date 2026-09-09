import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createWorkspaceFolder } from "#lib/server/data-sources/paths";

describe("workspace folders", () => {
    it("creates nested workspace and resource folders", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "stoat-data-source-"));

        try {
            const folder = await createWorkspaceFolder(root, "my-workspace", "my-resource-abc12");

            expect(folder).toBe(path.join(root, "my-workspace", "my-resource-abc12"));
            await expect(access(folder)).resolves.toBeUndefined();
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it("rejects folders outside the workspace", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "stoat-data-source-"));

        try {
            await expect(createWorkspaceFolder(root, "..", "outside")).rejects.toThrow(
                "inside the workspace",
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
