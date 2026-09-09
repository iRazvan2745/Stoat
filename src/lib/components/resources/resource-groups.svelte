<script lang="ts">
    import editIcon from "@ktibow/iconset-material-symbols/edit";
    import expandIcon from "@ktibow/iconset-material-symbols/expand";
    import folderOffIcon from "@ktibow/iconset-material-symbols/folder-off";
    import folderIcon from "@ktibow/iconset-material-symbols/folder-outline";
    import moreVertIcon from "@ktibow/iconset-material-symbols/more-vert";
    import tuneIcon from "@ktibow/iconset-material-symbols/tune";
    import {
        Button,
        Chip,
        Dialog,
        ExpressiveMenu,
        ExpressiveMenuItem,
        Icon,
        TextFieldOutlined,
        snackbar,
    } from "m3-svelte";

    import {
        updateResourceGroup,
        updateResourceGroupName,
        updateResourcePosition,
    } from "#lib/api/resource-groups.remote";
    import { getUserSettings, updateUserSettings } from "#lib/api/users.remote";
    import ResourceIcon from "#lib/components/resources/resource-icon.svelte";
    import {
        toResourceFlow,
        type ResourceFlowItem,
    } from "#lib/domain/resources/groups";

    interface Resource {
        id: string;
        name: string | null;
        slug: string | null;
        icon: string | null;
        type: string | null;
        groupName: string | null;
    }
    let {
        resources,
        workspaceId,
    }: { resources: Resource[]; workspaceId: string } = $props();

    // svelte-ignore state_referenced_locally
    const userSettings = getUserSettings();
    const showFolderResourceNames = $derived(
        userSettings.current?.showFolderResourceNames !== false
    );
    const flow = $derived(toResourceFlow(resources));
    type GroupItem = Extract<ResourceFlowItem<Resource>, { kind: "group" }>;
    let folderDialogOpen = $state(false);
    let dialogFolder = $state<string | null>(null);
    const dialogItem = $derived(
        dialogFolder === null
            ? null
            : (flow.find(
                      (item): item is GroupItem =>
                          item.kind === "group" && item.name === dialogFolder,
                  ) ?? null),
    );
    let selectedResource = $state<Resource | null>(null);
    let originalName = $state<string | null>(null);
    let name = $state("");
    let editorOpen = $state(false);
    let removeOpen = $state(false);
    let saving = $state(false);
    let errorMessage = $state("");
    let menuOpenGroup = $state<string | null>(null);
    const merging = $derived(
        !selectedResource &&
            name.trim() !== originalName &&
            flow.some(
                (item) => item.kind === "group" && item.name === name.trim()
            )
    );

    const editResource = (resource: Resource): void => {
        selectedResource = resource;
        originalName = null;
        name = resource.groupName ?? "";
        errorMessage = "";
        editorOpen = true;
    };
    const editGroup = (groupName: string, removing = false): void => {
        selectedResource = null;
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
            if (selectedResource) {
                await updateResourceGroup({
                    groupName,
                    resourceId: selectedResource.id,
                    workspaceId,
                });
            } else if (originalName) {
                await updateResourceGroupName({
                    groupName: originalName,
                    newGroupName: groupName,
                    workspaceId,
                });
            }
            editorOpen = false;
            removeOpen = false;
            snackbar(
                remove ? "Resources moved to Ungrouped" : "Resource group saved"
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

    type DropTarget =
        | { kind: "before"; resource: Resource }
        | { kind: "group"; name: string }
        | { kind: "ungroup" };

    let dragging = $state<Resource | null>(null);
    let dropTarget = $state<DropTarget | null>(null);

    let zoomFrom: DOMRect | null = null;

    const reducedMotion = (): boolean =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const m3Token = (name: string): string =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const m3Duration = (name: string, fallbackMs: number): number => {
        const raw = m3Token(name);

        const ms = raw.match(/([\d.]+)\s*ms/u);
        if (ms) {
            return Number(ms[1]);
        }

        const seconds = raw.match(/([\d.]+)\s*s/u);
        if (seconds) {
            return Number(seconds[1]) * 1000;
        }

        return fallbackMs;
    };

    const m3Easing = (name: string, fallback: string): string =>
        m3Token(name) || fallback;

    const zoomMotion = (opening: boolean): { duration: number; easing: string } =>
        opening
            ? {
                  duration: m3Duration("--m3-duration-slow-spatial", 500),
                  easing: m3Easing(
                      "--m3-timing-function-slow-spatial",
                      "cubic-bezier(0.05, 0.7, 0.1, 1)",
                  ),
              }
            : {
                  duration: m3Duration("--m3-duration-fast", 200),
                  easing: m3Easing(
                      "--m3-timing-function-fast",
                      "cubic-bezier(0.3, 0, 0.8, 0.15)",
                  ),
              };

    const zoomDelta = (
        from: DOMRect,
        to: DOMRect,
    ): { dx: number; dy: number; sx: number; sy: number } => ({
        dx: from.left + from.width / 2 - (to.left + to.width / 2),
        dy: from.top + from.height / 2 - (to.top + to.height / 2),
        sx: from.width / to.width,
        sy: from.height / to.height,
    });

    const openFolderDialog = (name: string, box: HTMLElement | null): void => {
        zoomFrom = box?.getBoundingClientRect() ?? null;
        dialogFolder = name;
        folderDialogOpen = true;
        if (reducedMotion() || !zoomFrom) {
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const dialog =
                    document.querySelector<HTMLDialogElement>("#folder-dialog");
                if (!dialog?.open || !zoomFrom) {
                    return;
                }
                const { dx, dy, sx, sy } = zoomDelta(
                    zoomFrom,
                    dialog.getBoundingClientRect(),
                );
                dialog.animate(
                    [
                        {
                            opacity: 0,
                            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
                        },
                        { opacity: 1, transform: "none" },
                    ],
                    zoomMotion(true),
                );
            });
        });
    };

    const closeFolderDialog = (): void => {
        const dialog =
            document.querySelector<HTMLDialogElement>("#folder-dialog");
        if (!dialog?.open || !zoomFrom || reducedMotion()) {
            folderDialogOpen = false;
            return;
        }
        const { dx, dy, sx, sy } = zoomDelta(
            zoomFrom,
            dialog.getBoundingClientRect(),
        );
        const animation = dialog.animate(
            [
                { opacity: 1, transform: "none" },
                {
                    opacity: 0,
                    transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
                },
            ],
            zoomMotion(false),
        );
        animation.onfinish = () => {
            folderDialogOpen = false;
        };
    };

    const openFolderFromButton = (event: Event): void => {
        event.stopPropagation();
        const box = (event.currentTarget as HTMLElement | null)?.closest<
            HTMLElement & { dataset: DOMStringMap }
        >("section.group-box");
        const name = box?.dataset.folder;
        if (box && name) {
            openFolderDialog(name, box);
        }
    };

    let viewOptionsOpen = $state(false);
    let savingViewOption = $state(false);
    const toggleFolderResourceNames = async (): Promise<void> => {
        if (savingViewOption) {
            return;
        }
        savingViewOption = true;
        viewOptionsOpen = false;
        const next = !showFolderResourceNames;
        try {
            await updateUserSettings({
                settings: { showFolderResourceNames: next },
            });
            await userSettings.refresh();
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to save view setting. Try again."
            );
        } finally {
            savingViewOption = false;
        }
    };
    const startDrag = (event: DragEvent, resource: Resource): void => {
        dragging = resource;
        event.dataTransfer?.setData("text/plain", resource.id);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
        }
    };
    const endDrag = (): void => {
        dragging = null;
        dropTarget = null;
    };
    const dragOverCard = (event: DragEvent, resource: Resource): void => {
        if (!dragging || dragging.id === resource.id) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }
        dropTarget = { kind: "before", resource };
    };
    const dragOverGroup = (event: DragEvent, name: string): void => {
        if (!dragging) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }
        dropTarget = { kind: "group", name };
    };
    const dragOverUngroup = (event: DragEvent): void => {
        if (!dragging || dragging.groupName === null) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }
        dropTarget = { kind: "ungroup" };
    };
    const dragLeave = (event: DragEvent): void => {
        const { relatedTarget, currentTarget } = event;
        if (
            relatedTarget instanceof Node &&
            currentTarget instanceof Node &&
            currentTarget.contains(relatedTarget)
        ) {
            return;
        }
        dropTarget = null;
    };
    const drop = async (event: DragEvent): Promise<void> => {
        const resource = dragging;
        const target = dropTarget;
        endDrag();
        event.preventDefault();
        event.stopPropagation();
        if (!resource || !target) {
            return;
        }
        let beforeResourceId: string | null = null;
        let groupName: string | null = null;
        let message: string;
        if (target.kind === "before") {
            beforeResourceId = target.resource.id;
            const moved = resource.name ?? "resource";
            message =
                target.resource.groupName === resource.groupName
                    ? `Moved ${moved}`
                    : `Moved ${moved} to ${target.resource.groupName ?? "Ungrouped"}`;
        } else if (target.kind === "group") {
            groupName = target.name;
            message = `Moved ${resource.name ?? "resource"} to ${target.name}`;
        } else {
            message = `Moved ${resource.name ?? "resource"} to Ungrouped`;
        }
        try {
            await updateResourcePosition({
                beforeResourceId,
                groupName,
                resourceId: resource.id,
                workspaceId,
            });
            snackbar(message);
        } catch (error) {
            snackbar(
                error instanceof Error
                    ? error.message
                    : "Unable to move resource. Try again."
            );
        }
    };
