#!/usr/bin/env bash
# Deploys the commit currently checked out in this folder to the local Docker host.
# Run on the EC2 server from the repo folder (GitHub Actions does this after CI passes):
#   bash scripts/deploy.sh
# Steps: build image → run migrations → replace container → wait for /ready → roll back on failure.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

NAME=athletiq-api
IMAGE=athletiq-api
KEEP_IMAGES=5   # tags kept for manual rollback (current one included)
log() { echo "[deploy $(date '+%H:%M:%S')] $*"; }

# One deploy at a time (a manual deploy and an automatic one must not overlap).
exec 9>/tmp/athletiq-deploy.lock
flock -n 9 || { log "another deploy is running; aborting"; exit 1; }

[ -f .env ] || { log ".env not found in $(pwd)"; exit 1; }

TAG=$(git rev-parse --short HEAD)
PREV=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NAME" 2>/dev/null || true)
log "deploying $TAG ($(git log -1 --format=%s)); running now: ${PREV:-nothing}"

# start <tag> <kind> <previous-tag>: deploy time, kind and previous version are shown by GET /ready.
start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    --env-file .env \
    -e DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -e DEPLOY_KIND="$2" -e DEPLOY_PREVIOUS="$3" \
    -p 127.0.0.1:4000:4000 \
    --restart unless-stopped \
    --init --stop-timeout 25 \
    --memory 512m \
    --log-opt max-size=20m --log-opt max-file=5 \
    "$IMAGE:$1" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:4000/ready >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

log "building image (the current container keeps serving)"
docker build --build-arg GIT_SHA="$TAG" \
  --build-arg GIT_COMMIT_MESSAGE="$(git log -1 --format=%s)" \
  --build-arg GIT_COMMIT_TIME="$(git log -1 --format=%cI)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "$IMAGE:$TAG" -t "$IMAGE:latest" .

log "applying database migrations"
docker run --rm --env-file .env "$IMAGE:$TAG" node dist/db/migrate.js

# Deploying a commit older than the running one counts as a rollback.
KIND=deploy
if [ "$PREV" = "$TAG" ]; then KIND=redeploy
elif [ -n "$PREV" ] && git merge-base --is-ancestor "$TAG" "$PREV" 2>/dev/null; then KIND=rollback; fi

log "switching container to $TAG ($KIND)"
start "$TAG" "$KIND" "$PREV"
if wait_ready; then
  log "healthy: $(curl -fsS http://127.0.0.1:4000/ready)"
else
  log "new version did not become ready; last logs:"
  docker logs --tail 80 "$NAME" || true
  if [ -n "$PREV" ] && [ "$PREV" != "$TAG" ] && docker image inspect "$IMAGE:$PREV" >/dev/null 2>&1; then
    log "rolling back to $PREV"
    start "$PREV" rollback "$TAG"
    wait_ready && log "rollback to $PREV is serving" || log "ROLLBACK ALSO FAILED: check the server"
  fi
  exit 1
fi

# Keep the newest tags for rollback; drop older images and stale build cache.
docker images "$IMAGE" --format '{{.Tag}}' | grep -vxE "latest|$TAG" | tail -n +"$KEEP_IMAGES" |
  while read -r old; do docker rmi "$IMAGE:$old" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
log "done: $TAG is live"
