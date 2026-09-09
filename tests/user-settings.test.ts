import { expect, it } from "vite-plus/test";

import {
    mergeUserSettings,
    parseUserSettings,
    showFolderResourceNames,
} from "#lib/domain/users/settings";

it("parses junk into empty settings and keeps known fields", () => {
    expect(parseUserSettings(null)).toEqual({});
    expect(parseUserSettings("nonsense")).toEqual({});
    expect(parseUserSettings({ showFolderResourceNames: false })).toEqual({
        showFolderResourceNames: false,
    });
});

it("defaults to showing names and only stores deviations from the default", () => {
    expect(showFolderResourceNames({})).toBe(true);
    expect(showFolderResourceNames(null)).toBe(true);
    expect(showFolderResourceNames({ showFolderResourceNames: false })).toBe(false);

    expect(mergeUserSettings({}, { showFolderResourceNames: true })).toEqual({});
    expect(
        mergeUserSettings({ showFolderResourceNames: false }, { showFolderResourceNames: true }),
    ).toEqual({});
    expect(mergeUserSettings({}, { showFolderResourceNames: false })).toEqual({
        showFolderResourceNames: false,
    });
});
