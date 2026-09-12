import { describe, expect, it } from "vite-plus/test";

import {
    deploymentNeedsGitSync,
    isGitSyncNeededMessage,
} from "#lib/domain/git-sync";

describe("isGitSyncNeededMessage", () => {
    it("detects the git-changed publish blocker", () => {
        expect(
            isGitSyncNeededMessage(
                "Git changed uptimekit/docker-compose.yml; sync before publishing app edits"
            )
        ).toBe(true);
    });

    it("detects git-deleted and conflict blockers", () => {
        expect(
            isGitSyncNeededMessage(
                "Git deleted uptimekit/docker-compose.yml; restore or reconcile it before publishing"
            )
        ).toBe(true);
        expect(
            isGitSyncNeededMessage(
                "Both the app and Git differ. Reconcile the Compose/settings in the app with this Git version, then sync again; neither version was overwritten"
            )
        ).toBe(true);
    });

    it("ignores ordinary deployment output", () => {
        expect(isGitSyncNeededMessage("Deploy complete: deployed")).toBe(false);
        expect(isGitSyncNeededMessage("Pulling image nginx")).toBe(false);
        expect(isGitSyncNeededMessage("")).toBe(false);
    });
});

describe("deploymentNeedsGitSync", () => {
    it("returns true when any log needs a sync", () => {
        expect(
            deploymentNeedsGitSync([
                { message: "Preparing deployment" },
                {
                    message:
                        "Git changed uptimekit/docker-compose.yml; sync before publishing app edits",
                },
            ])
        ).toBe(true);
    });

    it("returns false when no log needs a sync", () => {
        expect(
            deploymentNeedsGitSync([{ message: "Deploy complete: deployed" }])
        ).toBe(false);
        expect(deploymentNeedsGitSync([])).toBe(false);
    });
});
