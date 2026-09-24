import { createContext, type Snippet } from "svelte";

export const [getHeaderActions, setHeaderActions] = createContext<{ content?: Snippet }>();
