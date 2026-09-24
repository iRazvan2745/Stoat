<script lang="ts">
    import { authClient } from "$lib/auth-client";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "$lib/components/ui/dialog";
    import { Field, FieldDescription } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { watch } from "runed";

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let name = $state("");

    let slug = $state("");

    let slugTouched = $state(false);

    let logoUrl = $state("");

    let pending = $state(false);

    let error = $state("");

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) resetForm();
        },
    );

    function slugify(value: string) {
        return value
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .replace(/-{2,}/g, "-");
    }

    function onNameInput(value: string) {
        name = value;

        if (!slugTouched) slug = slugify(value);
    }

    function resetForm() {
        name = "";
        slug = "";
        slugTouched = false;
        logoUrl = "";
        error = "";
    }

    async function createOrganization(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";

        try {
            const result = await authClient.organization.create({
                name: name.trim(),
                slug: slug.trim(),
                logo: logoUrl.trim() || undefined,
                keepCurrentActiveOrganization: false,
            });

            if (result.error) { error = result.error.message ?? "Unable to create organization.";

 return; }

            window.location.assign("/");
        } catch { error = "Unable to connect. Try again."; }
        finally { pending = false; }
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>Add a new organization to manage projects and team members.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if error}
                <Alert variant="error" class="mb-4"><AlertDescription>{error}</AlertDescription></Alert>
            {/if}
            <form id="create-organization-form" onsubmit={createOrganization} class="space-y-4" aria-busy={pending}>
                <Field>
                    <Label for="org-name" required>Name</Label>
                    <Input id="org-name" value={name} oninput={(event) => onNameInput(event.currentTarget.value)} placeholder="Acme Corp" required maxlength={100} pattern=".*\S.*" disabled={pending} />
                </Field>
                <Field>
                    <Label for="org-slug" required>Slug</Label>
                    <Input id="org-slug" bind:value={slug} oninput={() => { slugTouched = true; }} placeholder="acme-corp" required minlength={2} maxlength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-describedby="org-slug-help" disabled={pending} />
                    <FieldDescription id="org-slug-help">This will be used in your organization URL.</FieldDescription>
                </Field>
                <Field>
                    <Label for="org-logo">Logo URL</Label>
                    <Input id="org-logo" bind:value={logoUrl} type="url" placeholder="https://…" disabled={pending} />
                    <FieldDescription>A direct link to your organization's logo.</FieldDescription>
                </Field>
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" disabled={pending} onclick={() => { open = false; }}>Cancel</Button>
            <Button type="submit" form="create-organization-form" loading={pending}>Create Organization</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
