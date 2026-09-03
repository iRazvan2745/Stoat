<script lang="ts">
    import type {
        AnsiColor,
        AnsiLogSegment,
        AnsiLogStyle,
        AnsiNamedColor,
    } from "#lib/domain/logs/ansi";

    interface Props {
        segments: readonly AnsiLogSegment[];
    }

    let { segments }: Props = $props();

    const NAMED_COLORS: Record<AnsiNamedColor, string> = {
        black: "light-dark(#454545, #b7b7b7)",
        blue: "light-dark(#075985, #7ab8ff)",
        brightBlack: "light-dark(#6b7280, #a1a1aa)",
        brightBlue: "light-dark(#075985, #a9d1ff)",
        brightCyan: "light-dark(#007c83, #9af1f3)",
        brightGreen: "light-dark(#218739, #9be7a5)",
        brightMagenta: "light-dark(#b83299, #f3c4ff)",
        brightRed: "light-dark(#c92a2a, #ffaaa5)",
        brightWhite: "light-dark(#ffffff, #ffffff)",
        brightYellow: "light-dark(#8a6100, #ffe08a)",
        cyan: "light-dark(#006d77, #5fd9e8)",
        green: "light-dark(#18794e, #6dd58c)",
        magenta: "light-dark(#9b2c84, #e5a8ff)",
        red: "light-dark(#b42318, #ff897d)",
        white: "light-dark(#f5f5f5, #f5f5f5)",
        yellow: "light-dark(#8a6100, #f6c344)",
    };

    const XTERM_COLORS = [
        "#000000",
        "#cd0000",
        "#00cd00",
        "#cdcd00",
        "#0000ee",
        "#cd00cd",
        "#00cdcd",
        "#e5e5e5",
        "#7f7f7f",
        "#ff0000",
        "#00ff00",
        "#ffff00",
        "#5c5cff",
        "#ff00ff",
        "#00ffff",
        "#ffffff",
    ];

    function indexedColorToCss(index: number): string {
        const color = XTERM_COLORS[index];

        if (color) {
            return color;
        }

        if (index >= 16 && index <= 231) {
            const cubeIndex = index - 16;
            const red = Math.floor(cubeIndex / 36);
            const green = Math.floor((cubeIndex % 36) / 6);
            const blue = cubeIndex % 6;
            const channel = (value: number): number =>
                value === 0 ? 0 : 55 + value * 40;

            return `rgb(${channel(red)} ${channel(green)} ${channel(blue)})`;
        }

        if (index >= 232 && index <= 255) {
            const shade = 8 + (index - 232) * 10;
            return `rgb(${shade} ${shade} ${shade})`;
        }

        return "currentColor";
    }

    function colorToCss(color: AnsiColor | undefined): string | undefined {
        if (!color) {
            return undefined;
        }

        if (color.kind === "named") {
            return NAMED_COLORS[color.name];
        }

        if (color.kind === "indexed") {
            return indexedColorToCss(color.index);
        }

        return `rgb(${color.red} ${color.green} ${color.blue})`;
    }

    function getStyle(style: AnsiLogStyle): string | undefined {
        const declarations: string[] = [];
        const foreground = style.inverse ? style.background : style.foreground;
        const background = style.inverse ? style.foreground : style.background;
        const foregroundColor = colorToCss(foreground);
        const backgroundColor = colorToCss(background);

        if (foregroundColor) {
            declarations.push(`color: ${foregroundColor}`);
        } else if (style.inverse) {
            declarations.push("color: var(--m3c-surface)");
        }

        if (backgroundColor) {
            declarations.push(`background-color: ${backgroundColor}`);
        } else if (style.inverse) {
            declarations.push("background-color: var(--m3c-on-surface)");
        }

        if (style.bold) {
            declarations.push("font-weight: 600");
        }

        if (style.dim) {
            declarations.push("opacity: 0.72");
        }

        if (style.italic) {
            declarations.push("font-style: italic");
        }

        const decorations = [
            style.strikethrough ? "line-through" : "",
            style.underline ? "underline" : "",
        ].filter(Boolean);

        if (decorations.length > 0) {
            declarations.push(`text-decoration: ${decorations.join(" ")}`);
        }

        return declarations.length > 0 ? declarations.join("; ") : undefined;
    }
</script>

{#each segments as segment}
    <span style={getStyle(segment.style)}>{segment.text}</span>
{/each}
