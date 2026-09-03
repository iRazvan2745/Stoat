// oxlint-disable func-style

export type AnsiNamedColor =
    | "black"
    | "blue"
    | "brightBlack"
    | "brightBlue"
    | "brightCyan"
    | "brightGreen"
    | "brightMagenta"
    | "brightRed"
    | "brightWhite"
    | "brightYellow"
    | "cyan"
    | "green"
    | "magenta"
    | "red"
    | "white"
    | "yellow";

export type AnsiColor =
    | { kind: "indexed"; index: number }
    | { kind: "named"; name: AnsiNamedColor }
    | { blue: number; green: number; kind: "rgb"; red: number };

export interface AnsiLogStyle {
    background?: AnsiColor;
    bold: boolean;
    dim: boolean;
    foreground?: AnsiColor;
    inverse: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
}

export interface AnsiLogSegment {
    style: AnsiLogStyle;
    text: string;
}

export type AnsiLogLine = AnsiLogSegment[];

type EscapeSequence =
    | { end: number; kind: "csi"; parameters: string; final: string }
    | { end: number; kind: "control" };

const ESCAPE = "\u001B";
const CSI = "\u009B";
const BELL = "\u0007";

const STANDARD_COLORS: readonly AnsiNamedColor[] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
];

const BRIGHT_COLORS: readonly AnsiNamedColor[] = [
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

function defaultStyle(): AnsiLogStyle {
    return {
        bold: false,
        dim: false,
        inverse: false,
        italic: false,
        strikethrough: false,
        underline: false,
    };
}

function readEscapeSequence(value: string, index: number): EscapeSequence | null {
    const first = value[index];

    if (first === CSI) {
        return readCsiSequence(value, index + 1);
    }

    if (first !== ESCAPE) {
        return null;
    }

    const next = value[index + 1];

    if (next === "[") {
        return readCsiSequence(value, index + 2);
    }

    if (next === "]") {
        let cursor = index + 2;

        while (cursor < value.length) {
            const character = value[cursor];

            if (character === BELL) {
                return { end: cursor + 1, kind: "control" };
            }

            if (character === ESCAPE && value[cursor + 1] === "\\") {
                return { end: cursor + 2, kind: "control" };
            }

            cursor += 1;
        }

        return { end: value.length, kind: "control" };
    }

    return {
        end: Math.min(index + 2, value.length),
        kind: "control",
    };
}

function readCsiSequence(value: string, start: number): EscapeSequence {
    let cursor = start;

    while (cursor < value.length) {
        const code = value.charCodeAt(cursor);

        if (code >= 0x40 && code <= 0x7e) {
            return {
                end: cursor + 1,
                final: value[cursor] ?? "",
                kind: "csi",
                parameters: value.slice(start, cursor),
            };
        }

        cursor += 1;
    }

    return { end: value.length, kind: "control" };
}

function parseSgrParameters(parameters: string): number[] {
    if (!parameters) {
        return [0];
    }

    const parsed = parameters
        .split(/[;:]/u)
        .filter((parameter) => parameter.length > 0)
        .map(Number);

    return parsed.length > 0 ? parsed : [0];
}

function validColorComponent(value: number | undefined): value is number {
    return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
}

function readExtendedColor(
    parameters: number[],
    index: number,
): { color: AnsiColor; consumed: number } | null {
    const mode = parameters[index + 1];

    if (mode === 5) {
        const colorIndex = parameters[index + 2];

        if (colorIndex !== undefined && Number.isInteger(colorIndex)) {
            return {
                color: {
                    index: Math.max(0, Math.min(255, colorIndex)),
                    kind: "indexed",
                },
                consumed: 2,
            };
        }
    }

    if (mode === 2) {
        const red = parameters[index + 2];
        const green = parameters[index + 3];
        const blue = parameters[index + 4];

        if (validColorComponent(red) && validColorComponent(green) && validColorComponent(blue)) {
            return {
                color: { blue, green, kind: "rgb", red },
                consumed: 4,
            };
        }
    }

    return null;
}

function applySgr(style: AnsiLogStyle, parameterText: string): AnsiLogStyle {
    const parameters = parseSgrParameters(parameterText);
    let next = { ...style };

    for (let index = 0; index < parameters.length; index += 1) {
        const code = parameters[index];

        if (code === undefined || !Number.isInteger(code)) {
            continue;
        }

        if (code === 0) {
            next = defaultStyle();
            continue;
        }

        if (code === 1) {
            next.bold = true;
            continue;
        }

        if (code === 2) {
            next.dim = true;
            continue;
        }

        if (code === 3) {
            next.italic = true;
            continue;
        }

        if (code === 4) {
            next.underline = true;
            continue;
        }

        if (code === 7) {
            next.inverse = true;
            continue;
        }

        if (code === 9) {
            next.strikethrough = true;
            continue;
        }

        if (code === 22) {
            next.bold = false;
            next.dim = false;
            continue;
        }

        if (code === 23) {
            next.italic = false;
            continue;
        }

        if (code === 24) {
            next.underline = false;
            continue;
        }

        if (code === 27) {
            next.inverse = false;
            continue;
        }

        if (code === 29) {
            next.strikethrough = false;
            continue;
        }

        if (code === 39) {
            next.foreground = undefined;
            continue;
        }

        if (code === 49) {
            next.background = undefined;
            continue;
        }

        if (code >= 30 && code <= 37) {
            const name = STANDARD_COLORS[code - 30];

            if (name) {
                next.foreground = { kind: "named", name };
            }

            continue;
        }

        if (code >= 40 && code <= 47) {
            const name = STANDARD_COLORS[code - 40];

            if (name) {
                next.background = { kind: "named", name };
            }

            continue;
        }

        if (code >= 90 && code <= 97) {
            const name = BRIGHT_COLORS[code - 90];

            if (name) {
                next.foreground = { kind: "named", name };
            }

            continue;
        }

        if (code >= 100 && code <= 107) {
            const name = BRIGHT_COLORS[code - 100];

            if (name) {
                next.background = { kind: "named", name };
            }

            continue;
        }

        if (code === 38 || code === 48) {
            const extended = readExtendedColor(parameters, index);

            if (extended) {
                if (code === 38) {
                    next.foreground = extended.color;
                } else {
                    next.background = extended.color;
                }

                index += extended.consumed;
            }
        }
    }

    return next;
}

function sameColor(left: AnsiColor | undefined, right: AnsiColor | undefined): boolean {
    if (left === right) {
        return true;
    }

    if (!left || !right || left.kind !== right.kind) {
        return false;
    }

    if (left.kind === "named" && right.kind === "named") {
        return left.name === right.name;
    }

    if (left.kind === "indexed" && right.kind === "indexed") {
        return left.index === right.index;
    }

    return (
        left.kind === "rgb" &&
        right.kind === "rgb" &&
        left.red === right.red &&
        left.green === right.green &&
        left.blue === right.blue
    );
}

function sameStyle(left: AnsiLogStyle, right: AnsiLogStyle): boolean {
    return (
        left.bold === right.bold &&
        left.dim === right.dim &&
        left.inverse === right.inverse &&
        left.italic === right.italic &&
        left.strikethrough === right.strikethrough &&
        left.underline === right.underline &&
        sameColor(left.foreground, right.foreground) &&
        sameColor(left.background, right.background)
    );
}

function isControlCharacter(character: string): boolean {
    const code = character.charCodeAt(0);

    return (code < 0x20 && code !== 0x09 && code !== 0x0d) || code === 0x7f;
}

export function parseAnsiLogLines(value: string): AnsiLogLine[] {
    const lines: AnsiLogLine[] = [[]];
    let style = defaultStyle();
    let text = "";

    const flushText = (): void => {
        if (!text) {
            return;
        }

        const line = lines.at(-1);

        if (!line) {
            return;
        }

        const previous = line.at(-1);

        if (previous && sameStyle(previous.style, style)) {
            previous.text += text;
        } else {
            line.push({ style, text });
        }

        text = "";
    };

    for (let index = 0; index < value.length; index += 1) {
        const escape = readEscapeSequence(value, index);

        if (escape) {
            flushText();

            if (escape.kind === "csi" && escape.final === "m") {
                style = applySgr(style, escape.parameters);
            }

            index = escape.end - 1;
            continue;
        }

        const character = value[index];

        if (character === "\n") {
            flushText();
            lines.push([]);
            continue;
        }

        if (character === "\r" || (character && isControlCharacter(character))) {
            continue;
        }

        if (character) {
            text += character;
        }
    }

    flushText();

    return lines;
}

export function stripAnsi(value: string): string {
    return parseAnsiLogLines(value)
        .map((line) => line.map((segment) => segment.text).join(""))
        .join("\n");
}
