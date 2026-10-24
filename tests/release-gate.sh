#!/usr/bin/env bash
# release-gate.sh: everything a release must pass, run BEFORE pushing it.
#
#   bash tests/release-gate.sh              # gate the committed HEAD
#   MDNEST_GATE_ALL=1 bash tests/release-gate.sh   # also every optional suite
#
# Why a separate script: git opens the SSH connection to GitHub first and runs
# the pre-push hook after, so a hook that runs the full release tier (20+
# minutes) has its connection dropped before the push happens (v4.8.11). This
# script runs the same tier, and more, with no connection open. When every
# check passes it records the exact tree it tested in .git/mdnest-release-gate.
# The pre-push hook accepts a push to main or release/* only when the tree being
# pushed is that tree, so a release can no longer reach GitHub with a change
# made after the gate ran.
#
# What it runs:
#   0. builds the backend and frontend images once, tagged by the tree's hash
#      (tests/lib/e2e-images.sh); every suite below reuses them
#   then two lanes side by side:
#   browser lane: e2e-browser.sh, then e2e-collab-multi.sh (always: live
#      collaboration only runs in multi mode). Each is split into shards
#      (MDNEST_E2E_SHARDS), one whole stack per shard.
#   other lane:
#   1. the pre-push hook in release mode: builds, unit tests, CLI suites,
#      audits, govulncheck, version consistency
#   2. Go vet + go test -race WITH a real Redis (host Go, else Docker), so the
#      durability-queue tests run instead of skipping
#   3. shellcheck (host, else Docker)
#   4. e2e-docker, e2e-sec-multi, backend-image-init, and the suites the
#      changed files call for, compared with origin/main:
#        backend/storage, deploy/helm, factory     -> e2e-ha-durability.sh
#        chat members, permission middleware       -> e2e-private-chats-multi.sh
#        transfer, download                        -> e2e-transfer-multi.sh
#      MDNEST_GATE_ALL=1 runs all three whatever changed.
#   MDNEST_GATE_LANES=1 runs the lanes one after the other.
#   5. last, alone: the @budget timing tests (fixed millisecond budgets), on
#      one stack per harness, once nothing else is running.
#
# Needs docker and node. Exits 0 only if every step passed; nothing is recorded
# otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
STAMP="$(git rev-parse --git-path mdnest-release-gate)"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-gate.XXXXXX")"
GO_VER="$(awk '/^go[[:space:]]/{print $2; exit}' backend/go.mod)"

pass=0; failed=0; ran=()
step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# The gate tests the working tree, and records HEAD's tree. They must be the
# same, or the record would vouch for code that was never tested.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: the gate records the committed tree,"
  echo "so it must test exactly that."
  git status --short --untracked-files=no
  exit 1
fi
have docker && docker info >/dev/null 2>&1 || { echo "docker is required"; exit 2; }
have node || { echo "node is required"; exit 2; }

TREE="$(git rev-parse 'HEAD^{tree}')"
rm -f "$STAMP"
git fetch -q origin main 2>/dev/null || true
CHANGED="$(git diff --name-only origin/main...HEAD 2>/dev/null || git diff --name-only origin/main HEAD)"
echo "Gating $(git rev-parse --short HEAD) ($(echo "$CHANGED" | grep -c . ) files changed since origin/main). Logs: $LOGDIR"

# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"

# run NAME LOG COMMAND...: run one check, record its exit code next to its log.
# Results are read back from those files, because the checks run in two
# background lanes and a subshell cannot update this shell's counters.
run() {
  local name="$1" log="$LOGDIR/$2" t0=$SECONDS rc; shift 2
  step "$name"
  "$@" >"$log" 2>&1; rc=$?
  printf '%s\n' "$name" >"$log.name"; echo "$rc" >"$log.rc"
  case "$rc" in
    0) printf '  \033[32mPASS\033[0m %s (%ds)\n' "$name" "$((SECONDS - t0))" ;;
    2) printf '  \033[33mSKIP\033[0m %s, prerequisites missing (log: %s)\n' "$name" "$log" ;;
    *) printf '  \033[31mFAIL\033[0m %s (%ds, log: %s)\n' "$name" "$((SECONDS - t0))" "$log" ;;
  esac
  return 0
}

