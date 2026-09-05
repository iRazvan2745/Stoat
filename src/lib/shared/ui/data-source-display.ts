/**
 * Values returned by the data-source APIs are intentionally kept opaque to
 * the UI. This small presentation layer makes it safe to render both the
 * current shape and the Git Source shape while the API evolves.
 */
export interface DataSourcePresentation {
    gitRepository: string | null;
    gitSource: string;
    uncloudUrl: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Remove URL userinfo before displaying a repository URL. This is a
 * client-side defence in depth: credentials should already be excluded from
 * API responses, but old data can still contain an embedded token.
 */
export const redactDisplayedUrl = (value: string | null | undefined): string => {
    if (!value) {
        return "";
    }

    try {
        const parsed = new URL(value);
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    } catch {
        // SCP-style SSH URLs (git@host:org/repo.git) are not valid URL input.
        return value.replace(/^(?:[^@/]+)@/u, "");
    }
};

const sourceName = (source: Record<string, unknown>): string | null => {
    const nested = isRecord(source.gitSource) ? source.gitSource : undefined;

    return (
        asString(source.gitSourceName) ??
        asString(source.git_source_name) ??
        asString(nested?.name) ??
        asString(nested?.label)
    );
};

const sourceUrl = (source: Record<string, unknown>): string | null => {
    const nested = isRecord(source.gitSource) ? source.gitSource : undefined;

    return (
        asString(source.gitUrl) ??
        asString(source.repositoryUrl) ??
        asString(source.repositoryURL) ??
        asString(nested?.url) ??
        asString(nested?.gitUrl)
    );
};

/** Return safe, human-readable labels for any supported data-source shape. */
export const presentDataSource = (value: unknown): DataSourcePresentation => {
    const source = isRecord(value) ? value : {};
    const repositoryUrl = sourceUrl(source);
    const name = sourceName(source);

    return {
        gitRepository: repositoryUrl ? redactDisplayedUrl(repositoryUrl) : null,
        gitSource: name ?? (repositoryUrl ? redactDisplayedUrl(repositoryUrl) : "Not assigned"),
        uncloudUrl: asString(source.uncloudUrl) ?? "Unknown endpoint",
    };
};

export const hasGitRepository = (value: unknown): boolean =>
    presentDataSource(value).gitRepository !== null;

/** A compact label for workspace cards and pickers. */
export const dataSourceLabel = (value: unknown): string => {
    const presentation = presentDataSource(value);
    return presentation.gitSource === "Not assigned"
        ? presentation.uncloudUrl
        : presentation.gitSource;
};

/** Safely render a data-source label returned in an overview/workspace row. */
export const presentWorkspaceDataSource = (value: unknown): string => {
    if (!isRecord(value)) {
        return "Data source";
    }

    const nested = isRecord(value.gitSource) ? value.gitSource : undefined;
    const label =
        sourceName(value) ??
        asString(value.gitSourceLabel) ??
        asString(value.dataSourceLabel) ??
        asString(value.gitUrl) ??
        asString(nested?.url) ??
        asString(value.uncloudUrl);

    return label ? redactDisplayedUrl(label) : "Data source";
};
