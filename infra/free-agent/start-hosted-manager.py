#!/usr/bin/python3
"""Wait for systemd's actual READY notification or process exit, without probes."""
import os
import selectors
import socket
import subprocess
import sys

path = os.path.join(os.environ['XDG_RUNTIME_DIR'], 'beeline-manager-notify.sock')
with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
    notify.bind(path)
    os.chmod(path, 0o600)
    try:
        manager = subprocess.Popen(sys.argv[1:], env={**os.environ, 'NOTIFY_SOCKET': path})
        pidfd = os.pidfd_open(manager.pid)
        try:
            with selectors.DefaultSelector() as events:
                events.register(notify, selectors.EVENT_READ, 'notification')
                events.register(pidfd, selectors.EVENT_READ, 'exit')
                while True:
                    for key, _ in events.select():
                        if key.data == 'exit':
                            sys.exit(manager.wait() or 78)
                        if b'READY=1' in notify.recv(65536).split(b'\n'):
                            sys.exit(0)
        finally:
            os.close(pidfd)
    finally:
        os.unlink(path)
