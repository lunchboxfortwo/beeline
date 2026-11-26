#!/usr/bin/env bash
# Install or update the raw log collectors on squire, as the host user.
# Usage: install-host.sh
set -euo pipefail
host_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
config="$host_home/.config"
if [[ ! -s "$config/beeline-log-walk/fly-api-token" ]]; then
  printf 'Stage the stored Fly deploy token before installing the log collectors.\n' >&2
  exit 1
fi
base="$host_home/.local/share/beeline-log-walk"
# Keep the voice collector's template, environment, and checkout in place.
checkout="$base/token-checkout"
if [ ! -d "$checkout/.git" ]; then
  git clone --quiet --depth 1 --branch main https://github.com/lunchboxfortwo/beeline.git "$checkout"
fi
git -C "$checkout" fetch --quiet origin main
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
env="$config/beeline-log-walk-token.env"
mkdir -p "$base/raw" "$config/systemd/user"
# systemd user units start with a minimal PATH; pin the real flyctl binary.
fly_dir="$(dirname "$(readlink -f "$(command -v flyctl)")")"
printf 'PATH=%s:/usr/local/bin:/usr/bin:/bin\nLOG_WALK_RAW=%s\n' \
  "$fly_dir" "$base/raw" > "$env"
manager=(systemctl --user --machine="$(id -un)@.host")
units=(beeline-log-collector@{beeline-server,beeline-free-agents}.service)
for unit in "${units[@]}"; do
  install -m 0644 "$checkout/packages/scripts/log-walk/systemd/beeline-log-collector@.service" "$config/systemd/user/$unit"
done
"${manager[@]}" enable --force --no-reload "${units[@]}"
"${manager[@]}" daemon-reload
"${manager[@]}" restart "${units[@]}"
