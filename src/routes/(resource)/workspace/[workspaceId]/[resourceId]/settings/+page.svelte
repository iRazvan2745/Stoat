<script lang="ts">
    import deleteIcon from "@ktibow/iconset-material-symbols/delete";
    import editIcon from "@ktibow/iconset-material-symbols/edit-outline";
    import linkIcon from "@ktibow/iconset-material-symbols/link";
    import uploadFileIcon from "@ktibow/iconset-material-symbols/upload";
    import warningIcon from "@ktibow/iconset-material-symbols/warning-outline";
    import {
        Button,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        MenuDivider,
        Snackbar,
        Switch,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import { onDestroy } from "svelte";

    import { getLatestSuccessfulDeployment } from "#lib/api/deployments.remote";
    import {
        listEnvironmentVariables,
        getPostgresConnection,
        getResource,
        listResourceContainers,
        listResourcesInWorkspace,
        streamResourceContainerLogs,
        updateResourceIdentity,
        updateResourceSettings,
    } from "#lib/api/resources.remote";
    import ResourceIcon from "#lib/components/resources/resource-icon.svelte";
    import {
        RESOURCE_ICON_ACCEPT,
        normalizeResourceIcon,
        resourceIconFromFile,
    } from "#lib/domain/resources/icon";
    import { MAX_RESOURCE_NAME_LENGTH } from "#lib/domain/resources/identity";
    import {
        parseResourceSettings,
        prefixChangeWarning,
        shouldPrefixResources,
    } from "#lib/domain/resources/settings";

    import ResourceTransferSettings from "./resource-transfer-settings.svelte";

    const SAVE_DEBOUNCE_MS = 400;

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const resourceQuery = getResource(params.resourceId);
    const svc = await resourceQuery;
    // svelte-ignore state_referenced_locally
    const latestDeploymentQuery = getLatestSuccessfulDeployment(
        params.resourceId
    );
    const latestDeployment = await latestDeploymentQuery;

    const initialShouldPrefix = shouldPrefixResources(
        parseResourceSettings(svc?.settings)
    );
    const deployedShouldPrefix = latestDeployment
        ? shouldPrefixResources(parseResourceSettings(latestDeployment.settings))
        : undefined;
    let shouldPrefix = $state(initialShouldPrefix);
    let lastSavedPrefix = $state(initialShouldPrefix);
    let name = $state(svc?.name ?? "");
    let icon = $state(svc?.icon ?? null);
    let lastSavedName = $state(svc?.name ?? "");
    let lastSavedIcon = $state(svc?.icon ?? null);
    let prefixSaveInFlight = false;
    let identitySaveInFlight = false;
    let prefixSaveTimeoutId = 0;
    let identitySaveTimeoutId = 0;
    let iconMenuOpen = $state(false);
    const uploadDialogOpen = useQueryState(
        "uploadIconDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    const urlDialogOpen = useQueryState(
        "iconUrlDialogOpen",
        parseAsBoolean.withDefault(false)
    );
    let iconUrlDraft = $state("");
    let uploadDraft = $state<string | null>(null);
    let uploadInput = $state<HTMLInputElement | undefined>();

    const slug = $derived(svc?.slug ?? svc?.id ?? "");
    const warning = $derived(
        prefixChangeWarning(shouldPrefix, deployedShouldPrefix)
    );
    const canRemoveIcon = $derived(Boolean(icon));

    const refreshAfterSave = [
        getResource,
        listResourceContainers,
        getPostgresConnection,
        listEnvironmentVariables,
        listResourcesInWorkspace,
        streamResourceContainerLogs,
    ] as const;

    const persistPrefix = async (next: boolean): Promise<void> => {
        if (!svc || prefixSaveInFlight || next === lastSavedPrefix) {
            return;
        }

        prefixSaveInFlight = true;
        let saved = false;

        try {
            await updateResourceSettings({
                resourceId: svc.id,
                settings: { shouldPrefix: next },
            }).updates(...refreshAfterSave);
            lastSavedPrefix = next;
            saved = true;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save settings"
            );
        } finally {
            prefixSaveInFlight = false;

            if (saved && shouldPrefix !== lastSavedPrefix) {
                void persistPrefix(shouldPrefix);
            }
        }
    };

    const schedulePrefixSave = (next: boolean): void => {
        clearTimeout(prefixSaveTimeoutId);

        if (next === lastSavedPrefix) {
            return;
        }

        prefixSaveTimeoutId = window.setTimeout(() => {
            void persistPrefix(next);
        }, SAVE_DEBOUNCE_MS);
    };

    const persistIdentity = async (): Promise<void> => {
        if (!svc || identitySaveInFlight) {
            return;
        }

        const nextName = name.trim();
        const nextIcon = icon;

        if (nextName === lastSavedName && nextIcon === lastSavedIcon) {
            return;
        }

        if (!nextName) {
            snackbar("Name is required");
            return;
        }

        identitySaveInFlight = true;
        let saved = false;

        try {
            await updateResourceIdentity({
                icon: nextIcon,
                name: nextName,
                resourceId: svc.id,
            }).updates(...refreshAfterSave);
            lastSavedName = nextName;
            lastSavedIcon = nextIcon;
            saved = true;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save resource"
            );
        } finally {
            identitySaveInFlight = false;

            if (
                saved &&
                (name.trim() !== lastSavedName || icon !== lastSavedIcon)
            ) {
                void persistIdentity();
            }
        }
    };

    const scheduleIdentitySave = (): void => {
        clearTimeout(identitySaveTimeoutId);

        if (name.trim() === lastSavedName && icon === lastSavedIcon) {
            return;
        }

        identitySaveTimeoutId = window.setTimeout(() => {
            void persistIdentity();
        }, SAVE_DEBOUNCE_MS);
    };

    const saveIdentityNow = (): void => {
        clearTimeout(identitySaveTimeoutId);
        void persistIdentity();
    };

    const applyIcon = (next: string | null): void => {
        icon = next;
        saveIdentityNow();
    };

    const closeIconMenu = (): void => {
        iconMenuOpen = false;
    };

    const openUploadDialog = (): void => {
        closeIconMenu();
        uploadDraft = null;
        void uploadDialogOpen.set(true);
    };

    const closeUploadDialog = (): void => {
        void uploadDialogOpen.set(false);
        uploadDraft = null;
    };

    const openUrlDialog = (): void => {
        closeIconMenu();
        iconUrlDraft = icon && !icon.startsWith("data:") ? icon : "";
        void urlDialogOpen.set(true);
    };

    const closeUrlDialog = (): void => {
        void urlDialogOpen.set(false);
        iconUrlDraft = "";
    };

    const onUploadFile = async (
        event: Event & { currentTarget: HTMLInputElement }
    ): Promise<void> => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";

        if (!file) {
            return;
        }

        try {
            uploadDraft = await resourceIconFromFile(file);
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Unable to read icon"
            );
        }
    };

    const saveUploadedIcon = (): void => {
        if (!uploadDraft) {
            return;
        }

        applyIcon(uploadDraft);
        closeUploadDialog();
    };

    const saveIconUrl = (): void => {
        try {
            const next = normalizeResourceIcon(iconUrlDraft);

            if (!next) {
                snackbar("Enter an image URL");
                return;
            }

            applyIcon(next);
            closeUrlDialog();
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Invalid icon URL"
            );
        }
    };

    const removeIcon = (): void => {
        closeIconMenu();
        applyIcon(null);
    };

    onDestroy(() => {
        clearTimeout(prefixSaveTimeoutId);
        clearTimeout(identitySaveTimeoutId);
    });
