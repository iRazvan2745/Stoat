<script lang="ts">
    import { getService } from "#lib/api/services.remote";

    const props = $props();

    // svelte-ignore state_referenced_locally
    const svc = await getService(props.serviceId);
</script>

<div
    class="text-on-surface-variant m-0 overflow-x-auto px-3 py-1 font-mono text-[1rem] whitespace-pre"
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
