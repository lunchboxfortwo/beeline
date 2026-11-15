// Existing SSH -> libvirt guest-agent transport. No guest listener or login changes.
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const WINDOWS_HOST = 'do@100.126.74.60';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const bridge = String.raw`
import base64,json,sys,libvirt,libvirt_qemu
request=json.load(sys.stdin)
libvirt.registerErrorHandler(lambda context,error:None,None)
connection=libvirt.open('qemu:///system')
domain=connection.lookupByName('win10')
def call(name,args):
 result=json.loads(libvirt_qemu.qemuAgentCommand(domain,json.dumps({'execute':name,'arguments':args}),30,0))
 if 'error' in result: raise RuntimeError(result['error'].get('desc','guest agent error'))
 return result['return']
def perform():
 mode=request.get('mode')
 if mode in ('upload','download'):
  handle=call('guest-file-open',{'path':request['guest'],'mode':'wb' if mode=='upload' else 'rb'})
  try:
   with open(request['host'],'rb' if mode=='upload' else 'wb') as f:
    while True:
     if mode=='upload':
      data=f.read(49152)
      if not data: break
      written=call('guest-file-write',{'handle':handle,'buf-b64':base64.b64encode(data).decode()})
      if written['count']!=len(data): raise RuntimeError('short guest write')
     else:
      data=call('guest-file-read',{'handle':handle,'count':49152})
      f.write(base64.b64decode(data.get('buf-b64','')))
      if data['eof']: break
  finally: call('guest-file-close',{'handle':handle})
  print('{}')
 else: print(json.dumps(call(request['command'],request.get('arguments',{}))))
try: perform()
except Exception as error: print(json.dumps({'transport_error':str(error)}))
finally: connection.close()
`;

export class WindowsGuest {
  constructor(processes, directory) { Object.assign(this, { processes, directory }); }
  async request(request) {
    const script = `sudo python3 -c ${quote(bridge)}`;
    const result = JSON.parse(await this.processes.run('ssh', ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=15', WINDOWS_HOST, script],
      { env: process.env, input: JSON.stringify(request), quiet: true, timeout: 30 * 60_000 }));
    if (result.transport_error) throw new Error(this.processes.redact(`Windows guest transport: ${result.transport_error}`));
    return result;
  }
  async powershell(body, { wait = true, timeout = 60_000 } = {}) {
    const started = await this.request({ command: 'guest-exec', arguments: {
      path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arg: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';\n" + body, 'utf16le').toString('base64')], 'capture-output': true,
    } });
    if (!wait) return started.pid;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await this.request({ command: 'guest-exec-status', arguments: { pid: started.pid } });
      if (status.exited) {
        const output = Buffer.from(status['out-data'] || '', 'base64').toString('utf8');
        if (status.exitcode !== 0) throw new Error(this.processes.redact(`Windows command failed (${status.exitcode}): ${output} ${Buffer.from(status['err-data'] || '', 'base64')}`));
        return output.trim();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Windows guest command timed out');
  }
  async transfer(mode, local, guest) {
    const privateDirectory = `/tmp/beeline-windows-transfer-${createHash('sha256').update(this.directory).digest('hex').slice(0, 20)}`;
    const host = `${privateDirectory}/${basename(local)}`;
    await this.processes.run('ssh', [WINDOWS_HOST, `umask 077; mkdir -p ${quote(privateDirectory)}`], { env: process.env, quiet: true });
    if (mode === 'upload') await this.processes.run('scp', ['-q', local, `${WINDOWS_HOST}:${host}`], { env: process.env, quiet: true });
    const temporary = mode === 'upload' ? `${guest}.upload-${randomBytes(8).toString('hex')}` : guest;
    await this.request({ mode, host, guest: temporary });
    if (mode === 'upload') {
      const escaped = value => value.replaceAll("'", "''");
      await this.powershell(`$ErrorActionPreference='Stop'; Move-Item -LiteralPath '${escaped(temporary)}' -Destination '${escaped(guest)}' -Force`);
    }
    if (mode === 'download') await this.processes.run('scp', ['-q', `${WINDOWS_HOST}:${host}`, local], { env: process.env, quiet: true });
    await this.processes.run('ssh', [WINDOWS_HOST, `rm -f ${quote(host)}`], { env: process.env, quiet: true });
  }
  async interactive(script, taskName) {
    // WiX and WebView need the existing interactive user's profile, not SYSTEM.
    // Reuse that token; do not provision a user, password or network service.
    const escaped = value => value.replaceAll("'", "''");
    return this.powershell(`$ErrorActionPreference='Stop'
$user=(Get-CimInstance Win32_ComputerSystem).UserName
if (!$user) { throw 'Windows build requires an already logged-in interactive user' }
$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${escaped(script)}"'
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${escaped(taskName)}' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '${escaped(taskName)}'
$user`);
  }
}
