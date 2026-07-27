#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--install|--uninstall|--help]

Install creates the standalone agentscrape command and its user LaunchAgent.
Uninstall removes only exact installer-owned public files. Runtime snapshots and
queue, failed-job, corpus, and log data are retained.
EOF
}

fail() {
  printf 'agentscrape-install: %s\n' "$*" >&2
  exit 1
}

ACTION=install
case "${1:-}" in
  ""|--install) ;;
  --uninstall) ACTION=uninstall ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
(( $# <= 1 )) || { usage >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ROOT_DIR="$ROOT"
LABEL=agentscrape.process-queue
OWNER_UID="$(id -u)"
PLATFORM="$(uname -s)"
DOMAIN="gui/$OWNER_UID"
SERVICE_TARGET="$DOMAIN/$LABEL"
BIN_DIR="${AGENTSCRAPE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
COMMAND_PATH="$BIN_DIR/agentscrape"
LAUNCH_AGENTS_DIR="${AGENTSCRAPE_INSTALL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
SERVICE_DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
STATE_DIR="${AGENTSCRAPE_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentscrape}"
SHARE_DIR="${AGENTSCRAPE_INSTALL_SHARE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agentscrape}"
QUEUE_DIR="$SHARE_DIR/queue"
FAILED_DIR="$SHARE_DIR/failed"
LOG_PATH="$STATE_DIR/process-queue.log"
RUNTIME_DIR="$STATE_DIR/runtime"
DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
RECEIPT_PATH="$STATE_DIR/install-receipt"
LOCK_DIR="$HOME/.local/state/.agentscrape-installer"
LOCK_PATH="$LOCK_DIR/install.lock"
BUN_CMD="${AGENTSCRAPE_INSTALL_BUN:-bun}"
LAUNCHCTL_CMD="${AGENTSCRAPE_INSTALL_LAUNCHCTL:-launchctl}"
PLUTIL_CMD="${AGENTSCRAPE_INSTALL_PLUTIL:-plutil}"
COMMAND_MARKER='agentscrape-installer-owned: agentscrape.command.v1'
RECEIPT_MARKER='agentscrape-installer-owned: agentscrape.install-receipt.v1'

BUN_BIN=""
LAUNCHCTL_BIN=""
DEPLOYED_SHA=""
DEPLOYED_TREE=""
SNAPSHOT_ROOT=""
SNAPSHOT_SOURCE=""
SNAPSHOT_TEMPLATE=""
SERVICE_PATH=""
LOCK_HELD=0
LOCK_TEMP=""
LOCK_TOKEN=""
LOCK_INODE=""
LOCK_DEVICE=""
LOADED_SERVICE_STATE=unknown
LOADED_SERVICE_PRINT=""
ALLOW_CURRENT_SERVICE_IDENTITY=0
ALLOW_RECEIPT_SERVICE_IDENTITY=0
PREINSTALL_STATE=""
PREVIOUS_SERVICE_LOADED=0
ROLLBACK_ENABLED=0
DEPLOYMENT_PUBLISHED=0
UNINSTALL_ROLLBACK=0
UNINSTALL_WAS_LOADED=0
UNINSTALL_TREE=""
UNINSTALL_HELPER=""
UNINSTALL_COMMAND_BACKUP=""
UNINSTALL_SERVICE_BACKUP=""
UNINSTALL_DEPLOYED_BACKUP=""
UNINSTALL_RECEIPT_BACKUP=""
UNINSTALL_COMMAND_INODE=""
UNINSTALL_COMMAND_DEVICE=""
UNINSTALL_SERVICE_INODE=""
UNINSTALL_SERVICE_DEVICE=""
UNINSTALL_DEPLOYED_INODE=""
UNINSTALL_DEPLOYED_DEVICE=""
UNINSTALL_RECEIPT_INODE=""
UNINSTALL_RECEIPT_DEVICE=""
COMMAND_CHANGED=0
SERVICE_CHANGED=0
RECEIPT_CHANGED=0
DEPLOYED_CHANGED=0
COMMAND_BACKUP=""
SERVICE_BACKUP=""
RECEIPT_BACKUP=""
DEPLOYED_BACKUP=""
COMMAND_TEMP=""
SERVICE_TEMP=""
RECEIPT_TEMP=""
DEPLOYED_TEMP=""
COMMAND_PRESENT=0
SERVICE_PRESENT=0
RECEIPT_PRESENT=0
DEPLOYED_PRESENT=0
COMMAND_INODE=""
COMMAND_DEVICE=""
SERVICE_INODE=""
SERVICE_DEVICE=""
RECEIPT_INODE=""
RECEIPT_DEVICE=""
DEPLOYED_INODE=""
DEPLOYED_DEVICE=""
RECEIPT_FORMAT=""
RECEIPT_KIND=""
RECEIPT_ROOT=""
RECEIPT_SOURCE=""
RECEIPT_SHA=""
RECEIPT_BUN=""
RECEIPT_COMMAND=""
RECEIPT_SERVICE=""
RECEIPT_SHARE=""
RECEIPT_QUEUE=""
RECEIPT_LOG=""
RECEIPT_SERVICE_PATH=""

path_owner_uid() {
  case "$PLATFORM" in
    Darwin) stat -f '%u' "$1" ;;
    Linux) stat -c '%u' -- "$1" ;;
    *) fail "unsupported platform: $PLATFORM" ;;
  esac
}

path_mode() {
  case "$PLATFORM" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' -- "$1" ;;
  esac
}

path_nlink() {
  case "$PLATFORM" in
    Darwin) stat -f '%l' "$1" ;;
    Linux) stat -c '%h' -- "$1" ;;
  esac
}

path_inode() {
  case "$PLATFORM" in
    Darwin) stat -f '%i' "$1" ;;
    Linux) stat -c '%i' -- "$1" ;;
  esac
}

path_device() {
  case "$PLATFORM" in
    Darwin) stat -f '%d' "$1" ;;
    Linux) stat -c '%d' -- "$1" ;;
  esac
}

safe_absolute_path() {
  local path="$1"
  [[ "$path" == /* && "$path" != / && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  [[ "$path" != *//* && "$path" != */./* && "$path" != */../* && "$path" != */. && "$path" != */.. ]]
}

is_standard_macos_alias() {
  local path="$1" target
  [[ "$PLATFORM" == Darwin ]] || return 1
  case "$path" in
    /tmp) target="$(readlink "$path")" || return 1; [[ "$target" == private/tmp || "$target" == /private/tmp ]] ;;
    /var) target="$(readlink "$path")" || return 1; [[ "$target" == private/var || "$target" == /private/var ]] ;;
    *) return 1 ;;
  esac
}

