<script lang="ts">
    import { page } from "$app/state";
    import { Alert, AlertAction, AlertDescription } from "$lib/components/ui/alert";
    import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardFooter, CardPanel } from "$lib/components/ui/card";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Field, FieldDescription, FieldError } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Switch } from "$lib/components/ui/switch";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/orpc";
    import { cn } from "$lib/utils";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Link from "@lucide/svelte/icons/link";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import Upload from "@lucide/svelte/icons/upload";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { untrack } from "svelte";
    import { watch } from "runed";
    import { z } from "zod";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: Boolean(projectId && resourceId),
        }),
    );

    const resource = $derived(resourceQuery.data);

    const prefixNamesSchema = z.object({ prefixNames: z.boolean().catch(false) }).catch({ prefixNames: false });

    let prefixNames = $state(false);

    let savedPrefixNames = $state(false);

    let loadedResourceId = $state("");

    let failedValue = $state<boolean | null>(null);

    const isDirty = $derived(prefixNames !== savedPrefixNames);

    let detailName = $state("");

    let detailDescription = $state("");

    let detailIcon = $state("");

    let savedDetailName = $state("");

    let savedDetailDescription = $state("");

    let savedDetailIcon = $state("");

    let iconLoadFailed = $state(false);

    const isDetailsDirty = $derived(
        detailName !== savedDetailName ||
            detailDescription !== savedDetailDescription ||
            detailIcon !== savedDetailIcon,
    );

    const isDetailsValid = $derived(detailName.trim().length > 0);

    const iconPreview = $derived(detailIcon.trim());

    let iconMenuOpen = $state(false);

    let uploadOpen = $state(false);

    let linkOpen = $state(false);

    let linkDraft = $state("");

    let linkError = $state("");

    let uploadPreview = $state("");

    let uploadError = $state("");

    let uploadProcessing = $state(false);

    let uploadFileName = $state("");

    let fileInput: HTMLInputElement | null = $state(null);

    const isLinkValid = $derived.by(() => {
        const value = linkDraft.trim();

        if (!value) return false;

        try {
            const url = new URL(value);

            return url.protocol === "http:" || url.protocol === "https:";
        } catch {
            return false;
        }
    });

    function openUploadDialog() {
        iconMenuOpen = false;
        uploadError = "";
        uploadPreview = "";
        uploadFileName = "";
        uploadProcessing = false;
        uploadOpen = true;
    }

    function openLinkDialog() {
        iconMenuOpen = false;
        linkError = "";
        const current = detailIcon.trim();
        linkDraft = current && !current.startsWith("data:") ? current : "";
        linkOpen = true;
    }

    function removeIcon() {
        iconMenuOpen = false;
        detailIcon = "";
        iconLoadFailed = false;
    }

    const SVG_MAX_BYTES = 256 * 1024;

    function isSvgFile(file: File): boolean {
        return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    }

    function fileToDataUrl(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."));
            reader.readAsDataURL(file);
        });
    }

    async function svgToDataUrl(file: File): Promise<string> {
        const text = await file.text();

        if (!/<svg[\s>]/i.test(text)) throw new Error("Not an SVG document.");

        return `data:image/svg+xml;base64,${(await fileToDataUrl(file)).split(",", 2)[1] ?? ""}`;
    }

    async function fileToResizedDataUrl(file: File): Promise<string> {
        const bitmap = await createImageBitmap(file);

        try {
            const max = 256;
            const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");

            if (!ctx) throw new Error("Canvas is not supported.");
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(bitmap, 0, 0, w, h);

            return canvas.toDataURL("image/png");
        } finally {
            bitmap.close();
        }
    }

    async function handleFileChange(event: Event) {
        const input = event.currentTarget;

        if (!(input instanceof HTMLInputElement)) return;
        const file = input.files?.[0];

        if (!file) return;
        uploadError = "";
        uploadPreview = "";
        uploadFileName = file.name;
        const svg = isSvgFile(file);

        if (!svg && !file.type.startsWith("image/")) {
            uploadError = "Please choose an image file.";
            input!.value = "";

            return;
        }

        if (svg && file.size > SVG_MAX_BYTES) {
            uploadError = "SVG must be 256 KB or smaller.";
            input!.value = "";

            return;
        }

        if (!svg && file.size > 5 * 1024 * 1024) {
            uploadError = "Image must be 5 MB or smaller.";
            input!.value = "";

            return;
        }

        uploadProcessing = true;

        try {
            uploadPreview = svg ? await svgToDataUrl(file) : await fileToResizedDataUrl(file);
        } catch {
            uploadError = "Unable to read that image. Try another file.";
        } finally {
            uploadProcessing = false;
            input!.value = "";
        }
    }

    function confirmUpload() {
        if (!uploadPreview || uploadProcessing) return;
        detailIcon = uploadPreview;
        iconLoadFailed = false;
        uploadOpen = false;
    }

    function confirmLink() {
        const value = linkDraft.trim();

        if (!value) {
            linkError = "Paste an image URL.";

            return;
        }

        try {
            const url = new URL(value);

            if (url.protocol !== "http:" && url.protocol !== "https:") {
                linkError = "Link must start with http:// or https://.";

                return;
            }
        } catch {
            linkError = "That doesn't look like a valid URL.";

            return;
        }

        linkError = "";
        detailIcon = value;
        iconLoadFailed = false;
        linkOpen = false;
    }

    const saveMutation = createMutation(() =>
        orpc.resources.updateSettings.mutationOptions({
            onSuccess: (updated, input) => {
                if (loadedResourceId === updated.id) {
                    failedValue = null;
                    savedPrefixNames = prefixNamesSchema.parse(updated.settings).prefixNames;
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({ input: { projectId: input.projectId } }),
                });
            },
            onError: (_error, input) => {
                if (loadedResourceId === input.resourceId) failedValue = input.prefixNames;
            },
        }),
    );

    const detailsMutation = createMutation(() =>
        orpc.resources.updateDetails.mutationOptions({
            onSuccess: (updated, input) => {
                if (loadedResourceId === updated.id) {
                    savedDetailName = updated.name ?? "";
                    savedDetailDescription = updated.description ?? "";
                    savedDetailIcon = updated.icon ?? "";
                    detailName = savedDetailName;
                    detailDescription = savedDetailDescription;
                    detailIcon = savedDetailIcon;
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({ input: { projectId: input.projectId } }),
                });
            },
        }),
    );

    $effect(() => {
        const current = resource;

        if (!current) return;
        untrack(() => {
            const saved = prefixNamesSchema.parse(current.settings).prefixNames;

            if (loadedResourceId !== current.id) {
                loadedResourceId = current.id;
                prefixNames = saved;
                savedPrefixNames = saved;
                failedValue = null;
                saveMutation.reset();
                savedDetailName = current.name ?? "";
                savedDetailDescription = current.description ?? "";
                savedDetailIcon = current.icon ?? "";
                detailName = savedDetailName;
                detailDescription = savedDetailDescription;
                detailIcon = savedDetailIcon;
                iconLoadFailed = false;
                detailsMutation.reset();
            } else {
                if (!isDirty) {
                    prefixNames = saved;
                    savedPrefixNames = saved;
                }

                if (!isDetailsDirty) {
                    savedDetailName = current.name ?? "";
                    savedDetailDescription = current.description ?? "";
                    savedDetailIcon = current.icon ?? "";
                    detailName = savedDetailName;
                    detailDescription = savedDetailDescription;
                    detailIcon = savedDetailIcon;
                }
            }
        });
    });

    // Reset before Avatar's preloader can report a cached failure for the new source.
    watch.pre(() => iconPreview, () => {
        iconLoadFailed = false;
    });

    $effect(() => {
        if (!isDirty) {
            failedValue = null;

            return;
        }

        if (loadedResourceId !== resourceId || saveMutation.isPending || failedValue === prefixNames) return;

        const input = { projectId, resourceId, prefixNames };

        untrack(() => saveMutation.mutate(input));
    });

    function retrySave() {
        failedValue = null;
        saveMutation.reset();
    }

    function saveDetails() {
        if (!isDetailsDirty || !isDetailsValid || detailsMutation.isPending) return;
        detailsMutation.mutate({
            projectId,
            resourceId,
            name: detailName.trim(),
            description: detailDescription.trim() || undefined,
            icon: detailIcon.trim() || undefined,
        });
    }

    function resetDetails() {
        detailName = savedDetailName;
        detailDescription = savedDetailDescription;
        detailIcon = savedDetailIcon;
        iconLoadFailed = false;
        detailsMutation.reset();
    }