</script>

{#if svc}
    <div class="flex h-full min-h-0 flex-col gap-6">
        <header class="flex min-w-0 flex-col gap-1">
            <h1 class="m3-font-headline-small text-on-surface">Settings</h1>
            <p class="m3-font-body-medium text-on-surface-variant">
                Manage resource configuration and workspace placement.
            </p>
        </header>

        <div class="flex max-w-m flex-col gap-6">
            <section class="flex flex-col gap-3">
                <h2 class="m3-font-title-small text-on-surface">Resource</h2>

                <div class="identity-row flex min-w-0 flex-col items-start gap-3 m:flex-row">
                    <div class="relative shrink-0">
                        <button
                            type="button"
                            class="icon-trigger m3-layer group bg-surface-container-high text-on-surface relative grid size-16 place-items-center overflow-hidden rounded-lg border-0 p-0"
                            aria-label="Change resource icon"
                            aria-expanded={iconMenuOpen}
                            aria-haspopup="menu"
                            style="anchor-name: --m3-menu-anchor"
                            onclick={() => (iconMenuOpen = !iconMenuOpen)}
                        >
                            <ResourceIcon
                                {icon}
                                type={svc.type}
                                size={48}
                                alt=""
                            />
                            <span
                                class="bg-scrim/32 text-surface absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                aria-hidden="true"
                            >
                                <Icon icon={editIcon} size={20} />
                            </span>
                        </button>

                        {#if iconMenuOpen}
                            <ExpressiveMenu
                                anchored
                                x="start"
                                y="down"
                                label="Resource icon"
                            >
                                <ExpressiveMenuItem
                                    leadingIcon={uploadFileIcon}
                                    label="Upload image"
                                    onclick={openUploadDialog}
                                />
                                <ExpressiveMenuItem
                                    leadingIcon={linkIcon}
                                    label="Set URL"
                                    onclick={openUrlDialog}
                                />
                                {#if canRemoveIcon}
                                    <MenuDivider />
                                    <ExpressiveMenuItem
                                        leadingIcon={deleteIcon}
                                        label="Remove icon"
                                        onclick={removeIcon}
                                    />
                                {/if}
                            </ExpressiveMenu>
                        {/if}
                    </div>

                    <div class="flex min-w-0 flex-1 flex-col gap-2">
                        <div
                            class="min-w-0 [&_.m3-container]:w-full [&_.m3-container]:min-w-0"
                        >
                            <TextFieldOutlined
                                bind:value={
                                    () => name,
                                    (next) => {
                                        name = next;
                                        scheduleIdentitySave();
                                    }
                                }
                                label="Name"
                                required
                                maxlength={MAX_RESOURCE_NAME_LENGTH}
                                onblur={saveIdentityNow}
                            />
                        </div>

                        {#if slug}
                            <p
                                class="m3-font-label-small text-on-surface-variant truncate font-mono"
                            >
                                {slug}
                            </p>
                        {/if}
                    </div>
                </div>
            </section>

            <section class="flex flex-col gap-3">
                <h2 class="m3-font-title-small text-on-surface">Deploy</h2>

                <label class="flex items-center gap-3">
                    <Switch
                        bind:checked={
                            () => shouldPrefix,
                            (next) => {
                                shouldPrefix = next;
                                schedulePrefixSave(next);
                            }
                        }
                    />
                    <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="m3-font-body-large text-on-surface">
                            Prefix compose services
                        </span>
                        <span
                            class="m3-font-body-small text-on-surface-variant"
                        >
                            {shouldPrefix && slug
                                ? `On the next deploy, services and volumes are named ${slug}-<name>.`
                                : "On the next deploy, compose service and volume names are used as written."}
                        </span>
                    </span>
                </label>

                {#if warning}
                    <div
                        class="bg-tertiary-container-subtle text-on-tertiary-container-subtle flex items-start gap-3 rounded-xl px-4 py-3"
                        role="status"
                    >
                        <span class="mt-0.5 shrink-0">
                            <Icon icon={warningIcon} size={20} />
                        </span>
                        <p class="m3-font-body-small">{warning}</p>
                    </div>
                {/if}
            </section>
        </div>

        <ResourceTransferSettings
            resourceId={svc.id}
            workspaceId={params.workspaceId}
        />
    </div>
{/if}

<Dialog
    bind:open={uploadDialogOpen.current}
    headline="Upload icon"
    onclose={closeUploadDialog}
>
    <div class="flex flex-col items-start gap-4">
        <input
            bind:this={uploadInput}
            type="file"
            class="sr-only"
            accept={RESOURCE_ICON_ACCEPT}
            onchange={onUploadFile}
        />

        <div
            class="bg-surface-container-high text-on-surface grid size-20 place-items-center overflow-hidden rounded-lg"
        >
            <ResourceIcon icon={uploadDraft} type={svc?.type} size={56} alt="" />
        </div>

        <p class="m3-font-body-small text-on-surface-variant">
            PNG, JPEG, GIF, WebP, or SVG. 256 KB max.
        </p>

        <Button
            variant="tonal"
            iconType="left"
            onclick={() => uploadInput?.click()}
        >
            <Icon icon={uploadFileIcon} size={18} />
            Choose image
        </Button>
    </div>

    {#snippet buttons()}
        <Button variant="text" type="button" onclick={closeUploadDialog}
            >Cancel</Button
        >
        <Button type="button" disabled={!uploadDraft} onclick={saveUploadedIcon}
            >Save</Button
        >
    {/snippet}
</Dialog>

<Dialog
    bind:open={urlDialogOpen.current}
    headline="Icon URL"
    onclose={closeUrlDialog}
>
    <div class="flex flex-col gap-4 [&_.m3-container]:w-full">
        <TextFieldOutlined
            bind:value={iconUrlDraft}
            label="URL"
            placeholder="https://example.com/icon.svg"
            enter={saveIconUrl}
        />
    </div>

    {#snippet buttons()}
        <Button variant="text" type="button" onclick={closeUrlDialog}
            >Cancel</Button
        >
        <Button
            type="button"
            disabled={!iconUrlDraft.trim()}
            onclick={saveIconUrl}
        >
            Save
        </Button>
    {/snippet}
</Dialog>

<Snackbar />

<style>
    .icon-trigger {
        @apply --m3-focus-inward;
    }
</style>
