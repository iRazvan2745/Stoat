import type { RequestHandler } from "@sveltejs/kit";
import {
    assertGitOAuthOrigin,
    createGitOAuthFlow,
    getGitOAuthConnection,
    getGitOAuthCookieConfig,
    getOrganizationGitOAuthProviders,
    GitOAuthError,
    requireGitOAuthAdmin,
} from "@stoat/api/git-oauth";
import { getAuth, getDb } from "../../../../services";

export const POST: RequestHandler = async ({ request, cookies }) => {
    try {
        assertGitOAuthOrigin(request);
        const db = getDb();

        const session = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });

        const identity = await requireGitOAuthAdmin(db, session);

        if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
            throw new GitOAuthError("invalid_request");
        // Ordinary browser forms are urlencoded; bound the stream before parsing it.
        const reader = request.body?.getReader();

        if (!reader) throw new GitOAuthError("invalid_request");
        const chunks: Uint8Array[] = [];
        let size = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) break;
                size += value.byteLength;

                if (size > 8192) {
                    await reader.cancel();
                    throw new GitOAuthError("invalid_request");
                }

                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));

        if (
            [...form.keys()].some(
                (key) =>
                    !["organizationId", "providerId", "name", "connectionId"].includes(key) ||
                    form.getAll(key).length !== 1,
            )
        )
            throw new GitOAuthError("invalid_request");
        const organizationId = form.get("organizationId");

        if (!organizationId || organizationId.length > 256)
            throw new GitOAuthError("invalid_request");

        if (organizationId !== identity.organizationId) throw new GitOAuthError("forbidden");
        const providers = await getOrganizationGitOAuthProviders(db, identity.organizationId);
        const provider = providers.find((entry) => entry.id === form.get("providerId"));

        if (!provider) throw new GitOAuthError("configuration");
        const connectionId = form.get("connectionId") || undefined;
        let name = form.get("name")?.trim() ?? "";

        if (connectionId) {
            const connection = await getGitOAuthConnection(
                db,
                identity.organizationId,
                connectionId,
                provider,
            );

            name ||= connection.name;
        }

        const flow = createGitOAuthFlow(
            {
                ...identity,
                providerId: provider.id,
                name,
                connectionId,
            },
            providers,
        );

        const cookieConfig = getGitOAuthCookieConfig();
        cookies.set(cookieConfig.name, flow.cookie, cookieConfig.options);

        return new Response(null, {
            status: 303,
            headers: {
                location: flow.authorizationUrl,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
            },
        });
    } catch (error) {
        const code = error instanceof GitOAuthError ? error.code : "failed";

        return new Response(null, {
            status: 303,
            headers: {
                location: `/git?oauth=${code}`,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
            },
        });
    }
};
