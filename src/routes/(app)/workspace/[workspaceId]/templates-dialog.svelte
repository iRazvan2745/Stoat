<script lang="ts">
    import {
        Button,
        Chip,
        Dialog,
        LoadingIndicator,
        TextField,
        snackbar,
    } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import { createServiceFromTemplate } from "#lib/api/services.remote";
    import { getTemplates } from "#lib/api/templates.remote";
    import type { ServiceTemplate } from "#lib/templates";

    import TemplateCard from "./template-card.svelte";

    interface Props {
        oncreated: () => Promise<void> | void;
        open: boolean;
        workspaceId: string;
    }

    let { oncreated, open = $bindable(false), workspaceId }: Props = $props();

    const templatesQuery = getTemplates();

    const selectedAppId = useQueryState(
        "selectedTemplate",
        parseAsString.withDefault("")
    );
    const selectedVersion = useQueryState(
        "selectedTemplateVersion",
        parseAsString.withDefault("")
    );
    let serviceName = $state("");
    let submitting = $state(false);

    const templates = $derived(templatesQuery.current ?? []);
    const selectedTemplate = $derived(
        templates.find((template) => template.appId === selectedAppId.current)
    );
    const resolvedServiceName = $derived(
        serviceName.trim() || selectedTemplate?.name.trim() || ""
    );
    const resolvedVersion = $derived(
        selectedTemplate?.versions.some(
            (version) => version.version === selectedVersion.current
        )
            ? selectedVersion.current
            : (selectedTemplate?.versions[0]?.version ?? "")
    );

    const selectTemplate = (template: ServiceTemplate): void => {
        selectedAppId.current = template.appId;
        selectedVersion.current = template.versions[0]?.version ?? "";
        serviceName = template.name;
    };

    const close = (): void => {
        open = false;
        submitting = false;
        selectedAppId.set("");
        selectedVersion.set("");
        serviceName = "";
    };

    const create = async (): Promise<void> => {
        if (
            !selectedAppId.current ||
            !resolvedVersion ||
            !resolvedServiceName ||
            submitting
        ) {
            return;
        }

        submitting = true;

        try {
            await createServiceFromTemplate({
                appId: selectedAppId.current,
                name: resolvedServiceName,
                version: resolvedVersion,
                workspaceId,
            });
            close();
            snackbar("Service created");
            await oncreated();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create service from template"
            );
        } finally {
            submitting = false;
        }
    };
</script>

<div class="max-w-none">
    <Dialog
        bind:open
        headline="Templates"
        id="templates-dialog"
        onclose={close}
    >
        {#if templatesQuery.loading}
            <div class="flex min-h-40 items-center justify-center">
                <LoadingIndicator aria-label="Loading templates" />
            </div>
        {:else if templatesQuery.error}
            <p class="text-error text-sm">{templatesQuery.error.message}</p>
        {:else if templates.length === 0}
            <p class="text-on-surface-variant text-sm">
                No templates found in /templates.
            </p>
        {:else}
            <div class="flex flex-col gap-4">
                <div class="template-grid">
                    {#each templates as template (template.appId)}
                        <TemplateCard
                            {template}
                            selected={selectedAppId.current === template.appId}
                            onclick={() => selectTemplate(template)}
                        />
                    {/each}
                </div>

                {#if selectedTemplate}
                    <div class="flex flex-col gap-3">
                        {#if selectedTemplate.versions.length > 1}
                            <div class="flex flex-wrap items-center gap-2">
                                <p class="text-on-surface-variant text-sm">
                                    Version
                                </p>
                                {#each selectedTemplate.versions as version (version.version)}
                                    <Chip
                                        variant="general"
                                        selected={resolvedVersion ===
                                            version.version}
                                        onclick={() =>
                                            selectedVersion.set(
                                                version.version
                                            )}
                                    >
                                        {version.version}
                                    </Chip>
                                {/each}
                            </div>
                        {/if}

                        <TextField
                            bind:value={serviceName}
                            label="Name"
                            required
                            placeholder={selectedTemplate.name}
                        />
                    </div>
                {/if}
            </div>
        {/if}

        {#snippet buttons()}
            <Button variant="text" onclick={close}>Cancel</Button>
            <Button
                disabled={submitting ||
                    !selectedAppId.current ||
                    !resolvedVersion ||
                    !resolvedServiceName}
                onclick={create}
            >
                {#if submitting}
                    <LoadingIndicator
                        size={18}
                        center={false}
                        aria-label="Creating service"
                    />
                    Adding...
                {:else}
                    Add
                {/if}
            </Button>
        {/snippet}
    </Dialog>
</div>

<style>
    :global(#templates-dialog.m3-container) {
        width: min(68rem, calc(100vw - 2rem));
        max-width: none;
        max-height: min(48rem, calc(100vh - 4rem));
    }

    .template-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr));
        gap: 0.75rem;
    }
</style>