</script>

<svelte:head><title>Settings / {resource?.name ?? "Resource"} / Stoat</title></svelte:head>

<div class="mx-auto w-full max-w-5xl space-y-8 py-6 sm:py-8">
    {#if resourceQuery.isPending}
        <Skeleton loading loading-label="Loading resource settings">
            <div class="space-y-8">
                <div class="grid gap-8 md:grid-cols-3">
                    <div>
                        <h2 class="text-lg font-semibold">General</h2>
                        <p class="mt-1 text-sm text-muted-foreground">Update the resource name, description, and icon.</p>
                    </div>
                    <Card class="md:col-span-2">
                        <CardPanel class="space-y-5 p-6">
                            <div>
                                <Label>Resource name</Label>
                                <p class="mt-2 text-sm">Resource service</p>
                            </div>
                            <div>
                                <Label>Description</Label>
                                <p class="mt-2 text-sm">Resource configuration and deployment settings.</p>
                            </div>
                        </CardPanel>
                    </Card>
                </div>
            </div>
        </Skeleton>
    {:else if resourceQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load resource settings: {resourceQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !resource}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon"><Boxes aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>Resource not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another organization.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <section class="grid gap-5 md:grid-cols-3 md:gap-8" aria-labelledby="general-settings-heading">
            <div>
                <h2 id="general-settings-heading" class="text-lg font-semibold leading-tight tracking-tight">General</h2>
                <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Update the name, description, and icon for this resource.
                </p>
            </div>

            <div class="md:col-span-2">
                <Card>
                    <CardPanel class="space-y-5 p-5 sm:p-6">
                        <div class="flex items-end gap-4">
                            <Menu bind:open={iconMenuOpen}>
                                <MenuTrigger
                                    aria-label={iconPreview ? "Change icon" : "Add icon"}
                                    disabled={detailsMutation.isPending}
                                    class={cn(
                                        "group relative flex size-16 shrink-0 items-center justify-center rounded-xl border bg-muted/40 outline-none transition-colors",
                                        "hover:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                                        "disabled:pointer-events-none disabled:opacity-50",
                                        iconPreview && !iconLoadFailed ? "border-border" : "border-dashed border-border",
                                    )}
                                >
                                    <Avatar class="size-full rounded-[calc(var(--radius-xl)-1px)] bg-transparent">
                                        {#if iconPreview && !iconLoadFailed}
                                            <AvatarImage
                                                src={iconPreview}
                                                alt=""
                                                class="object-contain"
                                                onLoadingStatusChange={(status) => {
                                                    const source = iconPreview;
                                                    // Let Avatar finish mounting before a cached error removes it.
                                                    queueMicrotask(() => {
                                                        if (source === iconPreview) iconLoadFailed = status === "error";
                                                    });
                                                }}
                                            />
                                        {/if}
                                        <AvatarFallback class="rounded-none bg-transparent">
                                            <Boxes class="size-6 text-muted-foreground" aria-hidden="true" />
                                        </AvatarFallback>
                                    </Avatar>
                                    <span
                                        class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[calc(var(--radius-xl)-1px)] bg-background/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
                                        aria-hidden="true"
                                    >
                                        <Pencil class="size-4" />
                                    </span>
                                </MenuTrigger>
                                <MenuPopup align="start" class="min-w-44">
                                    <MenuItem onclick={openUploadDialog}>
                                        <Upload aria-hidden="true" />
                                        Upload image
                                    </MenuItem>
                                    <MenuItem onclick={openLinkDialog}>
                                        <Link aria-hidden="true" />
                                        Use link
                                    </MenuItem>
                                    {#if iconPreview}
                                        <MenuSeparator />
                                        <MenuItem variant="destructive" onclick={removeIcon}>
                                            <Trash2 aria-hidden="true" />
                                            Remove icon
                                        </MenuItem>
                                    {/if}
                                </MenuPopup>
                            </Menu>
                            <Field class="min-w-0 flex-1">
                                <Label for="resource-name" required>Name</Label>
                                <Input
                                    id="resource-name"
                                    bind:value={detailName}
                                    placeholder="My service"
                                    required
                                    maxlength={100}
                                    disabled={detailsMutation.isPending}
                                    aria-invalid={!isDetailsValid}
                                />
                                {#if !isDetailsValid}<FieldError>Name is required.</FieldError>{/if}
                            </Field>
                        </div>
                        <Field>
                            <Label for="resource-description">Description</Label>
                            <Textarea
                                id="resource-description"
                                bind:value={detailDescription}
                                placeholder="What is this resource for?"
                                maxlength={500}
                                rows={3}
                                disabled={detailsMutation.isPending}
                            />
                        </Field>
                        {#if detailsMutation.isError}
                            <Alert variant="error">
                                <AlertDescription>
                                    Unable to save: {detailsMutation.error.message}
                                </AlertDescription>
                            </Alert>
                        {/if}
                    </CardPanel>
                    <CardFooter class="justify-between gap-4 border-t px-5 py-4 sm:px-6">
                        <p class="min-w-0 truncate text-sm text-muted-foreground" aria-live="polite">
                            {#if detailsMutation.isPending}
                                Saving…
                            {:else if isDetailsDirty}
                                Unsaved changes
                            {:else if detailsMutation.isSuccess}
                                Saved.
                            {/if}
                        </p>
                        <div class="flex shrink-0 items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={!isDetailsDirty || detailsMutation.isPending}
                                onclick={resetDetails}
                            >
                                Reset
                            </Button>
                            <Button
                                size="sm"
                                loading={detailsMutation.isPending}
                                disabled={!isDetailsDirty || !isDetailsValid || detailsMutation.isPending}
                                onclick={saveDetails}
                            >
                                {detailsMutation.isPending ? "Saving…" : "Save changes"}
                            </Button>
                        </div>
                    </CardFooter>
                </Card>
            </div>
        </section>

        <section class="grid gap-5 md:grid-cols-3 md:gap-8" aria-labelledby="compose-settings-heading">
            <div>
                <h2 id="compose-settings-heading" class="text-lg font-semibold leading-tight tracking-tight">Compose settings</h2>
                <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Configure how names in this resource's Compose spec are handled.
                </p>
            </div>

            <div class="md:col-span-2">
                <Card>
                    <CardPanel class="p-5 sm:p-6">
                        <div class="flex items-center justify-between gap-6">
                            <Field class="min-w-0 gap-1">
                                <Label for="prefix-names">Prefix names</Label>
                                <FieldDescription id="prefix-names-description" class="leading-snug">
                                    Prefix service, network, and volume names in the Compose spec with this resource's name so they are unique across the cluster.
                                </FieldDescription>
                            </Field>
                            <Switch id="prefix-names" aria-describedby="prefix-names-description" bind:checked={prefixNames} />
                        </div>
                    </CardPanel>
                    <div aria-live="polite">
                        {#if saveMutation.isError || saveMutation.isPending || isDirty || saveMutation.isSuccess}
                            <CardFooter class="border-t px-5 py-3 sm:px-6">
                                {#if saveMutation.isError && failedValue === prefixNames}
                                    <Alert variant="error" class="py-2">
                                        <AlertDescription>
                                            Unable to save: {saveMutation.error.message}
                                        </AlertDescription>
                                        <AlertAction>
                                            <Button variant="link" size="sm" class="h-auto p-0" onclick={retrySave}>Retry</Button>
                                        </AlertAction>
                                    </Alert>
                                {:else}
                                    <p class="text-sm text-muted-foreground">
                                        {#if saveMutation.isPending}
                                        Saving…
                                        {:else if isDirty}
                                            Waiting to save…
                                        {:else if saveMutation.isSuccess}
                                            Saved.
                                        {/if}
                                    </p>
                                {/if}
                            </CardFooter>
                        {/if}
                    </div>
                </Card>
            </div>
        </section>
    {/if}
</div>

<Dialog bind:open={uploadOpen}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Upload icon</DialogTitle>
            <DialogDescription>Choose an image. Raster images are resized to 256px; SVGs are stored as-is.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="space-y-4">
                <div class="flex items-center gap-4">
                    <Avatar class="size-14 rounded-xl border border-border bg-transparent">
                        {#if uploadPreview}<AvatarImage src={uploadPreview} alt="" class="object-contain" />{/if}
                        <AvatarFallback class="rounded-none bg-muted/50">
                            <Boxes class="size-5 text-muted-foreground" aria-hidden="true" />
                        </AvatarFallback>
                    </Avatar>
                    <div class="min-w-0 flex-1 space-y-1">
                        <p class="truncate text-sm font-medium">{uploadFileName || "No file chosen"}</p>
                        <p class="text-sm text-muted-foreground">PNG, JPEG, GIF, or WebP up to 5 MB. SVG up to 256 KB.</p>
                    </div>
                </div>
                <Input
                    bind:ref={fileInput}
                    type="file"
                    accept="image/*,.svg"
                    class="sr-only"
                    aria-label="Choose an image file"
                    onchange={handleFileChange}
                />
                <Button variant="outline" size="sm" loading={uploadProcessing} onclick={() => fileInput?.click()}>
                    <Upload class="size-4" aria-hidden="true" />
                    {uploadProcessing ? "Reading…" : "Choose file"}
                </Button>
                {#if uploadError}
                    <Alert variant="error"><AlertDescription>{uploadError}</AlertDescription></Alert>
                {/if}
            </div>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={() => (uploadOpen = false)}>Cancel</Button>
            <Button disabled={!uploadPreview || uploadProcessing} onclick={confirmUpload}>Use icon</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

<Dialog bind:open={linkOpen}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Use icon link</DialogTitle>
            <DialogDescription>Paste a direct link to an image. It will be shown in the resource list.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="space-y-4">
                <div class="flex items-center gap-3">
                    <Avatar class="size-14 rounded-xl border border-border bg-transparent">
                        {#if linkDraft.trim() && isLinkValid}
                            <AvatarImage
                                src={linkDraft.trim()}
                                alt=""
                                class="object-contain"
                                onLoadingStatusChange={(status) => {
                                    linkError = status === "error" ? "Unable to load a preview for that URL." : "";
                                }}
                            />
                        {/if}
                        <AvatarFallback class="rounded-none bg-muted/50">
                            <Boxes class="size-5 text-muted-foreground" aria-hidden="true" />
                        </AvatarFallback>
                    </Avatar>
                    <Field class="flex-1">
                        <Label for="icon-link-url">Image URL</Label>
                        <Input
                            id="icon-link-url"
                            type="url"
                            bind:value={linkDraft}
                            placeholder="https://example.com/icon.png"
                            maxlength={2048}
                            aria-invalid={Boolean(linkError)}
                            oninput={() => (linkError = "")}
                        />
                        {#if linkError}<FieldError>{linkError}</FieldError>{/if}
                    </Field>
                </div>
            </div>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={() => (linkOpen = false)}>Cancel</Button>
            <Button disabled={!isLinkValid} onclick={confirmLink}>Use icon</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
