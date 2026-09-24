<script lang="ts">
    let { provider }: { provider: string } = $props();
</script>

{#if provider === "github"}
    <img src="/icons/github-light.svg" alt="" aria-hidden="true" class="size-4 shrink-0 dark:hidden" />
    <img src="/icons/github-dark.svg" alt="" aria-hidden="true" class="hidden size-4 shrink-0 dark:block" />
{:else if provider === "gitea"}
    <img src="/icons/gitea.svg" alt="" aria-hidden="true" class="size-4 shrink-0" />
{:else if provider === "forgejo"}
    <img src="/icons/forgejo.svg" alt="" aria-hidden="true" class="size-4 shrink-0" />
{:else}
    <img src="/icons/git.svg" alt="" aria-hidden="true" class="size-4 shrink-0" />
{/if}
