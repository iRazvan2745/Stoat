// oxlint-disable func-style
import YAML, { isMap, isScalar } from "yaml";

/** An HTTP(S) route extracted from an `x-caddy` Caddyfile snippet. */
export interface CaddyIngress {
  /** Container port targeted by `{{upstreams ...}}`, when specified. */
  containerPort?: number;
  /** Site address without scheme or port. */
  host: string;
  /** Path matcher of the enclosing handle/handle_path/route block, if any. */
  path?: string;
  protocol: "http" | "https";
  /** Compose service name as written in the file. */
  serviceName: string;
  /** Compose service the traffic is proxied to (may differ from serviceName). */
  upstreamService: string;
}

const UPSTREAMS_PATTERN =
  /\{\{\s*upstreams(?:\s+"(?<service>[^"]+)")?(?:\s+(?<port>\d+))?\s*\}\}/gu;

const parseSiteAddress = (address: string): { host: string; protocol: "http" | "https" } => {
  let host = address;
  let protocol: "http" | "https" = "https";

  if (host.startsWith("http://")) {
    host = host.slice("http://".length);
    protocol = "http";
  } else if (host.startsWith("https://")) {
    host = host.slice("https://".length);
  }

  const portIndex = host.lastIndexOf(":");

  if (portIndex !== -1) {
    const port = host.slice(portIndex + 1);

    if (/^\d+$/u.test(port)) {
      if (port === "80") {
        protocol = "http";
      }

      host = host.slice(0, portIndex);
    }
  }

  return { host, protocol };
};

interface SiteBlock {
  addresses: string[];
  body: string;
}

/**
 * Splits a Caddyfile snippet into site blocks. A line at brace depth zero
 * that ends with `{` starts a block; its remainder is the address list.
 */
const splitSiteBlocks = (caddyfile: string): SiteBlock[] => {
  const blocks: SiteBlock[] = [];
  let depth = 0;
  let current: SiteBlock | undefined;

  for (const rawLine of caddyfile.split("\n")) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const opens = line.split("{").length - 1 - (line.split("{{").length - 1) * 2;
    const closes = line.split("}").length - 1 - (line.split("}}").length - 1) * 2;

    if (depth === 0 && line.endsWith("{")) {
      const addressPart = line.slice(0, -1).trim();
      current = {
        addresses: addressPart
          .split(/[\s,]+/u)
          .map((address) => address.trim())
          .filter((address) => address !== ""),
        body: "",
      };
      depth += opens - closes;
      continue;
    }

    if (current) {
      current.body += `${rawLine}\n`;
    }

    depth += opens - closes;

    if (depth <= 0 && current) {
      blocks.push(current);
      current = undefined;
      depth = 0;
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
};

interface UpstreamRoute {
  containerPort?: number;
  path?: string;
  upstreamService: string;
}

const MATCHER_BLOCK_PATTERN = /^(?:handle_path|handle|route)\s+(?<path>\S+)\s*\{$/u;

const stripMatcherQuotes = (token: string): string => {
  const isDoubleQuoted = token.startsWith('"') && token.endsWith('"');
  const isSingleQuoted = token.startsWith("'") && token.endsWith("'");

  if (token.length >= 2 && (isDoubleQuoted || isSingleQuoted)) {
    return token.slice(1, -1);
  }

  return token;
};

/**
 * Walks a site block body and pairs every `{{upstreams ...}}` directive with
 * the path matcher of its enclosing handle/handle_path/route block, if any.
 */
const parseUpstreamRoutes = (body: string, serviceName: string): UpstreamRoute[] => {
  const routes: UpstreamRoute[] = [];
  // Path matcher active at each brace depth (undefined for unmatched blocks).
  const matcherStack: Array<string | undefined> = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const currentPath = matcherStack.findLast((matcher) => matcher !== undefined);

    for (const match of line.matchAll(UPSTREAMS_PATTERN)) {
      const port = match.groups?.port;

      routes.push({
        upstreamService: match.groups?.service ?? serviceName,
        ...(port === undefined ? {} : { containerPort: Number(port) }),
        ...(currentPath === undefined ? {} : { path: currentPath }),
      });
    }

    const opens = line.split("{").length - 1 - (line.split("{{").length - 1) * 2;
    const closes = line.split("}").length - 1 - (line.split("}}").length - 1) * 2;

    if (opens > closes) {
      const rawMatcher = MATCHER_BLOCK_PATTERN.exec(line)?.groups?.path;
      const matcher = rawMatcher === undefined ? undefined : stripMatcherQuotes(rawMatcher);
      matcherStack.push(matcher?.startsWith("/") ? matcher : undefined);

      for (let extra = 1; extra < opens - closes; extra += 1) {
        matcherStack.push(undefined);
      }
    } else if (closes > opens) {
      for (let count = 0; count < closes - opens; count += 1) {
        matcherStack.pop();
      }
    }
  }

  return routes;
};

/** Extracts ingresses from a single service's `x-caddy` value. */
export function parseCaddyIngresses(caddyfile: string, serviceName: string): CaddyIngress[] {
  const ingresses: CaddyIngress[] = [];

  const seen = new Set<string>();

  for (const block of splitSiteBlocks(caddyfile)) {
    const routes = parseUpstreamRoutes(block.body, serviceName);

    for (const address of block.addresses) {
      // Skip global option blocks and snippet definitions.
      if (address.startsWith("(") || address === "{") {
        continue;
      }

      const { host, protocol } = parseSiteAddress(address);

      if (host === "" || host === ":") {
        continue;
      }

      const blockRoutes: UpstreamRoute[] =
        routes.length > 0 ? routes : [{ upstreamService: serviceName }];

      for (const route of blockRoutes) {
        const key = [host, route.path, route.upstreamService, route.containerPort].join("\u0000");

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        ingresses.push({
          host,
          protocol,
          serviceName,
          upstreamService: route.upstreamService,
          ...(route.containerPort === undefined ? {} : { containerPort: route.containerPort }),
          ...(route.path === undefined ? {} : { path: route.path }),
        });
      }
    }
  }

  return ingresses;
}

/** Extracts `x-caddy` ingresses for every service in a compose file. */
export function listComposeCaddyIngresses(compose: string): CaddyIngress[] {
  const doc = YAML.parseDocument(compose);

  if (doc.errors.length > 0) {
    return [];
  }

  const serviceMap = doc.get("services", true);

  if (!isMap(serviceMap)) {
    return [];
  }

  const ingresses: CaddyIngress[] = [];

  for (const pair of serviceMap.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isMap(pair.value)) {
      continue;
    }

    const caddy = pair.value.get("x-caddy", true);

    if (!isScalar(caddy) || typeof caddy.value !== "string") {
      continue;
    }

    ingresses.push(...parseCaddyIngresses(caddy.value, pair.key.value));
  }

  return ingresses;
}