validate_no_follow_path() {
  local path="$1" label="$2" allow_final_symlink="${3:-0}"
  local rest component current="" final=0
  safe_absolute_path "$path" || fail "$label must be a normalized absolute path: $path"
  rest="${path#/}"
  while [[ -n "$rest" ]]; do
    if [[ "$rest" == */* ]]; then component="${rest%%/*}"; rest="${rest#*/}"; else component="$rest"; rest=""; final=1; fi
    current="$current/$component"
    if [[ -L "$current" ]]; then
      if is_standard_macos_alias "$current"; then :
      elif (( final && allow_final_symlink )); then :
      else fail "$label has a symlink path component: $current"
      fi
    elif [[ -e "$current" ]] && (( ! final )) && [[ ! -d "$current" ]]; then
      fail "$label has a non-directory path component: $current"
    fi
  done
}

validate_owned_directory() {
  local path="$1" label="$2" exact_mode="${3:-}" mode numeric
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a plain directory: $path"
  [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
  mode="$(path_mode "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "$label has a malformed mode: $path"
  numeric=$((8#$mode))
  (( (numeric & 07022) == 0 )) || fail "$label has group/other write or special mode bits: $path"
  if [[ -n "$exact_mode" ]]; then
    [[ "$mode" == "$exact_mode" ]] || fail "$label must have mode $exact_mode: $path"
  fi
}

ensure_directory() {
  local path="$1" label="$2" mode="$3" parent
  validate_no_follow_path "$path" "$label"
  if [[ ! -e "$path" ]]; then
    parent="$(dirname "$path")"
    mkdir -p "$path"
    chmod "$mode" "$path"
    fsync_path directory "$path"
    fsync_path directory "$parent"
  fi
  validate_owned_directory "$path" "$label"
  chmod "$mode" "$path"
}

validate_regular_slot() {
  local path="$1" label="$2" allow_symlink="${3:-0}"
  validate_no_follow_path "$path" "$label" "$allow_symlink"
  if [[ -L "$path" ]]; then (( allow_symlink )) && return 0; fail "$label must not be a symlink: $path"; fi
  [[ ! -e "$path" || -f "$path" ]] || fail "$label must be a regular file: $path"
  if [[ -e "$path" ]]; then
    [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
    [[ "$(path_nlink "$path")" == 1 ]] || fail "$label must have exactly one hard link: $path"
  fi
}

canonicalize_data_paths() {
  if [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]]; then STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"; fi
  if [[ -d "$SHARE_DIR" && ! -L "$SHARE_DIR" ]]; then SHARE_DIR="$(cd "$SHARE_DIR" && pwd -P)"; fi
  QUEUE_DIR="$SHARE_DIR/queue"
  FAILED_DIR="$SHARE_DIR/failed"
  LOG_PATH="$STATE_DIR/process-queue.log"
  RUNTIME_DIR="$STATE_DIR/runtime"
  DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
  RECEIPT_PATH="$STATE_DIR/install-receipt"
  if [[ -n "$DEPLOYED_SHA" ]]; then
    SNAPSHOT_ROOT="$RUNTIME_DIR/$DEPLOYED_SHA"
    SNAPSHOT_SOURCE="$SNAPSHOT_ROOT/src/cli.ts"
    SNAPSHOT_TEMPLATE="$SNAPSHOT_ROOT/plist/$LABEL.plist"
  fi
}

validate_paths() {
  local path label
  safe_absolute_path "$HOME" || fail "HOME must be a normalized absolute path"
  validate_no_follow_path "$HOME" "HOME"
  validate_owned_directory "$HOME" "HOME"
  for path in "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR" "$SHARE_DIR" "$RUNTIME_DIR"; do
    validate_no_follow_path "$path" "configured directory"
  done
  [[ "$COMMAND_PATH" == "$HOME/"* ]] || fail "installed command must remain inside HOME"
  [[ "$SERVICE_DEST" == "$HOME/"* ]] || fail "LaunchAgent must remain inside HOME"
  while read -r path label; do validate_no_follow_path "$path" "$label"; done <<EOF
$LOG_PATH queue-log
$DEPLOYED_SHA_PATH deployed-sha
$RECEIPT_PATH install-receipt
$SERVICE_DEST LaunchAgent
EOF
  validate_no_follow_path "$COMMAND_PATH" "installed command" 1
}

fsync_path() {
  local kind="$1" path="$2"
  "$BUN_BIN" -e '
    import { closeSync, constants, fsyncSync, openSync } from "node:fs";
    const flags = constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) |
      (constants.O_NOFOLLOW ?? 0) | (process.argv[1] === "directory" ? (constants.O_DIRECTORY ?? 0) : 0);
    const fd = openSync(process.argv[2], flags);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  ' "$kind" "$path" >/dev/null
}

random_token() {
  /bin/dd if=/dev/urandom bs=32 count=1 2>/dev/null | /usr/bin/od -An -tx1 | /usr/bin/tr -d ' \n'
}

process_start_identity() {
  local value
  value="$(LC_ALL=C /bin/ps -p "$1" -o lstart= 2>/dev/null)" || return 1
  printf '%s' "$value" | /usr/bin/shasum -a 256 | { read -r digest _; printf '%s\n' "$digest"; }
}

lock_is_valid() {
  local file="$1" schema pid token start extra="" peer
  [[ -f "$file" && ! -L "$file" && "$(path_owner_uid "$file")" == "$OWNER_UID" &&
    "$(path_mode "$file")" == 600 && "$(path_nlink "$file")" == 2 ]] || return 1
  exec 4<"$file"
  if ! { IFS= read -r schema <&4 && IFS= read -r pid <&4 && IFS= read -r token <&4 && IFS= read -r start <&4; }; then
    exec 4<&-
    return 1
  fi
  if IFS= read -r extra <&4 || [[ -n "$extra" ]]; then exec 4<&-; return 1; fi
  exec 4<&-
  [[ "$schema" == schema=agentscrape-install-lock.v1 && "$pid" =~ ^pid=([1-9][0-9]*)$ ]] || return 1
  LOCK_OWNER_PID="${BASH_REMATCH[1]}"
  [[ "$token" =~ ^token=([0-9a-f]{64})$ ]] || return 1
  LOCK_OWNER_TOKEN="${BASH_REMATCH[1]}"
  [[ "$start" =~ ^start=([0-9a-f]{64}|unavailable)$ ]] || return 1
  LOCK_OWNER_START="${BASH_REMATCH[1]}"
  peer="$LOCK_DIR/.install-lock.$LOCK_OWNER_TOKEN"
  [[ -f "$peer" && ! -L "$peer" && "$(path_inode "$peer")" == "$(path_inode "$file")" &&
    "$(path_device "$peer")" == "$(path_device "$file")" && "$(path_nlink "$peer")" == 2 ]]
}

acquire_lock() {
  local start current stale
  ensure_directory "$HOME/.local" "managed .local" 700
  ensure_directory "$HOME/.local/state" "managed state parent" 700
  ensure_directory "$LOCK_DIR" "installer lock directory" 700
  validate_owned_directory "$LOCK_DIR" "installer lock directory" 700
  if [[ -e "$LOCK_PATH" || -L "$LOCK_PATH" ]]; then
    lock_is_valid "$LOCK_PATH" || fail "refusing malformed or foreign install lock: $LOCK_PATH"
    if kill -0 "$LOCK_OWNER_PID" 2>/dev/null; then
      current="$(process_start_identity "$LOCK_OWNER_PID" 2>/dev/null || printf unavailable)"
      [[ "$LOCK_OWNER_START" != unavailable && "$current" != unavailable && "$LOCK_OWNER_START" != "$current" ]] ||
        fail "another agentscrape install or uninstall is active (pid $LOCK_OWNER_PID)"
    fi
    stale="$LOCK_DIR/.stale.$LOCK_OWNER_TOKEN"
    mv "$LOCK_PATH" "$stale"
    fsync_path directory "$LOCK_DIR"
    lock_is_valid "$stale" || fail "stale lock changed while reclaiming; retained at $stale"
    rm -f "$stale" "$LOCK_DIR/.install-lock.$LOCK_OWNER_TOKEN"
    fsync_path directory "$LOCK_DIR"
  fi
  LOCK_TOKEN="$(random_token)"
  LOCK_TEMP="$LOCK_DIR/.install-lock.$LOCK_TOKEN"
  start="$(process_start_identity "$$" 2>/dev/null || printf unavailable)"
  ( set -o noclobber; printf 'schema=agentscrape-install-lock.v1\npid=%s\ntoken=%s\nstart=%s\n' "$$" "$LOCK_TOKEN" "$start" >"$LOCK_TEMP" )
  chmod 600 "$LOCK_TEMP"
  fsync_path file "$LOCK_TEMP"
  ln "$LOCK_TEMP" "$LOCK_PATH" 2>/dev/null || fail "another agentscrape install or uninstall is active"
  LOCK_HELD=1
  LOCK_INODE="$(path_inode "$LOCK_PATH")"
  LOCK_DEVICE="$(path_device "$LOCK_PATH")"
  fsync_path directory "$LOCK_DIR"
}

release_lock() {
  local status="${1:-$?}"
  if (( LOCK_HELD )); then
    set +e
    if lock_is_valid "$LOCK_PATH" && [[ "$LOCK_OWNER_PID" == "$$" && "$LOCK_OWNER_TOKEN" == "$LOCK_TOKEN" &&
      "$(path_inode "$LOCK_PATH")" == "$LOCK_INODE" && "$(path_device "$LOCK_PATH")" == "$LOCK_DEVICE" ]]; then
      rm -f "$LOCK_PATH" "$LOCK_TEMP"
      fsync_path directory "$LOCK_DIR" || true
    else
      printf 'agentscrape-install: refusing to release a replaced install lock\n' >&2
    fi
    LOCK_HELD=0
    set -e
  fi
  return "$status"
}

shell_quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

expected_service_path() {
  printf '%s:%s:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n' "$(dirname "$1")" "$(dirname "$2")"
}

render_wrapper() {
  local root="$1" sha="$2" bun="$3" source="$4" share="$5"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n# %s\n# label: %s\n# source-root: %s\n# source-sha: %s\n# bun: %s\n' \
    "$COMMAND_MARKER" "$LABEL" "$root" "$sha" "$bun"
  printf 'export AGENTSCRAPE_DATA_HOME=%s\nexec %s %s "$@"\n' "$(shell_quote "$share")" "$(shell_quote "$bun")" "$(shell_quote "$source")"
}

escape_xml() {
  local value="$1"; value=${value//&/&amp;}; value=${value//</&lt;}; value=${value//>/&gt;}; value=${value//\"/&quot;}; value=${value//\'/&apos;}; printf '%s' "$value"
}

escape_sed() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }

render_plist() {
  local template="$1" command="$2" service_path="$3" queue="$4" log="$5" text program path_value queue_value log_value
  [[ -f "$template" && ! -L "$template" ]] || return 1
  text="$(<"$template")"
  program="$(escape_sed "$(escape_xml "$command")")"
  path_value="$(escape_sed "$(escape_xml "$service_path")")"
  queue_value="$(escape_sed "$(escape_xml "$queue")")"
  log_value="$(escape_sed "$(escape_xml "$log")")"
  text="$(printf '%s' "$text" | sed -e "s|__AGENTSCRAPE_PROGRAM__|$program|g" -e "s|__AGENTSCRAPE_PATH__|$path_value|g" -e "s|__AGENTSCRAPE_QUEUE__|$queue_value|g" -e "s|__AGENTSCRAPE_LOG__|$log_value|g")"
  [[ "$text" != *'__AGENTSCRAPE_'* ]] || return 1
  printf '%s' "$text"
}

render_receipt() {
  printf 'marker=%s\nlabel=%s\nroot=%s\nsource=%s\nbun=%s\ncommand=%s\nservice=%s\nshare=%s\nqueue=%s\nlog=%s\npath=%s\nsha=%s\n' \
    "$RECEIPT_MARKER" "$LABEL" "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"
}

file_matches() {
  local path="$1" mode="$2"; shift 2
  [[ -f "$path" && ! -L "$path" && "$(path_owner_uid "$path")" == "$OWNER_UID" &&
    "$(path_mode "$path")" == "$mode" && "$(path_nlink "$path")" == 1 ]] || return 1
  cmp -s "$path" <("$@")
}

wrapper_matches_values() { file_matches "$1" 755 render_wrapper "$2" "$3" "$4" "$5" "$6"; }
plist_matches_values() { file_matches "$1" 600 render_plist "$2" "$3" "$4" "$5" "$6"; }
deployed_matches() { file_matches "$1" 600 printf '%s\n' "$2"; }

load_receipt() {
  local file="${1:-$RECEIPT_PATH}" line extra=""
  local -a lines=()
  RECEIPT_FORMAT=""; RECEIPT_KIND=""
  [[ -f "$file" && ! -L "$file" && "$(path_owner_uid "$file")" == "$OWNER_UID" &&
    "$(path_mode "$file")" == 600 && "$(path_nlink "$file")" == 1 ]] || return 1
  while IFS= read -r line; do lines+=("$line"); done <"$file"
  (( ${#lines[@]} == 12 || ${#lines[@]} == 8 )) || return 1
  [[ "${lines[0]}" == "marker=$RECEIPT_MARKER" && "${lines[1]}" == "label=$LABEL" ]] || return 1
  RECEIPT_ROOT="${lines[2]#root=}"; RECEIPT_SOURCE="${lines[3]#source=}"; RECEIPT_BUN="${lines[4]#bun=}"
  RECEIPT_COMMAND="${lines[5]#command=}"; RECEIPT_SERVICE="${lines[6]#service=}"
  [[ "${lines[2]}" == root=* && "${lines[3]}" == source=* && "${lines[4]}" == bun=* &&
    "${lines[5]}" == command=* && "${lines[6]}" == service=* ]] || return 1
  if (( ${#lines[@]} == 12 )); then
    RECEIPT_FORMAT=current; RECEIPT_SHARE="${lines[7]#share=}"; RECEIPT_QUEUE="${lines[8]#queue=}"
    RECEIPT_LOG="${lines[9]#log=}"; RECEIPT_SERVICE_PATH="${lines[10]#path=}"; RECEIPT_SHA="${lines[11]#sha=}"
    [[ "${lines[7]}" == share=* && "${lines[8]}" == queue=* && "${lines[9]}" == log=* && "${lines[10]}" == path=* && "${lines[11]}" == sha=* ]] || return 1
    cmp -s "$file" <(render_receipt "$RECEIPT_ROOT" "$RECEIPT_SOURCE" "$RECEIPT_BUN" "$RECEIPT_COMMAND" "$RECEIPT_SERVICE" "$RECEIPT_SHARE" "$RECEIPT_QUEUE" "$RECEIPT_LOG" "$RECEIPT_SERVICE_PATH" "$RECEIPT_SHA") || return 1
  else
    RECEIPT_FORMAT=legacy; RECEIPT_SHA="${lines[7]#sha=}"; [[ "${lines[7]}" == sha=* ]] || return 1
    RECEIPT_SHARE="$SHARE_DIR"; RECEIPT_QUEUE="$SHARE_DIR/queue"; RECEIPT_LOG="$STATE_DIR/process-queue.log"
    RECEIPT_SERVICE_PATH="$(expected_service_path "$RECEIPT_BUN" "$RECEIPT_COMMAND")"
  fi
  for line in "$RECEIPT_ROOT" "$RECEIPT_SOURCE" "$RECEIPT_BUN" "$RECEIPT_COMMAND" "$RECEIPT_SERVICE" "$RECEIPT_SHARE" "$RECEIPT_QUEUE" "$RECEIPT_LOG"; do safe_absolute_path "$line" || return 1; done
  [[ "$RECEIPT_SOURCE" == "$RECEIPT_ROOT/src/cli.ts" && "$RECEIPT_COMMAND" == "$COMMAND_PATH" &&
    "$RECEIPT_SERVICE" == "$SERVICE_DEST" && "$RECEIPT_QUEUE" == "$RECEIPT_SHARE/queue" &&
    "$RECEIPT_LOG" == "$STATE_DIR/process-queue.log" && "$RECEIPT_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$RECEIPT_SERVICE_PATH" == "$(expected_service_path "$RECEIPT_BUN" "$RECEIPT_COMMAND")" ]] || return 1
  if [[ "$RECEIPT_ROOT" == "$RUNTIME_DIR/$RECEIPT_SHA" ]]; then
    [[ "$RECEIPT_FORMAT" == current ]] || return 1
    RECEIPT_KIND=snapshot
  else
    RECEIPT_KIND=checkout
  fi
}

resolve_commit_tree() {
  local authority="$1" sha="$2" commit type tree
  [[ "$sha" =~ ^[0-9a-f]{40}$ && -d "$authority" && ! -L "$authority" &&
    "$(git -C "$authority" rev-parse --show-toplevel 2>/dev/null)" == "$authority" ]] || return 1
  commit="$(git -C "$authority" rev-parse --verify "$sha^{commit}" 2>/dev/null)" || return 1
  type="$(git -C "$authority" cat-file -t "$sha" 2>/dev/null)" || return 1
  tree="$(git -C "$authority" rev-parse --verify "$sha^{tree}" 2>/dev/null)" || return 1
  [[ "$commit" == "$sha" && "$type" == commit && "$tree" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$tree"
}

resolve_git_tree() {
  local authority="$1" sha="$2" tree entry mode type object path
  tree="$(resolve_commit_tree "$authority" "$sha")" || return 1
  entry="$(git -C "$authority" ls-tree "$sha" -- scripts/runtime-snapshot.ts 2>/dev/null)" || return 1
  mode="${entry%% *}"; entry="${entry#* }"; type="${entry%% *}"; entry="${entry#* }"; object="${entry%%$'\t'*}"; path="${entry#*$'\t'}"
  [[ ( "$mode" == 100644 || "$mode" == 100755 ) && "$type" == blob &&
    "$object" =~ ^[0-9a-f]{40}$ && "$path" == scripts/runtime-snapshot.ts ]] || return 1
  printf '%s\n' "$tree"
}

run_helper() {
  local authority="$1" sha="$2" tree="$3" bun="$4" temporary resolved; shift 4
  resolved="$(resolve_git_tree "$authority" "$sha")" || fail "Git authority cannot authenticate runtime helper for $sha"
  [[ "$resolved" == "$tree" ]] || fail "Git authority resolved the wrong tree for $sha"
  temporary="$(mktemp -d "$STATE_DIR/.runtime-helper.XXXXXX")"
  git -C "$authority" show "$sha:scripts/runtime-snapshot.ts" >"$temporary/helper.ts"
  chmod 500 "$temporary/helper.ts"
  "$bun" "$temporary/helper.ts" "$@"
  rm -rf "$temporary"
}

verify_snapshot() {
  local root="$1" sha="$2" bun="$3" tree
  tree="$(resolve_git_tree "$ROOT_DIR" "$sha")" || return 1
  run_helper "$ROOT_DIR" "$sha" "$tree" "$bun" verify "$root" "$sha" "$tree" >/dev/null
}

snapshot_helper_preflight() {
  local root="$1" sha="$2" bun="$3" helper="$1/scripts/runtime-snapshot.ts" manifest="$1/.agentscrape-runtime-manifest.json"
  [[ "$root" == "$RUNTIME_DIR/$sha" ]] || { printf 'snapshot root is outside the configured runtime directory\n' >&2; return 1; }
  [[ "$RECEIPT_SOURCE" == "$root/src/cli.ts" ]] || { printf 'snapshot receipt source is inconsistent\n' >&2; return 1; }
  # The program is a literal passed to Bun.
  # shellcheck disable=SC2016
  "$bun" -e '
    import { createHash } from "node:crypto";
    import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
    const [root, sha, manifestPath, helperPath, uidText] = process.argv.slice(1);
    const uid = Number(uidText), hex40 = /^[0-9a-f]{40}$/, hex64 = /^[0-9a-f]{64}$/;
    const mode = (s) => s.mode & 0o7777;
    const regular = (s) => s.isFile() && s.uid === uid && s.nlink === 1;
    const stable = (a, b) => ["dev","ino","mode","nlink","uid","gid","rdev","size","mtimeMs","ctimeMs"]
      .every((key) => a[key] === b[key]);
    const rootBefore = lstatSync(root);
    if (!rootBefore.isDirectory() || rootBefore.uid !== uid || mode(rootBefore) !== 0o500) throw Error("unsafe snapshot root");
    const scripts = lstatSync(`${root}/scripts`);
    if (!scripts.isDirectory() || scripts.uid !== uid || mode(scripts) !== 0o500) throw Error("unsafe snapshot scripts directory");
    const readStable = (path, limit, wantedMode) => {
      const before = lstatSync(path);
      if (!regular(before) || mode(before) !== wantedMode || before.size > limit) throw Error("unsafe snapshot file");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd); if (!stable(before, opened)) throw Error("snapshot file changed");
        const bytes = readFileSync(fd), finished = fstatSync(fd), after = lstatSync(path);
        if (bytes.length !== before.size || !stable(before, finished) || !stable(before, after)) throw Error("snapshot file changed");
        return bytes;
      } finally { closeSync(fd); }
    };
    const bytes = readStable(manifestPath, 8 * 1024 * 1024, 0o400);
    let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw Error("malformed snapshot manifest"); }
    const keys = "architecture,bun_version,entries,entrypoint,install_argv,kind,platform,schema_version,sha,tree";
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).sort().join(",") !== keys ||
      value.schema_version !== 1 || value.kind !== "agentscrape-runtime-snapshot" || value.sha !== sha || !hex40.test(sha) ||
      typeof value.tree !== "string" || !hex40.test(value.tree) || value.entrypoint !== "src/cli.ts" ||
      JSON.stringify(value.install_argv) !== JSON.stringify(["install","--frozen-lockfile","--production","--ignore-scripts","--backend=copyfile"]) ||
      !Array.isArray(value.entries) || value.entries.length > 20000 ||
      !bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw Error("noncanonical snapshot manifest");
    const matches = value.entries.filter((entry) => entry?.path === "scripts/runtime-snapshot.ts");
    if (matches.length !== 1) throw Error("snapshot helper inventory is ambiguous");
    const entry = matches[0];
    if (Object.keys(entry).sort().join(",") !== "mode,path,sha256,size,type" || entry.type !== "file" ||
      (entry.mode !== "0400" && entry.mode !== "0500") || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024 ||
      typeof entry.sha256 !== "string" || !hex64.test(entry.sha256)) throw Error("snapshot helper inventory is malformed");
    const helper = readStable(helperPath, 64 * 1024 * 1024, Number.parseInt(entry.mode, 8));
    if (helper.length !== entry.size || createHash("sha256").update(helper).digest("hex") !== entry.sha256 ||
      !stable(rootBefore, lstatSync(root))) throw Error("snapshot helper does not match manifest");
    process.stdout.write(`${value.tree}\n`);
  ' "$root" "$sha" "$manifest" "$helper" "$OWNER_UID"
}

verify_sealed_snapshot() {
  local tree
  tree="$(snapshot_helper_preflight "$RECEIPT_ROOT" "$RECEIPT_SHA" "$RECEIPT_BUN")" || return 1
  "$RECEIPT_BUN" "$RECEIPT_ROOT/scripts/runtime-snapshot.ts" verify "$RECEIPT_ROOT" "$RECEIPT_SHA" "$tree" >/dev/null || return 1
  UNINSTALL_TREE="$tree"; UNINSTALL_HELPER="$RECEIPT_ROOT/scripts/runtime-snapshot.ts"
}

prepare_snapshot() {
  local sha="$1" tree="$2" bun="$3" target="$RUNTIME_DIR/$1" stage listing status=0 version
  if [[ -e "$target" || -L "$target" ]]; then
    verify_snapshot "$target" "$sha" "$bun" || fail "refusing invalid existing runtime snapshot: $target"
    fsync_path directory "$RUNTIME_DIR"
    return
  fi
  listing="$(git -C "$ROOT_DIR" ls-tree -r --format='%(objectmode) %(objecttype)' "$sha")"
  while read -r mode type; do [[ "$mode" != 120000 && "$mode" != 160000 && "$type" != commit ]] || fail "refusing tracked symlink or gitlink in runtime commit"; done <<<"$listing"
  for path in src/cli.ts config/presets config/preset-schema.yaml plist/$LABEL.plist scripts/runtime-snapshot.ts test/corpus package.json bun.lock; do
    git -C "$ROOT_DIR" cat-file -e "$sha:$path" 2>/dev/null || fail "runtime commit is missing required asset: $path"
  done
  stage="$(mktemp -d "$RUNTIME_DIR/.stage.XXXXXX")"
  set +e
  ( set -e
    git -C "$ROOT_DIR" archive "$sha" | tar -x -C "$stage"
    cd "$stage"
    "$bun" install --frozen-lockfile --production --ignore-scripts --backend=copyfile
    version="$("$bun" --version)"
    "$bun" scripts/runtime-snapshot.ts prepare "$stage" "$sha" "$tree" "$version"
    "$bun" scripts/runtime-snapshot.ts verify "$stage" "$sha" "$tree"
  )
  status=$?
  set -e
  if (( status != 0 )); then chmod -R u+w "$stage" 2>/dev/null || true; rm -rf "$stage"; fail "failed to prepare sealed runtime snapshot for $sha"; fi
  run_helper "$ROOT_DIR" "$sha" "$tree" "$bun" publish "$stage" "$target" || status=$?
  if (( status == 17 )); then chmod -R u+w "$stage" 2>/dev/null || true; rm -rf "$stage"
  elif (( status != 0 )); then fail "native no-replace runtime publication failed"
  fi
  verify_snapshot "$target" "$sha" "$bun" || fail "published runtime snapshot failed verification"
  fsync_path directory "$RUNTIME_DIR"
}

receipt_is_authorized() {
  local tree
  if [[ "$RECEIPT_KIND" == snapshot ]]; then verify_snapshot "$RECEIPT_ROOT" "$RECEIPT_SHA" "$RECEIPT_BUN"; return; fi
  tree="$(resolve_commit_tree "$ROOT_DIR" "$RECEIPT_SHA")" || return 1
  [[ -f "$RECEIPT_BUN" && -x "$RECEIPT_BUN" && -d "$RECEIPT_ROOT" && ! -L "$RECEIPT_ROOT" ]] || return 1
  [[ "$(resolve_commit_tree "$RECEIPT_ROOT" "$RECEIPT_SHA" 2>/dev/null)" == "$tree" ]] || return 1
}

receipt_command_matches() { wrapper_matches_values "$COMMAND_PATH" "$RECEIPT_ROOT" "$RECEIPT_SHA" "$RECEIPT_BUN" "$RECEIPT_SOURCE" "$RECEIPT_SHARE"; }
receipt_plist_matches() {
  local template
  if [[ "$RECEIPT_KIND" == snapshot ]]; then template="$RECEIPT_ROOT/plist/$LABEL.plist"
  else
    template="$(mktemp "$STATE_DIR/.prior-plist.XXXXXX")"
    git -C "$ROOT_DIR" show "$RECEIPT_SHA:plist/$LABEL.plist" >"$template"
  fi
  plist_matches_values "$SERVICE_DEST" "$template" "$RECEIPT_COMMAND" "$RECEIPT_SERVICE_PATH" "$RECEIPT_QUEUE" "$RECEIPT_LOG"
  local status=$?
  [[ "$RECEIPT_KIND" == snapshot ]] || rm -f "$template"
  return "$status"
}

current_receipt_matches() {
  [[ "$RECEIPT_FORMAT" == current && "$RECEIPT_KIND" == snapshot ]] || return 1
  cmp -s "$RECEIPT_PATH" <(render_receipt "$SNAPSHOT_ROOT" "$SNAPSHOT_SOURCE" "$BUN_BIN" "$COMMAND_PATH" "$SERVICE_DEST" "$SHARE_DIR" "$QUEUE_DIR" "$LOG_PATH" "$SERVICE_PATH" "$DEPLOYED_SHA")
}

capture_identity() {
  local path="$1" prefix="$2"
  if [[ -e "$path" && ! -L "$path" ]]; then
    printf -v "${prefix}_PRESENT" 1
    printf -v "${prefix}_INODE" '%s' "$(path_inode "$path")"
    printf -v "${prefix}_DEVICE" '%s' "$(path_device "$path")"
  fi
}

classify_install() {
  local command_current=0 service_current=0 receipt_current=0 deployed_current=0 deployed_valid=0
  capture_identity "$COMMAND_PATH" COMMAND; capture_identity "$SERVICE_DEST" SERVICE
  capture_identity "$RECEIPT_PATH" RECEIPT; capture_identity "$DEPLOYED_SHA_PATH" DEPLOYED
  if (( RECEIPT_PRESENT )); then load_receipt || fail "refusing malformed or unowned install receipt"; receipt_is_authorized || fail "install receipt is outside current Git authority"; fi
  if wrapper_matches_values "$COMMAND_PATH" "$SNAPSHOT_ROOT" "$DEPLOYED_SHA" "$BUN_BIN" "$SNAPSHOT_SOURCE" "$SHARE_DIR"; then command_current=1; fi
  if plist_matches_values "$SERVICE_DEST" "$SNAPSHOT_TEMPLATE" "$COMMAND_PATH" "$SERVICE_PATH" "$QUEUE_DIR" "$LOG_PATH"; then service_current=1; fi
  if (( RECEIPT_PRESENT )) && current_receipt_matches; then receipt_current=1; fi
  if (( DEPLOYED_PRESENT )); then
    if [[ -f "$DEPLOYED_SHA_PATH" && ! -L "$DEPLOYED_SHA_PATH" && "$(<"$DEPLOYED_SHA_PATH")" =~ ^[0-9a-f]{40}$ &&
      "$(path_mode "$DEPLOYED_SHA_PATH")" == 600 && "$(path_nlink "$DEPLOYED_SHA_PATH")" == 1 ]]; then deployed_valid=1; fi
    if deployed_matches "$DEPLOYED_SHA_PATH" "$DEPLOYED_SHA"; then deployed_current=1; fi
  fi
  if (( ! RECEIPT_PRESENT && ! DEPLOYED_PRESENT && ! COMMAND_PRESENT && ! SERVICE_PRESENT )); then PREINSTALL_STATE=A
  elif (( receipt_current && command_current && service_current && deployed_current )); then PREINSTALL_STATE=D
  elif (( receipt_current && command_current && service_current && (! DEPLOYED_PRESENT || (deployed_valid && ! deployed_current)) )); then PREINSTALL_STATE=C
  elif (( RECEIPT_PRESENT && COMMAND_PRESENT && SERVICE_PRESENT && DEPLOYED_PRESENT )) &&
    receipt_command_matches && receipt_plist_matches && deployed_matches "$DEPLOYED_SHA_PATH" "$RECEIPT_SHA"; then PREINSTALL_STATE=B
  else fail "refusing foreign, malformed, or interrupted mixed install state"
  fi
  ALLOW_CURRENT_SERVICE_IDENTITY=1
  [[ "$PREINSTALL_STATE" == B ]] && ALLOW_RECEIPT_SERVICE_IDENTITY=1 || true
}

run_launchctl_bounded() {
  "$BUN_BIN" -e '
    import { spawnSync } from "node:child_process";
    const result = spawnSync(process.argv[1], process.argv.slice(2), {
      encoding: "utf8", maxBuffer: 65_536, env: process.env,
    });
    if (result.error || result.signal || result.status === null) process.exit(125);
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status);
  ' "$LAUNCHCTL_BIN" "$@"
}

trim_space() { local v="$1"; while [[ "$v" == ' '* || "$v" == $'\t'* ]]; do v="${v#?}"; done; while [[ "$v" == *' ' || "$v" == *$'\t' ]]; do v="${v%?}"; done; printf '%s' "$v"; }

loaded_output_matches() {
  local program="$1" service_path="$2" plist="$3" line trimmed in_env=0 programs=0 plists=0 envs=0 paths=0 oslogs=0 xpcs=0 invalid=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_space "$line")"
    case "$trimmed" in
      'program = '*) [[ "$trimmed" == "program = $program" ]] && ((programs+=1)) || invalid=1 ;;
      'path = '*) [[ "$trimmed" == "path = $plist" ]] && ((plists+=1)) || invalid=1 ;;
      'environment = {') ((envs+=1)); in_env=1 ;;
      'environment = {'*) ((envs+=1)); [[ "$trimmed" == "environment = { PATH => $service_path }" ]] && ((paths+=1)) || invalid=1 ;;
      '}') in_env=0 ;;
      *' => '*)
        if (( in_env )); then
          case "$trimmed" in
            "PATH => $service_path") ((paths+=1)) ;;
            'OSLogRateLimit => 64') ((oslogs+=1)); (( oslogs == 1 )) || invalid=1 ;;
            "XPC_SERVICE_NAME => $LABEL") ((xpcs+=1)); (( xpcs == 1 )) || invalid=1 ;;
            *) invalid=1 ;;
          esac
        fi
        ;;
    esac
  done <<<"$LOADED_SERVICE_PRINT"
  (( ! invalid && programs == 1 && plists == 1 && envs == 1 && paths == 1 ))
}

