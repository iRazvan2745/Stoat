# Git synchronization

Stoat keeps editable, unformatted Compose in the app and formatted deployment Compose in Git. Git files also contain an `x-stoat` extension with resource identity, prefix settings, workspace information, group, name, and icon. Keep that extension when editing or moving files so Stoat can recognize existing resources.

## Using it

1. Apply database migrations with `vp run db:migrate` when upgrading an existing development installation. Production Compose already runs migrations in its deployment hook.
2. Open **Data sources → Git repositories** and assign a repository to a cluster connection.
3. Click **Sync** to import Git configuration, publish app changes, and queue deployments.
4. Choose **Enable automatic deployments** from the repository actions menu to run the same synchronization every minute. Automatic synchronization starts paused for existing and newly created repositories.

The first sync starts at the current commit instead of replaying the repository's entire pre-Stoat history. Subsequent syncs process every unseen commit on the checked-out branch, in first-parent order, including commits with no Compose changes. Merge commits deploy their merged tree. A burst of commits is not collapsed into a single deployment.

Every recognized resource present in a commit gets a deployment with that commit's SHA and immutable formatted Compose. Queue deduplication is per resource and commit, so repeated syncs and retries do not create extra deployments. An explicit redeploy of unchanged configuration can still use the same commit. A normal app deployment publishes and deploys only that resource's formatted configuration; unresolved differences in other resources remain visible on the Git Source without blocking it.

Git versions Compose and non-secret app metadata. App-managed environment values remain outside Git and are captured in each private deployment snapshot. They are applied only when preparing the deployment payload.

Compose `configs:` `file:` references are resolved from resource files. The app database is the source of truth for those files (managed on the resource **Files** page); Git siblings next to the Compose file are the fallback mirror. A first sync imports missing siblings into the app without overwriting existing rows, and app changes are published back as sibling files unless the resource opts out with the **Mirror to Git** toggle. Only the single Compose file is sent to the cluster — file content is inlined as `content:` at deploy time, and config names are prefixed like services and volumes.

## Repository structure

New app resources use:

```text
workspace-slug/
  resource-slug/
    compose.yaml
  Group%20name/
    resource-slug/
      compose.yaml
```

Existing repositories can use `compose.yaml`, `compose.yml`, `docker-compose.yaml`, or `docker-compose.yml`. Two folder levels map to workspace/resource; deeper paths include a group. Older imported paths remain usable. App group changes move the tracked Compose file, and Git folder moves with preserved `x-stoat` identity update the app group. A Git move to another workspace requires that destination workspace to exist in the app.

For a new unassigned file, Stoat uses the matching workspace's cluster, a matching metadata destination, or the repository's sole cluster connection. Ambiguous destinations require an existing workspace folder; Stoat does not guess a cluster.

## Conflicts and failures

A sync compares the last synchronized app and Git fingerprints. If both sides changed differently, it preserves both versions and reports a conflict. **Resolve sync differences** lets you use Git changes or keep app changes. Keeping app changes queues the unseen Git revisions first, then publishes the app version as a new commit.

Invalid Compose for a known resource becomes a failed deployment snapshot; a later fixing commit can still proceed. Invalid files without a known resource are reported instead of creating an unusable resource. Missing tracked files preserve the app resource and pause synchronization rather than deleting running workloads. Restore the file, retaining its metadata, to continue. When deleting a resource in the app, also remove its tracked Git file; later commits will not recreate a deleted resource whose identity was already synchronized.

Git pulls only fast-forward. Rewritten history, unfinished local changes, and failed access are reported. A failed push retains the local commit for retry. One checkout per Git Source replaces separate checkouts for new workspaces; synchronization and publication use process and PostgreSQL locks.

## Validation

Regular tests run with `vp test`. The Git/database integration tests use local bare repositories, an isolated PostgreSQL database, and a mocked deployment transport; they do not contact a cluster.

```sh
GIT_SYNC_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/stoat_git_sync_test vp run test:git-sync
```

The integration suite deliberately resets the `public` schema of that test database and refuses a database with a different name.
