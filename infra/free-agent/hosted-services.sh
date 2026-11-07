#!/bin/sh
# The hosted VM owns a private rootfs, runtime directory and cgroup tree.
# Squire installs its broker through this real systemd user manager.
set -eu

# This entry is also called by the helper after resume. Never inherit an
# agent's private HOME or XDG paths when creating the machine's user manager.
export HOME=/root USER=root LOGNAME=root
export XDG_CONFIG_HOME=/root/.config XDG_STATE_HOME=/root/.local/state XDG_DATA_HOME=/root/.local/share
export XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus

node /opt/beeline/reconcile-broker-marker.mjs

: "${XDG_RUNTIME_DIR:?hosted runtime directory is required}"
mkdir -p "$XDG_RUNTIME_DIR" /run/systemd/system
chmod 700 "$XDG_RUNTIME_DIR"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  python3 /opt/beeline/start-hosted-manager.py /lib/systemd/systemd --user --log-target=console \
    >"$XDG_RUNTIME_DIR/manager.log" 2>&1 || {
      echo 'free-agent: hosted service manager did not start' >&2
      cat "$XDG_RUNTIME_DIR/manager.log" >&2
      exit 78
    }
fi
systemctl --user start dbus.socket
systemctl --user start trusty-squire-broker.service
