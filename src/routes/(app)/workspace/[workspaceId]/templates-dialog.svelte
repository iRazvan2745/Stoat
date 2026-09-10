<script lang="ts">
    import {
        Button,
        Chip,
        Dialog,
        LoadingIndicator,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    import { createResourceFromTemplate } from "#lib/api/resources.remote";
    import { listTemplates } from "#lib/api/templates.remote";
    import type { ResourceTemplate } from "#lib/domain/templates";

    import TemplateCard from "./template-card.svelte";

    interface Props {
        oncreated: () => Promise<void> | void;
        open: boolean;
        workspaceId: string;
    }

    let { oncreated, open = $bindable(false), workspaceId }: Props = $props();

    const templatesQuery = listTemplates();

    const selectedAppId = useQueryState(
        "selectedTemplate",
        parseAsString.withDefault("")
    );
    const selectedVersion = useQueryState(
        "selectedTemplateVersion",
        parseAsString.withDefault("")
    );
    let resourceName = $state("");
    let submitting = $state(false);

    const templates = $derived(templatesQuery.current ?? []);
    const selectedTemplate = $derived(
        templates.find((template) => template.appId === selectedAppId.current)
    );
    const resolvedResourceName = $derived(
        resourceName.trim() || selectedTemplate?.name.trim() || ""
    );
    const resolvedVersion = $derived(
        selectedTemplate?.versions.some(
            (version) => version.version === selectedVersion.current
        )
            ? selectedVersion.current
            : (selectedTemplate?.versions[0]?.version ?? "")
    );

    const selectTemplate = (template: ResourceTemplate): void => {
        selectedAppId.current = template.appId;
        selectedVersion.current = template.versions[0]?.version ?? "";
        resourceName = template.name;
    };

    const close = (): void => {
        open = false;
        submitting = false;
        selectedAppId.set("");
        selectedVersion.set("");
        resourceName = "";
    };

    const create = async (): Promise<void> => {
        if (
            !selectedAppId.current ||
            !resolvedVersion ||
            !resolvedResourceName ||
            submitting
        ) {
            return;
        }

        submitting = true;

        try {
            await createResourceFromTemplate({
                appId: selectedAppId.current,
                name: resolvedResourceName,
                version: resolvedVersion,
                workspaceId,
            });
            close();
            snackbar("Resource created");
            await oncreated();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to create resource from template"
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
            <p class="text-error m3-font-body-medium">{templatesQuery.error.message}</p>
        {:else if templates.length === 0}
            <p class="text-on-surface-variant m3-font-body-medium">
                No templates found in /templates.
            </p>
        {:else}
            <div class="flex flex-col gap-4">
                <div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15.5rem,1fr))]">
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
                                <p class="text-on-surface-variant m3-font-body-medium">
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

                        <TextFieldOutlined
                            bind:value={resourceName}
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
                    !resolvedResourceName}
                onclick={create}
            >
                {#if submitting}
                    <LoadingIndicator
                        size={18}
                        center={false}
                        aria-label="Creating resource"
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
</style>
