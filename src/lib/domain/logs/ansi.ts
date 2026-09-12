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

function readCsiSequence(value: string, start: number): EscapeSequence {
    let cursor = start;

    while (cursor < value.length) {
        const code = value.codePointAt(cursor) ?? 0;

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

function readEscapeSequence(
    value: string,
    index: number
): EscapeSequence | null {
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
    return (
        value !== undefined &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255
    );
}

function readExtendedColor(
    parameters: number[],
    index: number
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

        if (
            validColorComponent(red) &&
            validColorComponent(green) &&
            validColorComponent(blue)
        ) {
            return {
                color: { blue, green, kind: "rgb", red },
                consumed: 4,
            };
        }
    }

    return null;
}

const applySgrFlags = (
    style: AnsiLogStyle,
    code: number
): AnsiLogStyle | undefined => {
    switch (code) {
        case 0: {
            return defaultStyle();
        }
        case 1: {
            return { ...style, bold: true };
        }
        case 2: {
            return { ...style, dim: true };
        }
        case 3: {
            return { ...style, italic: true };
        }
        case 4: {
            return { ...style, underline: true };
        }
        case 7: {
            return { ...style, inverse: true };
        }
        case 9: {
            return { ...style, strikethrough: true };
        }
        case 22: {
            return { ...style, bold: false, dim: false };
        }
        case 23: {
            return { ...style, italic: false };
        }
        case 24: {
            return { ...style, underline: false };
        }
        case 27: {
            return { ...style, inverse: false };
        }
        case 29: {
            return { ...style, strikethrough: false };
        }
        case 39: {
            return { ...style, foreground: undefined };
        }
        case 49: {
            return { ...style, background: undefined };
        }
        default: {
            return undefined;
        }
    }
};

const namedColorForCode = (
    code: number
):
    | { name: AnsiNamedColor; target: "background" | "foreground" }
    | undefined => {
    if (code >= 30 && code <= 37) {
        const name = STANDARD_COLORS[code - 30];
        return name ? { name, target: "foreground" } : undefined;
    }

    if (code >= 40 && code <= 47) {
        const name = STANDARD_COLORS[code - 40];
        return name ? { name, target: "background" } : undefined;
    }

    if (code >= 90 && code <= 97) {
        const name = BRIGHT_COLORS[code - 90];
        return name ? { name, target: "foreground" } : undefined;
    }

    if (code >= 100 && code <= 107) {
        const name = BRIGHT_COLORS[code - 100];
        return name ? { name, target: "background" } : undefined;
    }

    return undefined;
};

const applyNamedColor = (
    style: AnsiLogStyle,
    code: number
): AnsiLogStyle | undefined => {
    const color = namedColorForCode(code);
    return color
        ? {
              ...style,
              [color.target]: { kind: "named", name: color.name },
          }
        : undefined;
};

const applyExtendedSgrColor = (
    style: AnsiLogStyle,
    parameters: number[],
    index: number,
    code: number
): { consumed: number; style: AnsiLogStyle } | undefined => {
    if (code !== 38 && code !== 48) {
        return undefined;
    }

    const extended = readExtendedColor(parameters, index);
    if (!extended) {
        return undefined;
    }

    return {
        consumed: extended.consumed,
        style: {
            ...style,
            [code === 38 ? "foreground" : "background"]: extended.color,
        },
    };
};

function applySgr(style: AnsiLogStyle, parameterText: string): AnsiLogStyle {
    const parameters = parseSgrParameters(parameterText);
    let next = { ...style };

    for (let index = 0; index < parameters.length; index += 1) {
        const code = parameters[index];

        if (code === undefined || !Number.isInteger(code)) {
            continue;
        }

        const flags = applySgrFlags(next, code);
        if (flags) {
            next = flags;
            continue;
        }

        const namedColor = applyNamedColor(next, code);
        if (namedColor) {
            next = namedColor;
            continue;
        }

        const extendedColor = applyExtendedSgrColor(
            next,
            parameters,
            index,
            code
        );
        if (extendedColor) {
            next = extendedColor.style;
            index += extendedColor.consumed;
        }
    }

    return next;
}

function sameColor(
    left: AnsiColor | undefined,
    right: AnsiColor | undefined
): boolean {
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
    const code = character.codePointAt(0) ?? 0;

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

        if (
            character === "\r" ||
            (character && isControlCharacter(character))
        ) {
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
