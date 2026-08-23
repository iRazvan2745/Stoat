import { query } from "$app/server";
import * as v from "valibot";

import {
  createWorkspace as insertWorkspace,
  deleteWorkspace as removeWorkspace,
  getWorkspace as loadWorkspace,
  listWorkspaces as loadWorkspaces,
} from "#lib/server/workspace";

export const listWorkspaces = query(async () => await loadWorkspaces());

export const getWorkspace = query(v.string(), async (id) => await loadWorkspace(id));

const CreateWorkspaceInput = v.object({
  dataSourceId: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(3)),
});

export const createWorkspace = query(
  CreateWorkspaceInput,
  async (input) => await insertWorkspace(input),
);

export const deleteWorkspace = query(v.string(), async (id) => await removeWorkspace(id));