inspect_service() {
  local status expected
  LOADED_SERVICE_PRINT=""
  if LOADED_SERVICE_PRINT="$(run_launchctl_bounded print "$SERVICE_TARGET" 2>&1)"; then status=0; else status=$?; fi
  if (( status == 113 )); then
    expected="$(printf 'Bad request.\nCould not find service "%s" in domain for user gui: %s' "$LABEL" "$OWNER_UID")"
    [[ "$LOADED_SERVICE_PRINT" == "$expected" ]] || fail "launchctl returned noncanonical absent-service evidence"
    LOADED_SERVICE_STATE=absent; return
  fi
  (( status == 0 )) || fail "launchctl could not determine service state (status $status)"
  if (( ALLOW_CURRENT_SERVICE_IDENTITY )) && loaded_output_matches "$COMMAND_PATH" "$SERVICE_PATH" "$SERVICE_DEST"; then LOADED_SERVICE_STATE=owned
  elif (( ALLOW_RECEIPT_SERVICE_IDENTITY )) && loaded_output_matches "$RECEIPT_COMMAND" "$RECEIPT_SERVICE_PATH" "$RECEIPT_SERVICE"; then LOADED_SERVICE_STATE=owned
  else LOADED_SERVICE_STATE=foreign
  fi
}

check_service() { inspect_service; [[ "$LOADED_SERVICE_STATE" != foreign ]] || fail "refusing foreign loaded service"; }

