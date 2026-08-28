import { command, query } from "$app/server";
import * as v from "valibot";

import { requireDataSourceAccess, requireSession, requireWorkspaceAccess } from "#lib/api/guard";
import {
  createWorkspace as insertWorkspace,
  deleteWorkspace as removeWorkspace,
  getWorkspace as loadWorkspace,
  listWorkspaces as loadWorkspaces,
} from "#lib/server/workspace";

export const listWorkspaces = query(async () => {
  const session = requireSession();
  return await loadWorkspaces(session.user.id);
});

export const getWorkspace = query(v.string(), async (id) => {
  await requireWorkspaceAccess(id);
  return await loadWorkspace(id);
});

const CreateWorkspaceInput = v.object({
  dataSourceId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(3)),
});

export const createWorkspace = command(CreateWorkspaceInput, async (input) => {
  await requireDataSourceAccess(input.dataSourceId);
  return await insertWorkspace(input);
});

export const deleteWorkspace = command(v.string(), async (id) => {
  await requireWorkspaceAccess(id);
  return await removeWorkspace(id);
});
