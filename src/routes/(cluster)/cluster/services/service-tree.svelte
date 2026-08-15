<script lang="ts">
  import type { ServiceTreeNode } from "./service-tree";
  import ServiceTreeRow from "./service-tree-row.svelte";

  let {
    nodes,
  }: {
    nodes: ServiceTreeNode[];
  } = $props();
</script>

{#each nodes as node, index (node.type === "group" ? node.name : node.service.id)}
  {#if node.type === "group"}
    <!-- synthetic group row: no service data behind it -->
    <div
      class="
        bg-surface-container-low
        border-outline-variant
        grid min-w-275
        grid-cols-[minmax(260px,1.4fr)_130px_240px_110px_110px]
        items-center gap-4
        border-b px-5 py-3
      "
    >
      <div class="text-on-surface font-medium">
        {node.name}
      </div>

      <div></div>
      <div></div>
      <div></div>
      <div></div>
    </div>

    {#each node.children as child, childIndex}
      <ServiceTreeRow
        service={child.service}
        label={child.name}
        depth={1}
        last={childIndex === node.children.length - 1}
      />
    {/each}
  {:else}
    <ServiceTreeRow service={node.service} label={node.name} depth={0} />
  {/if}
{/each}