# 0a. A fresh worktree has no node_modules, and the hook's lock-file checks
# (npm ls) need an install to compare against. npm ci installs exactly what
# the lock file says and refuses a lock file out of step with package.json,
# so a real lock problem still fails here, with npm's own message.
for d in frontend mcp-server; do
  [ -d "$d/node_modules" ] && continue
  step "npm ci in $d (no node_modules yet)"
  (cd "$d" && npm ci --no-audit --no-fund) >"$LOGDIR/npm-ci-$d.log" 2>&1 \
    || { echo "  npm ci failed in $d: the lock file does not match package.json, or the registry is unreachable (log: $LOGDIR/npm-ci-$d.log)"; exit 1; }
done

# 0. Build the two images once. Every suite below finds them by the tree's
# hash and skips its own build (tests/lib/e2e-images.sh).
step "Building the e2e images for this tree"
t0=$SECONDS
e2e_backend_image "$REPO_ROOT" "$LOGDIR" >/dev/null && e2e_frontend_image "$REPO_ROOT" "$LOGDIR" >/dev/null \
  && e2e_playwright_ready "$LOGDIR" \
  || { echo "  image build or Playwright setup failed, logs in $LOGDIR"; exit 1; }
echo "  ready ($((SECONDS - t0))s)"

# 1. The pre-push hook, in release mode, run here instead of inside a push.
# Its end-to-end suites run below in the lanes instead of inside the hook.
hook_release() {
  printf 'HEAD %s refs/heads/release/gate 0000000000000000000000000000000000000000\n' "$(git rev-parse HEAD)" \
    | MDNEST_GATE_INNER=1 MDNEST_GATE_SUITES_OUTSIDE=1 bash .githooks/pre-push
}

# 2. Go with a real Redis.
go_suite() {
  if have go; then
    local rname="mdnest-gate-redis-$$"
    docker run -d --rm --name "$rname" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null || return 1
    local port; port="$(docker port "$rname" 6379/tcp | head -1 | sed 's/.*://')"
    sleep 1
    (cd backend && go vet ./... && MDNEST_TEST_REDIS_URL="redis://127.0.0.1:$port/15" go test -race -count=1 ./...)
    local rc=$?; docker rm -f "$rname" >/dev/null 2>&1; return $rc
  fi
  local net="mdnest-gate-$$" rname="mdnest-gate-redis-$$"
  docker network create "$net" >/dev/null || return 1
  docker run -d --rm --name "$rname" --network "$net" redis:7-alpine >/dev/null
  docker volume create mdnest-gomod >/dev/null; docker volume create mdnest-gobuild >/dev/null
  docker run --rm --network "$net" -e MDNEST_TEST_REDIS_URL="redis://$rname:6379/15" \
    -v "$REPO_ROOT/backend:/src" -v mdnest-gomod:/go/pkg/mod -v mdnest-gobuild:/root/.cache/go-build \
    -w /src "golang:$GO_VER" sh -c 'go vet ./... && go test -race -count=1 ./...'
  local rc=$?
  docker rm -f "$rname" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1
  return $rc
}

# 3. shellcheck, the same files and severity as CI.
SC_FILES=(setup.sh mdnest-server mdnest git-sync/sync.sh install-cli.sh .githooks/pre-push tests/release-gate.sh tests/lib/e2e-images.sh)
shellcheck_suite() {
  if have shellcheck; then shellcheck -S error "${SC_FILES[@]}"; else
    docker run --rm -v "$REPO_ROOT:/mnt" -w /mnt koalaman/shellcheck:stable -S error "${SC_FILES[@]}"
  fi
}

