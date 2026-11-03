/** A click may start this run once; cancellation cannot be undone by a late request. */
export function createStartGate() {
  let settle: (started: boolean) => void;
  let settled = false;
  const wait = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const finish = (started: boolean) => {
    if (settled) return;
    settled = true;
    settle(started);
  };
  return { wait, start: () => finish(true), cancel: () => finish(false) };
}
