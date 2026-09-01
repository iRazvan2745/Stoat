import { snackbar } from "m3-svelte";

interface CopyMessages {
    success?: string;
    failure?: string;
}

/** Copies text to the clipboard and reports the outcome via a snackbar. */
export async function copyToClipboard(value: string, messages?: CopyMessages): Promise<void> {
    try {
        await navigator.clipboard.writeText(value);
        snackbar(messages?.success ?? "Copied to clipboard");
    } catch {
        snackbar(messages?.failure ?? "Unable to copy");
    }
}
