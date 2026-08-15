// oxlint-disable oxc/no-barrel-file
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const task = sqliteTable("task", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  priority: integer("priority").notNull().default(1),
  title: text("title").notNull(),
});

export const dataSource = sqliteTable("data_source", {
  id: text("id"),
  path: text("path"),
  url: text("url"),
});

export * from "./auth.schema";
