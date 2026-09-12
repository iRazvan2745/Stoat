<script lang="ts">
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import syncIcon from "@ktibow/iconset-material-symbols/sync";
    import { Button, Icon, snackbar } from "m3-svelte";

    import {
        resolveGitSourceSync,
        syncGitSource,
    } from "#lib/api/data-sources.remote";
    import { getResourceGitSourceId } from "#lib/api/resources.remote";
    import type { DeploymentLogRecord } from "#lib/domain/deployments/logs";
    import { deploymentNeedsGitSync } from "#lib/domain/git-sync";

    interface Props {
        logs: DeploymentLogRecord[];
        resourceId: string;
    }

    let { logs, resourceId }: Props = $props();

    // svelte-ignore state_referenced_locally
    const gitSourceIdQuery = getResourceGitSourceId(resourceId);
    const gitSourceId = $derived(gitSourceIdQuery.current ?? null);
    const needsSync = $derived(deploymentNeedsGitSync(logs));

    let syncing = $state(false);
    let needsResolution = $state(false);

    const isConflictIssue = (issue: string): boolean =>
        /both the app and git differ|reconcile the compose/iu.test(issue);

    async function runSync(resolution?: "app" | "git"): Promise<void> {
        if (!gitSourceId || syncing) {
            return;
        }

        syncing = true;
        needsResolution = false;

        try {
            const result = resolution
                ? await resolveGitSourceSync({ gitSourceId, resolution })
                : await syncGitSource(gitSourceId);

            if (result.issues.some(isConflictIssue)) {
                needsResolution = true;
                snackbar("Sync needs a choice: the app and Git both changed");
                return;
            }

            snackbar(
                `Synced ${result.commits} commits · ${result.deployments} deployments · ${result.issues.length} issues`
            );
        } catch (error) {
            if (
                !resolution &&
                logs.some((log) => isConflictIssue(log.message))
            ) {
                needsResolution = true;
            }

            snackbar(
                error instanceof Error ? error.message : "Git sync failed"
            );
        } finally {
            syncing = false;
        }
    }
</script>

{#if needsSync && gitSourceId}
    <div
        class="bg-secondary-container text-on-secondary-container mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3"
        role="alert"
    >
        <div class="flex min-w-0 items-center gap-3">
            <span
                class="bg-secondary-container text-on-secondary-container grid size-9 shrink-0 place-items-center rounded-full"
                aria-hidden="true"
            >
                <Icon icon={syncIcon} size={20} />
            </span>

            <div class="min-w-0">
                <p class="m3-font-label-large">
                    Git has newer changes than this deployment
                </p>

                <p class="m3-font-body-small opacity-80">
                    Sync pulls all pending commits for this repository — every
                    changed service queues a deployment. Let the queue drain,
                    then redeploy this resource if needed.
                </p>
            </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
            {#if needsResolution}
                <Button
                    variant="tonal"
                    disabled={syncing}
                    onclick={() => void runSync("git")}
                >
                    {syncing ? "Syncing…" : "Use Git changes"}
                </Button>

                <Button disabled={syncing} onclick={() => void runSync("app")}>
                    {syncing ? "Syncing…" : "Keep app changes"}
                </Button>
            {:else}
                <Button
                    variant="tonal"
                    size="xs"
                    iconType="left"
                    disabled={syncing}
                    onclick={() => void runSync()}
                >
                    <Icon icon={refreshIcon} size={18} />
                    {syncing ? "Syncing…" : "Sync now"}
                </Button>
            {/if}
        </div>
    </div>
{/if}
