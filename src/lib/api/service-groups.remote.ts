import { command } from "$app/server";
import * as v from "valibot";

import { requireWorkspaceAccess } from "#lib/api/guard";
import { listServicesInWorkspace } from "#lib/api/services.remote";
import { ServiceGroupNameInput } from "#lib/domain/services/groups";
import {
    updateServiceGroup as updateServiceGroupRecord,
    updateServiceGroupName as updateServiceGroupNameRecord,
} from "#lib/server/services/service-groups";

const UpdateServiceGroupInput = v.object({
    groupName: v.nullable(ServiceGroupNameInput),
    serviceId: v.string(),
    workspaceId: v.string(),
});

const UpdateServiceGroupNameInput = v.object({
    groupName: ServiceGroupNameInput,
    newGroupName: v.nullable(ServiceGroupNameInput),
    workspaceId: v.string(),
});

export const updateServiceGroup = command(UpdateServiceGroupInput, async (input) => {
    await requireWorkspaceAccess(input.workspaceId);
    await updateServiceGroupRecord(input.workspaceId, input.serviceId, input.groupName);
    await listServicesInWorkspace(input.workspaceId).refresh();
});

export const updateServiceGroupName = command(UpdateServiceGroupNameInput, async (input) => {
    await requireWorkspaceAccess(input.workspaceId);
    await updateServiceGroupNameRecord(input.workspaceId, input.groupName, input.newGroupName);
    await listServicesInWorkspace(input.workspaceId).refresh();
});
