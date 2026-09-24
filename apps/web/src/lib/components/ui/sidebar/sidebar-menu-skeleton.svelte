<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { Skeleton } from '$lib/components/ui/skeleton';
  import { cn, type WithElementRef } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<div
  bind:this={ref}
  data-slot="sidebar-menu-skeleton"
  data-sidebar="menu-skeleton"
  class={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
  {...restProps}
>
  <Skeleton> {@render children?.()} </Skeleton>
</div>
