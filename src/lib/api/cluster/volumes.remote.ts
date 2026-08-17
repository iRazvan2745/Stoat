import { query } from "$app/server";

import { ucClient } from "#lib/api/client";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Unable to load volumes.";

export const getVolumes = query(async () => {
  try {
    const { data, response } = await ucClient.GET("/api/v1/volumes");

    if (!response.ok) {
      return {
        error: `Uncloud API returned HTTP ${response.status}.`,
        items: [],
      };
    }

    if (!data) {
      return {
        error: "Uncloud API returned an empty response.",
        items: [],
      };
    }

    return { error: null, items: data.items };
  } catch (error) {
    return { error: getErrorMessage(error), items: [] };
  }
});
