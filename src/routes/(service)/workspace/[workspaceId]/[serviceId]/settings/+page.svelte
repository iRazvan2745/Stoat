<script lang="ts">
    import warningIcon from "@ktibow/iconset-material-symbols/warning-outline";
    import { Icon, Snackbar, Switch, snackbar } from "m3-svelte";

    import { getLatestSuccessfulDeployment } from "#lib/api/deployments.remote";
    import {
        getEnvironmentVariables,
        getPostgresConnection,
        getService,
        getServiceContainerLogs,
        getServiceContainers,
        getServicesInWorkspace,
        updateServiceSettings,
    } from "#lib/api/services.remote";
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
    let lastSaved = $state(initialShouldPrefix);
    let saveInFlight = false;

    const slug = $derived(svc?.slug ?? svc?.id ?? "");
    const warning = $derived(
        prefixChangeWarning(shouldPrefix, deployedShouldPrefix)
    );

    const persist = async (next: boolean): Promise<void> => {
        if (!svc || saveInFlight || next === lastSaved) {
            return;
        }

        saveInFlight = true;

        try {
            await updateServiceSettings({
                serviceId: svc.id,
                settings: { shouldPrefix: next },
            }).updates(
                getService,
                getServiceContainers,
                getPostgresConnection,
                getEnvironmentVariables,
                getServicesInWorkspace,
                getServiceContainerLogs
            );
            lastSaved = next;
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save settings"
            );
        } finally {
            saveInFlight = false;

            if (shouldPrefix !== lastSaved) {
                void persist(shouldPrefix);
            }
        }
    };

    $effect(() => {
        const next = shouldPrefix;

        if (next === lastSaved) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            void persist(next);
        }, SAVE_DEBOUNCE_MS);

        return (): void => {
            window.clearTimeout(timeoutId);
        };
    });
</script>

{#if svc}
    <div class="flex h-full min-h-0 flex-col gap-4">
        <header class="flex min-w-0 flex-col gap-1">
            <h1 class="text-on-surface text-xl font-medium">Settings</h1>
            <p class="text-on-surface-variant text-sm">
                Service options that apply on the next deploy.
            </p>
        </header>

        <div class="flex max-w-xl flex-col gap-3">
            <label class="flex items-center gap-3">
                <Switch bind:checked={shouldPrefix} />
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
                    <p class="text-sm">{warning}</p>
                </div>
            {/if}
        </div>
    </div>
{/if}

<Snackbar />
