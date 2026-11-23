/**
 * A worker started by runOwned with `ownerLink` reads EOF on stdin when its
 * owner dies, including by SIGKILL, which no exit hook can observe. It then
 * kills its own process group, so a killed command leaves no worker holding
 * its locks. This is an explicit end-of-file event, never a timer.
 */
export function exitWithOwner(): void {
  if (process.env.BEELINE_OWNER_LINK !== '1') return;
  process.stdin.resume();
  process.stdin.on('end', () => {
    try {
      process.kill(0, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  });
  // The link must not keep a finished worker alive.
  process.stdin.unref?.();
}
