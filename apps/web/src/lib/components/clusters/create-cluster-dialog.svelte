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
    import { Field, FieldDescription } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { orpc, queryClient } from "$lib/orpc";
    import { createMutation } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let name = $state("");

    let sidecarUrl = $state("");

    let sidecarToken = $state("");

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) resetForm();
        },
    );

    function resetForm() {
        name = "";
        sidecarUrl = "";
        sidecarToken = "";
        createMutationState.reset();
    }

    const createMutationState = createMutation(() =>
        orpc.cluster.createCluster.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listClusters.queryKey(),
                });
                open = false;
            },
        }),
    );

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message || "Unable to create cluster."
            : "",
    );

    const canSubmit = $derived(
        Boolean(name.trim()) &&
            Boolean(sidecarUrl.trim()) &&
            Boolean(sidecarToken.trim()) &&
            !createMutationState.isPending,
    );

    function createCluster(event: SubmitEvent) {
        event.preventDefault();

        if (createMutationState.isPending) return;

        if (!name.trim() || !sidecarUrl.trim() || !sidecarToken.trim()) return;
        createMutationState.mutate({
            name: name.trim(),
            sidecarUrl: sidecarUrl.trim(),
            sidecarToken: sidecarToken.trim(),
        });
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Cluster</DialogTitle>
            <DialogDescription>Clusters run your projects' resources.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if errorMessage}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
            {/if}
            <form
                id="create-cluster-form"
                method="POST"
                onsubmit={createCluster}
                class="space-y-4"
                aria-busy={createMutationState.isPending}
            >
                <Field>
                    <Label for="cluster-name" required>Name</Label>
                    <Input
                        id="cluster-name"
                        bind:value={name}
                        placeholder="Production"
                        required
                        maxlength={100}
                        disabled={createMutationState.isPending}
                    />
                </Field>
                <Field>
                    <Label for="cluster-sidecar-url" required>Sidecar URL</Label>
                    <Input
                        id="cluster-sidecar-url"
                        type="url"
                        inputmode="url"
                        bind:value={sidecarUrl}
                        placeholder="https://sidecar.example.com"
                        required
                        maxlength={500}
                        autocomplete="off"
                        disabled={createMutationState.isPending}
                        aria-describedby="cluster-sidecar-url-hint"
                    />
                    <FieldDescription id="cluster-sidecar-url-hint">
                        Where the cluster's sidecar is reachable.
                    </FieldDescription>
                </Field>
                <Field>
                    <Label for="cluster-sidecar-token" required>Sidecar token</Label>
                    <Input
                        id="cluster-sidecar-token"
                        type="password"
                        bind:value={sidecarToken}
                        placeholder="••••••••"
                        required
                        maxlength={500}
                        autocomplete="new-password"
                        disabled={createMutationState.isPending}
                        aria-describedby="cluster-sidecar-token-hint"
                    />
                    <FieldDescription id="cluster-sidecar-token-hint">
                        Authenticates Stoat against the sidecar. Never shown again after
                        creation.
                    </FieldDescription>
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
                form="create-cluster-form"
                loading={createMutationState.isPending}
                disabled={!canSubmit}
            >
                Create Cluster
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
