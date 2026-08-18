<script lang="ts">
    import { getService } from "#lib/api/services.remote";

    const props = $props();

    // svelte-ignore state_referenced_locally
    const svc = await getService(props.serviceId);
</script>

<div
    class="deployment-log-banner text-on-surface-variant m-0 overflow-x-auto p-0.5 pb-0.75 whitespace-pre select-none"
    aria-hidden="true"
>
    {`
    
    ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣦⣄⠀
⠀   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣿⣿⠟⠀
⠀   ⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣷⣶⣶⣶⣾⣿⣿⣿⣿⡏⠀⠀⠀⠀⠀
⠀   ⠀⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀Stoat - Infrastructure as it
⠀   ⠀⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀⠀⠀⠀             should be
   ⠀⠀⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠉⠁⠀⠀⠈⠙⠿⣿⣧⡀⠀⠀⠀⠀⠀⠀
   ⠀⣰⣿⣿⠛⠁⠿⣿⣿⣿⣟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⣦⠀⠀⠀⠀⠀Deploying ${svc?.name ?? svc?.slug ?? "ggs, couldnt get a name n'or a slug"}
   ⣰⣿⠟⠀⠀⠀⠀⠀⠉⠛⠿⠆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
   ⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
   ⢹⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
   ⠀⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀

   `}
</div>
