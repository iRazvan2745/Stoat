import * as v from "valibot";
import { expect, it } from "vite-plus/test";

import { ResourceGroupNameInput, toResourceFlow } from "#lib/domain/resources/groups";

it("keeps the caller's arrangement: boxes appear at their first member's spot and ungrouped resources stay inline", () => {
    const resources = [
        { groupName: "Monitoring", id: "1" },
        { groupName: null, id: "2" },
        { groupName: "Media", id: "3" },
        { groupName: "Monitoring", id: "4" },
        { groupName: null, id: "5" },
        { groupName: "Media", id: "6" },
    ];
    expect(toResourceFlow(resources)).toEqual([
        {
            kind: "group",
            name: "Monitoring",
            resources: [resources[0], resources[3]],
        },
        { kind: "resource", resource: resources[1] },
        {
            kind: "group",
            name: "Media",
            resources: [resources[2], resources[5]],
        },
        { kind: "resource", resource: resources[4] },
    ]);
    expect(resources.map((resource) => resource.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
});

it("handles empty workspaces and names that resemble object properties", () => {
    expect(toResourceFlow([])).toEqual([]);
    expect(
        toResourceFlow([
            { groupName: "__proto__" },
            { groupName: "Ungrouped" },
            { groupName: null },
        ]),
    ).toEqual([
        { kind: "group", name: "__proto__", resources: [{ groupName: "__proto__" }] },
        {
            kind: "group",
            name: "Ungrouped",
            resources: [{ groupName: "Ungrouped" }],
        },
        { kind: "resource", resource: { groupName: null } },
    ]);
});

it("normalizes group names and rejects empty or oversized names", () => {
    expect(v.parse(ResourceGroupNameInput, "  Production  ")).toBe("Production");
    expect(v.safeParse(ResourceGroupNameInput, "  ").success).toBe(false);
    expect(v.safeParse(ResourceGroupNameInput, "a".repeat(81)).success).toBe(false);
    expect(v.safeParse(ResourceGroupNameInput, "a".repeat(80)).success).toBe(true);
});
