import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import * as schema from "@stoat/db/schema/index";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, inject, it } from "vite-plus/test";
import dbPackage from "../../packages/db/package.json";
import * as queue from "../../packages/workflows/src/schema";

const require = createRequire(resolve("packages/db/package.json"));

const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");

it("keeps migrated queue tables and sequences in generate and CLI push", async () => {
    const metadataPath = resolve("packages/db/src/migrations/meta");

    const latestSnapshot = (await readdir(metadataPath))
        .filter((name) => name.endsWith("_snapshot.json"))
        .sort()
        .at(-1)!;

    const snapshot = JSON.parse(await readFile(resolve(metadataPath, latestSnapshot), "utf8"));

    expect(dbPackage.scripts["db:push"]).toBe("drizzle-kit push");
    expect(await generateMigration(snapshot, generateDrizzleJson({ ...schema, ...queue }))).toEqual(
        [],
    );

    // Use only the Testcontainers URL, never the application's DATABASE_URL.
    const url = new URL(inject("databaseUrl"));
    const databaseName = `schema_tooling_${randomUUID().replaceAll("-", "")}`;
    const admin = createDb({ DATABASE_URL: url.toString() });
    url.pathname = `/${databaseName}`;
    const db = createDb({ DATABASE_URL: url.toString() });
    let created = false;

    try {
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        created = true;
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const tables = await db.$client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'effect_mq_%' ORDER BY tablename",
        );

        expect(tables.rows.map((row) => row.tablename)).toEqual([
            "effect_mq_dedupe",
            "effect_mq_flow_children",
            "effect_mq_flow_outbox",
            "effect_mq_job_attempts",
            "effect_mq_jobs",
            "effect_mq_queue_control",
            "effect_mq_schedules",
        ]);

        const sequences = await db.$client.query(
            `SELECT pg_get_serial_sequence('effect_mq_jobs', 'seq') AS identity,
                    pg_get_serial_sequence('effect_mq_flow_outbox', 'id') AS serial`,
        );

        expect(sequences.rows).toEqual([
            {
                identity: "public.effect_mq_jobs_seq_seq",
                serial: "public.effect_mq_flow_outbox_id_seq",
            },
        ]);

        // The CLI passes composite-PK introspection parameters correctly; pushSchema does not.
        // Read-only startup options also prevent an accidental approval from applying DDL.
        url.searchParams.set("options", "-c default_transaction_read_only=on");

        const push = spawnSync(
            process.execPath,
            [
                resolve("packages/db/node_modules/drizzle-kit/bin.cjs"),
                "push",
                "--strict",
                "--verbose",
            ],
            {
                cwd: resolve("packages/db"),
                env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test" },
                encoding: "utf8",
                input: "\n",
                timeout: 30_000,
            },
        );

        const output = `${push.stdout}\n${push.stderr}`;
        expect(push.error, output).toBeUndefined();
        expect(push.status, output).toBe(0);
        expect(output).not.toMatch(/\bDROP\s+(?:TABLE|SEQUENCE|COLUMN|IDENTITY)\b/i);
        expect(output).toMatch(/No changes detected|You are about to execute current statements:/);
        // With pending index/constraint changes, --strict refuses to apply without a TTY.
        expect(push.stderr.trim()).toMatch(/^$|^Error: Interactive prompts require a TTY terminal/);
    } finally {
        await db.$client.end();

        try {
            if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
        } finally {
            await admin.$client.end();
        }
    }
}, 60_000);
