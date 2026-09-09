import { command, query } from "$app/server";
import * as v from "valibot";

import { requireDataSourceAccess, requireSession, requireWorkspaceAccess } from "#lib/api/guard";
import { withRemoteLogging } from "#lib/api/remote-logging";
import { ENV_NAME_PATTERN } from "#lib/domain/environment";
import {
    createWorkspace as createWorkspaceRecord,
    deleteWorkspace as deleteWorkspaceRecord,
    getWorkspace as getWorkspaceRecord,
    listWorkspaces as listWorkspaceRecords,
} from "#lib/server/workspaces";
import {
    listWorkspaceEnvironmentVariables as listWorkspaceEnvironmentVariableRecords,
    replaceWorkspaceEnvironmentVariables as replaceWorkspaceEnvironmentVariableRecords,
} from "#lib/server/workspaces/environment";

const WorkspaceIdInput = v.string();

const CreateWorkspaceInput = v.object({
    dataSourceId: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(3)),
});

const EnvironmentVariableInput = v.object({
    name: v.pipe(v.string(), v.regex(ENV_NAME_PATTERN)),
    value: v.string(),
});

const UpdateWorkspaceEnvironmentInput = v.pipe(
    v.object({
        variables: v.array(EnvironmentVariableInput),
        workspaceId: WorkspaceIdInput,
    }),
    v.check(
        (input) =>
            new Set(input.variables.map((variable) => variable.name)).size ===
            input.variables.length,
        "Environment variable names must be unique",
    ),
);

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

export const listWorkspaceEnvironmentVariables = query(
    WorkspaceIdInput,
    withRemoteLogging(
        "workspaces.listWorkspaceEnvironmentVariables",
        "query",
        async (workspaceId: string) => {
            await requireWorkspaceAccess(workspaceId);
            return await listWorkspaceEnvironmentVariableRecords(workspaceId);
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

export const updateWorkspaceEnvironmentVariables = command(
    UpdateWorkspaceEnvironmentInput,
    withRemoteLogging(
        "workspaces.updateWorkspaceEnvironmentVariables",
        "command",
        async (input: v.InferOutput<typeof UpdateWorkspaceEnvironmentInput>) => {
            await requireWorkspaceAccess(input.workspaceId);
            return await replaceWorkspaceEnvironmentVariableRecords(
                input.workspaceId,
                input.variables,
            );
        },
        { inputKey: "workspaceId" },
    ),
);
