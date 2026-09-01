<script lang="ts">
    import contentCopyIcon from "@ktibow/iconset-material-symbols/content-copy-outline";
    import dnsIcon from "@ktibow/iconset-material-symbols/dns";
    import languageIcon from "@ktibow/iconset-material-symbols/language";
    import lockIcon from "@ktibow/iconset-material-symbols/lock-outline";
    import openInNewIcon from "@ktibow/iconset-material-symbols/open-in-new";
    import publicIcon from "@ktibow/iconset-material-symbols/public";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import settingsEthernetIcon from "@ktibow/iconset-material-symbols/settings-ethernet";
    import { Button, Card, Icon, LoadingIndicator, Snackbar } from "m3-svelte";

    import { getService, listServiceIngresses } from "#lib/api/services.remote";
    import {
        Flow,
        FlowNode,
        FlowNodeList,
        FlowParallel,
    } from "#lib/components/flow";
    import ServiceIcon from "#lib/components/services/service-icon.svelte";
    import type { ServiceIngress } from "#lib/domain/services/ingresses";
    import { copyToClipboard } from "#lib/shared/ui/clipboard";

    const { params } = $props();

    const service = $derived(getService(params.serviceId));
    const ingressQuery = $derived(listServiceIngresses(params.serviceId));

    const svc = $derived(await service);

    const info = $derived(ingressQuery.current);
    const routes = $derived(info?.ingresses ?? []);
    const ready = $derived(info !== undefined);

    const routeIcon = (route: ServiceIngress) => {
        if (route.mode === "host") {
            return settingsEthernetIcon;
        }

        return route.protocol === "https" ? lockIcon : publicIcon;
    };

    const routeHeadline = (route: ServiceIngress): string => {
        if (route.url) {
            return route.url;
        }

        if (route.mode === "host") {
            return route.host
                ? `${route.host}:${route.publishedPort ?? route.containerPort}`
                : `:${route.publishedPort ?? route.containerPort}`;
        }

        return route.host ?? "Hostname assigned at deploy";
    };

    interface FlowPath {
        id: string;
        label: string;
        port: number;
        target: string;
    }

    interface FlowBranch {
        https: boolean;
        host: string;
        id: string;
        kind: "domain" | "port";
        paths: FlowPath[];
    }

    const branches = $derived.by((): FlowBranch[] => {
        const domains = new Map<string, FlowBranch>();
        const result: FlowBranch[] = [];

        for (const [index, route] of routes.entries()) {
            if (route.mode === "host") {
                result.push({
                    host: `:${route.publishedPort ?? route.containerPort}`,
                    https: false,
                    id: `port-${index}`,
                    kind: "port",
                    paths: [
                        {
                            id: `port-${index}-target`,
                            label: `:${route.containerPort}`,
                            port: route.containerPort,
                            target: route.composeService,
                        },
                    ],
                });
                continue;
            }

            const host = route.host ?? "auto hostname";
            let branch = domains.get(host);

            if (!branch) {
                branch = {
                    host,
                    https: route.protocol === "https",
                    id: `domain-${domains.size}`,
                    kind: "domain",
                    paths: [],
                };
                domains.set(host, branch);
                result.push(branch);
            }

            branch.paths.push({
                id: `${branch.id}-path-${branch.paths.length}`,
                label: route.path ?? "/",
                port: route.containerPort,
                target: route.composeService,
            });
        }

        return result;
    });

    const routeTarget = (route: ServiceIngress): string =>
        `${route.composeService}:${route.containerPort}`;

    const copyable = (route: ServiceIngress): string | undefined => {
        if (route.url) {
            return route.url;
        }

        if (route.host) {
            return route.mode === "host"
                ? `${route.host}:${route.publishedPort ?? route.containerPort}`
                : route.host;
        }

        return undefined;
    };

    const modeClasses = (route: ServiceIngress): string =>
        route.mode === "ingress"
            ? "bg-primary-container-subtle text-on-primary-container-subtle"
            : "bg-secondary-container-subtle text-on-secondary-container-subtle";

    const routeKey = (route: ServiceIngress): string =>
        [
            route.mode,
            route.host ?? "",
            route.path ?? "",
            route.publishedPort ?? "",
            route.containerPort,
            route.composeService,
        ].join("|");
