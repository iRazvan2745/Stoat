<script lang="ts">
  import { cn, type WithElementRef } from '$lib/utils';
  import type { HTMLLabelAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className,
    children,
    required = false,
    ...restProps
  }: WithElementRef<HTMLLabelAttributes, HTMLLabelElement> & {
    required?: boolean;
  } = $props();
</script>

<label
  bind:this={ref}
  class={cn(
    'inline-flex items-center font-medium text-base/4.5 text-foreground sm:text-sm/4',
    className
  )}
  data-slot="label"
  {...restProps}
>
  {#if required}
    <div class="inline-flex items-baseline gap-0.5">
      {@render children?.()}

      <span
        class="inline-block origin-center text-md leading-none text-orange-500 scale-125"
      >
        *
      </span>
    </div>
  {:else}
    <div>
      {@render children?.()}
    </div>
  {/if}
</label>