import * as v from "valibot";
import { expect, it } from "vite-plus/test";

import { groupServices, ServiceGroupNameInput } from "#lib/domain/services/groups";

it("sorts named groups and keeps ungrouped services last without losing service order", () => {
    const services = [
        { groupName: null, id: "1" },
        { groupName: "Web", id: "2" },
        { groupName: "Data", id: "3" },
        { groupName: "Web", id: "4" },
    ];
    expect(groupServices(services)).toEqual([
        { name: "Data", services: [services[2]] },
        { name: "Web", services: [services[1], services[3]] },
        { name: null, services: [services[0]] },
    ]);
    expect(services.map((service) => service.id)).toEqual(["1", "2", "3", "4"]);
});

it("handles empty workspaces and names that resemble object properties", () => {
    expect(groupServices([])).toEqual([]);
    expect(
        groupServices([
            { groupName: "__proto__" },
            { groupName: "Ungrouped" },
            { groupName: null },
        ]),
    ).toHaveLength(3);
});

it("normalizes group names and rejects empty or oversized names", () => {
    expect(v.parse(ServiceGroupNameInput, "  Production  ")).toBe("Production");
    expect(v.safeParse(ServiceGroupNameInput, "  ").success).toBe(false);
    expect(v.safeParse(ServiceGroupNameInput, "a".repeat(81)).success).toBe(false);
    expect(v.safeParse(ServiceGroupNameInput, "a".repeat(80)).success).toBe(true);
});
