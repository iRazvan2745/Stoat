import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createDataSourceFolder } from "./data-source";

describe("data source folders", () => {
  it("creates nested workspace and service folders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-data-source-"));

    try {
      const folder = await createDataSourceFolder(root, "my-workspace", "my-service-abc12");

      expect(folder).toBe(path.join(root, "my-workspace", "my-service-abc12"));
      await expect(access(folder)).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects folders outside the data source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-data-source-"));

    try {
      await expect(createDataSourceFolder(root, "..", "outside")).rejects.toThrow(
        "inside the data source",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