# 4. The suites the changes call for.
wants() { [ "${MDNEST_GATE_ALL:-0}" = 1 ] || echo "$CHANGED" | grep -qE "$1"; }
optional() { # pattern, script, why
  if wants "$1"; then
    run "$2 ($3)" "$2.log" bash "tests/$2"
  else
    echo "  skip $2: nothing it covers changed"
  fi
}

# Two lanes run side by side. The browser lane holds the two Playwright
# harnesses (each already split into shards); the other lane holds everything
# that needs no browser. Inside a lane the checks run one after another, so the
# machine never runs more than one browser harness at a time.
# MDNEST_GATE_LANES=1 runs both lanes one after the other, as before.
browser_lane() {
  run "e2e-browser.sh (UI, single mode)" e2e-browser.sh.log env MDNEST_E2E_BUDGET=skip bash tests/e2e-browser.sh
  # Always: live collaboration and shared editing exist only in multi mode, so
  # this is the only suite that runs them, and a lockout of every Live note
  # (v4.8.10 to v4.8.12, behind a proxy) needed no change to any file above.
  run "e2e-collab-multi.sh (live collaboration and shared editing, multi mode)" e2e-collab-multi.sh.log env MDNEST_E2E_BUDGET=skip bash tests/e2e-collab-multi.sh
}
other_lane() {
  run "pre-push hook, release tier (builds, unit, CLI, audits)" hook.log hook_release
  run "Go vet + go test -race, with Redis" go.log go_suite
  run "shellcheck" shellcheck.log shellcheck_suite
  run "e2e-docker.sh (CLI against the backend, host and bare alpine)" e2e-docker.sh.log bash tests/e2e-docker.sh
  run "e2e-sec-multi.sh (multi-mode access)" e2e-sec-multi.sh.log bash tests/e2e-sec-multi.sh
  run "backend-image-init.sh (tini reaps orphans)" backend-image-init.sh.log bash tests/backend-image-init.sh
  optional '^backend/storage/|^deploy/helm/|^backend/main\.go' e2e-ha-durability.sh "HA writer, queue, leader"
  optional 'chat_members|^backend/middleware/permission|^backend/store/chat' e2e-private-chats-multi.sh "private chats"
  optional '^backend/handlers/(transfer|download|treecopy)' e2e-transfer-multi.sh "move, copy, download"
}
t0=$SECONDS
if [ "${MDNEST_GATE_LANES:-2}" = 1 ]; then
  other_lane; browser_lane
else
  browser_lane & bpid=$!
  other_lane
  wait "$bpid"
fi
echo "  parallel part done ($((SECONDS - t0))s)"

# 5. The timing-budget tests (@budget, see tests/lib/e2e-images.sh), last and
# alone: they compare against a fixed number of milliseconds, so they only
# mean something once nothing else from the gate is using the CPU.
t0=$SECONDS
run "@budget timing tests, single mode (alone)" budget-browser.log \
  env MDNEST_E2E_BUDGET=only MDNEST_E2E_SHARDS=1 bash tests/e2e-browser.sh
run "@budget timing tests, multi mode (alone)" budget-collab.log \
  env MDNEST_E2E_BUDGET=only MDNEST_E2E_SHARDS=1 bash tests/e2e-collab-multi.sh
echo "  quiet part done ($((SECONDS - t0))s)"

for rcfile in "$LOGDIR"/*.rc; do
  [ -e "$rcfile" ] || continue
  name="$(cat "${rcfile%.rc}.name")"
  case "$(cat "$rcfile")" in
    0) pass=$((pass + 1)); ran+=("$name") ;;
    2) ;;  # reported as SKIP above, as the hook always has
    *) failed=$((failed + 1)) ;;
  esac
done

echo
echo "=== release gate: $pass passed, $failed failed ==="
if [ "$failed" -ne 0 ]; then
  echo "Nothing recorded. Fix the failures and run the gate again."
  exit 1
fi
printf '%s %s %s\n' "$TREE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(IFS=,; echo "${ran[*]}" | tr ' ' '_')" > "$STAMP"
echo "Recorded: tree $TREE passed. Push the release branch now; the hook will accept exactly this tree."
