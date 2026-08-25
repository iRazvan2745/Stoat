import { command, query } from "$app/server";
import * as v from "valibot";

import { requireSession } from "#lib/api/guard";
import {
  createWorkspace as insertWorkspace,
  deleteWorkspace as removeWorkspace,
  getWorkspace as loadWorkspace,
  listWorkspaces as loadWorkspaces,
} from "#lib/server/workspace";

export const listWorkspaces = query(async () => {
  requireSession();
  return await loadWorkspaces();
});

export const getWorkspace = query(v.string(), async (id) => {
  requireSession();
  return await loadWorkspace(id);
});

const CreateWorkspaceInput = v.object({
  dataSourceId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(3)),
});

export const createWorkspace = command(CreateWorkspaceInput, async (input) => {
  requireSession();
  return await insertWorkspace(input);
});

export const deleteWorkspace = command(v.string(), async (id) => {
  requireSession();
  return await removeWorkspace(id);
});
