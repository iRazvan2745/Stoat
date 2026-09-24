<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";

    let {
        label,
        value,
        secret = false,
    }: {
        label: string;
        value: string;
        secret?: boolean;
    } = $props();

    let revealed = $state(false);

    let copied = $state(false);

    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    const displayValue = $derived(secret && !revealed ? "••••••••••••" : value);

    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            // Leave the value selectable without claiming a failed copy succeeded.
            return;
        }

        copied = true;

        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => (copied = false), 1500);
    }

    function selectAll(event: Event) {
        if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.select();
    }
</script>

<Field>
    <Label>{label}</Label>
    <InputGroup>
        <InputGroupInput readonly value={displayValue} class="font-mono" onclick={selectAll} />
        <InputGroupAddon align="inline-end">
            {#if secret}
                <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => (revealed = !revealed)}
                    aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
                >
                    {revealed ? "Hide" : "Show"}
                </Button>
            {/if}
            <Button
                variant="ghost"
                size="icon-sm"
                onclick={copy}
                aria-label={`Copy ${label}`}
                title={`Copy ${label}`}
            >
                {#if copied}
                    <Check class="text-success-foreground" aria-hidden="true" />
                {:else}
                    <Copy aria-hidden="true" />
                {/if}
            </Button>
        </InputGroupAddon>
    </InputGroup>
</Field>
