import { createAttachmentKey } from "svelte/attachments";

/**
 * Creates a stable attachment (key + callback) once per component instance.
 * The returned function merges the attachment into a props object; only the
 * props change reactively, so the DOM element is never detached/reattached
 * when unrelated props update.
 */
export function createElementAttachment<T extends HTMLElement>(
  setter: (element: T | null) => void | (() => void),
) {
  const key = createAttachmentKey();

  const attachment = (element: T) => {
    const teardown = setter(element);
    return () => {
      teardown?.();
      setter(null);
    };
  };

  return <P extends Record<string, unknown>>(props: P): P =>
    ({
      ...props,
      [key]: attachment,
    }) as P;
}
