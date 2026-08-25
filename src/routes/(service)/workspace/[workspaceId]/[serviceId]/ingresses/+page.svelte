<script lang="ts">
    import contentCopyIcon from "@ktibow/iconset-material-symbols/content-copy-outline";
    import dnsIcon from "@ktibow/iconset-material-symbols/dns";
    import languageIcon from "@ktibow/iconset-material-symbols/language";
    import lockIcon from "@ktibow/iconset-material-symbols/lock-outline";
    import openInNewIcon from "@ktibow/iconset-material-symbols/open-in-new";
    import publicIcon from "@ktibow/iconset-material-symbols/public";
    import refreshIcon from "@ktibow/iconset-material-symbols/refresh";
    import settingsEthernetIcon from "@ktibow/iconset-material-symbols/settings-ethernet";
    import {
        Button,
        Card,
        Icon,
        LoadingIndicator,
        Snackbar,
        snackbar,
    } from "m3-svelte";

    import { getService, getServiceIngresses } from "#lib/api/services.remote";
    import { Flow, FlowNode, FlowParallel } from "#lib/components/flow";
    import type { ServiceIngress } from "#lib/server/service/service-ingresses";
    import ServiceIcon from "#lib/service/icon.svelte";

    const { params } = $props();

    // svelte-ignore state_referenced_locally
    const service = getService(params.serviceId);
    // svelte-ignore state_referenced_locally
    const ingressQuery = getServiceIngresses(params.serviceId);

    const svc = await service;

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

    const routeNodeLabel = (route: ServiceIngress): string => {
        if (route.mode === "host") {
            return `:${route.publishedPort ?? route.containerPort}`;
        }

        return route.host ?? "auto hostname";
    };

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

    const copy = async (value: string): Promise<void> => {
        try {
            await navigator.clipboard.writeText(value);
            snackbar("Copied to clipboard");
        } catch {
            snackbar("Unable to copy");
        }
    };

    const modeClasses = (route: ServiceIngress): string =>
        route.mode === "ingress"
            ? "bg-primary-container-subtle text-on-primary-container-subtle"
            : "bg-secondary-container-subtle text-on-secondary-container-subtle";
</script>

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

            <div class="flex min-h-56 [&>div]:flex [&>div]:min-h-56">
                <Flow padding={{ x: 24, y: 40 }}>
                    <FlowNode id="internet">
                        <span class="flex items-center gap-2">
                            <span class="text-on-surface-variant flex">
                                <Icon icon={languageIcon} size={18} />
                            </span>
                            Internet
                        </span>
                    </FlowNode>

                    {#if routes.length > 1}
                        <FlowParallel>
                            {#each routes as route, index (index)}
                                <FlowNode id={`route-${index}`}>
                                    <span class="flex items-center gap-2">
                                        <span
                                            class="text-on-surface-variant flex"
                                        >
                                            <Icon
                                                icon={routeIcon(route)}
                                                size={18}
                                            />
                                        </span>
                                        <span class="font-mono">
                                            {routeNodeLabel(route)}
                                        </span>
                                    </span>
                                </FlowNode>
                            {/each}
                        </FlowParallel>
                    {:else if routes[0]}
                        {@const route = routes[0]}
                        <FlowNode id="route-0">
                            <span class="flex items-center gap-2">
                                <span class="text-on-surface-variant flex">
                                    <Icon icon={routeIcon(route)} size={18} />
                                </span>
                                <span class="font-mono">
                                    {routeNodeLabel(route)}
                                </span>
                            </span>
                        </FlowNode>
                    {/if}

                    <FlowNode id="service">
                        <span class="flex items-center gap-2">
                            {#if svc}
                                <ServiceIcon
                                    icon={svc.icon}
                                    type={svc.type}
                                    size={18}
                                    alt=""
                                />
                            {:else}
                                <span class="text-on-surface-variant flex">
                                    <Icon icon={dnsIcon} size={18} />
                                </span>
                            {/if}
                            {info?.serviceName ?? "Service"}
                        </span>
                    </FlowNode>
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
                {#each routes as route, index (index)}
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
                                onclick={() => copy(copyValue)}
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
