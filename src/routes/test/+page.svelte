<script lang="ts">
    import codeIcon from "@ktibow/iconset-material-symbols/code";
    import pauseIcon from "@ktibow/iconset-material-symbols/pause";
    import playArrowIcon from "@ktibow/iconset-material-symbols/play-arrow";
    import skipNextIcon from "@ktibow/iconset-material-symbols/skip-next";
    import skipPreviousIcon from "@ktibow/iconset-material-symbols/skip-previous";
    import variablesIcon from "@ktibow/iconset-material-symbols/variables-outline";
    import { Button, ButtonGroup, Card, Icon } from "m3-svelte";

    type Size = "xs" | "s" | "m";

    let playing = $state(true);
    let view = $state(0);
    let size = $state<Size>("s");
    let spaced = $state(0);

    const iconSize = $derived(size === "m" ? 24 : 20);
</script>

<svelte:head>
    <title>Button group — Stoat</title>
</svelte:head>

<div class="bg-surface mx-auto flex min-h-svh p-6 md:p-10">
    <div class="mx-auto flex max-w-3xl flex-col gap-8">
        <header class="flex flex-col gap-1">
            <h1 class="text-on-surface text-2xl font-medium">Button group</h1>
            <p class="text-on-surface-variant text-sm">
                Selected is a stadium pill. The others stay circles. Hold any
                button to grow it and squish the corners.
            </p>
        </header>

        <Card variant="filled">
            <div class="flex flex-col items-center gap-6 px-6 py-10">
                <p class="text-on-surface-variant text-sm">Playback</p>
                <ButtonGroup selected={1} {size} aria-label="Playback controls">
                    <Button
                        variant="filled"
                        iconType="full"
                        {size}
                        aria-label="Previous"
                    >
                        <Icon icon={skipPreviousIcon} size={iconSize} />
                    </Button>
                    <Button
                        variant="filled"
                        iconType="full"
                        {size}
                        aria-pressed={playing}
                        aria-label={playing ? "Pause" : "Play"}
                        onclick={() => (playing = !playing)}
                    >
                        <Icon
                            icon={playing ? pauseIcon : playArrowIcon}
                            size={iconSize}
                        />
                    </Button>
                    <Button
                        variant="filled"
                        iconType="full"
                        {size}
                        aria-label="Next"
                    >
                        <Icon icon={skipNextIcon} size={iconSize} />
                    </Button>
                </ButtonGroup>
            </div>
        </Card>

        <section class="flex flex-col gap-3">
            <h2 class="text-on-surface text-lg font-medium">With labels</h2>
            <ButtonGroup selected={view} aria-label="Environment view">
                <Button
                    variant="filled"
                    iconType="left"
                    aria-pressed={view === 0}
                    onclick={() => (view = 0)}
                >
                    <Icon icon={variablesIcon} size={18} />
                    Variables
                </Button>
                <Button
                    variant="filled"
                    iconType="left"
                    aria-pressed={view === 1}
                    onclick={() => (view = 1)}
                >
                    <Icon icon={codeIcon} size={18} />
                    .env
                </Button>
            </ButtonGroup>
        </section>

        <section class="flex flex-col gap-3">
            <h2 class="text-on-surface text-lg font-medium">
                Standard spacing
            </h2>
            <p class="text-on-surface-variant text-sm">
                Wider gaps, same grow-on-select behavior.
            </p>
            <ButtonGroup
                variant="standard"
                selected={spaced}
                aria-label="Align"
            >
                <Button
                    variant="filled"
                    aria-pressed={spaced === 0}
                    onclick={() => (spaced = 0)}>Start</Button
                >
                <Button
                    variant="filled"
                    aria-pressed={spaced === 1}
                    onclick={() => (spaced = 1)}>Center</Button
                >
                <Button
                    variant="filled"
                    aria-pressed={spaced === 2}
                    onclick={() => (spaced = 2)}>End</Button
                >
            </ButtonGroup>
        </section>

        <section class="flex flex-col gap-3">
            <h2 class="text-on-surface text-lg font-medium">Size</h2>
            <ButtonGroup
                selected={["xs", "s", "m"].indexOf(size)}
                aria-label="Size"
            >
                <Button
                    variant="filled"
                    aria-pressed={size === "xs"}
                    onclick={() => (size = "xs")}>XS</Button
                >
                <Button
                    variant="filled"
                    aria-pressed={size === "s"}
                    onclick={() => (size = "s")}>S</Button
                >
                <Button
                    variant="filled"
                    aria-pressed={size === "m"}
                    onclick={() => (size = "m")}>M</Button
                >
            </ButtonGroup>
        </section>
    </div>
</div>
