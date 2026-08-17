import fs from "node:fs/promises";

// oxlint-disable func-style
// oxlint-disable-next-line import/no-named-as-default stupid rule
import simpleGit from "simple-git";

export async function getRepo({ repoPath, repoUrl }: { repoPath: string; repoUrl: string }) {
  try {
    console.log(`Found repo`, { repoPath, repoUrl });
    await fs.access(`${repoPath}/.git`);
  } catch {
    console.log(`Cloning repo`, { repoPath, repoUrl });
    await simpleGit().clone(repoUrl, repoPath);
  }
  return simpleGit(repoPath);
}
