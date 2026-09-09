// Test-only authentication key; no application credentials are loaded by integration tests.
export const APP_SECRET = "stoat-git-sync-integration-test-key";
export const DATABASE_URL = process.env.GIT_SYNC_TEST_DATABASE_URL ?? "";
