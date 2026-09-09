import { command } from "$app/server";
import * as v from "valibot";

import { requireWorkspaceAccess } from "#lib/api/guard";
import { listResourcesInWorkspace } from "#lib/api/resources.remote";
import { ResourceGroupNameInput } from "#lib/domain/resources/groups";
import {
    updateResourceGroup as updateResourceGroupRecord,
    updateResourceGroupName as updateResourceGroupNameRecord,
    updateResourcePosition as updateResourcePositionRecord,
} from "#lib/server/resources/resource-groups";

const UpdateResourceGroupInput = v.object({
    groupName: v.nullable(ResourceGroupNameInput),
    resourceId: v.string(),
    workspaceId: v.string(),
});

const UpdateResourceGroupNameInput = v.object({
    groupName: ResourceGroupNameInput,
    newGroupName: v.nullable(ResourceGroupNameInput),
    workspaceId: v.string(),
});

const UpdateResourcePositionInput = v.object({
    beforeResourceId: v.nullable(v.string()),
    groupName: v.nullable(ResourceGroupNameInput),
    resourceId: v.string(),
    workspaceId: v.string(),
});

export const updateResourceGroup = command(UpdateResourceGroupInput, async (input) => {
    await requireWorkspaceAccess(input.workspaceId);
    await updateResourceGroupRecord(input.workspaceId, input.resourceId, input.groupName);
    await listResourcesInWorkspace(input.workspaceId).refresh();
});

export const updateResourceGroupName = command(UpdateResourceGroupNameInput, async (input) => {
    await requireWorkspaceAccess(input.workspaceId);
    await updateResourceGroupNameRecord(input.workspaceId, input.groupName, input.newGroupName);
    await listResourcesInWorkspace(input.workspaceId).refresh();
});

export const updateResourcePosition = command(UpdateResourcePositionInput, async (input) => {
    await requireWorkspaceAccess(input.workspaceId);
    await updateResourcePositionRecord(
        input.workspaceId,
        input.resourceId,
        input.beforeResourceId,
        input.groupName,
    );
    await listResourcesInWorkspace(input.workspaceId).refresh();
});
