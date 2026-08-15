import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const task = sqliteTable("task", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  priority: integer("priority").notNull().default(1),
  title: text("title").notNull(),
});

export * from "./auth.schema";
