import { runOwned } from './wait.js';

// pidfd/kqueue are kernel exit notifications, with no polling or timeout.
const WAIT = `import os,sys,select
pid=int(sys.argv[1])
try:
 if hasattr(os,'pidfd_open'):
  fd=os.pidfd_open(pid)
  try: select.select([fd,sys.stdin],[],[])
  finally: os.close(fd)
 else:
  queue=select.kqueue()
  try: queue.control([select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT),select.kevent(sys.stdin.fileno(),filter=select.KQ_FILTER_READ,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT)],1)
  finally: queue.close()
except ProcessLookupError: pass
`;
export async function waitForProcessExit(pid:number,signal?:AbortSignal):Promise<void>{
  const child = await runOwned({ step: 'process exit observer', file: '/usr/bin/python3',
    args: ['-c', WAIT, String(pid)], ownerLink: true, ...(signal ? { signal } : {}) });
  if (child.code !== 0) throw new Error(`process exit observer failed (${child.code ?? child.signal})`);
}
