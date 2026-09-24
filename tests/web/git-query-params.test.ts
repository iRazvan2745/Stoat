import { expect, it } from "vite-plus/test";
import {
    connectionDialogUrl,
    connectionFormParsers,
} from "../../apps/web/src/lib/git-query-params";

it("accepts supported query providers and rejects Gitea", () => {
    for (const provider of ["github", "forgejo", "generic"]) {
        expect(connectionFormParsers.provider.parse(provider)).toBe(provider);
    }

    expect(connectionFormParsers.provider.parse("gitea")).toBeNull();
});

it("preserves connection drafts on close/reopen and clears them on save or switching connections", () => {
    for (const edit of [null, "connection-a"]) {
        const dialog = edit ? "edit-connection" : "add-connection";

        const original = new URL(
            "https://stoat.test/git?connectionId=selected&name=My+server&provider=forgejo&authMode=oauth&credentialType=https&oauthProviderId=app&setupExpanded=true#accounts",
        );

        original.searchParams.set("dialog", dialog);

        if (edit) original.searchParams.set("edit", edit);

        const closed = new URL(connectionDialogUrl(original, null), original);
        const reopened = new URL(connectionDialogUrl(closed, dialog, edit), original);
        expect(closed.searchParams.has("dialog")).toBe(false);
        expect(closed.searchParams.get("edit")).toBe(edit);

        for (const key of Object.keys(connectionFormParsers)) {
            expect(closed.searchParams.get(key)).toBe(original.searchParams.get(key));
            expect(reopened.searchParams.get(key)).toBe(original.searchParams.get(key));
        }

        const saved = new URL(connectionDialogUrl(reopened, null, null, true), original);

        const switched = new URL(
            connectionDialogUrl(closed, "edit-connection", "connection-b"),
            original,
        );

        for (const url of [saved, switched]) {
            for (const key of Object.keys(connectionFormParsers))
                expect(url.searchParams.has(key)).toBe(false);
            expect(url.searchParams.get("connectionId")).toBe("selected");
            expect(url.hash).toBe("#accounts");
        }

        expect(saved.searchParams.has("edit")).toBe(false);
        expect(saved.searchParams.has("dialog")).toBe(false);
        expect(switched.searchParams.get("edit")).toBe("connection-b");

        if (edit) {
            const add = new URL(connectionDialogUrl(closed, "add-connection"), original);
            expect(add.searchParams.has("edit")).toBe(false);

            for (const key of Object.keys(connectionFormParsers))
                expect(add.searchParams.has(key)).toBe(false);
        }
    }
});
