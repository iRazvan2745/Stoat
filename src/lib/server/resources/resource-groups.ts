import { and, asc, eq } from "drizzle-orm";

import { db } from "#lib/db";
import { resources } from "#lib/db/schema";
import { withKeyedLock } from "#lib/server/shared/locks";

const ORDER_SPACING = 1024;
const MIN_ORDER_GAP = 1e-3;

interface ResourceOrderRow {
    groupName: string | null;
    id: string;
    sortOrder: number | null;
}

type OrderedResourceRow = Omit<ResourceOrderRow, "sortOrder"> & {
    sortOrder: number;
};

type DbExecutor = Pick<typeof db, "select" | "update">;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const asExecutor = (tx: DbTransaction): DbExecutor => tx as unknown as DbExecutor;

const listResourceOrderRows = async (
    executor: DbExecutor,
    workspaceId: string,
): Promise<ResourceOrderRow[]> =>
    await executor
        .select({
            groupName: resources.groupName,
            id: resources.id,
            sortOrder: resources.sortOrder,
        })
        .from(resources)
        .where(eq(resources.workspaceId, workspaceId))
        .orderBy(asc(resources.sortOrder), asc(resources.id));

// Freshly created resources have no order yet (null sorts last); give them
// concrete values behind the ordered ones before computing a position.
const materializePendingOrders = async (
    executor: DbExecutor,
    workspaceId: string,
    rows: ResourceOrderRow[],
): Promise<OrderedResourceRow[]> => {
    const maxOrder = rows.reduce(
        (max, row) => (row.sortOrder === null ? max : Math.max(max, row.sortOrder)),
        Number.NEGATIVE_INFINITY,
    );
    let next = maxOrder === Number.NEGATIVE_INFINITY ? 0 : maxOrder + ORDER_SPACING;
    for (const row of rows) {
        if (row.sortOrder !== null) {
            continue;
        }
        await executor
            .update(resources)
            .set({ sortOrder: next })
            .where(and(eq(resources.id, row.id), eq(resources.workspaceId, workspaceId)));
        row.sortOrder = next;
        next += ORDER_SPACING;
    }
    return rows as OrderedResourceRow[];
};

// When repeated insertions have squeezed neighbors too close together,
// rewrite every order in the workspace with fresh, evenly spaced values.
const renormalizeOrders = async (
    executor: DbExecutor,
    workspaceId: string,
    rows: OrderedResourceRow[],
): Promise<void> => {
    for (const [index, row] of rows.entries()) {
        const sortOrder = index * ORDER_SPACING;
        if (row.sortOrder === sortOrder) {
            continue;
        }
        await executor
            .update(resources)
            .set({ sortOrder })
            .where(and(eq(resources.id, row.id), eq(resources.workspaceId, workspaceId)));
        row.sortOrder = sortOrder;
    }
};

// Order for a resource appended to the end of a group (null = ungrouped end,
// which is also where brand new groups start).
const appendOrderFor = (rows: OrderedResourceRow[], groupName: string | null): number => {
    const endOrder = (rows.at(-1)?.sortOrder ?? -ORDER_SPACING) + ORDER_SPACING;
    if (groupName === null) {
        return endOrder;
    }
    const members = rows.filter((row) => row.groupName === groupName);
    if (members.length === 0) {
        return endOrder;
    }
    return Math.max(...members.map((member) => member.sortOrder)) + 1;
};

export const updateResourceGroup = async (
    workspaceId: string,
    resourceId: string,
    groupName: string | null,
): Promise<void> => {
    // Serialize ordering writes per workspace so two concurrent moves cannot
    // assign duplicate sortOrder values; the whole read-modify-write runs in
    // one transaction.
    await withKeyedLock(`workspace-order:${workspaceId}`, async () => {
        await db.transaction(async (tx) => {
            const executor = asExecutor(tx);
            const pending = await listResourceOrderRows(executor, workspaceId);
            const rows = await materializePendingOrders(executor, workspaceId, pending);
            if (!rows.some((row) => row.id === resourceId)) {
                throw new Error("Resource is no longer in this workspace");
            }
            await executor
                .update(resources)
                .set({ groupName, sortOrder: appendOrderFor(rows, groupName) })
                .where(and(eq(resources.id, resourceId), eq(resources.workspaceId, workspaceId)));
        });
    });
};

export const updateResourceGroupName = async (
    workspaceId: string,
    groupName: string,
    newGroupName: string | null,
): Promise<void> => {
    await db
        .update(resources)
        .set({ groupName: newGroupName })
        .where(and(eq(resources.workspaceId, workspaceId), eq(resources.groupName, groupName)));
};

// Places a resource at a new dashboard position. With a target resource the
// move lands directly before it and adopts its group; otherwise the resource
// is appended to the given group (null = ungrouped, at the very end).
// When moving before another resource, `groupName` must be null or match the
// target's group — the target's group wins, so a conflicting value is rejected
// instead of being silently ignored.
export const updateResourcePosition = async (
    workspaceId: string,
    resourceId: string,
    beforeResourceId: string | null,
    groupName: string | null,
): Promise<void> => {
    await withKeyedLock(`workspace-order:${workspaceId}`, async () => {
        await db.transaction(async (tx) => {
            const executor = asExecutor(tx);
            const pending = await listResourceOrderRows(executor, workspaceId);
            const rows = await materializePendingOrders(executor, workspaceId, pending);
            const moving = rows.find((row) => row.id === resourceId);
            if (!moving) {
                throw new Error("Resource is no longer in this workspace");
            }

            let nextGroupName: string | null;
            let nextOrder: number;

            if (beforeResourceId === null) {
                nextGroupName = groupName;
                nextOrder = appendOrderFor(rows, groupName);
            } else {
                const before = rows.find((row) => row.id === beforeResourceId);
                if (!before) {
                    throw new Error("Target resource is no longer in this workspace");
                }
                if (groupName !== null && groupName !== before.groupName) {
                    throw new Error(
                        "Group does not match the target resource's group; omit groupName when moving before another resource",
                    );
                }
                nextGroupName = before.groupName;
                const index = rows.indexOf(before);
                const previous = index > 0 ? rows[index - 1] : undefined;
                if (previous?.id === resourceId) {
                    if (moving.groupName === before.groupName) {
                        return;
                    }
                    nextOrder = moving.sortOrder;
                } else {
                    let previousOrder = previous?.sortOrder ?? before.sortOrder - ORDER_SPACING;
                    if (before.sortOrder - previousOrder < MIN_ORDER_GAP) {
                        await renormalizeOrders(executor, workspaceId, rows);
                        previousOrder = previous?.sortOrder ?? before.sortOrder - ORDER_SPACING;
                    }
                    nextOrder = (previousOrder + before.sortOrder) / 2;
                }
            }

            await executor
                .update(resources)
                .set({ groupName: nextGroupName, sortOrder: nextOrder })
                .where(and(eq(resources.id, resourceId), eq(resources.workspaceId, workspaceId)));
        });
    });
};
