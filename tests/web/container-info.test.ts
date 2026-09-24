import { describe, expect, it } from "vite-plus/test";
import { containerInfo } from "../../apps/web/src/lib/container-info";

describe("containerInfo", () => {
    it("preserves full names and separates health from runtime status", () => {
        expect(
            containerInfo({
                Id: "container-id",
                Name: "/project-resource-service-123456789",
                Config: { Image: "registry.example.com/team/app:latest" },
                Image: "sha256:digest",
                State: { Status: "running", Health: { Status: "unhealthy" } },
            }),
        ).toEqual({
            id: "container-id",
            name: "project-resource-service-123456789",
            image: "registry.example.com/team/app:latest",
            status: "running",
            health: "unhealthy",
            healthVariant: "error",
        });
    });

    it("handles missing and malformed inspection fields", () => {
        expect(containerInfo({ Name: 42, State: null, Config: [] })).toEqual({
            id: undefined,
            name: "Unnamed container",
            image: "Unknown image",
            status: "unknown",
            health: "Unknown",
            healthVariant: "secondary",
        });
        expect(containerInfo({ Id: "full-container-id", Image: "sha256:digest" })).toMatchObject({
            name: "full-container-id",
            image: "sha256:digest",
        });
        expect(
            containerInfo({
                Name: " /kept ",
                Config: { Image: " " },
                Image: "fallback-image",
                State: { Status: "running", Health: [] },
            }),
        ).toMatchObject({
            name: " /kept ",
            image: "fallback-image",
            status: "running",
            health: "Unknown",
        });
    });

    it("preserves full IDs and rejects malformed IDs", () => {
        const id = "abcdef0123456789abcdef0123456789";
        expect(containerInfo({ Id: id }).id).toBe(id);

        for (const Id of [undefined, null, 42, [], {}, "", "   "]) {
            expect(containerInfo({ Id }).id).toBeUndefined();
        }
    });

    it.each([
        ["healthy", "success"],
        ["starting", "warning"],
        ["none", "secondary"],
    ])("maps %s health to %s", (health, variant) => {
        expect(
            containerInfo({ State: { Status: "exited", Health: { Status: health } } }),
        ).toMatchObject({
            status: "exited",
            health,
            healthVariant: variant,
        });
    });
});
