import createClient from "openapi-fetch";

import type { paths } from "../../../../schema";
import { fetchUncloud, fetchUncloudStream } from "./fetch";

export interface UncloudConnection {
    uncloudToken: string | null;
    uncloudUrl: string;
}

const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;

export const normalizeUncloudUrl = (value: string): string => {
    const url = value.trim().replace(/\/+$/u, "");

    return URL_SCHEME_PATTERN.test(url) ? url : `http://${url}`;
};

const authorizationHeaders = (token: string | null): Record<string, string> | undefined =>
    token ? { Authorization: `Bearer ${token}` } : undefined;

export const createUncloudClient = (connection: UncloudConnection) =>
    createClient<paths>({
        baseUrl: normalizeUncloudUrl(connection.uncloudUrl),
        fetch: fetchUncloud,
        headers: authorizationHeaders(connection.uncloudToken),
    });

/**
 * Client for endpoints that stream their response body. The timeout only
 * applies until headers arrive, so streams are not killed mid-read.
 */
export const createUncloudStreamClient = (connection: UncloudConnection) =>
    createClient<paths>({
        baseUrl: normalizeUncloudUrl(connection.uncloudUrl),
        fetch: fetchUncloudStream,
        headers: authorizationHeaders(connection.uncloudToken),
    });