</script>

{#snippet resourceCard(resource: Resource)}
    <li
        class="resource-card"
        draggable="true"
        class:dragging={dragging?.id === resource.id}
        class:drop-target={dropTarget?.kind === "before" &&
            dropTarget.resource.id === resource.id}
        ondragstart={(event) => startDrag(event, resource)}
        ondragend={endDrag}
        ondragover={(event) => dragOverCard(event, resource)}
        ondragleave={dragLeave}
        ondrop={(event) => void drop(event)}
    >
        <a
            class="resource-link m3-layer"
            draggable="false"
            href={`/workspace/${workspaceId}/${resource.id}`}
        >
            <span class="resource-icon"
                ><ResourceIcon
                    icon={resource.icon}
                    type={resource.type}
                    size={24}
                    alt=""
                /></span
            >
            <span class="resource-text"
                ><span class="resource-name"
                    >{resource.name ?? "Untitled"}</span
                ><span class="resource-slug">{resource.slug ?? ""}</span
                ></span
            >
        </a>
        <Button
            variant="text"
            iconType="full"
            aria-label={`Change group for ${resource.name ?? "Untitled"}`}
            title="Change resource group"
            onclick={() => editResource(resource)}
        >
            <Icon icon={folderIcon} />
        </Button>
    </li>
{/snippet}

{#snippet resourceIconTile(resource: Resource)}
    <li
        class="resource-tile"
        draggable="true"
        class:dragging={dragging?.id === resource.id}
        class:drop-target={dropTarget?.kind === "before" &&
            dropTarget.resource.id === resource.id}
        ondragstart={(event) => startDrag(event, resource)}
        ondragend={endDrag}
        ondragover={(event) => dragOverCard(event, resource)}
        ondragleave={dragLeave}
        ondrop={(event) => void drop(event)}
    >
        <a
            class="resource-tile-link m3-layer"
            class:with-name={showFolderResourceNames}
            draggable="false"
            href={`/workspace/${workspaceId}/${resource.id}`}
            title={resource.name ?? "Untitled"}
            aria-label={resource.name ?? "Untitled"}
        >
            <span class="resource-icon"
                ><ResourceIcon
                    icon={resource.icon}
                    type={resource.type}
                    size={24}
                    alt=""
                /></span
            >
            {#if showFolderResourceNames}
                <span class="resource-tile-name"
                    >{resource.name ?? "Untitled"}</span
                >
            {/if}
        </a>
    </li>
{/snippet}

{#snippet groupMenu(name: string)}
    <div class="group-menu">
        <Button
            variant="text"
            size="xs"
            aria-label={`Group actions for ${name}`}
            aria-expanded={menuOpenGroup === name}
            aria-haspopup="menu"
            style={menuOpenGroup === name
                ? "anchor-name: --m3-menu-anchor"
                : undefined}
            onclick={() => {
                menuOpenGroup = menuOpenGroup === name ? null : name;
            }}
        >
            <Icon icon={moreVertIcon} />
        </Button>
        {#if menuOpenGroup === name}
            <ExpressiveMenu anchored x="end" y="down" label="Group actions">
                <ExpressiveMenuItem
                    leadingIcon={editIcon}
                    label="Rename"
                    onclick={() => {
                        menuOpenGroup = null;
                        editGroup(name);
                    }}
                />
                <ExpressiveMenuItem
                    leadingIcon={folderOffIcon}
                    label="Ungroup"
                    onclick={() => {
                        menuOpenGroup = null;
                        editGroup(name, true);
                    }}
                />
            </ExpressiveMenu>
        {/if}
    </div>
{/snippet}

<div class="view-options">
    <div class="view-options-anchor">
        <Button
            variant="text"
            size="xs"
            aria-label="View options"
            aria-expanded={viewOptionsOpen}
            aria-haspopup="menu"
            style={viewOptionsOpen
                ? "anchor-name: --m3-menu-anchor"
                : undefined}
            onclick={() => {
                viewOptionsOpen = !viewOptionsOpen;
            }}
        >
            <Icon icon={tuneIcon} />
        </Button>
        {#if viewOptionsOpen}
            <ExpressiveMenu anchored x="end" y="down" label="View options">
                <ExpressiveMenuItem
                    label="Show resource names in folders"
                    selected={showFolderResourceNames}
                    disabled={savingViewOption}
                    onclick={toggleFolderResourceNames}
                />
            </ExpressiveMenu>
        {/if}
    </div>
</div>

<ul class="resource-groups">
    {#each flow as item (item.kind === "group"
        ? `group:${item.name}`
        : `resource:${item.resource.id}`)}
        {#if item.kind === "group"}
            <li class="group-item">
                <section
                    class="group-box"
                    data-folder={item.name}
                    role="group"
                    class:drop-target={dropTarget?.kind === "group" &&
                        dropTarget.name === item.name}
                    aria-label={item.name}
                    ondragover={(event) => dragOverGroup(event, item.name)}
                    ondragleave={dragLeave}
                    ondrop={(event) => void drop(event)}
                >
                    <div class="group-header">
                        <span class="group-folder" aria-hidden="true"
                            ><Icon icon={folderIcon} size={20} /></span
                        >
                        <h2 title={item.name}>{item.name}</h2>
                        <span class="count"
                            >{item.resources.length}
                            {item.resources.length === 1
                                ? "resource"
                                : "resources"}</span
                        >
                        <div class="group-actions">
                            <Button
                                variant="text"
                                size="xs"
                                aria-label={`Open ${item.name} folder`}
                                title="Open folder"
                                onclick={openFolderFromButton}
                            >
                                <Icon icon={expandIcon} />
                            </Button>
                            {@render groupMenu(item.name)}
                        </div>
                    </div>
                    <ul
                        class="resource-grid"
                        class:with-names={showFolderResourceNames}
                    >
                        {#each item.resources as resource (resource.id)}
                            {#if showFolderResourceNames}
                                {@render resourceCard(resource)}
                            {:else}
                                {@render resourceIconTile(resource)}
                            {/if}
                        {/each}
                    </ul>
                </section>
            </li>
        {:else}
            {@render resourceCard(item.resource)}
        {/if}
    {/each}
    {#if dragging && dragging.groupName !== null}
        <li
            class="ungroup-drop-zone"
            class:drop-target={dropTarget?.kind === "ungroup"}
            ondragover={dragOverUngroup}
            ondragleave={dragLeave}
            ondrop={(event) => void drop(event)}
        >
            Drop here to ungroup
        </li>
    {/if}
</ul>

<Dialog
    id="folder-dialog"
    bind:open={folderDialogOpen}
    icon={folderIcon}
    headline={dialogItem?.name ?? ""}
    closedby="none"
    oncancel={(event) => {
        event.preventDefault();
        closeFolderDialog();
    }}
    onclick={(event) => {
        if (event.target === event.currentTarget) {
            closeFolderDialog();
        }
    }}
>
    {#if dialogItem}
        <ul class="dialog-list" aria-label={`Resources in ${dialogItem.name}`}>
            {#each dialogItem.resources as resource (resource.id)}
                <li>
                    <a
                        class="dialog-row m3-layer"
                        href={`/workspace/${workspaceId}/${resource.id}`}
                    >
                        <span class="resource-icon"
                            ><ResourceIcon
                                icon={resource.icon}
                                type={resource.type}
                                size={24}
                                alt=""
                            /></span
                        >
                        <span class="resource-text"
                            ><span class="resource-name"
                                >{resource.name ?? "Untitled"}</span
                            ><span class="resource-slug"
                                >{resource.slug ?? ""}</span
                            ></span
                        >
                    </a>
                    <Button
                        variant="text"
                        iconType="full"
                        aria-label={`Change group for ${resource.name ?? "Untitled"}`}
                        title="Change resource group"
                        onclick={() => editResource(resource)}
                    >
                        <Icon icon={folderIcon} />
                    </Button>
                </li>
            {/each}
        </ul>
    {/if}
    {#snippet buttons()}
        <Button variant="text" onclick={closeFolderDialog}>Close</Button>
    {/snippet}
</Dialog>

<Dialog
    bind:open={editorOpen}
    headline={selectedResource ? "Change resource group" : "Rename group"}
>
    <form
        id="resource-group-form"
        class="group-form"
        onsubmit={(event) => {
            event.preventDefault();
            void save();
        }}
    >
        <p>
            {selectedResource
                ? `Organize ${selectedResource.name ?? "this resource"} with related resources. Choose an existing group or enter a new name.`
                : "Give this group a descriptive name."}
        </p>
        <TextFieldOutlined
            label="Group name"
            bind:value={name}
            maxlength={80}
            required
            disabled={saving}
            error={Boolean(errorMessage)}
            aria-describedby={errorMessage ? "resource-group-error" : undefined}
        />
        {#if selectedResource && flow.some((item) => item.kind === "group")}
            <div class="group-choices" role="group" aria-label="Existing groups">
                {#each flow as item (item.kind === "group" ? item.name : item.resource.id)}
                    {#if item.kind === "group"}
                        <Chip
                            variant="general"
                            type="button"
                            disabled={saving}
                            aria-pressed={name === item.name}
                            selected={name === item.name}
                            onclick={() => {
                                name = item.name;
                            }}>{item.name}</Chip
                        >
                    {/if}
                {/each}
            </div>
        {/if}
        {#if merging}<p>
                Resources will be combined with the existing “{name.trim()}”
                group.
            </p>{/if}
        {#if errorMessage}<p
                id="resource-group-error"
                class="error"
                role="alert"
            >
                {errorMessage}
            </p>{/if}
    </form>
    {#snippet buttons()}
        {#if selectedResource?.groupName}
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
            form="resource-group-form"
            disabled={saving || !name.trim()}
            >{saving ? "Saving…" : "Save"}</Button
        >
    {/snippet}
</Dialog>

<Dialog bind:open={removeOpen} headline="Ungroup resources?">
    <p>
        All resources in “{originalName}” will move to Ungrouped. The group will
        disappear. Your resources will keep running.
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
    .view-options {
        display: flex;
        justify-content: flex-end;
        padding: 8px 16px 0;
    }
    .view-options-anchor {
        position: relative;
        display: flex;
    }
    .view-options-anchor :global(button) {
        min-width: 48px;
        min-height: 48px;
    }
    .resource-groups {
        list-style: none;
        margin: 0;
        padding: 16px;
        columns: 300px;
        column-gap: 8px;
    }
    .resource-groups > * {
        break-inside: avoid;
        width: 100%;
        min-width: 0;
        margin-bottom: 8px;
    }
    .group-item {
        display: block;
    }
    .group-box {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
        background: var(--m3c-surface-container);
        border-radius: var(--m3-shape-extra-large);
        min-width: 0;
        transition:
            background-color var(--m3-easing-fast),
            outline-color var(--m3-easing-fast);
    }
    .resource-grid {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, 48px);
        gap: 8px;
    }
    .resource-grid.with-names {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .resource-tile {
        display: grid;
        cursor: grab;
        border-radius: var(--m3-shape-medium);
        transition:
            background-color var(--m3-easing-fast),
            opacity var(--m3-easing-fast),
            outline-color var(--m3-easing-fast);
    }
    .resource-tile.dragging {
        opacity: 0.4;
    }
    .resource-tile.drop-target {
        outline: 2px dashed var(--m3c-primary);
        outline-offset: -2px;
        background: color-mix(in srgb, var(--m3c-primary) 8%, transparent);
    }
    .resource-tile-link {
        @apply --m3-focus-inward;
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: var(--m3-shape-medium);
        text-decoration: none;
        color: inherit;
    }
    .resource-tile-link.with-name {
        width: 100%;
        height: auto;
        padding: 8px 4px;
        gap: 4px;
    }
    .resource-tile-name {
        @apply --m3-label-medium;
        color: var(--m3c-on-surface);
        text-align: center;
        overflow-wrap: anywhere;
        max-width: 100%;
    }
    .group-header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 48px;
    }
    .group-folder {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: var(--m3-shape-full);
        background: var(--m3c-surface-container-high);
        color: var(--m3c-on-surface-variant);
        flex-shrink: 0;
    }
    h2 {
        @apply --m3-title-medium;
        color: var(--m3c-on-surface);
        margin: 0;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .count {
        @apply --m3-label-medium;
        color: var(--m3c-on-surface-variant);
        white-space: nowrap;
        padding: 8px 16px;
        border-radius: var(--m3-shape-full);
        background: var(--m3c-surface-container-high);
        flex-shrink: 0;
    }
    .group-menu {
        position: relative;
        display: flex;
        flex-shrink: 0;
    }
    .group-actions {
        display: flex;
        flex-shrink: 0;
        margin-inline-start: auto;
    }
    :global(#folder-dialog.m3-container) {
        width: min(30rem, calc(100vw - 2rem));
        max-width: none;
        max-height: min(40rem, calc(100vh - 4rem));
    }
    :global(#folder-dialog.m3-container[open]) {
        animation: none;
    }
    .dialog-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
    }
    .dialog-list > li {
        display: flex;
        align-items: center;
        min-width: 0;
        background: var(--m3c-surface-container);
        border-radius: var(--m3-shape-medium);
        overflow: hidden;
    }
    .dialog-row {
        @apply --m3-focus-inward;
        display: flex;
        align-items: center;
        gap: 16px;
        min-height: 72px;
        padding: 8px 8px 8px 16px;
        text-decoration: none;
        color: var(--m3c-on-surface);
        flex: 1;
        min-width: 0;
    }
    .dialog-list > li > :global(button) {
        min-width: 48px;
        min-height: 48px;
    }
    .resource-card {
        display: flex;
        align-items: center;
        min-width: 0;
        background: var(--m3c-surface-container-low);
        border-radius: var(--m3-shape-medium);
        overflow: hidden;
        cursor: grab;
        transition:
            background-color var(--m3-easing-fast),
            opacity var(--m3-easing-fast),
            outline-color var(--m3-easing-fast);
    }
    .group-box .resource-card {
        background: var(--m3c-surface-container-high);
    }
    .resource-card.dragging {
        opacity: 0.4;
    }
    .group-box.drop-target,
    .resource-card.drop-target,
    .ungroup-drop-zone.drop-target {
        outline: 2px dashed var(--m3c-primary);
        outline-offset: -2px;
    }
    .group-box.drop-target {
        background: color-mix(
            in srgb,
            var(--m3c-primary) 8%,
            var(--m3c-surface-container)
        );
    }
    .resource-card.drop-target {
        background: color-mix(
            in srgb,
            var(--m3c-primary) 8%,
            var(--m3c-surface-container-low)
        );
    }
    .group-box .resource-card.drop-target {
        background: color-mix(
            in srgb,
            var(--m3c-primary) 8%,
            var(--m3c-surface-container-high)
        );
    }
    .ungroup-drop-zone {
        @apply --m3-body-medium;
        display: grid;
        place-items: center;
        min-height: 96px;
        border-radius: var(--m3-shape-extra-large);
        outline: 2px dashed var(--m3c-outline-variant);
        outline-offset: -2px;
        color: var(--m3c-on-surface-variant);
        transition:
            background-color var(--m3-easing-fast),
            outline-color var(--m3-easing-fast),
            color var(--m3-easing-fast);
    }
    .ungroup-drop-zone.drop-target {
        color: var(--m3c-primary);
        background: color-mix(in srgb, var(--m3c-primary) 8%, transparent);
    }
    .resource-link {
        @apply --m3-focus-inward;
        display: flex;
        align-items: center;
        gap: 16px;
        min-height: 72px;
        padding: 8px 8px 8px 16px;
        text-decoration: none;
        color: var(--m3c-on-surface);
        flex: 1;
        min-width: 0;
    }
    .resource-text {
        display: grid;
        min-width: 0;
    }
    .resource-name {
        @apply --m3-body-large;
        overflow-wrap: anywhere;
    }
    .resource-slug {
        @apply --m3-body-medium;
        color: var(--m3c-on-surface-variant);
        overflow-wrap: anywhere;
    }
    .resource-icon {
        flex-shrink: 0;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: var(--m3-shape-full);
        background: var(--m3c-surface-container-highest);
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
    .resource-card > :global(button),
    .group-actions :global(button) {
        min-width: 48px;
        min-height: 48px;
    }
    .error {
        color: var(--m3c-error);
    }
</style>
