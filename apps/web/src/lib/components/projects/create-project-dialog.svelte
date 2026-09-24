<script lang="ts">
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
    import { Field, FieldDescription, FieldError } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/orpc";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let name = $state("");

    let description = $state("");

    let clusterId = $state("");

    const clustersQuery = createQuery(() => orpc.cluster.listClusters.queryOptions());

    const clusters = $derived(clustersQuery.data?.items ?? []);

    const selectItems = $derived(clusters.map((c) => ({ label: c.name, value: c.id })));

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) resetForm();
        },
    );

    // Pre-select the first cluster once the list loads so the form always
    // submits an explicit cluster, while still letting the user change it.
    // If the previous selection is no longer in the list (e.g. org switch),
    // fall back to the first available cluster.
    watch(
        [
            () => open,
            () => clustersQuery.isPending,
            () => clustersQuery.isError,
            () => clusters,
            () => clusterId,
        ],
        ([isOpen, isPending, isError, currentClusters, currentClusterId]) => {
        if (!isOpen) return;

        if (isPending || isError) return;

        if (currentClusters.length === 0) {
            if (clusterId !== "") clusterId = "";

            return;
        }

        if (!currentClusterId || !currentClusters.some((c) => c.id === currentClusterId)) {
            clusterId = currentClusters[0].id;
        }
        },
    );

    function resetForm() {
        name = "";
        description = "";
        clusterId = "";
        createMutationState.reset();
    }

    const createMutationState = createMutation(() =>
        orpc.projects.createProject.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.projects.key(),
                });
                open = false;
            },
        }),
    );

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message || "Unable to create project."
            : "",
    );

    const canSubmit = $derived(
        Boolean(name.trim()) && Boolean(clusterId) && !createMutationState.isPending,
    );

    function createProject(event: SubmitEvent) {
        event.preventDefault();

        if (createMutationState.isPending || !clusterId) return;
        createMutationState.mutate({
            name: name.trim(),
            description: description.trim() || undefined,
            clusterId,
        });
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>Projects group your environments and resources.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if errorMessage}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
            {/if}
            <form
                id="create-project-form"
                method="POST"
                onsubmit={createProject}
                class="space-y-4"
                aria-busy={createMutationState.isPending}
            >
                <Field>
                    <Label for="project-name" required>Name</Label>
                    <Input
                        id="project-name"
                        bind:value={name}
                        placeholder="My website"
                        required
                        maxlength={100}
                        disabled={createMutationState.isPending}
                    />
                </Field>
                <Field>
                    <Label for="project-description">Description</Label>
                    <Textarea
                        id="project-description"
                        bind:value={description}
                        placeholder="What is this project for?"
                        maxlength={500}
                        rows={3}
                        disabled={createMutationState.isPending}
                    />
                </Field>
                <Field>
                    <Label for="project-cluster">Cluster</Label>
                    {#if clustersQuery.isPending}
                        <Input
                            id="project-cluster"
                            value="Loading clusters…"
                            disabled
                            aria-label="Loading clusters"
                        />
                    {:else if clustersQuery.isError}
                        <FieldError>
                            Unable to load clusters: {clustersQuery.error.message}
                        </FieldError>
                    {:else if clusters.length === 0}
                        <Select bind:value={clusterId} items={[]} disabled required>
                            <SelectTrigger id="project-cluster" aria-label="No clusters available">
                                <SelectValue placeholder="No clusters yet" />
                            </SelectTrigger>
                        </Select>
                        <FieldDescription>
                            No clusters yet.
                            <a
                                href="/clusters"
                                onclick={() => (open = false)}
                                class="underline underline-offset-4 hover:text-primary"
                            >
                                Set up a cluster first
                            </a>
                        </FieldDescription>
                    {:else}
                        <Select
                            bind:value={clusterId}
                            items={selectItems}
                            disabled={createMutationState.isPending}
                            required
                        >
                            <SelectTrigger id="project-cluster" aria-label="Select a cluster">
                                <SelectValue placeholder="Select a cluster" />
                            </SelectTrigger>
                            <SelectContent>
                                {#each clusters as cluster (cluster.id)}
                                    <SelectItem value={cluster.id} label={cluster.name}>
                                        {cluster.name}
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                        <FieldDescription>Where this project's resources will run.</FieldDescription>
                    {/if}
                </Field>
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
                form="create-project-form"
                loading={createMutationState.isPending}
                disabled={!canSubmit}
            >
                Create Project
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
