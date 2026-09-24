<script module lang="ts">
    import { parseAsString, parseAsStringLiteral } from "nuqs-svelte";

    export const resourceFormParsers = {
        resourceName: parseAsString.withDefault(""),
        resourceDescription: parseAsString.withDefault(""),
        source: parseAsStringLiteral(["blank", "git"]).withDefault("blank"),
    };
</script>

<script lang="ts">
    import { page } from "$app/state";
    import GitSourceFields from "./git-source-fields.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
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
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/orpc";
    import { createMutation } from "@tanstack/svelte-query";
    import { useQueryStates } from "nuqs-svelte";
    import { watch } from "runed";
    import { onDestroy, untrack } from "svelte";

    let { open = $bindable(false), projectId }: { open?: boolean; projectId: string } =
        $props();

    const fields = useQueryStates(resourceFormParsers, { shallow: true, scroll: false });

    const fromGit = $derived(fields.source.current === "git");

    const pathname = untrack(() => page.url.pathname);

    let active = true;

    onDestroy(() => { active = false; });

    let connectionId = $state("");

    let repositoryUrl = $state("");

    let branch = $state("");

    let path = $state(".");

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) resetPrivateFields();
        },
    );

    function resetPrivateFields() {
        connectionId = "";
        repositoryUrl = "";
        branch = "";
        path = ".";
        createMutationState.reset();
    }

    const createMutationState = createMutation(() =>
        orpc.resources.createResource.mutationOptions({
            onSuccess: async (_updated, input) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
                void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });

                if (active && projectId === input.projectId && page.url.pathname === pathname) open = false;
            },
        }),
    );

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message || "Unable to create resource."
            : "",
    );

    const canSubmit = $derived(Boolean(fields.resourceName.current.trim()) && !createMutationState.isPending && (!fromGit || Boolean(connectionId && repositoryUrl && branch.trim() && path.trim())));

    async function createResource(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;
        createMutationState.mutate({
            projectId,
            name: fields.resourceName.current.trim(),
            description: fields.resourceDescription.current.trim() || undefined,
            type: "compose",
            git: fromGit ? { connectionId, repositoryUrl, branch: branch.trim(), path: path.trim() } : undefined,
        });
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>New Compose</DialogTitle>
            <DialogDescription>Create a compose resource in this project.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if errorMessage}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
            {/if}
            <form
                id="create-resource-form"
                method="POST"
                onsubmit={createResource}
                class="space-y-4"
                aria-busy={createMutationState.isPending}
            >
                <Field>
                    <Label for="resource-name" required>Name</Label>
                    <Input
                        id="resource-name"
                        bind:value={fields.resourceName.current}
                        placeholder="My service"
                        required
                        maxlength={100}
                        disabled={createMutationState.isPending}
                    />
                </Field>
                <Field>
                    <Label for="resource-description">Description</Label>
                    <Textarea
                        id="resource-description"
                        bind:value={fields.resourceDescription.current}
                        placeholder="What is this resource for?"
                        maxlength={500}
                        rows={3}
                        disabled={createMutationState.isPending}
                    />
                </Field>
                <label class="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        bind:checked={() => fromGit, (checked) => { fields.source.current = checked ? "git" : "blank"; }}
                        disabled={createMutationState.isPending}
                    />
                    Import from Git
                </label>
                {#if fromGit}
                    <GitSourceFields bind:connectionId bind:repositoryUrl bind:branch bind:path disabled={createMutationState.isPending} />
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                disabled={createMutationState.isPending}
                onclick={() => {
                    open = false;
                }}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="create-resource-form"
                loading={createMutationState.isPending}
                disabled={!canSubmit}
            >
                Create Resource
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