unload_service() {
  inspect_service
  [[ "$LOADED_SERVICE_STATE" != foreign ]] || fail "refusing foreign loaded service"
  [[ "$LOADED_SERVICE_STATE" == absent ]] && return
  local output status=0
  output="$(run_launchctl_bounded bootout "$SERVICE_TARGET" 2>&1)" || status=$?
  (( status == 0 )) && [[ -z "$output" ]] || fail "launchctl bootout failed"
  inspect_service
  [[ "$LOADED_SERVICE_STATE" == absent ]] || fail "service remained loaded after bootout"
}

make_backup() {
  local source="$1" destination="$2"
  [[ -e "$source" && ! -L "$source" ]] || return 0
  cp -p "$source" "$destination"
  fsync_path file "$destination"
}

path_has_identity() { [[ -e "$1" && ! -L "$1" && "$(path_inode "$1")" == "$2" && "$(path_device "$1")" == "$3" ]]; }

publish_file() {
  local source="$1" destination="$2" present="$3" inode="$4" device="$5" label="$6"
  if (( present )); then
    path_has_identity "$destination" "$inode" "$device" || fail "$label changed after classification"
    # An active malicious same-UID process can still race this final check and rename.
    mv -f "$source" "$destination"
  else
    if [[ "${AGENTSCRAPE_INSTALL_TEST_COLLIDE:-}" == "$label" ]]; then printf foreign >"$destination"; fi
    run_helper "$ROOT_DIR" "$DEPLOYED_SHA" "$DEPLOYED_TREE" "$BUN_BIN" publish "$source" "$destination"
  fi
}

