import { describe, expect, it } from "vite-plus/test";
import { render } from "svelte/server";
import StepperItem from "../../apps/web/src/lib/components/ui/stepper/stepper-item.svelte";

describe("StepperItem", () => {
    it("renders its state and loading indicator without waiting for an effect", () => {
        for (const [step, completed, loading, state, isLoading] of [
            [1, false, true, "completed", false],
            [2, false, true, "active", true],
            [3, false, true, "inactive", false],
            [3, true, false, "completed", false],
        ] as const) {
            const { body } = render(StepperItem, {
                props: { step, completed, loading },
                context: new Map([
                    ["StepperContext", { activeStep: 2, orientation: "horizontal" }],
                ]),
            });

            expect(body).toContain(`data-state="${state}"`);
            expect(body.includes("data-loading")).toBe(isLoading);
        }
    });
});
