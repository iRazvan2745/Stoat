import * as v from "valibot";

export const ResourceGroupNameInput = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Enter a group name"),
    v.maxLength(80, "Use 80 characters or fewer"),
);

export type ResourceFlowItem<T> =
    | { kind: "group"; name: string; resources: T[] }
    | { kind: "resource"; resource: T };

// Turns an ordered resource list into dashboard flow items: a group box at
// its first member's position (members keep their relative order inside it)
// and ungrouped resources as standalone items exactly where they sit.
export const toResourceFlow = <T extends { groupName: string | null }>(
    resources: readonly T[],
): ResourceFlowItem<T>[] => {
    const items: ResourceFlowItem<T>[] = [];
    const groups = new Map<string, T[]>();
    for (const resource of resources) {
        if (resource.groupName === null) {
            items.push({ kind: "resource", resource });
            continue;
        }
        let members = groups.get(resource.groupName);
        if (!members) {
            members = [];
            groups.set(resource.groupName, members);
            items.push({
                kind: "group",
                name: resource.groupName,
                resources: members,
            });
        }
        members.push(resource);
    }
    return items;
};