prepare_prior_snapshot_and_backups() {
  if (( ! RECEIPT_PRESENT )); then return; fi
  make_backup "$COMMAND_PATH" "$COMMAND_BACKUP"
  make_backup "$SERVICE_DEST" "$SERVICE_BACKUP"
  make_backup "$RECEIPT_PATH" "$RECEIPT_BACKUP"
  make_backup "$DEPLOYED_SHA_PATH" "$DEPLOYED_BACKUP"
}

restore_one() {
  local backup="$1" destination="$2" changed="$3" mode="$4"
  (( changed )) || return 0
  if [[ -f "$backup" && ! -L "$backup" ]]; then
    [[ ! -e "$destination" || -f "$destination" ]] || return 1
    mv -f "$backup" "$destination"; chmod "$mode" "$destination"
  else
    [[ ! -L "$destination" ]] || return 1
    rm -f "$destination"
  fi
}

cleanup_temps() { rm -f "$COMMAND_TEMP" "$SERVICE_TEMP" "$RECEIPT_TEMP" "$DEPLOYED_TEMP" "$COMMAND_BACKUP" "$SERVICE_BACKUP" "$RECEIPT_BACKUP" "$DEPLOYED_BACKUP" 2>/dev/null || true; }

rollback_install() {
  local status="$?" ok=1
  if (( ROLLBACK_ENABLED && ! DEPLOYMENT_PUBLISHED )); then
    set +e
    inspect_service
    [[ "$LOADED_SERVICE_STATE" != owned ]] || "$LAUNCHCTL_BIN" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || ok=0
    restore_one "$DEPLOYED_BACKUP" "$DEPLOYED_SHA_PATH" "$DEPLOYED_CHANGED" 600 || ok=0
    restore_one "$RECEIPT_BACKUP" "$RECEIPT_PATH" "$RECEIPT_CHANGED" 600 || ok=0
    restore_one "$SERVICE_BACKUP" "$SERVICE_DEST" "$SERVICE_CHANGED" 600 || ok=0
    restore_one "$COMMAND_BACKUP" "$COMMAND_PATH" "$COMMAND_CHANGED" 755 || ok=0
    fsync_path directory "$STATE_DIR" || ok=0; fsync_path directory "$LAUNCH_AGENTS_DIR" || ok=0; fsync_path directory "$BIN_DIR" || ok=0
    if (( PREVIOUS_SERVICE_LOADED )); then "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$SERVICE_DEST" >/dev/null 2>&1 || ok=0; fi
    (( ok )) && printf 'agentscrape-install: restored previous owned state after failure\n' >&2 || printf 'agentscrape-install: rollback incomplete; manual cleanup required\n' >&2
    cleanup_temps
    set -e
  fi
  release_lock "$status"
  exit "$status"
}

