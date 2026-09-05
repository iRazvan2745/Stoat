<script lang="ts">
    import folderIcon from "@ktibow/iconset-material-symbols/folder-outline";
    import {
        Button,
        Chip,
        Dialog,
        Icon,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";

    import {
        updateServiceGroup,
        updateServiceGroupName,
    } from "#lib/api/service-groups.remote";
    import ServiceIcon from "#lib/components/services/service-icon.svelte";
    import { groupServices } from "#lib/domain/services/groups";

    interface Service {
        id: string;
        name: string | null;
        slug: string | null;
        icon: string | null;
        type: string | null;
        groupName: string | null;
    }
    let {
        services,
        workspaceId,
    }: { services: Service[]; workspaceId: string } = $props();
    const groups = $derived(groupServices(services));
    let selectedService = $state<Service | null>(null);
    let originalName = $state<string | null>(null);
    let name = $state("");
    let editorOpen = $state(false);
    let removeOpen = $state(false);
    let saving = $state(false);
    let errorMessage = $state("");
    const merging = $derived(
        !selectedService &&
            name.trim() !== originalName &&
            groups.some((group) => group.name === name.trim())
    );

    const editService = (service: Service): void => {
        selectedService = service;
        originalName = null;
        name = service.groupName ?? "";
        errorMessage = "";
        editorOpen = true;
    };
    const editGroup = (groupName: string, removing = false): void => {
        selectedService = null;
        originalName = groupName;
        name = groupName;
        errorMessage = "";
        if (removing) {
            removeOpen = true;
        } else {
            editorOpen = true;
        }
    };
    const save = async (remove = false): Promise<void> => {
        if (saving) {
            return;
        }
        const groupName = remove ? null : name.trim();
        if (groupName !== null && (!groupName || groupName.length > 80)) {
            errorMessage = "Enter a group name with 1–80 characters.";
            return;
        }
        saving = true;
        errorMessage = "";
        try {
            if (selectedService) {
                await updateServiceGroup({
                    groupName,
                    serviceId: selectedService.id,
                    workspaceId,
                });
            } else if (originalName) {
                await updateServiceGroupName({
                    groupName: originalName,
                    newGroupName: groupName,
                    workspaceId,
                });
            }
            editorOpen = false;
            removeOpen = false;
            snackbar(
                remove ? "Services moved to Ungrouped" : "Service group saved"
            );
        } catch (error) {
            errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unable to save group. Try again.";
        } finally {
            saving = false;
        }
    };
</script>

<div class="service-groups">
    {#each groups as group (group.name)}
        <section aria-label={group.name ?? "Ungrouped"}>
            <div class="group-heading">
                <h2>{group.name ?? "Ungrouped"}</h2>
                <span class="count"
                    >{group.services.length}
                    {group.services.length === 1 ? "service" : "services"}</span
                >
                {#if group.name !== null}
                    <div class="group-actions">
                        <Button
                            variant="text"
                            aria-label={`Rename ${group.name}`}
                            onclick={() => editGroup(group.name ?? "")}
                            >Rename</Button
                        >
                        <Button
                            variant="text"
                            aria-label={`Ungroup services in ${group.name}`}
                            onclick={() => editGroup(group.name ?? "", true)}
                            >Ungroup</Button
                        >
                    </div>
                {/if}
            </div>
            <ul class="service-list">
                {#each group.services as service (service.id)}
                    <li>
                        <a
                            class="service-link m3-layer"
                            href={`/workspace/${workspaceId}/${service.id}`}
                        >
                            <span class="service-icon"
                                ><ServiceIcon
                                    icon={service.icon}
                                    type={service.type}
                                    size={24}
                                    alt=""
                                /></span
                            >
                            <span class="service-text"
                                ><span class="service-name"
                                    >{service.name ?? "Untitled"}</span
                                ><span class="service-slug"
                                    >{service.slug ?? ""}</span
                                ></span
                            >
                        </a>
                        <Button
                            variant="text"
                            iconType="full"
                            aria-label={`Change group for ${service.name ?? "Untitled"}`}
                            title="Change service group"
                            onclick={() => editService(service)}
                        >
                            <Icon icon={folderIcon} />
                        </Button>
                    </li>
                {/each}
            </ul>
        </section>
    {/each}
</div>

<Dialog
    bind:open={editorOpen}
    headline={selectedService ? "Change service group" : "Rename group"}
>
    <form
        id="service-group-form"
        class="group-form"
        onsubmit={(event) => {
            event.preventDefault();
            void save();
        }}
    >
        <p>
            {selectedService
                ? `Organize ${selectedService.name ?? "this service"} with related services. Choose an existing group or enter a new name.`
                : "Give this group a descriptive name."}
        </p>
        <TextFieldOutlined
            label="Group name"
            bind:value={name}
            maxlength={80}
            required
            disabled={saving}
            error={Boolean(errorMessage)}
            aria-describedby={errorMessage ? "service-group-error" : undefined}
        />
        {#if selectedService && groups.some((group) => group.name !== null)}
            <div class="group-choices" aria-label="Existing groups">
                {#each groups as group (group.name)}
                    {#if group.name !== null}
                        <Chip
                            variant="general"
                            type="button"
                            disabled={saving}
                            aria-pressed={name === group.name}
                            selected={name === group.name}
                            onclick={() => {
                                name = group.name ?? "";
                            }}>{group.name}</Chip
                        >
                    {/if}
                {/each}
            </div>
        {/if}
        {#if merging}<p>
                Services will be combined with the existing “{name.trim()}”
                group.
            </p>{/if}
        {#if errorMessage}<p
                id="service-group-error"
                class="error"
                role="alert"
            >
                {errorMessage}
            </p>{/if}
    </form>
    {#snippet buttons()}
        {#if selectedService?.groupName}
            <Button variant="text" disabled={saving} onclick={() => save(true)}
                >Ungroup</Button
            >
        {/if}
        <Button
            variant="text"
            disabled={saving}
            onclick={() => {
                editorOpen = false;
            }}>Cancel</Button
        >
        <Button
            variant="text"
            type="submit"
            form="service-group-form"
            disabled={saving || !name.trim()}
            >{saving ? "Saving…" : "Save"}</Button
        >
    {/snippet}
</Dialog>

<Dialog bind:open={removeOpen} headline="Ungroup services?">
    <p>
        All services in “{originalName}” will move to Ungrouped. The group will
        disappear. Your services will keep running.
    </p>
    {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
    {#snippet buttons()}
        <Button
            variant="text"
            disabled={saving}
            onclick={() => {
                removeOpen = false;
            }}>Cancel</Button
        >
        <Button variant="text" disabled={saving} onclick={() => save(true)}
            >{saving ? "Saving…" : "Ungroup"}</Button
        >
    {/snippet}
</Dialog>

<style>
    .service-groups {
        display: grid;
        gap: 24px;
        padding-block: 16px;
    }
    section {
        min-width: 0;
    }
    .group-heading {
        display: flex;
        align-items: center;
        gap: 16px;
        min-height: 56px;
        padding-inline: 16px 8px;
    }
    h2 {
        @apply --m3-title-medium;
        color: var(--m3c-on-surface);
        overflow-wrap: anywhere;
        margin: 0;
    }
    .count {
        @apply --m3-label-medium;
        color: var(--m3c-on-surface-variant);
        white-space: nowrap;
    }
    .group-actions {
        display: flex;
        margin-inline-start: auto;
    }
    .service-list {
        list-style: none;
        margin: 0;
        padding: 8px 0;
        background: var(--m3c-surface-container-low);
        border-radius: var(--m3-shape-medium);
    }
    li {
        display: flex;
        align-items: center;
        padding-inline-end: 8px;
        min-width: 0;
    }
    .service-link {
        @apply --m3-focus-inward;
        display: flex;
        align-items: center;
        gap: 16px;
        min-height: 72px;
        padding: 8px 16px;
        text-decoration: none;
        color: var(--m3c-on-surface);
        flex: 1;
        min-width: 0;
    }
    .service-text {
        display: grid;
        min-width: 0;
    }
    .service-name {
        @apply --m3-body-large;
        overflow-wrap: anywhere;
    }
    .service-slug {
        @apply --m3-body-medium;
        color: var(--m3c-on-surface-variant);
        overflow-wrap: anywhere;
    }
    .service-icon {
        flex-shrink: 0;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: var(--m3-shape-medium);
        background: var(--m3c-surface-container-high);
        color: var(--m3c-on-surface);
    }
    .group-form {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
    p {
        @apply --m3-body-medium;
        color: var(--m3c-on-surface-variant);
        margin: 0;
    }
    .group-choices {
        max-height: 192px;
        overflow-y: auto;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }
    .group-choices :global(button) {
        max-width: 100%;
        height: auto;
        min-height: 48px;
        white-space: normal;
        overflow-wrap: anywhere;
    }
    li > :global(button),
    .group-actions :global(button) {
        min-width: 48px;
        min-height: 48px;
    }
    .error {
        color: var(--m3c-error);
    }
    @media (max-width: 599px) {
        .group-heading {
            flex-wrap: wrap;
            gap: 8px;
        }
    }
</style>
