import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./index";
import { member, organization } from "./schema";

export function listUserOrganizations(db: Database, userId: string) {
    return db
        .select({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            role: member.role,
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(eq(member.userId, userId))
        .orderBy(asc(member.createdAt), asc(member.id));
}

export async function getOrganizationMembership(
    db: Database,
    userId: string,
    organizationId: string,
) {
    const [membership] = await db
        .select()
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
        .limit(1);

    return membership;
}
