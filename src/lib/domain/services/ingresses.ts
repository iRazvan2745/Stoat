export type ServiceIngressProtocol = "http" | "https" | "tcp" | "udp";

export interface ServiceIngress {
    /** Deployed compose service name (prefixed when service prefixing is enabled). */
    composeService: string;
    containerPort: number;
    /** Resolved public host (hostname or IP), when known. */
    host?: string;
    mode: "host" | "ingress";
    /** Path matcher for caddy routes (e.g. "/sdoc-server/*"). */
    path?: string;
    protocol: ServiceIngressProtocol;
    publishedPort?: number;
    /** Clickable URL for HTTP(S) ingresses. */
    url?: string;
    /** Opaque reference used to edit an x-ports entry in the Compose file. */
    editableRouteId?: string;
    /** Compose service name before any deployment prefix is applied. */
    editableComposeService?: string;
    /** Hostname written in Compose; absent means the cluster assigns one. */
    editableHostname?: string;
    /** Published port written in Compose, including uncommon HTTP(S) mappings. */
    editablePublishedPort?: number;
}

export interface ServiceIngressInfo {
    clusterDomain?: string;
    composeServices: string[];
    ingresses: ServiceIngress[];
    serviceName: string;
}
