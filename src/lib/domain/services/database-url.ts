export const DEFAULT_POSTGRES_PORT = 5432;

export interface PostgresConnectionTarget {
    host: string;
    port: number;
}

export interface PostgresConnectionUrl extends PostgresConnectionTarget {
    url: string;
}

export interface PostgresConnectionParts {
    database: string;
    password: string;
    user: string;
}

export interface DisplayableConnectionUrl {
    afterPassword: string;
    beforePassword: string;
    password: string;
    url: string;
}

export function encodeConnectionComponent(value: string): string {
    return encodeURIComponent(value);
}

export function buildPostgresUrl(
    parts: PostgresConnectionParts,
    target: PostgresConnectionTarget,
): string {
    const user = encodeConnectionComponent(parts.user);
    const password = encodeConnectionComponent(parts.password);
    const database = encodeConnectionComponent(parts.database);

    return `postgresql://${user}:${password}@${target.host}:${target.port}/${database}`;
}

export function splitPostgresUrl(url: string): DisplayableConnectionUrl {
    const schemeSeparator = url.indexOf("://");
    const atIndex = url.lastIndexOf("@");

    if (schemeSeparator === -1 || atIndex === -1) {
        return {
            afterPassword: "",
            beforePassword: url,
            password: "",
            url,
        };
    }

    const credentials = url.slice(schemeSeparator + 3, atIndex);
    const passwordSeparator = credentials.indexOf(":");

    if (passwordSeparator === -1) {
        return {
            afterPassword: url.slice(atIndex),
            beforePassword: url.slice(0, atIndex),
            password: "",
            url,
        };
    }

    const beforePassword = url.slice(0, schemeSeparator + 3 + passwordSeparator + 1);
    const password = credentials.slice(passwordSeparator + 1);

    return {
        afterPassword: url.slice(atIndex),
        beforePassword,
        password,
        url,
    };
}

const PASSWORD_MASK = "•";

export function maskPostgresUrl(url: string, revealPassword: boolean): string {
    if (revealPassword) {
        return url;
    }

    const display = splitPostgresUrl(url);

    if (!display.password) {
        return url;
    }

    return `${display.beforePassword}${PASSWORD_MASK}${display.afterPassword}`;
}

const URL_SCHEME = /^(?<scheme>[a-z][a-z0-9+.-]*:\/\/)(?<rest>.*)$/iu;
const URL_WRAP = /(?=[/:@?&#])/u;

export function wrapUrlSegments(url: string): string[] {
    if (!url) {
        return [];
    }

    const schemeMatch = URL_SCHEME.exec(url);
    const scheme = schemeMatch?.groups?.scheme ?? "";
    const rest = schemeMatch?.groups?.rest ?? url;
    const pieces = rest.length === 0 ? [] : rest.split(URL_WRAP).filter(Boolean);

    return scheme ? [scheme, ...pieces] : pieces;
}

export function envValue(
    variables: readonly { name: string; value: string }[],
    name: string,
    fallback: string,
): string {
    return variables.find((variable) => variable.name === name)?.value ?? fallback;
}

export function postgresConnectionParts(
    variables: readonly { name: string; value: string }[],
): PostgresConnectionParts {
    return {
        database: envValue(variables, "POSTGRES_DB", "postgres"),
        password: envValue(variables, "POSTGRES_PASSWORD", ""),
        user: envValue(variables, "POSTGRES_USER", "postgres"),
    };
}

export function internalHostname(serviceName: string): string {
    return `${serviceName}.internal`;
}
