#!/bin/sh
# Run the helper baked into this pinned image. Process exit is a real outcome;
# neither release acquisition nor a failed helper invokes an installer here.
set -eu
export PATH="/opt/beeline/helper/bin:$HOME/.local/bin:$PATH"
if [ "${BEELINE_HOSTED_SERVICES:-0}" = 1 ]; then
  /bin/sh /opt/beeline/hosted-services.sh || exit 78
fi
exec /opt/beeline/helper/bin/beeline free-agent
