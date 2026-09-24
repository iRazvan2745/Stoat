import type { RequestHandler } from "@sveltejs/kit";
import {
    exchangeGitOAuthCode,
    getGitOAuthCallbackUrl,
    getGitOAuthCookieConfig,
    getOrganizationGitOAuthProviders,
    GitOAuthError,
    gitOAuthCookieName,
    gitOAuthCookieOptions,
    readGitOAuthFlow,
    requireGitOAuthAdmin,
    saveGitOAuthConnection,
} from "@stoat/api/git-oauth";
import { getAuth, getDb } from "../../../../services";

export const GET: RequestHandler = async ({ request, url, cookies }) => {
    let cookieConfig = { name: gitOAuthCookieName, options: gitOAuthCookieOptions };
    let result = "success";

    try {
        cookieConfig = getGitOAuthCookieConfig();
        const cookie = cookies.get(cookieConfig.name);
        const callback = new URL(getGitOAuthCallbackUrl());

        if (
            request.method !== "GET" ||
            url.origin !== callback.origin ||
            url.pathname !== callback.pathname ||
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.getAll("code").length !== 1 ||
            url.searchParams.has("error")
        )
            throw new GitOAuthError("invalid_request");
        const db = getDb();

        const session = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });

        const identity = await requireGitOAuthAdmin(db, session);
        const providers = await getOrganizationGitOAuthProviders(db, identity.organizationId);
        const flow = readGitOAuthFlow(cookie, url.searchParams.get("state"), identity, providers);
        const account = await exchangeGitOAuthCode(flow, url.searchParams.get("code")!, providers);

        // Recheck the live session after the provider request, not a cached browser session.
        const currentSession = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });

        const currentIdentity = await requireGitOAuthAdmin(db, currentSession);
        readGitOAuthFlow(
            cookie,
            url.searchParams.get("state"),
            currentIdentity,
            await getOrganizationGitOAuthProviders(db, currentIdentity.organizationId),
        );
        await saveGitOAuthConnection(db, flow, account);
    } catch (error) {
        // Never reflect provider errors, authorization codes, or credentials into logs or URLs.
        result = error instanceof GitOAuthError ? error.code : "failed";
    } finally {
        // Configuration failures clear only the secure cookie, never enable a local fallback.
        cookies.delete(cookieConfig.name, cookieConfig.options);
    }

    return new Response(null, {
        status: 303,
        headers: {
            location: `/git?oauth=${result}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
        },
    });
};