</script>

{#snippet targetNode(id: string, name: string)}
    <FlowNode {id}>
        <span class="flex items-center gap-2">
            {#if svc}
                <ServiceIcon icon={svc.icon} type={svc.type} size={18} alt="" />
            {:else}
                <span class="text-on-surface-variant flex">
                    <Icon icon={dnsIcon} size={18} />
                </span>
            {/if}
            {name}
        </span>
    </FlowNode>
{/snippet}

{#snippet pathChain(path: FlowPath)}
    <FlowNodeList
        class="col-span-2 grid grid-cols-subgrid"
        listClass="col-span-2 grid grid-cols-subgrid items-start"
    >
        <FlowNode id={path.id} edgeLabel={`:${path.port}`}>
            <span class="font-mono">{path.label}</span>
        </FlowNode>
        {@render targetNode(`${path.id}-target`, path.target)}
    </FlowNodeList>
{/snippet}

{#snippet branchChain(branch: FlowBranch)}
    <FlowNodeList>
        {#if branch.kind === "port"}
            {@const path = branch.paths[0]}
            <FlowNode
                id={branch.id}
                edgeLabel={path ? `:${path.port}` : undefined}
            >
                <span class="flex items-center gap-2">
                    <span class="text-on-surface-variant flex">
                        <Icon icon={settingsEthernetIcon} size={18} />
                    </span>
                    <span class="font-mono">{branch.host}</span>
                </span>
            </FlowNode>
            {#if path}
                {@render targetNode(`${branch.id}-target`, path.target)}
            {/if}
        {:else}
            <FlowNode id={branch.id}>
                <span class="flex items-center gap-2">
                    <span class="text-on-surface-variant flex">
                        <Icon
                            icon={branch.https ? lockIcon : publicIcon}
                            size={18}
                        />
                    </span>
                    <span class="font-mono">{branch.host}</span>
                </span>
            </FlowNode>

            {#if branch.paths.length > 1}
                <FlowParallel
                    contentClass="ml-0 grid w-fit grid-cols-[max-content_max-content] items-start gap-x-16 gap-y-5"
                >
                    {#each branch.paths as path (path.id)}
                        {@render pathChain(path)}
                    {/each}
                </FlowParallel>
            {:else if branch.paths[0]}
                {@const path = branch.paths[0]}
                <FlowNode id={path.id} edgeLabel={`:${path.port}`}>
                    <span class="font-mono">{path.label}</span>
                </FlowNode>
                {@render targetNode(`${path.id}-target`, path.target)}
            {/if}
        {/if}
    </FlowNodeList>
{/snippet}

<div class="flex h-full min-h-0 flex-col gap-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
            <h1 class="m3-font-headline-small text-on-surface">Ingresses</h1>
            <p class="m3-font-body-medium text-on-surface-variant">
                How traffic reaches this service through Caddy and published
                ports.
            </p>
        </div>

        <Button
            variant="tonal"
            square
            aria-label="Refresh ingresses"
            onclick={() => ingressQuery.refresh()}
        >
            <Icon icon={refreshIcon} />
        </Button>
    </header>

    {#if !ready && ingressQuery.loading}
        <Card variant="elevated">
            <div class="flex min-h-48 items-center justify-center">
                <LoadingIndicator aria-label="Loading ingresses" />
            </div>
        </Card>
    {:else if ingressQuery.error}
        <Card variant="elevated">
            <div
                class="bg-error-container-subtle text-on-error-container-subtle rounded-lg px-3 py-2"
                role="status"
            >
                <p class="m3-font-body-small">{ingressQuery.error.message}</p>
            </div>
        </Card>
    {:else if info === null}
        <Card variant="elevated">
            <div
                class="bg-error-container-subtle text-on-error-container-subtle rounded-lg px-3 py-2"
                role="status"
            >
                <p class="m3-font-body-small">
                    Service not found. It may have been deleted.
                </p>
            </div>
        </Card>
    {:else if routes.length === 0}
        <Card variant="elevated">
            <div
                class="text-on-surface-variant flex min-h-48 flex-col items-center justify-center gap-1 py-4 text-center"
            >
                <Icon icon={languageIcon} size={28} />
                <p class="m3-font-body-medium mt-1">No ingresses configured</p>
                <p class="m3-font-body-small">
                    Add <code class="font-mono">ports</code> or
                    <code class="font-mono">x-ports</code> to the compose file to
                    expose this service.
                </p>
            </div>
        </Card>
    {:else}
        <Card variant="elevated">
            <h2 class="m3-font-title-small text-on-surface">Traffic flow</h2>

            <div
                class="flex min-h-56 [&>div]:flex [&>div]:min-h-56"
                role="group"
                aria-label="Traffic flow diagram showing how public hosts and ports route to service containers"
            >
                <Flow padding={{ x: 24, y: 40 }}>
                    {#if branches.length > 1}
                        <FlowParallel>
                            {#each branches as branch (branch.id)}
                                {@render branchChain(branch)}
                            {/each}
                        </FlowParallel>
                    {:else if branches[0]}
                        {@render branchChain(branches[0])}
                    {/if}
                </Flow>
            </div>
        </Card>

        <Card variant="elevated">
            <div class="flex min-h-10 items-center justify-between gap-2">
                <h2 class="m3-font-title-small text-on-surface">Routes</h2>

                <span
                    class="bg-secondary-container text-on-secondary-container m3-font-label-medium inline-flex h-6 shrink-0 items-center rounded-full px-2.5"
                >
                    {routes.length}
                    {routes.length === 1 ? "route" : "routes"}
                </span>
            </div>

            <ul class="mt-1 flex flex-col gap-2">
                {#each routes as route (routeKey(route))}
                    {@const copyValue = copyable(route)}
                    <li
                        class="flex min-w-0 items-center gap-3 rounded-md px-2 py-2"
                    >
                        <div
                            class="bg-surface-container-high text-on-surface grid size-8 shrink-0 place-items-center rounded-full"
                        >
                            <Icon icon={routeIcon(route)} size={18} />
                        </div>

                        <div class="min-w-0 flex-1">
                            <p
                                class="m3-font-label-large text-on-surface truncate font-mono"
                            >
                                {routeHeadline(route)}
                            </p>
                            <p
                                class="m3-font-label-small text-on-surface-variant truncate"
                            >
                                {route.protocol} · {routeTarget(route)}
                            </p>
                        </div>

                        <span
                            class={[
                                "m3-font-label-small inline-flex h-5 shrink-0 items-center rounded-full px-2 capitalize",
                                modeClasses(route),
                            ]}
                        >
                            {route.mode}
                        </span>

                        {#if copyValue}
                            <Button
                                variant="text"
                                square
                                aria-label={`Copy ${copyValue}`}
                                onclick={() => copyToClipboard(copyValue)}
                            >
                                <Icon icon={contentCopyIcon} size={18} />
                            </Button>
                        {/if}

                        {#if route.url}
                            <Button
                                variant="text"
                                square
                                href={route.url}
                                target="_blank"
                                rel="noopener"
                                aria-label={`Open ${route.url} in a new tab`}
                            >
                                <Icon icon={openInNewIcon} size={18} />
                            </Button>
                        {/if}
                    </li>
                {/each}
            </ul>
        </Card>
    {/if}
</div>

<Snackbar />
