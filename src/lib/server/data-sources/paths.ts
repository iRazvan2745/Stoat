import fs from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "$app/env/private";

export const getDataDir = (): string => DATA_DIR ?? "./data";

export const workspacePath = (workspaceId: string): string =>
    path.resolve(getDataDir(), workspaceId);

export const createWorkspaceFolder = async (
    rootPath: string,
    ...folders: string[]
): Promise<string> => {
    const root = path.resolve(rootPath);
    const folderPath = path.resolve(root, ...folders);
    const relativeFolderPath = path.relative(root, folderPath);

    if (
        relativeFolderPath === ".." ||
        relativeFolderPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeFolderPath)
    ) {
        throw new Error("Folder path must be inside the workspace");
    }

    await fs.mkdir(folderPath, { recursive: true });

    return folderPath;
};

/** One checkout per Git Source, shared by all of its workspaces. */
export const gitSourcePath = (gitSourceId: string): string =>
    path.resolve(getDataDir(), "git-sources", gitSourceId);
