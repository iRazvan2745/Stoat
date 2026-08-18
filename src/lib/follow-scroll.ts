// oxlint-disable func-style
import type { Attachment } from "svelte/attachments";

export function attachFollowScroll(
  shouldFollow: () => boolean,
  scrollToBottom?: (scroller: HTMLElement) => void,
): Attachment<HTMLElement> {
  return (content) => {
    const scroller = content.parentElement;

    if (!scroller) {
      return;
    }

    const align = (): void => {
      if (!shouldFollow()) {
        return;
      }

      if (scrollToBottom) {
        scrollToBottom(scroller);
        return;
      }

      scroller.scrollTop = scroller.scrollHeight;
    };

    const observer = new ResizeObserver(align);
    observer.observe(content);

    return (): void => {
      observer.disconnect();
    };
  };
}
