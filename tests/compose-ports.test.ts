import { describe, expect, it } from "vite-plus/test";

import {
    findPublishedTcpPort,
    listComposePorts,
    parseComposePortSpec,
} from "#lib/server/resources/compose-ports";

describe("parseComposePortSpec", () => {
    it("parses docker short, mapped, and host-ip forms", () => {
        expect(parseComposePortSpec("5432", "db")).toEqual({
            containerPort: 5432,
            protocol: "tcp",
            publishedPort: 5432,
            serviceName: "db",
        });
        expect(parseComposePortSpec("5432:5432", "db")).toEqual({
            containerPort: 5432,
            protocol: "tcp",
            publishedPort: 5432,
            serviceName: "db",
        });
        expect(parseComposePortSpec("127.0.0.1:5434:5432", "db")).toEqual({
            containerPort: 5432,
            hostIp: "127.0.0.1",
            protocol: "tcp",
            publishedPort: 5434,
            serviceName: "db",
        });
    });

    it("parses uncloud x-ports without treating ingress as a published TCP port", () => {
        expect(parseComposePortSpec("80/http", "web")).toEqual({
            containerPort: 80,
            protocol: "http",
            serviceName: "web",
        });
        expect(parseComposePortSpec("app.example.com:80/http", "web")).toEqual({
            containerPort: 80,
            hostname: "app.example.com",
            protocol: "http",
            serviceName: "web",
        });
        expect(parseComposePortSpec("25001:5432/tcp", "db")).toEqual({
            containerPort: 5432,
            protocol: "tcp",
            publishedPort: 25_001,
            serviceName: "db",
        });
    });
});

describe("listComposePorts", () => {
    it("reads ports and x-ports from each compose service", () => {
        const ports = listComposePorts(`
services:
  web:
    image: nginx
    x-ports:
      - 25001:80/https
  db:
    image: postgres
    ports:
      - "127.0.0.1:5434:5432"
`);

        expect(ports).toEqual([
            {
                containerPort: 80,
                protocol: "https",
                publishedPort: 25_001,
                serviceName: "web",
            },
            {
                containerPort: 5432,
                hostIp: "127.0.0.1",
                protocol: "tcp",
                publishedPort: 5434,
                serviceName: "db",
            },
        ]);
    });

    it("reads long-form published ports", () => {
        const ports = listComposePorts(`
services:
  db:
    image: postgres
    ports:
      - target: 5432
        published: 5432
        protocol: tcp
        host_ip: 0.0.0.0
`);

        expect(ports).toEqual([
            {
                containerPort: 5432,
                hostIp: "0.0.0.0",
                protocol: "tcp",
                publishedPort: 5432,
                serviceName: "db",
            },
        ]);
    });
});

describe("findPublishedTcpPort", () => {
    it("prefers the matching container port and ignores http ingress", () => {
        const published = findPublishedTcpPort(
            [
                {
                    containerPort: 80,
                    protocol: "http",
                    serviceName: "web",
                },
                {
                    containerPort: 5432,
                    protocol: "tcp",
                    publishedPort: 5434,
                    serviceName: "db",
                },
            ],
            5432,
        );

        expect(published?.publishedPort).toBe(5434);
        expect(
            findPublishedTcpPort([{ containerPort: 80, protocol: "http", serviceName: "web" }]),
        ).toBeUndefined();
    });
});
