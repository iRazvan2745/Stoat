<script lang="ts">
    import editIcon from "@ktibow/iconset-material-symbols/edit-outline";
    import warningIcon from "@ktibow/iconset-material-symbols/warning-outline";
    import {
        Button,
        Icon,
        Snackbar,
        Switch,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { onDestroy } from "svelte";

    import { getLatestSuccessfulDeployment } from "#lib/api/deployments.remote";
    import {
        getEnvironmentVariables,
        getPostgresConnection,
        getService,
        getServiceContainerLogs,
        getServiceContainers,
        getServicesInWorkspace,
        updateServiceIdentity,
        updateServiceSettings,
    } from "#lib/api/services.remote";
    import {
        SERVICE_ICON_ACCEPT,
        serviceIconFromFile,
    } from "#lib/service/icon";
    import ServiceIcon from "#lib/service/icon.svelte";
    import { MAX_SERVICE_NAME_LENGTH } from "#lib/service/identity";
    import {
        parseServiceSettings,
        prefixChangeWarning,
        shouldPrefixServices,
    } from "#lib/service/settings";

    const SAVE_DEBOUNCE_MS = 400;

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const serviceQuery = getService(params.serviceId);
    const svc = await serviceQuery;
    // svelte-ignore state_referenced_locally
    const latestDeploymentQuery = getLatestSuccessfulDeployment(
        params.serviceId
    );
    const latestDeployment = await latestDeploymentQuery;

    const initialShouldPrefix = shouldPrefixServices(
        parseServiceSettings(svc?.settings)
    );
    const deployedShouldPrefix = latestDeployment
        ? shouldPrefixServices(parseServiceSettings(latestDeployment.settings))
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

    const slug = $derived(svc?.slug ?? svc?.id ?? "");
    const warning = $derived(
        prefixChangeWarning(shouldPrefix, deployedShouldPrefix)
    );
    const canRemoveIcon = $derived(Boolean(icon));

    const refreshAfterSave = [
        getService,
        getServiceContainers,
        getPostgresConnection,
        getEnvironmentVariables,
        getServicesInWorkspace,
        getServiceContainerLogs,
    ] as const;

    const persistPrefix = async (next: boolean): Promise<void> => {
        if (!svc || prefixSaveInFlight || next === lastSavedPrefix) {
            return;
        }

        prefixSaveInFlight = true;

        try {
            await updateServiceSettings({
                serviceId: svc.id,
                settings: { shouldPrefix: next },
            }).updates(...refreshAfterSave);
            lastSavedPrefix = next;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save settings"
            );
        } finally {
            prefixSaveInFlight = false;

            if (shouldPrefix !== lastSavedPrefix) {
                void persistPrefix(shouldPrefix);
            }
        }
    };

    const schedulePrefixSave = (next: boolean): void => {
        window.clearTimeout(prefixSaveTimeoutId);

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

        try {
            await updateServiceIdentity({
                icon: nextIcon,
                name: nextName,
                serviceId: svc.id,
            }).updates(...refreshAfterSave);
            lastSavedName = nextName;
            lastSavedIcon = nextIcon;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save service"
            );
        } finally {
            identitySaveInFlight = false;

            if (name.trim() !== lastSavedName || icon !== lastSavedIcon) {
                void persistIdentity();
            }
        }
    };

    const scheduleIdentitySave = (): void => {
        window.clearTimeout(identitySaveTimeoutId);

        if (name.trim() === lastSavedName && icon === lastSavedIcon) {
            return;
        }

        identitySaveTimeoutId = window.setTimeout(() => {
            void persistIdentity();
        }, SAVE_DEBOUNCE_MS);
    };

    const saveIdentityNow = (): void => {
        window.clearTimeout(identitySaveTimeoutId);
        void persistIdentity();
    };

    const onIconFile = async (
        event: Event & { currentTarget: HTMLInputElement }
    ): Promise<void> => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";

        if (!file) {
            return;
        }

        try {
            icon = await serviceIconFromFile(file);
            saveIdentityNow();
        } catch (error) {
            snackbar(
                error instanceof Error ? error.message : "Unable to read icon"
            );
        }
    };

    const removeIcon = (): void => {
        icon = null;
        saveIdentityNow();
    };

    onDestroy(() => {
        window.clearTimeout(prefixSaveTimeoutId);
        window.clearTimeout(identitySaveTimeoutId);
    });
</script>

{#if svc}
    <div class="flex h-full min-h-0 flex-col gap-6">
        <header class="flex min-w-0 flex-col gap-1">
            <h1 class="m3-font-headline-small text-on-surface">Settings</h1>
            <p class="m3-font-body-medium text-on-surface-variant">
                Name, icon, and options that apply on the next deploy.
            </p>
        </header>

        <div class="flex max-w-xl flex-col gap-6">
            <section class="flex flex-col gap-3">
                <h2 class="m3-font-title-small text-on-surface">Service</h2>

                <div class="flex items-start gap-3">
                    <label
                        class="group bg-surface-container-high text-on-surface focus-within:outline-primary relative grid size-16 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-lg focus-within:outline-2 focus-within:outline-offset-2"
                    >
                        <span class="sr-only">Change service icon</span>
                        <input
                            type="file"
                            class="sr-only"
                            accept={SERVICE_ICON_ACCEPT}
                            onchange={onIconFile}
                        />
                        <ServiceIcon {icon} type={svc.type} size={48} alt="" />
                        <span
                            class="bg-on-surface/50 text-surface absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                            aria-hidden="true"
                        >
                            <Icon icon={editIcon} size={20} />
                        </span>
                    </label>

                    <div class="flex min-w-0 flex-1 flex-col gap-2">
                        <div class="[&_.m3-container]:w-full">
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
                                maxlength={MAX_SERVICE_NAME_LENGTH}
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

                        {#if canRemoveIcon}
                            <div>
                                <Button variant="text" size="s" onclick={removeIcon}>
                                    Remove icon
                                </Button>
                            </div>
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
                        <span class="m3-font-body-small text-on-surface-variant">
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
    </div>
{/if}

<Snackbar />
