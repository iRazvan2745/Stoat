import { stopWorker } from "@stoat/workflows/lifecycle";
import type { Plugin } from "vite";

export function monitoringWorker(): Plugin {
    return {
        name: "stoat-monitoring-worker",
        configureServer(server) {
            const close = server.close.bind(server);

            // closeBundle runs concurrently with runner teardown, which is too late.
            // Vite also calls server.close() on config-triggered restarts.
            server.close = async () => {
                await stopWorker();
                await close();
            };
        },
    };
}
