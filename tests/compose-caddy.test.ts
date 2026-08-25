import { describe, expect, it } from "vite-plus/test";

import { listComposeCaddyIngresses, parseCaddyIngresses } from "#lib/server/service/compose-caddy";
import { interpolateComposeVariables } from "#lib/server/service/compose-interpolate";

const SEAFILE_CADDY = `files.example.com {
  handle_path /socket.io/* {
    rewrite * /socket.io{uri}
    reverse_proxy {{upstreams "seafile-seadoc" 80}}
  }
  handle_path /sdoc-server/* {
    rewrite * {uri}
    reverse_proxy {{upstreams "seafile-seadoc" 80}}
  }
  reverse_proxy {{upstreams 80}}
}
`;

describe("parseCaddyIngresses", () => {
  it("extracts one route per path handler plus the catch-all", () => {
    expect(parseCaddyIngresses(SEAFILE_CADDY, "seafile-seafile")).toEqual([
      {
        containerPort: 80,
        host: "files.example.com",
        path: "/socket.io/*",
        protocol: "https",
        serviceName: "seafile-seafile",
        upstreamService: "seafile-seadoc",
      },
      {
        containerPort: 80,
        host: "files.example.com",
        path: "/sdoc-server/*",
        protocol: "https",
        serviceName: "seafile-seafile",
        upstreamService: "seafile-seadoc",
      },
      {
        containerPort: 80,
        host: "files.example.com",
        protocol: "https",
        serviceName: "seafile-seafile",
        upstreamService: "seafile-seafile",
      },
    ]);
  });

  it("dedupes identical routes across handlers", () => {
    const caddy = `app.example.com {
  handle /a/* {
    reverse_proxy {{upstreams 80}}
  }
  handle /a/* {
    reverse_proxy {{upstreams 80}}
  }
}
`;

    expect(parseCaddyIngresses(caddy, "app")).toHaveLength(1);
  });

  it("respects explicit http scheme and port 80 addresses", () => {
    const caddy = `http://plain.example.com {
  reverse_proxy {{upstreams 3000}}
}

other.example.com:80 {
  reverse_proxy {{upstreams "backend" 8080}}
}
`;

    expect(parseCaddyIngresses(caddy, "web")).toEqual([
      {
        containerPort: 3000,
        host: "plain.example.com",
        protocol: "http",
        serviceName: "web",
        upstreamService: "web",
      },
      {
        containerPort: 8080,
        host: "other.example.com",
        protocol: "http",
        serviceName: "web",
        upstreamService: "backend",
      },
    ]);
  });

  it("strips quotes from path matchers", () => {
    const caddy = `app.example.com {
  handle_path "/x/*" {
    reverse_proxy {{upstreams 80}}
  }
  handle '/y/*' {
    reverse_proxy {{upstreams 81}}
  }
}
`;

    expect(parseCaddyIngresses(caddy, "app")).toEqual([
      {
        containerPort: 80,
        host: "app.example.com",
        path: "/x/*",
        protocol: "https",
        serviceName: "app",
        upstreamService: "app",
      },
      {
        containerPort: 81,
        host: "app.example.com",
        path: "/y/*",
        protocol: "https",
        serviceName: "app",
        upstreamService: "app",
      },
    ]);
  });

  it("handles upstreams without an explicit port", () => {
    const caddy = `app.example.com {
  reverse_proxy {{upstreams}}
}
`;

    expect(parseCaddyIngresses(caddy, "app")).toEqual([
      {
        host: "app.example.com",
        protocol: "https",
        serviceName: "app",
        upstreamService: "app",
      },
    ]);
  });
});

describe("listComposeCaddyIngresses", () => {
  it("collects x-caddy ingresses across services", () => {
    const compose = `services:
  web:
    image: nginx
    x-caddy: |
      web.example.com {
        reverse_proxy {{upstreams 80}}
      }
  api:
    image: node
`;

    expect(listComposeCaddyIngresses(compose)).toEqual([
      {
        containerPort: 80,
        host: "web.example.com",
        protocol: "https",
        serviceName: "web",
        upstreamService: "web",
      },
    ]);
  });
});

describe("interpolateComposeVariables", () => {
  const variables = new Map([
    ["SEAFILE_SERVER_HOSTNAME", "files.example.com"],
    ["EMPTY", ""],
  ]);
  const lookup = (name: string) => variables.get(name);

  it("resolves plain, braced, and default forms", () => {
    expect(interpolateComposeVariables("$SEAFILE_SERVER_HOSTNAME", lookup)).toBe(
      "files.example.com",
    );
    expect(interpolateComposeVariables("${SEAFILE_SERVER_HOSTNAME}", lookup)).toBe(
      "files.example.com",
    );
    expect(interpolateComposeVariables("${MISSING:-fallback}", lookup)).toBe("fallback");
    expect(interpolateComposeVariables("${EMPTY:-fallback}", lookup)).toBe("fallback");
    expect(interpolateComposeVariables("${EMPTY-fallback}", lookup)).toBe("");
  });

  it("resolves nested defaults and required markers", () => {
    expect(
      interpolateComposeVariables(
        "${SEADOC_SERVER_URL:-${PROTOCOL:-http}://${SEAFILE_SERVER_HOSTNAME:?not set}/sdoc-server}",
        lookup,
      ),
    ).toBe("http://files.example.com/sdoc-server");
  });

  it("keeps escaped dollar signs", () => {
    expect(
      interpolateComposeVariables('redis-server --requirepass "$$REDIS_PASSWORD"', lookup),
    ).toBe('redis-server --requirepass "$REDIS_PASSWORD"');
  });
});
