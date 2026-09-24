<script lang="ts">
    import { Alert, AlertAction, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Spinner } from "$lib/components/ui/spinner";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc } from "$lib/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    let { projectId, resourceId }: { projectId: string; resourceId: string } = $props();

    const dialog = useQueryState("dialog", parseAsString.withOptions({ shallow: true, scroll: false }));

    const composeQuery = createQuery(() =>
        orpc.resources.getFormattedCompose.queryOptions({
            input: { projectId, resourceId },
            enabled: dialog.current === "preview-compose",
            staleTime: 0,
            retry: false,
        }),
    );
</script>

<Button variant="secondary" onclick={() => void dialog.set("preview-compose")}>Preview compose</Button>

<Dialog
    bind:open={
        () => dialog.current === "preview-compose",
        (open) => {
            if (!open && dialog.current === "preview-compose") void dialog.set(null);
        }
    }
>
    <DialogContent class="max-w-4xl">
        <DialogHeader>
            <DialogTitle>Final Compose</DialogTitle>
            <DialogDescription>
                Read-only formatted Compose from the saved configuration. Unsaved changes are not included.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if composeQuery.isFetching || composeQuery.isPending}
                <div class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
                    <Spinner class="size-4" aria-hidden="true" />
                    Loading compose...
                </div>
            {:else if composeQuery.isError}
                <Alert variant="error">
                    <AlertDescription>
                        Unable to preview compose: {composeQuery.error.message}
                    </AlertDescription>
                    <AlertAction>
                        <Button variant="outline" size="sm" onclick={() => composeQuery.refetch()}>Retry</Button>
                    </AlertAction>
                </Alert>
            {:else if composeQuery.data}
                <Textarea
                    readonly
                    aria-label="Final Docker Compose YAML"
                    spellcheck="false"
                    wrap="off"
                    value={composeQuery.data.yaml}
                    class="h-[55vh] min-h-48 rounded-xl bg-code font-mono text-code-foreground [&_textarea]:h-full [&_textarea]:resize-none [&_textarea]:font-mono [&_textarea]:leading-6"
                />
            {/if}
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={() => {
                if (dialog.current === "preview-compose") void dialog.set(null);
            }}>Close</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
