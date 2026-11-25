#!/usr/bin/env bash
# Registry images are build outputs, never release memory. A prebuild may be
# absent or fail; release then builds from source with the same Dockerfile.
set -euo pipefail

mode="${1:?expected server image build mode}"
sha="${2:?expected full source SHA}"
version="${3:-development}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid server source SHA' >&2; exit 1; }
test "$(git rev-parse HEAD)" = "$sha"
source_image="registry.fly.io/beeline-server:source-$sha"
if [ "$mode" = prepare-local ]; then
  if ! docker image inspect "$source_image" >/dev/null 2>&1; then
    docker build --file apps/server/Dockerfile --tag "$source_image" \
      --build-arg "BEELINE_RELEASE_SHA=$sha" .
  fi
elif [ "$mode" = prebuild ]; then
  flyctl auth docker
  flyctl deploy . --local-only --config apps/infra/fly.beeline-server.toml \
    --dockerfile apps/server/Dockerfile --app beeline-server \
    --build-arg BEELINE_RELEASE_VERSION=development --build-arg "BEELINE_RELEASE_SHA=$sha" \
    --image-label "source-$sha" --build-only --push --yes
elif [[ "$mode" == release || "$mode" == build-local || "$mode" == push-local ]]; then
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo 'invalid server release version' >&2; exit 1; }
  label="${version#v}-${sha:0:12}"
  release_image="registry.fly.io/beeline-server:$label"
  if [ "$mode" = push-local ]; then
    flyctl auth docker
    docker push "$release_image"
    exit
  fi
  [[ "${IMAGE_REF:-}" == "registry.fly.io/beeline-free-agents:$label@sha256:"* && "${IMAGE_REF##*@}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo 'matching free agent image digest is required' >&2; exit 1;
  }
  if [ "$mode" = release ]; then flyctl auth docker; fi
  if { [ "$mode" = build-local ] && docker image inspect "$source_image" >/dev/null 2>&1; } ||
     { [ "$mode" = release ] && docker pull "$source_image"; }; then
    actual_sha=$(docker image inspect --format '{{ index .Config.Labels "app.usebeeline.release.sha" }}' "$source_image")
    test "$actual_sha" = "$sha" || { echo 'prebuilt server image source SHA mismatch' >&2; exit 1; }
    # Pin the prebuilt bytes. Only the starter image reference and release
    # identity change here.
    if [ "$mode" = build-local ]; then
      source_ref=$(docker image inspect --format '{{.Id}}' "$source_image")
      [[ "$source_ref" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
    else
      source_ref=$(docker image inspect --format '{{ index .RepoDigests 0 }}' "$source_image")
      [[ "$source_ref" =~ ^registry\.fly\.io/beeline-server@sha256:[0-9a-f]{64}$ ]] || {
        echo 'prebuilt server image has no immutable registry digest' >&2; exit 1;
      }
    fi
    docker build --pull=false --tag "$release_image" --file - . <<EOF
FROM $source_ref
USER root
RUN node -e 'require("node:fs").writeFileSync("/app/apps/server/assets/free-agent-image.json", JSON.stringify({image:"$IMAGE_REF"}))'
USER node
ENV BEELINE_RELEASE_VERSION=$version BEELINE_RELEASE_SHA=$sha
LABEL app.usebeeline.release.version=$version app.usebeeline.release.sha=$sha
EOF
    if [ "$mode" = release ]; then docker push "$release_image"; fi
  elif [ "$mode" = build-local ]; then
    docker build --file apps/server/Dockerfile --tag "$release_image" \
      --build-arg "BEELINE_RELEASE_VERSION=$version" --build-arg "BEELINE_RELEASE_SHA=$sha" \
      --build-arg "BEELINE_FREE_AGENT_IMAGE=$IMAGE_REF" .
  else
    echo 'No prebuilt server image available; building the exact release from source.'
    flyctl deploy . --local-only --config apps/infra/fly.beeline-server.toml \
      --dockerfile apps/server/Dockerfile --app beeline-server \
      --build-arg "BEELINE_RELEASE_VERSION=$version" --build-arg "BEELINE_RELEASE_SHA=$sha" \
      --build-arg "BEELINE_FREE_AGENT_IMAGE=$IMAGE_REF" \
      --image-label "$label" --build-only --push --yes
  fi
  # Fly's builder can use a separate Docker daemon; pull before migrations.
  if [ "$mode" = release ]; then docker pull "$release_image"; fi
else
  echo "unknown server image mode: $mode" >&2
  exit 1
fi
