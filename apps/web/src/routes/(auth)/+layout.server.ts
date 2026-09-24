import { redirect } from "@sveltejs/kit";
import { getAuth } from "../../services";

export const load = async ({ request }) => {
    if (await getAuth().api.getSession({ headers: request.headers })) redirect(303, "/");
};
