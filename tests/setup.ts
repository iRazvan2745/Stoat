import { inject } from "vite-plus/test";

// Never let integration tests or workflow queues use the developer's database.
process.env.DATABASE_URL = inject("databaseUrl");
