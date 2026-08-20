import { error } from "@sveltejs/kit";

import { readTemplateLogo } from "#lib/server/templates";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  try {
    const logo = await readTemplateLogo(params.appId);

    if (!logo) {
      error(404, "Logo not found");
    }

    const body = new Uint8Array(logo.body.byteLength);
    body.set(logo.body);

    return new Response(body.buffer, {
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": logo.contentType,
      },
    });
  } catch {
    error(404, "Logo not found");
  }
};
