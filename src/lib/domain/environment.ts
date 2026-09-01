// oxlint-disable func-style
export interface EnvironmentVariable {
    name: string;
    value: string;
}

export interface ParsedEnvFile {
    errors: string[];
    variables: EnvironmentVariable[];
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function isValidEnvName(name: string): boolean {
    return ENV_NAME_PATTERN.test(name);
}

export function quoteEnvValue(value: string): string {
    if (value === "") {
        return "";
    }

    const needsQuotes = /[\s#"'$`\\]/u.test(value);

    if (!needsQuotes) {
        return value;
    }

    const escaped = value.replaceAll(/[\\"\n]/gu, (character) => {
        if (character === "\n") {
            return "\\n";
        }

        return `\\${character}`;
    });

    return `"${escaped}"`;
}

export function unquoteEnvValue(raw: string): string {
    const trimmed = raw.trim();

    if (trimmed.length >= 2) {
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.slice(1, -1).replaceAll(/\\[\\"n]/gu, (sequence) => {
                if (sequence === "\\n") {
                    return "\n";
                }

                return sequence.slice(1);
            });
        }

        if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
            return trimmed.slice(1, -1);
        }
    }

    const commentIndex = trimmed.indexOf(" #");

    if (commentIndex !== -1) {
        return trimmed.slice(0, commentIndex).trim();
    }

    return trimmed;
}

export function serializeEnvFile(variables: readonly EnvironmentVariable[]): string {
    return variables
        .map((variable) => ({
            name: variable.name.trim(),
            value: variable.value,
        }))
        .filter((variable) => variable.name !== "")
        .map((variable) => `${variable.name}=${quoteEnvValue(variable.value)}`)
        .join("\n");
}

export function parseEnvFile(source: string): ParsedEnvFile {
    const variables: EnvironmentVariable[] = [];
    const errors: string[] = [];
    const names = new Set<string>();
    const lines = source.split(/\r?\n/u);

    for (const [index, rawLine] of lines.entries()) {
        const lineNumber = index + 1;
        const trimmed = rawLine.trim();

        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }

        let line = trimmed;

        if (line.startsWith("export ")) {
            line = line.slice("export ".length).trim();
        }

        const separatorIndex = line.indexOf("=");

        if (separatorIndex === -1) {
            errors.push(`Line ${lineNumber}: missing "="`);
            continue;
        }

        const name = line.slice(0, separatorIndex).trim();

        if (!isValidEnvName(name)) {
            errors.push(`Line ${lineNumber}: invalid name "${name}"`);
            continue;
        }

        if (names.has(name)) {
            errors.push(`Line ${lineNumber}: duplicate name "${name}"`);
            continue;
        }

        names.add(name);
        variables.push({
            name,
            value: unquoteEnvValue(line.slice(separatorIndex + 1)),
        });
    }

    return { errors, variables };
}

export function normalizeEnvironmentVariables(
    variables: readonly EnvironmentVariable[],
): EnvironmentVariable[] {
    return variables
        .map((variable) => ({
            name: variable.name.trim(),
            value: variable.value,
        }))
        .filter((variable) => variable.name !== "");
}

export function validateEnvironmentVariables(variables: readonly EnvironmentVariable[]): string[] {
    const errors: string[] = [];
    const names = new Set<string>();

    for (const variable of normalizeEnvironmentVariables(variables)) {
        if (!isValidEnvName(variable.name)) {
            errors.push(`Invalid name "${variable.name}"`);
            continue;
        }

        if (names.has(variable.name)) {
            errors.push(`Duplicate name "${variable.name}"`);
            continue;
        }

        names.add(variable.name);
    }

    return errors;
}
