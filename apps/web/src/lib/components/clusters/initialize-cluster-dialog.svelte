<script lang="ts">
    import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
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
    import { Fieldset, FieldsetLegend } from "$lib/components/ui/fieldset";
    import { Input } from "$lib/components/ui/input";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Stepper,
        StepperIndicator,
        StepperItem,
        StepperSeparator,
        StepperTitle,
    } from "$lib/components/ui/stepper";
    import { orpc, queryClient } from "$lib/orpc";
    import Database from "@lucide/svelte/icons/database";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Info from "@lucide/svelte/icons/info";
    import Server from "@lucide/svelte/icons/server";
    import ShieldCheck from "@lucide/svelte/icons/shield-check";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { watch } from "runed";

    type StorageType = "volume" | "bind";

    type Step = 1 | 2 | 3;

    let {
        open = $bindable(false),
        clusterId,
        onInitialized,
    }: {
        open?: boolean;
        clusterId: string;
        onInitialized?: (deploymentId: string, originatingClusterId: string) => void;
    } = $props();

    let step = $state<Step>(1);

    let machineId = $state("");

    let greptimeStorageType = $state<StorageType>("volume");

    let greptimeVolumeName = $state("stoat-monitoring-greptime");

    let greptimeBindPath = $state("/srv/stoat/monitoring/greptimedb");

    let alloyStorageType = $state<StorageType>("volume");

    let alloyVolumeName = $state("stoat-monitoring-alloy");

    let alloyBindPath = $state("/srv/stoat/monitoring/alloy");

    let retentionDays = $state(14);

    let hydratedForOpen = $state(false);

    const optionsQuery = createQuery(() =>
        orpc.cluster.getInitializationOptions.queryOptions({
            input: { clusterId },
            enabled: open && clusterId.length > 0,
        }),
    );

    const options = $derived(optionsQuery.data);

    const machines = $derived(options?.machines ?? []);

    const volumes = $derived(options?.volumes ?? []);

    const selectedMachine = $derived(machines.find((machine) => machine.id === machineId));

    const selectedMachineVolumes = $derived(
        volumes.filter((volume) => volume.machineId === machineId),
    );

    const initializeMutationState = createMutation(() =>
        orpc.cluster.initializeCluster.mutationOptions({
            onSuccess: async (data, variables) => {
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: orpc.cluster.getCluster.queryKey({ input: { clusterId: variables.clusterId } }),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.cluster.getInitializationOptions.queryKey({
                            input: { clusterId: variables.clusterId },
                        }),
                    }),
                ]);

                if (clusterId === variables.clusterId) open = false;

                if (data?.deploymentId) onInitialized?.(data.deploymentId, variables.clusterId);
            },
        }),
    );

    const errorMessage = $derived(
        initializeMutationState.error
            ? initializeMutationState.error.message || "Unable to initialize the cluster."
            : "",
    );

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) {
                resetForm();
            }
        },
    );

    // Apply a saved configuration once per dialog opening. This makes a failed
    // or interrupted setup easy to review without overwriting edits during the
    // current session.
    watch(
        [() => open, () => optionsQuery.data],
        ([isOpen, data]) => {
            if (!isOpen || !data || hydratedForOpen) return;
            const current = data;
            const saved = current.configuration;
            machineId = saved?.machineId ?? current.machines[0]?.id ?? "";
            greptimeStorageType = saved?.greptimeStorage.type ?? "volume";
            greptimeVolumeName =
                saved?.greptimeStorage.type === "volume"
                    ? saved.greptimeStorage.source
                    : "stoat-monitoring-greptime";
            greptimeBindPath =
                saved?.greptimeStorage.type === "bind"
                    ? saved.greptimeStorage.source
                    : "/srv/stoat/monitoring/greptimedb";
            alloyStorageType = saved?.alloyStorage.type ?? "volume";
            alloyVolumeName =
                saved?.alloyStorage.type === "volume"
                    ? saved.alloyStorage.source
                    : "stoat-monitoring-alloy";
            alloyBindPath =
                saved?.alloyStorage.type === "bind"
                    ? saved.alloyStorage.source
                    : "/srv/stoat/monitoring/alloy";
            retentionDays = saved?.retentionDays ?? 14;
            hydratedForOpen = true;
        },
    );

    function resetForm() {
        step = 1;
        machineId = "";
        greptimeStorageType = "volume";
        greptimeVolumeName = "stoat-monitoring-greptime";
        greptimeBindPath = "/srv/stoat/monitoring/greptimedb";
        alloyStorageType = "volume";
        alloyVolumeName = "stoat-monitoring-alloy";
        alloyBindPath = "/srv/stoat/monitoring/alloy";
        retentionDays = 14;
        hydratedForOpen = false;
        initializeMutationState.reset();
    }

    function isValidVolumeName(value: string) {
        return /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value.trim());
    }

    function isValidBindPath(value: string) {
        const path = value.trim();

        return (
            /^\/(?:srv|mnt|data|opt|var\/lib)\/[a-zA-Z0-9_./-]+$/.test(path) &&
            !path.split("/").some((part) => part === ".." || part === ".") &&
            !/^\/var\/lib\/(?:docker|containerd)(?:\/|$)/.test(path)
        );
    }

    function storageSource(type: StorageType, volumeName: string, bindPath: string) {
        return (type === "volume" ? volumeName : bindPath).trim();
    }

    function storageError(
        label: string,
        type: StorageType,
        volumeName: string,
        bindPath: string,
    ) {
        const source = storageSource(type, volumeName, bindPath);

        if (!source) return `${label} storage source is required.`;

        if (type === "volume" && !isValidVolumeName(source)) {
            return "Use a named volume with letters, numbers, dots, dashes, or underscores.";
        }

        if (type === "bind" && !isValidBindPath(source)) {
            return "Use a dedicated absolute path under /srv, /mnt, /data, /opt, or /var/lib.";
        }

        return "";
    }

    const greptimeStorageError = $derived(
        storageError(
            "Greptime",
            greptimeStorageType,
            greptimeVolumeName,
            greptimeBindPath,
        ),
    );

    const alloyStorageError = $derived(
        storageError("Alloy", alloyStorageType, alloyVolumeName, alloyBindPath),
    );

    const storageSourcesAreDifferent = $derived(
        storageSource(greptimeStorageType, greptimeVolumeName, greptimeBindPath) !==
            storageSource(alloyStorageType, alloyVolumeName, alloyBindPath),
    );

    // The number input crosses the Input component boundary as a string,
    // so coerce before validating. Without this, Number.isInteger("365")
    // is false and every typed value looks invalid.
    const retentionDaysValue = $derived(
        Number(retentionDays),
    );

    const retentionIsValid = $derived(
        Number.isInteger(retentionDaysValue) &&
            retentionDaysValue >= 1 &&
            retentionDaysValue <= 365,
    );

    const stepIsValid = $derived.by(() => {
        if (step === 1) return Boolean(machineId);

        if (step === 2) {
            return Boolean(
                !greptimeStorageError &&
                    !alloyStorageError &&
                    storageSourcesAreDifferent &&
                    retentionIsValid,
            );
        }

        return Boolean(machineId && !greptimeStorageError && !alloyStorageError && storageSourcesAreDifferent && retentionIsValid);
    });

    const canSubmit = $derived(
        step === 3 && stepIsValid && !initializeMutationState.isPending,
    );

    function nextStep() {
        if (step < 3 && stepIsValid) step = step === 1 ? 2 : 3;
    }

    function previousStep() {
        if (step > 1) step = step === 3 ? 2 : 1;
    }

    function submitInitialization(event: SubmitEvent) {
        event.preventDefault();

        if (step !== 3) {
            nextStep();

            return;
        }

        if (!canSubmit) return;

        initializeMutationState.mutate({
            clusterId,
            configuration: {
                machineId,
                greptimeStorage: {
                    type: greptimeStorageType,
                    source: storageSource(greptimeStorageType, greptimeVolumeName, greptimeBindPath),
                },
                alloyStorage: {
                    type: alloyStorageType,
                    source: storageSource(alloyStorageType, alloyVolumeName, alloyBindPath),
                },
                retentionDays: retentionDaysValue,
            },
        });
    }
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
            <DialogTitle>Initialize cluster monitoring</DialogTitle>
            <DialogDescription>
                Choose where the internal monitoring stack stores its data. This setup does not
                publish monitoring services to the internet.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if optionsQuery.isPending}
                <Skeleton loading loading-label="Loading initialization options">
                    <div class="space-y-4">
                        <div>
                            <Label>Machine</Label>
                            <p class="mt-2 rounded-lg border border-border p-3 text-sm">Primary cluster machine</p>
                        </div>
                        <div class="rounded-lg border border-border p-4">
                            <h3 class="font-medium">GreptimeDB storage</h3>
                            <p class="mt-2 text-sm text-muted-foreground">Persistent monitoring data volume.</p>
                        </div>
                        <div class="rounded-lg border border-border p-4">
                            <h3 class="font-medium">Alloy storage</h3>
                            <p class="mt-2 text-sm text-muted-foreground">Persistent collector data volume.</p>
                        </div>
                    </div>
                </Skeleton>
            {:else if optionsQuery.isError}
                <Alert variant="error">
                    <Info aria-hidden="true" />
                    <AlertTitle>Could not load cluster options</AlertTitle>
                    <AlertDescription>
                        {(optionsQuery.error as Error).message || "The cluster sidecar did not return its available machines."}
                    </AlertDescription>
                </Alert>
            {:else if machines.length === 0}
                <Alert variant="warning">
                    <Server aria-hidden="true" />
                    <AlertTitle>No available machines</AlertTitle>
                    <AlertDescription>
                        Add an available machine to the cluster before initializing monitoring.
                    </AlertDescription>
                </Alert>
            {:else}
                <Stepper {step} class="mb-5">
                    {#each [
                        { number: 1, label: "Placement" },
                        { number: 2, label: "Storage" },
                        { number: 3, label: "Review" },
                    ] as item, index (item.number)}
                        <StepperItem step={item.number} class="min-w-0 flex-1 last:flex-none">
                            <StepperIndicator class="size-7">{item.number}</StepperIndicator>
                            <StepperTitle class="ml-2 hidden text-xs text-muted-foreground group-data-[state=active]/step:text-foreground group-data-[state=completed]/step:text-foreground sm:block">
                                {item.label}
                            </StepperTitle>
                            {#if index < 2}<StepperSeparator class="mr-0 ml-2 min-w-4" />{/if}
                        </StepperItem>
                    {/each}
                </Stepper>

                {#if errorMessage}
                    <Alert variant="error" class="mb-4">
                        <Info aria-hidden="true" />
                        <AlertDescription>{errorMessage}</AlertDescription>
                    </Alert>
                {/if}

                <form
                    id="initialize-cluster-form"
                    method="POST"
                    onsubmit={submitInitialization}
                    class="space-y-5"
                    aria-busy={initializeMutationState.isPending}
                >
                    {#if step === 1}
                        <div class="space-y-5">
                            <Field>
                                <Label for="initialization-machine" required>Deployment machine</Label>
                                <Select bind:value={machineId} items={machines.map((machine) => ({ label: machine.name, value: machine.id }))}>
                                    <SelectTrigger id="initialization-machine" aria-label="Select deployment machine">
                                        <SelectValue placeholder="Select a machine" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {#each machines as machine (machine.id)}
                                            <SelectItem value={machine.id} label={machine.name}>
                                                <span class="flex min-w-0 items-center gap-2">
                                                    <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                    <span class="truncate">{machine.name}</span>
                                                    <span class="text-xs text-muted-foreground">{machine.state}</span>
                                                </span>
                                            </SelectItem>
                                        {/each}
                                    </SelectContent>
                                </Select>
                                <FieldDescription>
                                    GreptimeDB is pinned to this machine so its local data stays with its service.
                                </FieldDescription>
                            </Field>

                            <Alert variant="info">
                                <Server aria-hidden="true" />
                                <AlertTitle>Alloy runs on every available machine</AlertTitle>
                                <AlertDescription>
                                    Alloy collects node metrics cluster-wide. Its data is stored locally on each
                                    machine, so a bind path must exist on every machine; named volumes are managed
                                    for you.
                                </AlertDescription>
                            </Alert>

                            {#if selectedMachine}
                                <Card class="rounded-lg bg-muted/25 text-sm">
                                    <CardPanel class="p-3">
                                        <div class="flex items-center gap-2 font-medium">
                                            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
                                            {selectedMachine.name}
                                            <span class="text-xs font-normal text-muted-foreground">{selectedMachine.state}</span>
                                        </div>
                                        <p class="mt-1 text-xs text-muted-foreground">
                                            {selectedMachineVolumes.length === 0
                                                ? "No existing named volumes were reported on this machine."
                                                : `Existing named volumes: ${selectedMachineVolumes.map((volume) => volume.name).join(", ")}`}
                                        </p>
                                    </CardPanel>
                                </Card>
                            {/if}
                        </div>
                    {:else if step === 2}
                        <div class="space-y-5">
                            <div>
                                <h3 class="flex items-center gap-2 text-sm font-semibold">
                                    <Database class="size-4 text-muted-foreground" aria-hidden="true" />
                                    GreptimeDB storage
                                </h3>
                                <p class="mt-1 text-xs text-muted-foreground">
                                    Metrics and logs are retained here. Keep this location on the selected deployment machine.
                                </p>
                            </div>

                            <Fieldset class="space-y-2">
                                <FieldsetLegend class="text-sm">Storage type</FieldsetLegend>
                                <RadioGroup bind:value={greptimeStorageType} class="grid gap-2 sm:grid-cols-2" aria-label="GreptimeDB storage type">
                                    <label class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${greptimeStorageType === "volume" ? "border-primary bg-primary/5" : "border-border"}`}>
                                        <RadioGroupItem class="mt-0.5" value="volume" />
                                        <span>
                                            <span class="block text-sm font-medium">Named volume</span>
                                            <span class="mt-0.5 block text-xs text-muted-foreground">Managed by Uncloud and pinned with GreptimeDB.</span>
                                        </span>
                                    </label>
                                    <label class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${greptimeStorageType === "bind" ? "border-primary bg-primary/5" : "border-border"}`}>
                                        <RadioGroupItem class="mt-0.5" value="bind" />
                                        <span>
                                            <span class="block text-sm font-medium">Host path</span>
                                            <span class="mt-0.5 block text-xs text-muted-foreground">Use a dedicated absolute path on the selected machine.</span>
                                        </span>
                                    </label>
                                </RadioGroup>
                            </Fieldset>

                            <Field>
                                <Label for="greptime-storage-source" required>{greptimeStorageType === "volume" ? "Volume name" : "Absolute host path"}</Label>
                                {#if greptimeStorageType === "volume"}
                                    <Input
                                        id="greptime-storage-source"
                                        bind:value={greptimeVolumeName}
                                        list="initialization-volumes"
                                        placeholder="stoat-monitoring-greptime"
                                        autocomplete="off"
                                        aria-invalid={Boolean(greptimeStorageError)}
                                    />
                                {:else}
                                    <Input
                                        id="greptime-storage-source"
                                        bind:value={greptimeBindPath}
                                        placeholder="/srv/stoat/monitoring/greptimedb"
                                        autocomplete="off"
                                        aria-invalid={Boolean(greptimeStorageError)}
                                    />
                                {/if}
                                {#if greptimeStorageError}
                                    <FieldError>{greptimeStorageError}</FieldError>
                                {:else}
                                    <FieldDescription>
                                        {greptimeStorageType === "volume" ? "Use a unique name; this volume is not shared with Alloy." : "Allowed roots: /srv, /mnt, /data, /opt, and /var/lib."}
                                    </FieldDescription>
                                {/if}
                            </Field>

                            <Separator />
                            <div>
                                <h3 class="flex items-center gap-2 text-sm font-semibold">
                                    <HardDrive class="size-4 text-muted-foreground" aria-hidden="true" />
                                    Alloy storage
                                </h3>
                                <p class="mt-1 text-xs text-muted-foreground">
                                    Alloy keeps its local collection state per machine. The same source must be available wherever Alloy runs.
                                </p>
                            </div>

                            <Fieldset class="space-y-2">
                                <FieldsetLegend class="text-sm">Storage type</FieldsetLegend>
                                <RadioGroup bind:value={alloyStorageType} class="grid gap-2 sm:grid-cols-2" aria-label="Alloy storage type">
                                    <label class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${alloyStorageType === "volume" ? "border-primary bg-primary/5" : "border-border"}`}>
                                        <RadioGroupItem class="mt-0.5" value="volume" />
                                        <span>
                                            <span class="block text-sm font-medium">Named volume</span>
                                            <span class="mt-0.5 block text-xs text-muted-foreground">Creates local managed storage for every Alloy replica.</span>
                                        </span>
                                    </label>
                                    <label class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${alloyStorageType === "bind" ? "border-primary bg-primary/5" : "border-border"}`}>
                                        <RadioGroupItem class="mt-0.5" value="bind" />
                                        <span>
                                            <span class="block text-sm font-medium">Host path</span>
                                            <span class="mt-0.5 block text-xs text-muted-foreground">Use a dedicated path present on all cluster machines.</span>
                                        </span>
                                    </label>
                                </RadioGroup>
                            </Fieldset>

                            <Field>
                                <Label for="alloy-storage-source" required>{alloyStorageType === "volume" ? "Volume name" : "Absolute host path"}</Label>
                                {#if alloyStorageType === "volume"}
                                    <Input
                                        id="alloy-storage-source"
                                        bind:value={alloyVolumeName}
                                        list="initialization-volumes"
                                        placeholder="stoat-monitoring-alloy"
                                        autocomplete="off"
                                        aria-invalid={Boolean(alloyStorageError)}
                                    />
                                {:else}
                                    <Input
                                        id="alloy-storage-source"
                                        bind:value={alloyBindPath}
                                        placeholder="/srv/stoat/monitoring/alloy"
                                        autocomplete="off"
                                        aria-invalid={Boolean(alloyStorageError)}
                                    />
                                {/if}
                                {#if alloyStorageError}
                                    <FieldError>{alloyStorageError}</FieldError>
                                {:else}
                                    <FieldDescription>
                                        {alloyStorageType === "volume" ? "Use a different name from the GreptimeDB volume." : "This path must exist on every machine where Alloy is scheduled."}
                                    </FieldDescription>
                                {/if}
                            </Field>

                            <Field>
                                <Label for="retention-days" required>Retention period</Label>
                                <InputGroup class="max-w-40">
                                    <InputGroupInput
                                        id="retention-days"
                                        type="number"
                                        min="1"
                                        max="365"
                                        step="1"
                                        bind:value={retentionDays}
                                        aria-invalid={!retentionIsValid}
                                    />
                                    <InputGroupAddon align="inline-end">days</InputGroupAddon>
                                </InputGroup>
                                <FieldDescription>Choose between 1 and 365 days of monitoring data.</FieldDescription>
                            </Field>

                            <datalist id="initialization-volumes">
                                {#each selectedMachineVolumes as volume (volume.machineId + volume.name)}
                                    <option value={volume.name}>{volume.machineName}</option>
                                {/each}
                            </datalist>

                            {#if !storageSourcesAreDifferent}
                                <Alert variant="error">
                                    <AlertDescription>
                                        GreptimeDB and Alloy must use separate storage locations.
                                    </AlertDescription>
                                </Alert>
                            {/if}
                        </div>
                    {:else}
                        <div class="space-y-4">
                            <Alert variant="info">
                                <ShieldCheck aria-hidden="true" />
                                <AlertTitle>Internal-only monitoring</AlertTitle>
                                <AlertDescription>
                                    Services are kept on the Uncloud internal network. No public ports or ingress routes are created.
                                </AlertDescription>
                            </Alert>

                            <Card class="rounded-lg">
                                <CardPanel class="p-0">
                                    <div class="flex items-start justify-between gap-4 p-3">
                                        <span class="text-sm text-muted-foreground">GreptimeDB machine</span>
                                        <span class="text-right text-sm font-medium">{selectedMachine?.name ?? machineId}</span>
                                    </div>
                                    <Separator />
                                    <div class="flex items-start justify-between gap-4 p-3">
                                        <span class="text-sm text-muted-foreground">GreptimeDB storage</span>
                                        <span class="text-right text-sm font-medium">{greptimeStorageType}: {storageSource(greptimeStorageType, greptimeVolumeName, greptimeBindPath)}</span>
                                    </div>
                                    <Separator />
                                    <div class="flex items-start justify-between gap-4 p-3">
                                        <span class="text-sm text-muted-foreground">Alloy storage</span>
                                        <span class="text-right text-sm font-medium">{alloyStorageType}: {storageSource(alloyStorageType, alloyVolumeName, alloyBindPath)}</span>
                                    </div>
                                    <Separator />
                                    <div class="flex items-start justify-between gap-4 p-3">
                                        <span class="text-sm text-muted-foreground">Retention</span>
                                        <span class="text-right text-sm font-medium">{retentionDays} days</span>
                                    </div>
                                </CardPanel>
                            </Card>

                            <p class="text-xs text-muted-foreground">
                                Alloy will run on every available machine and use local storage on each one. Review bind paths carefully before continuing.
                            </p>
                        </div>
                    {/if}
                </form>
            {/if}
        </DialogPanel>

        {#if !optionsQuery.isPending && !optionsQuery.isError && machines.length > 0}
            <DialogFooter>
                <Button
                    variant="outline"
                    disabled={initializeMutationState.isPending}
                    onclick={() => {
                        open = false;
                    }}
                >
                    Cancel
                </Button>
                {#if step > 1}
                    <Button
                        variant="outline"
                        disabled={initializeMutationState.isPending}
                        onclick={previousStep}
                    >
                        Back
                    </Button>
                {/if}
                {#if step < 3}
                    <Button
                        type="button"
                        disabled={!stepIsValid || initializeMutationState.isPending}
                        onclick={nextStep}
                    >
                        Continue
                    </Button>
                {:else}
                    <Button
                        type="submit"
                        form="initialize-cluster-form"
                        loading={initializeMutationState.isPending}
                        disabled={!canSubmit}
                    >
                        Initialize monitoring
                    </Button>
                {/if}
            </DialogFooter>
        {/if}
    </DialogContent>
</Dialog>
