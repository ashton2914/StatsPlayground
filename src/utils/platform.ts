const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl+";
export const shiftKey = isMac ? "⇧" : "Shift+";
