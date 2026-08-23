// oxlint-disable func-style
import YAML, { isMap, isScalar, isSeq } from "yaml";

const PORT_PROTOCOLS = ["http", "https", "tcp", "udp"] as const;

export type ComposePortProtocol = (typeof PORT_PROTOCOLS)[number];

export interface ComposePort {
  containerPort: number;
  hostIp?: string;
  hostname?: string;
  protocol: ComposePortProtocol;
  publishedPort?: number;
  serviceName: string;
}

const isPortProtocol = (value: string): value is ComposePortProtocol =>
  PORT_PROTOCOLS.includes(value as ComposePortProtocol);

const parsePortNumber = (value: string): number | undefined => {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }

  const port = Math.trunc(Number(value));

  if (port < 1 || port > 65_535) {
    return undefined;
  }

  return port;
};

const isIpAddress = (value: string): boolean => {
  if (value.includes(":")) {
    return false;
  }

  const parts = value.split(".");

  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/u.test(part)) {
        return false;
      }

      const octet = Math.trunc(Number(part));

      return octet >= 0 && octet <= 255;
    })
  );
};

const splitProtocol = (spec: string): { protocol: ComposePortProtocol; rest: string } => {
  const separatorIndex = spec.lastIndexOf("/");

  if (separatorIndex === -1) {
    return { protocol: "tcp", rest: spec };
  }

  const protocol = spec.slice(separatorIndex + 1).toLowerCase();

  if (!isPortProtocol(protocol)) {
    return { protocol: "tcp", rest: spec };
  }

  return { protocol, rest: spec.slice(0, separatorIndex) };
};

const withPublishedPort = (port: ComposePort, publishedPort: number | undefined): ComposePort =>
  publishedPort === undefined ? port : { ...port, publishedPort };

const parseSinglePort = (
  value: string,
  protocol: ComposePortProtocol,
  serviceName: string,
): ComposePort | undefined => {
  const containerPort = parsePortNumber(value);

  if (containerPort === undefined) {
    return undefined;
  }

  const shouldPublish = protocol === "tcp" || protocol === "udp";

  return withPublishedPort(
    { containerPort, protocol, serviceName },
    shouldPublish ? containerPort : undefined,
  );
};

const parseMappedPort = (
  left: string,
  right: string,
  protocol: ComposePortProtocol,
  serviceName: string,
): ComposePort | undefined => {
  const containerPort = parsePortNumber(right);

  if (containerPort === undefined) {
    return undefined;
  }

  const publishedPort = parsePortNumber(left);

  if (publishedPort !== undefined) {
    return { containerPort, protocol, publishedPort, serviceName };
  }

  if (isIpAddress(left)) {
    return {
      containerPort,
      hostIp: left,
      protocol,
      publishedPort: containerPort,
      serviceName,
    };
  }

  return { containerPort, hostname: left, protocol, serviceName };
};

const parseHostBoundPort = (
  left: string,
  middle: string,
  right: string,
  protocol: ComposePortProtocol,
  serviceName: string,
): ComposePort | undefined => {
  const containerPort = parsePortNumber(right);

  if (containerPort === undefined) {
    return undefined;
  }

  const host = isIpAddress(left) ? { hostIp: left } : { hostname: left };

  return withPublishedPort(
    { containerPort, protocol, serviceName, ...host },
    parsePortNumber(middle),
  );
};

export function parseComposePortSpec(spec: string, serviceName: string): ComposePort | undefined {
  const trimmed = spec.trim();

  if (trimmed === "") {
    return undefined;
  }

  const { protocol, rest } = splitProtocol(trimmed);
  const parts = rest.split(":");
  const [first = "", second = "", third = ""] = parts;

  if (parts.length === 1) {
    return parseSinglePort(first, protocol, serviceName);
  }

  if (parts.length === 2) {
    return parseMappedPort(first, second, protocol, serviceName);
  }

  if (parts.length === 3) {
    return parseHostBoundPort(first, second, third, protocol, serviceName);
  }

  return undefined;
}

const readNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parsePortNumber(value);
  }

  return undefined;
};

const parseLongPort = (
  value: Record<string, unknown>,
  serviceName: string,
): ComposePort | undefined => {
  const containerPort = readNumber(value.target ?? value.containerPort);

  if (containerPort === undefined) {
    return undefined;
  }

  const protocolValue = typeof value.protocol === "string" ? value.protocol.toLowerCase() : "tcp";
  const protocol = isPortProtocol(protocolValue) ? protocolValue : "tcp";
  const hostIp = typeof value.host_ip === "string" ? value.host_ip : undefined;
  const hostname = typeof value.hostname === "string" ? value.hostname : undefined;
  const publishedPort = readNumber(value.published ?? value.publishedPort);

  return {
    containerPort,
    protocol,
    serviceName,
    ...(hostIp === undefined ? {} : { hostIp }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(publishedPort === undefined ? {} : { publishedPort }),
  };
};

const yamlNodeValue = (item: unknown): unknown => {
  if (isScalar(item)) {
    return item.value;
  }

  if (
    typeof item === "object" &&
    item !== null &&
    "toJSON" in item &&
    typeof item.toJSON === "function"
  ) {
    return item.toJSON();
  }

  return item;
};

const collectPortValues = (value: unknown): unknown[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (isSeq(value)) {
    return value.items.map((item) => yamlNodeValue(item));
  }

  if (Array.isArray(value)) {
    return value;
  }

  return [value];
};

const parsePortValue = (value: unknown, serviceName: string): ComposePort | undefined => {
  if (typeof value === "string" || typeof value === "number") {
    return parseComposePortSpec(String(value), serviceName);
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return parseLongPort(value as Record<string, unknown>, serviceName);
  }

  return undefined;
};

export function listComposePorts(compose: string): ComposePort[] {
  const doc = YAML.parseDocument(compose);

  if (doc.errors.length > 0) {
    return [];
  }

  const serviceMap = doc.get("services", true);

  if (!isMap(serviceMap)) {
    return [];
  }

  const ports: ComposePort[] = [];

  for (const pair of serviceMap.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isMap(pair.value)) {
      continue;
    }

    const serviceName = pair.key.value;
    const service = pair.value;
    const values = [
      ...collectPortValues(service.get("ports", true)),
      ...collectPortValues(service.get("x-ports", true)),
    ];

    for (const value of values) {
      const parsed = parsePortValue(value, serviceName);

      if (parsed) {
        ports.push(parsed);
      }
    }
  }

  return ports;
}

export function findPublishedTcpPort(
  ports: readonly ComposePort[],
  containerPort = 5432,
): ComposePort | undefined {
  const matching = ports.filter(
    (port) =>
      (port.protocol === "tcp" || port.protocol === "udp") && port.publishedPort !== undefined,
  );

  return matching.find((port) => port.containerPort === containerPort) ?? matching[0];
}