failpoint() { [[ "${AGENTSCRAPE_INSTALL_TEST_FAILPOINT:-}" != "$1" ]] || { printf 'agentscrape-install: injected failure at %s\n' "$1" >&2; return 97; }; }

install_public_files() {
  COMMAND_TEMP="$(mktemp "$BIN_DIR/.agentscrape.XXXXXX")"; SERVICE_TEMP="$(mktemp "$LAUNCH_AGENTS_DIR/.$LABEL.XXXXXX")"
  RECEIPT_TEMP="$(mktemp "$STATE_DIR/.install-receipt.XXXXXX")"; DEPLOYED_TEMP="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  render_wrapper "$SNAPSHOT_ROOT" "$DEPLOYED_SHA" "$BUN_BIN" "$SNAPSHOT_SOURCE" "$SHARE_DIR" >"$COMMAND_TEMP"; chmod 755 "$COMMAND_TEMP"
  render_plist "$SNAPSHOT_TEMPLATE" "$COMMAND_PATH" "$SERVICE_PATH" "$QUEUE_DIR" "$LOG_PATH" >"$SERVICE_TEMP"; chmod 600 "$SERVICE_TEMP"; "$PLUTIL_CMD" -lint "$SERVICE_TEMP" >/dev/null
  render_receipt "$SNAPSHOT_ROOT" "$SNAPSHOT_SOURCE" "$BUN_BIN" "$COMMAND_PATH" "$SERVICE_DEST" "$SHARE_DIR" "$QUEUE_DIR" "$LOG_PATH" "$SERVICE_PATH" "$DEPLOYED_SHA" >"$RECEIPT_TEMP"; chmod 600 "$RECEIPT_TEMP"
  printf '%s\n' "$DEPLOYED_SHA" >"$DEPLOYED_TEMP"; chmod 600 "$DEPLOYED_TEMP"
  for file in "$COMMAND_TEMP" "$SERVICE_TEMP" "$RECEIPT_TEMP" "$DEPLOYED_TEMP"; do fsync_path file "$file"; done

  unload_service
  publish_file "$COMMAND_TEMP" "$COMMAND_PATH" "$COMMAND_PRESENT" "$COMMAND_INODE" "$COMMAND_DEVICE" command; COMMAND_TEMP=""; COMMAND_CHANGED=1; fsync_path directory "$BIN_DIR"; failpoint after-command
  publish_file "$SERVICE_TEMP" "$SERVICE_DEST" "$SERVICE_PRESENT" "$SERVICE_INODE" "$SERVICE_DEVICE" plist; SERVICE_TEMP=""; SERVICE_CHANGED=1; fsync_path directory "$LAUNCH_AGENTS_DIR"; failpoint after-plist
  ALLOW_CURRENT_SERVICE_IDENTITY=1
  "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$SERVICE_DEST"
  inspect_service; [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "loaded service failed strict verification"
  publish_file "$RECEIPT_TEMP" "$RECEIPT_PATH" "$RECEIPT_PRESENT" "$RECEIPT_INODE" "$RECEIPT_DEVICE" receipt; RECEIPT_TEMP=""; RECEIPT_CHANGED=1; fsync_path directory "$STATE_DIR"; failpoint after-receipt
  publish_file "$DEPLOYED_TEMP" "$DEPLOYED_SHA_PATH" "$DEPLOYED_PRESENT" "$DEPLOYED_INODE" "$DEPLOYED_DEVICE" deployed; DEPLOYED_TEMP=""; DEPLOYED_CHANGED=1
  failpoint before-deployed-fsync
  fsync_path directory "$STATE_DIR"
  DEPLOYMENT_PUBLISHED=1; ROLLBACK_ENABLED=0
}

restore_uninstall_file() {
  local backup="$1" destination="$2" inode="$3" device="$4"
  if [[ -e "$destination" || -L "$destination" ]]; then
    path_has_identity "$destination" "$inode" "$device"
    return
  fi
  [[ -f "$backup" && ! -L "$backup" ]] || return 1
  if [[ "$RECEIPT_KIND" == snapshot ]]; then
    "$RECEIPT_BUN" "$UNINSTALL_HELPER" publish "$backup" "$destination"
  else
    run_helper "$ROOT_DIR" "$RECEIPT_SHA" "$UNINSTALL_TREE" "$RECEIPT_BUN" publish "$backup" "$destination"
  fi
}

rollback_uninstall() {
  local status="$?" ok=1
  if (( UNINSTALL_ROLLBACK )); then
    set +e
    restore_uninstall_file "$UNINSTALL_COMMAND_BACKUP" "$COMMAND_PATH" "$UNINSTALL_COMMAND_INODE" "$UNINSTALL_COMMAND_DEVICE" || ok=0
    restore_uninstall_file "$UNINSTALL_SERVICE_BACKUP" "$SERVICE_DEST" "$UNINSTALL_SERVICE_INODE" "$UNINSTALL_SERVICE_DEVICE" || ok=0
    restore_uninstall_file "$UNINSTALL_DEPLOYED_BACKUP" "$DEPLOYED_SHA_PATH" "$UNINSTALL_DEPLOYED_INODE" "$UNINSTALL_DEPLOYED_DEVICE" || ok=0
    restore_uninstall_file "$UNINSTALL_RECEIPT_BACKUP" "$RECEIPT_PATH" "$UNINSTALL_RECEIPT_INODE" "$UNINSTALL_RECEIPT_DEVICE" || ok=0
    fsync_path directory "$BIN_DIR" || ok=0
    fsync_path directory "$LAUNCH_AGENTS_DIR" || ok=0
    fsync_path directory "$STATE_DIR" || ok=0
    if (( UNINSTALL_WAS_LOADED )); then "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$SERVICE_DEST" >/dev/null 2>&1 || ok=0; fi
    (( ok )) && printf 'agentscrape-install: restored owned state after uninstall failure\n' >&2 ||
      printf 'agentscrape-install: uninstall rollback incomplete; manual cleanup required\n' >&2
    rm -f "$UNINSTALL_COMMAND_BACKUP" "$UNINSTALL_SERVICE_BACKUP" "$UNINSTALL_DEPLOYED_BACKUP" "$UNINSTALL_RECEIPT_BACKUP" 2>/dev/null || true
    set -e
  fi
  release_lock "$status"
  exit "$status"
}

uninstall() {
  local evidence=0
  for path in "$COMMAND_PATH" "$SERVICE_DEST" "$DEPLOYED_SHA_PATH" "$RECEIPT_PATH"; do [[ ! -e "$path" && ! -L "$path" ]] || evidence=1; done
  ALLOW_CURRENT_SERVICE_IDENTITY=0; ALLOW_RECEIPT_SERVICE_IDENTITY=0
  if (( ! evidence )); then check_service; return; fi
  for path in "$COMMAND_PATH" "$SERVICE_DEST" "$DEPLOYED_SHA_PATH" "$RECEIPT_PATH"; do validate_regular_slot "$path" "uninstall artifact"; [[ -e "$path" ]] || fail "refusing incomplete uninstall state"; done
  load_receipt || fail "refusing malformed uninstall receipt"
  if [[ "$RECEIPT_KIND" == snapshot ]]; then
    verify_sealed_snapshot || fail "uninstall snapshot failed sealed preflight or verification"
  else
    [[ "$RECEIPT_ROOT" == "$ROOT_DIR" && "$RECEIPT_SOURCE" == "$ROOT_DIR/src/cli.ts" ]] ||
      fail "checkout uninstall receipt does not belong to this checkout"
    UNINSTALL_TREE="$(resolve_git_tree "$ROOT_DIR" "$RECEIPT_SHA")" ||
      fail "checkout uninstall receipt helper is outside current Git authority"
    [[ -f "$RECEIPT_BUN" && -x "$RECEIPT_BUN" ]] || fail "checkout uninstall receipt Bun is unavailable"
  fi
  receipt_command_matches || fail "refusing unrelated installed command"
  receipt_plist_matches || fail "refusing unrelated LaunchAgent"
  deployed_matches "$DEPLOYED_SHA_PATH" "$RECEIPT_SHA" || fail "refusing unrelated deployed SHA"
  UNINSTALL_COMMAND_INODE="$(path_inode "$COMMAND_PATH")"; UNINSTALL_COMMAND_DEVICE="$(path_device "$COMMAND_PATH")"
  UNINSTALL_SERVICE_INODE="$(path_inode "$SERVICE_DEST")"; UNINSTALL_SERVICE_DEVICE="$(path_device "$SERVICE_DEST")"
  UNINSTALL_DEPLOYED_INODE="$(path_inode "$DEPLOYED_SHA_PATH")"; UNINSTALL_DEPLOYED_DEVICE="$(path_device "$DEPLOYED_SHA_PATH")"
  UNINSTALL_RECEIPT_INODE="$(path_inode "$RECEIPT_PATH")"; UNINSTALL_RECEIPT_DEVICE="$(path_device "$RECEIPT_PATH")"
  UNINSTALL_COMMAND_BACKUP="$BIN_DIR/.agentscrape.uninstall-rollback.$$"
  UNINSTALL_SERVICE_BACKUP="$LAUNCH_AGENTS_DIR/.$LABEL.uninstall-rollback.$$"
  UNINSTALL_DEPLOYED_BACKUP="$STATE_DIR/.deployed-sha.uninstall-rollback.$$"
  UNINSTALL_RECEIPT_BACKUP="$STATE_DIR/.install-receipt.uninstall-rollback.$$"
  make_backup "$COMMAND_PATH" "$UNINSTALL_COMMAND_BACKUP"
  make_backup "$SERVICE_DEST" "$UNINSTALL_SERVICE_BACKUP"
  make_backup "$DEPLOYED_SHA_PATH" "$UNINSTALL_DEPLOYED_BACKUP"
  make_backup "$RECEIPT_PATH" "$UNINSTALL_RECEIPT_BACKUP"
  fsync_path directory "$BIN_DIR"; fsync_path directory "$LAUNCH_AGENTS_DIR"; fsync_path directory "$STATE_DIR"
  ALLOW_RECEIPT_SERVICE_IDENTITY=1
  inspect_service
  [[ "$LOADED_SERVICE_STATE" != foreign ]] || fail "refusing foreign loaded service"
  [[ "$LOADED_SERVICE_STATE" != owned ]] || UNINSTALL_WAS_LOADED=1
  UNINSTALL_ROLLBACK=1
  trap rollback_uninstall EXIT HUP INT TERM
  unload_service
  path_has_identity "$COMMAND_PATH" "$UNINSTALL_COMMAND_INODE" "$UNINSTALL_COMMAND_DEVICE" || fail "command changed during uninstall"
  path_has_identity "$SERVICE_DEST" "$UNINSTALL_SERVICE_INODE" "$UNINSTALL_SERVICE_DEVICE" || fail "plist changed during uninstall"
  path_has_identity "$DEPLOYED_SHA_PATH" "$UNINSTALL_DEPLOYED_INODE" "$UNINSTALL_DEPLOYED_DEVICE" || fail "deployed SHA changed during uninstall"
  path_has_identity "$RECEIPT_PATH" "$UNINSTALL_RECEIPT_INODE" "$UNINSTALL_RECEIPT_DEVICE" || fail "receipt changed during uninstall"
  rm "$COMMAND_PATH" "$SERVICE_DEST" "$DEPLOYED_SHA_PATH" "$RECEIPT_PATH"
  fsync_path directory "$BIN_DIR"; fsync_path directory "$LAUNCH_AGENTS_DIR"; fsync_path directory "$STATE_DIR"
  UNINSTALL_ROLLBACK=0
  rm -f "$UNINSTALL_COMMAND_BACKUP" "$UNINSTALL_SERVICE_BACKUP" "$UNINSTALL_DEPLOYED_BACKUP" "$UNINSTALL_RECEIPT_BACKUP"
  fsync_path directory "$BIN_DIR"; fsync_path directory "$LAUNCH_AGENTS_DIR"; fsync_path directory "$STATE_DIR"
  trap 'release_lock "$?"' EXIT
}

command -v "$BUN_CMD" >/dev/null 2>&1 || fail "Bun is required"
BUN_BIN="$(command -v "$BUN_CMD")"
command -v "$LAUNCHCTL_CMD" >/dev/null 2>&1 || fail "launchctl is required"
LAUNCHCTL_BIN="$(command -v "$LAUNCHCTL_CMD")"
if [[ "$ACTION" == install ]]; then command -v "$PLUTIL_CMD" >/dev/null 2>&1 || fail "plutil is required"; fi
for executable in "$BUN_BIN" "$LAUNCHCTL_BIN"; do safe_absolute_path "$executable" || fail "tool must resolve to an absolute path"; [[ -f "$executable" && -x "$executable" ]] || fail "tool is not executable"; done
SERVICE_PATH="$(expected_service_path "$BUN_BIN" "$COMMAND_PATH")"
validate_paths
acquire_lock
trap 'release_lock "$?"' EXIT
ensure_directory "$STATE_DIR" "state directory" 700
canonicalize_data_paths
ensure_directory "$RUNTIME_DIR" "runtime directory" 700

if [[ "$ACTION" == uninstall ]]; then
  uninstall
  printf 'uninstalled owned agentscrape command and service\n'
  exit 0
fi

DEPLOYED_SHA="$(git -C "$ROOT_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || fail "current Git authority is unavailable"
DEPLOYED_TREE="$(resolve_git_tree "$ROOT_DIR" "$DEPLOYED_SHA")" || fail "HEAD lacks an authenticated runtime helper"
SNAPSHOT_ROOT="$RUNTIME_DIR/$DEPLOYED_SHA"; SNAPSHOT_SOURCE="$SNAPSHOT_ROOT/src/cli.ts"; SNAPSHOT_TEMPLATE="$SNAPSHOT_ROOT/plist/$LABEL.plist"
ensure_directory "$BIN_DIR" "install bin directory" 700
ensure_directory "$LAUNCH_AGENTS_DIR" "LaunchAgents directory" 700
ensure_directory "$SHARE_DIR" "share directory" 700
canonicalize_data_paths
ensure_directory "$QUEUE_DIR" "queue directory" 700
ensure_directory "$FAILED_DIR" "failed directory" 700
for pair in "$LOG_PATH:queue log" "$DEPLOYED_SHA_PATH:deployed SHA" "$RECEIPT_PATH:install receipt" "$SERVICE_DEST:LaunchAgent"; do validate_regular_slot "${pair%%:*}" "${pair#*:}"; done
validate_regular_slot "$COMMAND_PATH" "installed command" 1
prepare_snapshot "$DEPLOYED_SHA" "$DEPLOYED_TREE" "$BUN_BIN"
classify_install
check_service
if [[ ! -e "$LOG_PATH" ]]; then touch "$LOG_PATH"; chmod 600 "$LOG_PATH"; fsync_path file "$LOG_PATH"; fsync_path directory "$STATE_DIR"; fi
if [[ "$PREINSTALL_STATE" == D ]]; then
  if [[ "$LOADED_SERVICE_STATE" == absent ]]; then "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$SERVICE_DEST"; inspect_service; [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "loaded service verification failed"; fi
else
  COMMAND_BACKUP="$BIN_DIR/.agentscrape.rollback.$$"; SERVICE_BACKUP="$LAUNCH_AGENTS_DIR/.$LABEL.rollback.$$"
  RECEIPT_BACKUP="$STATE_DIR/.install-receipt.rollback.$$"; DEPLOYED_BACKUP="$STATE_DIR/.deployed-sha.rollback.$$"
  prepare_prior_snapshot_and_backups
  [[ "$LOADED_SERVICE_STATE" != owned ]] || PREVIOUS_SERVICE_LOADED=1
  ROLLBACK_ENABLED=1
  trap rollback_install EXIT HUP INT TERM
  if [[ "$PREINSTALL_STATE" == C ]]; then
    if [[ "$LOADED_SERVICE_STATE" == absent ]]; then "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$SERVICE_DEST"; inspect_service; [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "loaded service verification failed"; fi
    DEPLOYED_TEMP="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"; printf '%s\n' "$DEPLOYED_SHA" >"$DEPLOYED_TEMP"; chmod 600 "$DEPLOYED_TEMP"; fsync_path file "$DEPLOYED_TEMP"
    publish_file "$DEPLOYED_TEMP" "$DEPLOYED_SHA_PATH" "$DEPLOYED_PRESENT" "$DEPLOYED_INODE" "$DEPLOYED_DEVICE" deployed; DEPLOYED_TEMP=""; DEPLOYED_CHANGED=1; failpoint before-deployed-fsync; fsync_path directory "$STATE_DIR"; DEPLOYMENT_PUBLISHED=1; ROLLBACK_ENABLED=0
  else
    install_public_files
  fi
  cleanup_temps
  trap 'release_lock "$?"' EXIT
fi
printf 'installed %s\ninstalled and loaded %s\n' "$COMMAND_PATH" "$SERVICE_DEST"
