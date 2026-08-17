import fs from "node:fs/promises";
import path from "node:path";

export const getDataDir = (): string => process.env.DATA_DIR ?? "./data";

export const createDataSourceFolder = async (
  dataSourcePath: string,
  ...folders: string[]
): Promise<string> => {
  const rootPath = path.resolve(dataSourcePath);
  const folderPath = path.resolve(rootPath, ...folders);
  const relativeFolderPath = path.relative(rootPath, folderPath);

  if (
    relativeFolderPath === ".." ||
    relativeFolderPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFolderPath)
  ) {
    throw new Error("Folder path must be inside the data source");
  }

  await fs.mkdir(folderPath, { recursive: true });

  return folderPath;
};
