import { UNCLOUD_API } from "$app/env/private";
import createClient from "openapi-fetch";

import type { paths } from "../../../../schema";
import { fetchUncloud, fetchUncloudStream } from "./fetch";

export const ucClient = createClient<paths>({
  baseUrl: UNCLOUD_API,
  fetch: fetchUncloud,
});

/**
 * Client for endpoints that stream their response body. The timeout only
 * applies until headers arrive, so streams are not killed mid-read.
 */
export const ucStreamClient = createClient<paths>({
  baseUrl: UNCLOUD_API,
  fetch: fetchUncloudStream,
});
