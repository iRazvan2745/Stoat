import type { AppRouterClient } from "@stoat/api/routers/index";
import { Match } from "effect";
import { z } from "zod";

const text = z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional()
    .catch(undefined);

const inspectionSchema = z.object({
    Id: text,
    Name: text,
    Image: text,
    Config: z.object({ Image: text }).optional().catch(undefined),
    State: z
        .object({
            Status: text,
            Health: z.object({ Status: text }).optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
});

export function containerInfo(
    container: Awaited<
        ReturnType<AppRouterClient["resources"]["getContainers"]>
    >[number]["container"],
) {
    const inspection = inspectionSchema.parse(container);
    const health = inspection.State?.Health?.Status;
    const id = inspection.Id;

    return {
        id,
        name: inspection.Name?.replace(/^\//u, "") || id || "Unnamed container",
        image: inspection.Config?.Image ?? inspection.Image ?? "Unknown image",
        status: inspection.State?.Status ?? "unknown",
        health: health ?? "Unknown",
        healthVariant: Match.value(health).pipe(
            Match.when("healthy", () => "success" as const),
            Match.when("unhealthy", () => "error" as const),
            Match.when("starting", () => "warning" as const),
            Match.orElse(() => "secondary" as const),
        ),
    };
}
