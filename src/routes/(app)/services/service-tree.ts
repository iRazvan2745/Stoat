// oxlint-disable func-style
import type { getServices } from "#lib/api/services.remote";

export type Service = NonNullable<
  ReturnType<typeof getServices>["current"]
>["items"][number];

export interface ServiceTreeLeaf {
  type: "service";
  name: string;
  service: Service;
}

export type ServiceTreeNode =
  | {
      type: "group";
      name: string;
      children: ServiceTreeLeaf[];
    }
  | ServiceTreeLeaf;

export function toServiceTree(services: Service[]): ServiceTreeNode[] {
  const groups = new Map<string, Service[]>();

  /*
   * Group by the first part of the service name:
   *
   * forgejo
   * forgejo-runner-1
   * forgejo-runner-2
   *
   * => "forgejo"
   */
  for (const service of services) {
    const [groupName = service.name] = service.name.split("-");

    const group = groups.get(groupName) ?? [];
    group.push(service);
    groups.set(groupName, group);
  }

  const tree: ServiceTreeNode[] = [];

  for (const [groupName, groupServices] of groups) {
    /*
     * Don't create pointless groups for a single service.
     *
     * "grafana" stays:
     *
     * grafana
     *
     * instead of:
     *
     * grafana
     * └─ grafana
     */
    if (groupServices.length === 1) {
      const [service] = groupServices;

      if (!service) {
        continue;
      }

      tree.push({
        name: service.name,
        service,
        type: "service",
      });

      continue;
    }

    /*
     * Multiple services share a prefix, so it becomes a synthetic
     * group row. The real service with the group's exact name (if it
     * exists, e.g. "forgejo") is NOT consumed by the group; it stays
     * listed underneath it as a normal service row.
     */
    tree.push({
      children: groupServices.map((service) => ({
        /*
         * The real root service keeps its full name, everything else
         * gets only the group prefix stripped:
         *
         * forgejo            -> forgejo
         * forgejo-runner-dind-1 -> runner-dind-1
         */
        name:
          service.name === groupName
            ? service.name
            : service.name.slice(groupName.length + 1),

        service,
        type: "service",
      })),
      name: groupName,
      type: "group",
    });
  }

  return tree;
}
