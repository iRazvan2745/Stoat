<script lang="ts">
	import { cn } from './cn';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { watch } from 'runed';
	import { useDescendantsContext } from './descendants.svelte';
	import { setFlowNodeAnchorContext } from './node-context.svelte';
	import { createElementAttachment } from './render-props';
	import { rectEquals, type NodeData, type RectLike } from './types';

	interface FlowNodeProps {
		id?: string;
		disabled?: boolean;
		/** Label rendered on the connector leaving this node. */
		edgeLabel?: string;
		class?: string;
		children?: Snippet;
		render?: Snippet<[{ props: Record<string, unknown> }]>;
	}

	let { id, disabled = false, edgeLabel, class: className, children, render }: FlowNodeProps = $props();

	const descendants = useDescendantsContext<NodeData>();
	const generatedId = $props.id();
	let nodeId = $derived(id ?? generatedId);

	let nodeRef = $state<HTMLElement | null>(null);
	let startAnchorRef = $state<HTMLElement | null>(null);
	let endAnchorRef = $state<HTMLElement | null>(null);
	let measurements = $state<{
		start: RectLike | null;
		end: RectLike | null;
	}>({
		start: null,
		end: null
	});

	let index = $derived(descendants.getIndex(nodeId));
	let nodeData = $derived<NodeData>({
		element: nodeRef,
		parallel: false,
		disabled,
		start: measurements.start,
		end: measurements.end,
		edgeLabel
	});

	setFlowNodeAnchorContext({
		registerStartAnchor: (anchor) => {
			startAnchorRef = anchor;
			remeasure();
		},
		registerEndAnchor: (anchor) => {
			endAnchorRef = anchor;
			remeasure();
		}
	});

	function remeasure() {
		if (!nodeRef) return;

		const nodeRect = nodeRef.getBoundingClientRect();
		const startRect = startAnchorRef?.getBoundingClientRect() ?? nodeRect;
		const endRect = endAnchorRef?.getBoundingClientRect() ?? nodeRect;

		if (rectEquals(measurements.start, startRect) && rectEquals(measurements.end, endRect)) {
			return;
		}

		measurements = {
			start: startRect,
			end: endRect
		};
	}

	const observeNodeSize = (element: HTMLElement) => {
		const onResize = () => {
			remeasure();
			descendants.notifySizeChange();
		};

		const observer = new ResizeObserver(onResize);
		observer.observe(element);
		return () => observer.disconnect();
	};

	const attachNode = createElementAttachment<HTMLElement>((element) => {
		nodeRef = element;
		if (!element) return;
		return observeNodeSize(element);
	});

	let renderProps = $derived(
		attachNode({
			class: className,
			style: 'cursor: default;',
			'data-node-index': index,
			'data-node-id': nodeId,
			'data-testid': nodeId
		})
	);

	onMount(() => {
		const onLayoutShift = () => {
			remeasure();
			descendants.notifySizeChange();
		};

		window.addEventListener('scroll', onLayoutShift, {
			capture: true,
			passive: true
		});
		window.addEventListener('resize', onLayoutShift, { passive: true });

		const unregister = descendants.mount(
			untrack(() => nodeId),
			untrack(() => nodeData)
		);
		return () => {
			unregister();
			window.removeEventListener('scroll', onLayoutShift, { capture: true });
			window.removeEventListener('resize', onLayoutShift);
		};
	});

	watch([() => nodeId, () => nodeData], ([nextId, nextData], previous) => {
		const previousId = previous?.[0];

		if (previousId && previousId !== nextId) {
			descendants.unmount(previousId);
			descendants.mount(nextId, nextData);
			return;
		}

		descendants.update(nextId, nextData);
	});

	watch(
		() => descendants.measurementEpoch,
		() => {
			untrack(() => remeasure());
		}
	);
</script>

{#if render}
	{@render render({ props: renderProps })}
{:else}
	<li
		{@attach observeNodeSize}
		bind:this={nodeRef}
		class={cn('bg-surface-container-high text-on-surface m3-font-body-medium ring-outline-variant rounded-md px-3 py-2 ring', className)}
		style="cursor: default;"
		data-node-index={index}
		data-node-id={nodeId}
		data-testid={nodeId}
	>
		{@render children?.()}
	</li>
{/if}
