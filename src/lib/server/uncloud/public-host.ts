import type { UncloudConnection } from "#lib/server/uncloud";
import { createUncloudClient } from "#lib/server/uncloud";

/** Best-effort public address of the cluster: first public IP, else the first machine's hostname. */
export const firstPublicHost = async (
    connection: UncloudConnection,
): Promise<string | undefined> => {
    try {
        const { data, response } = await createUncloudClient(connection).GET("/api/v1/machines");

        if (!response.ok || !data) {
            return undefined;
        }

        for (const machine of data.items) {
            if (machine.publicIp) {
                return machine.publicIp;
            }
        }

        return data.items[0]?.hostname ?? data.items[0]?.name;
    } catch {
        return undefined;
    }
};
