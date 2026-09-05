import * as v from "valibot";

export const ServiceGroupNameInput = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Enter a group name"),
    v.maxLength(80, "Use 80 characters or fewer"),
);

export const groupServices = <T extends { groupName: string | null }>(
    services: readonly T[],
): { name: string | null; services: T[] }[] => {
    const groups = new Map<string | null, T[]>();
    for (const service of services) {
        const members = groups.get(service.groupName) ?? [];
        members.push(service);
        groups.set(service.groupName, members);
    }
    return [...groups.entries()]
        .toSorted(([left], [right]) => {
            if (left === null) {
                return 1;
            }
            if (right === null) {
                return -1;
            }
            return left.localeCompare(right);
        })
        .map(([name, members]) => ({ name, services: members }));
};
