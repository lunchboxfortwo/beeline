# Base image for free starter agents (one Fly Machine per agent, app
# beeline-free-agents). It holds the tools an agent works with and the
# Pi harness and the helper built from this image's exact release checkout.
FROM node:22-bookworm-slim AS browser-tools
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl git less procps python3 ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
# Latest stable releases, resolved together and checksum pinned for repeatable builds.
# agent-browser is Apache-2.0; Lightpanda is AGPL-3.0.
ARG AGENT_BROWSER_VERSION=0.41.2
ARG AGENT_BROWSER_SHA256=c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379
ARG LIGHTPANDA_VERSION=1.0.3
ARG LIGHTPANDA_SHA256=53eb34da09159dcf8f04865dbfe3e63e9a652062684495aa7ced5ddd7c82e8b0
RUN curl -fsSL "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-linux-x64" -o /usr/local/bin/agent-browser \
  && echo "${AGENT_BROWSER_SHA256}  /usr/local/bin/agent-browser" | sha256sum -c - \
  && curl -fsSL "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux" -o /usr/local/bin/lightpanda \
  && echo "${LIGHTPANDA_SHA256}  /usr/local/bin/lightpanda" | sha256sum -c - \
  && chmod 755 /usr/local/bin/agent-browser /usr/local/bin/lightpanda
ENV AGENT_BROWSER_ENGINE=lightpanda AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/lightpanda \
    AGENT_BROWSER_SOCKET_DIR=/tmp/beeline-browser

FROM node:22-bookworm-slim AS helper-build
WORKDIR /build
COPY infra/free-agent/helper-bundle/ /bundle/
COPY infra/free-agent/bake-helper.mjs /build/
ARG BEELINE_RELEASE_VERSION
ARG BEELINE_RELEASE_SHA
RUN node bake-helper.mjs "$BEELINE_RELEASE_VERSION" "$BEELINE_RELEASE_SHA" \
  && find /opt/beeline/helper -type f -iname '*squire*' -delete

FROM browser-tools AS runtime
ARG PI_VERSION=0.84.3
ARG PI_ACP_VERSION=0.0.34
RUN test "$PI_VERSION" != latest && test "$PI_ACP_VERSION" != latest \
  && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" "pi-acp@${PI_ACP_VERSION}" \
  && npm cache clean --force
COPY infra/free-agent/prepare-image.mjs /opt/beeline/
RUN node /opt/beeline/prepare-image.mjs
COPY infra/free-agent/entrypoint.sh /opt/beeline/
# Keep the verified helper outside the Machine's persistent HOME.
COPY --from=helper-build /opt/beeline/helper/ /opt/beeline/helper/
ARG BEELINE_RELEASE_VERSION
ARG BEELINE_RELEASE_SHA
LABEL app.usebeeline.release.version=$BEELINE_RELEASE_VERSION \
  app.usebeeline.release.sha=$BEELINE_RELEASE_SHA
ENV HOME=/root
WORKDIR /root
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "/opt/beeline/entrypoint.sh"]
