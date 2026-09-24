<script lang="ts">
	import ChevronLeft from "@lucide/svelte/icons/chevron-left";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import { Button } from "$lib/components/ui/button";
	import {
		Pagination,
		PaginationContent,
		PaginationEllipsis,
		PaginationItem,
	} from "$lib/components/ui/pagination";

	interface Props {
		/** 1-based current page. Bindable: page changes are emitted via the binding. */
		page: number;
		totalPages: number;
	}

	let { page = $bindable<number>(), totalPages }: Props = $props();

	/**
	 * Window of ±2 around the current page with ellipsis gaps when
	 * totalPages > 7. Mirrors UptimeKit's DataPagination behavior:
	 * always show first/last, show current±2, collapse the rest into a
	 * single ellipsis on each side.
	 */
	const items = $derived.by<(number | "ellipsis-prev" | "ellipsis-next")[]>(() => {
		const list: (number | "ellipsis-prev" | "ellipsis-next")[] = [];

		for (let p = 1; p <= totalPages; p += 1) {
			if (
				totalPages > 7 &&
				(p < page - 2 || p > page + 2) &&
				p !== 1 &&
				p !== totalPages
			) {
				if (p === page - 3) {
					list.push("ellipsis-prev");
				} else if (p === page + 3) {
					list.push("ellipsis-next");
				}

				continue;
			}

			list.push(p);
		}

		return list;
	});
</script>

{#if totalPages > 1}
	<div class="flex items-center justify-end border-t bg-muted/20 px-4 py-3">
		<Pagination class="mx-0 w-auto">
			<PaginationContent>
				<PaginationItem>
					<Button
						variant="ghost"
						size="icon"
						class="h-8 w-8"
						aria-label="Previous page"
						disabled={page === 1}
						onclick={() => {
							page = page - 1;
						}}
					>
						<ChevronLeft aria-hidden="true" class="h-4 w-4" />
					</Button>
				</PaginationItem>
				{#each items as item (item)}
					<PaginationItem>
						{#if item === "ellipsis-prev" || item === "ellipsis-next"}
							<PaginationEllipsis />
						{:else}
							<Button
								variant={item === page ? "outline" : "ghost"}
								size="icon"
								class="h-8 w-8"
								aria-label={`Page ${item}`}
								aria-current={item === page ? "page" : undefined}
								onclick={() => {
									page = item;
								}}
							>
								{item}
							</Button>
						{/if}
					</PaginationItem>
				{/each}
				<PaginationItem>
					<Button
						variant="ghost"
						size="icon"
						class="h-8 w-8"
						aria-label="Next page"
						disabled={page === totalPages}
						onclick={() => {
							page = page + 1;
						}}
					>
						<ChevronRight aria-hidden="true" class="h-4 w-4" />
					</Button>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	</div>
{/if}
