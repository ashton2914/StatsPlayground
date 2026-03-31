/** Callback ref that repositions a context menu to stay within the viewport */
export function ctxMenuRef(el: HTMLDivElement | null) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width - 4)}px`;
  if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height - 4)}px`;
}
