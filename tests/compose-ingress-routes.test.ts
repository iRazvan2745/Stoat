import { describe, expect, it } from "vite-plus/test";

import {
    addComposeIngressRoute,
    deleteComposeIngressRoute,
    listEditableComposeIngressRoutes,
    updateComposeIngressRoute,
} from "#lib/server/resources/compose-ingress-routes";

const COMPOSE = `services:
  web:
    image: nginx
    x-ports:
      - 3000/https
      - api.example.com:3001/http
      - 25001:3002/tcp
  worker:
    image: busybox
`;

describe("compose ingress routes", () => {
    it("lists editable HTTP and transport routes", () => {
        expect(listEditableComposeIngressRoutes(COMPOSE)).toEqual([
            {
                composeService: "web",
                containerPort: 3000,
                id: '["x-ports","web",0,"3000/https"]',
                protocol: "https",
            },
            {
                composeService: "web",
                containerPort: 3001,
                hostname: "api.example.com",
                id: '["x-ports","web",1,"api.example.com:3001/http"]',
                protocol: "http",
            },
            {
                composeService: "web",
                containerPort: 3002,
                id: '["x-ports","web",2,"25001:3002/tcp"]',
                protocol: "tcp",
                publishedPort: 25_001,
            },
        ]);
    });

    it("adds a domain route to the selected compose service", () => {
        const updated = addComposeIngressRoute(COMPOSE, {
            composeService: "worker",
            containerPort: 8080,
            hostname: "worker.example.com",
            protocol: "https",
        });

        expect(updated).toContain("x-ports:\n      - worker.example.com:8080/https");
    });

    it("preserves a scalar x-ports value when adding the first editable route", () => {
        const updated = addComposeIngressRoute(
            `services:\n  web:\n    image: nginx\n    x-ports: 25001:3000/tcp\n`,
            {
                composeService: "web",
                containerPort: 3000,
                protocol: "https",
            },
        );

        expect(updated).toContain("- 25001:3000/tcp");
        expect(updated).toContain("- 3000/https");
    });

    it("requires and writes a published port for TCP and UDP routes", () => {
        expect(() =>
            addComposeIngressRoute(COMPOSE, {
                composeService: "worker",
                containerPort: 53,
                protocol: "udp",
            }),
        ).toThrow("Published port is required");

        const updated = addComposeIngressRoute(COMPOSE, {
            composeService: "worker",
            containerPort: 53,
            hostname: "dns.example.com",
            protocol: "udp",
            publishedPort: 5353,
        });

        expect(updated).toContain("dns.example.com:5353:53/udp");
    });

    it("updates and moves a route without touching unrelated ports", () => {
        const [route] = listEditableComposeIngressRoutes(COMPOSE);
        const updated = updateComposeIngressRoute(COMPOSE, route!.id, {
            composeService: "worker",
            containerPort: 8080,
            hostname: "worker.example.com",
            protocol: "http",
        });

        expect(updated).not.toContain("3000/https");
        expect(updated).toContain("25001:3002/tcp");
        expect(updated).toContain("worker.example.com:8080/http");
    });

    it("deletes a route and rejects a stale route reference", () => {
        const [, route] = listEditableComposeIngressRoutes(COMPOSE);
        const updated = deleteComposeIngressRoute(COMPOSE, route!.id);

        expect(updated).not.toContain("api.example.com:3001/http");
        expect(() => deleteComposeIngressRoute(updated, route!.id)).toThrow(
            "changed since the page was loaded",
        );
    });
});
