import { UNCLOUD_API } from "$app/env/private";
import createClient from "openapi-fetch";

import type { paths } from "../../../schema";

export const ucClient = createClient<paths>({
  baseUrl: UNCLOUD_API,
});
