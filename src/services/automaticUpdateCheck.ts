interface StartedRef {
  current: boolean;
}

export function runAutomaticUpdateCheck(
  enabled: boolean,
  started: StartedRef,
  check: () => void,
): void {
  if (!enabled || started.current) {
    return;
  }
  started.current = true;
  check();
}