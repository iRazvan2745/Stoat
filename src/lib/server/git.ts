// oxlint-disable func-style
import fs from "node:fs/promises";

import simpleGit from "simple-git";

// const repoPath = "./data/infra-repo";
// const repoUrl = "git@github.com:your-org/infra.git";

export async function getRepo({
  repoPath,
  repoUrl,
}: {
  repoPath: string;
  repoUrl: string;
}) {
  try {
    await fs.access(`${repoPath}/.git`);
  } catch {
    await simpleGit().clone(repoUrl, repoPath);
  }

  return simpleGit(repoPath);
}
