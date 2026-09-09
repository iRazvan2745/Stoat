<script lang="ts">
    import { getResource } from "#lib/api/resources.remote";

    const props = $props();

    // svelte-ignore state_referenced_locally
    const svc = await getResource(props.resourceId);
</script>

<div
    class="text-on-surface-variant m3-font-body-large m-0 overflow-x-auto px-3 py-1 font-mono whitespace-pre"
    aria-hidden="true"
>
    {`⠀⠀⠀        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣦⣄⠀
        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣿⣿⠟⠀
        ⠀⠀⠀⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣷⣶⣶⣶⣾⣿⣿⣿⣿⡏⠀⠀⠀⠀⠀
        ⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀ Stoat - Infrastructure as it
        ⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀⠀⠀⠀              should be
        ⠀⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠉⠁⠀⠀⠈⠙⠿⣿⣧⡀⠀⠀⠀⠀⠀⠀
        ⣰⣿⣿⠛⠁⠿⣿⣿⣿⣟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⣦⠀⠀⠀⠀⠀ Deploying ${svc?.name ?? svc?.slug ?? "ggs, couldnt get a name n'or a slug"}
        ⣰⣿⠟⠀⠀⠀⠀⠀⠉⠛⠿⠆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
        ⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
        `}
</div>
