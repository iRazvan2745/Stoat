import { command, query } from "$app/server";
import * as v from "valibot";

import { requireDataSourceAccess, requireSession, requireWorkspaceAccess } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import {
    createWorkspace as createWorkspaceRecord,
    deleteWorkspace as deleteWorkspaceRecord,
    getWorkspace as getWorkspaceRecord,
    listWorkspaces as listWorkspaceRecords,
} from "#lib/server/workspaces";

const WorkspaceIdInput = v.string();

const CreateWorkspaceInput = v.object({
    dataSourceId: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(3)),
});

export const listWorkspaces = query(
    withRemoteLogging("workspaces.listWorkspaces", "query", async () => {
        const session = requireSession();
        return await listWorkspaceRecords(session.user.id);
    }),
);

export const getWorkspace = query(
    WorkspaceIdInput,
    withRemoteLogging(
        "workspaces.getWorkspace",
        "query",
        async (workspaceId: string) => {
            await requireWorkspaceAccess(workspaceId);
            return await getWorkspaceRecord(workspaceId);
        },
        { inputKey: "workspaceId" },
    ),
);

export const createWorkspace = command(
    CreateWorkspaceInput,
    withRemoteLogging(
        "workspaces.createWorkspace",
        "command",
        async (input: v.InferOutput<typeof CreateWorkspaceInput>) => {
            await requireDataSourceAccess(input.dataSourceId);
            return await createWorkspaceRecord(input);
        },
    ),
);

export const deleteWorkspace = command(
    WorkspaceIdInput,
    withRemoteLogging(
        "workspaces.deleteWorkspace",
        "command",
        async (workspaceId: string) => {
            await requireWorkspaceAccess(workspaceId);
            return await deleteWorkspaceRecord(workspaceId);
        },
        { inputKey: "workspaceId" },
    ),
);
