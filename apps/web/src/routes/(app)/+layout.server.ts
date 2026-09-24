import { redirect } from "@sveltejs/kit";
import { listUserOrganizations } from "@stoat/db/organizations";
import { getAuth, getDb } from "../../services";

export const load = async ({ request }) => {
    const session = await getAuth().api.getSession({ headers: request.headers });

    if (!session) redirect(303, "/login");
    const organizations = await listUserOrganizations(getDb(), session.user.id);
    let activeOrganizationId = session.session.activeOrganizationId;

    if (!organizations.some((organization) => organization.id === activeOrganizationId)) {
        activeOrganizationId = organizations[0]?.id ?? null;
        await getAuth().api.setActiveOrganization({
            headers: request.headers,
            body: { organizationId: activeOrganizationId },
        });
    }

    return {
        user: { name: session.user.name, email: session.user.email, image: session.user.image },
        organizations,
        activeOrganizationId,
    };
};
