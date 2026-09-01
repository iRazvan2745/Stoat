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
}

export interface ServiceIngressInfo {
    clusterDomain?: string;
    ingresses: ServiceIngress[];
    serviceName: string;
}
