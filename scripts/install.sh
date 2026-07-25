#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--install|--uninstall|--help]

Install creates the standalone agentscrape command plus one owned user LaunchAgent
for `agentscrape process-queue`.

Uninstall safely unloads and removes only the owned command, LaunchAgent, and
installer receipts. It preserves queue, failed-job, and log state.
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
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
if (( $# > 1 )); then
  usage >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE_CLI="$ROOT/src/cli.ts"
LABEL="agentscrape.process-queue"
BIN_DIR="${AGENTSCRAPE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
COMMAND_PATH="$BIN_DIR/agentscrape"
LAUNCH_AGENTS_DIR="${AGENTSCRAPE_INSTALL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
SERVICE_DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
TEMPLATE="$ROOT/plist/$LABEL.plist"
STATE_DIR="${AGENTSCRAPE_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentscrape}"
SHARE_DIR="${AGENTSCRAPE_INSTALL_SHARE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agentscrape}"
QUEUE_DIR="$SHARE_DIR/queue"
FAILED_DIR="$SHARE_DIR/failed"
LOG_PATH="$STATE_DIR/process-queue.log"
DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
RECEIPT_PATH="$STATE_DIR/install-receipt"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$DOMAIN/$LABEL"
BUN_CMD="${AGENTSCRAPE_INSTALL_BUN:-bun}"
LAUNCHCTL="${AGENTSCRAPE_INSTALL_LAUNCHCTL:-launchctl}"
PLUTIL="${AGENTSCRAPE_INSTALL_PLUTIL:-plutil}"
COMMAND_MARKER="agentscrape-installer-owned: agentscrape.command.v1"
RECEIPT_MARKER="agentscrape-installer-owned: agentscrape.install-receipt.v1"
OWNER_UID="$(id -u)"
PLATFORM="$(uname -s)"
ROOT_DIR="$(cd "$ROOT" && pwd -P)"
SOURCE_CLI_CANONICAL="$ROOT_DIR/src/cli.ts"

BUN_BIN=""
SERVICE_PATH=""
DEPLOYED_SHA=""
LOADED_SERVICE_STATE=absent
LOADED_SERVICE_PRINT=""
PREVIOUS_SERVICE_LOADED=0
ROLLBACK_ENABLED=0
INSTALL_RECEIPT_PRESENT=0
INSTALL_RECEIPT_CURRENT=0
INSTALL_COMMAND_PRESENT=0
INSTALL_COMMAND_CURRENT=0
INSTALL_COMMAND_PRIOR=0
INSTALL_SERVICE_PRESENT=0
INSTALL_SERVICE_CURRENT=0
INSTALL_SERVICE_PRIOR=0
INSTALL_DEPLOYED_PRESENT=0
INSTALL_DEPLOYED_VALID=0
INSTALL_DEPLOYED_CURRENT=0
INSTALL_DEPLOYED_PRIOR=0
ALLOW_CURRENT_SERVICE_IDENTITY=0
ALLOW_RECEIPT_SERVICE_IDENTITY=0
COMMAND_BACKUP=""
SERVICE_BACKUP=""
RECEIPT_BACKUP=""
COMMAND_ORIGINAL_PRESENT=0
SERVICE_ORIGINAL_PRESENT=0
RECEIPT_ORIGINAL_PRESENT=0
COMMAND_REPLACED=0
SERVICE_REPLACED=0
RECEIPT_REPLACED=0
DEPLOYED_ORIGINAL_PRESENT=0
DEPLOYED_ORIGINAL_INODE=""
DEPLOYED_SHA_TEMP=""
FINAL_PUBLICATION_ARMED=0
DEPLOYMENT_PUBLISHED=0
RECEIPT_FORMAT=""
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
    *) fail "unsupported platform for ownership checks: $PLATFORM" ;;
  esac
}

path_mode() {
  case "$PLATFORM" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' -- "$1" ;;
    *) fail "unsupported platform for mode checks: $PLATFORM" ;;
  esac
}

path_nlink() {
  case "$PLATFORM" in
    Darwin) stat -f '%l' "$1" ;;
    Linux) stat -c '%h' -- "$1" ;;
    *) fail "unsupported platform for link-count checks: $PLATFORM" ;;
  esac
}

path_inode() {
  case "$PLATFORM" in
    Darwin) stat -f '%i' "$1" ;;
    Linux) stat -c '%i' -- "$1" ;;
    *) fail "unsupported platform for inode checks: $PLATFORM" ;;
  esac
}

safe_absolute_path() {
  local path="$1"
  [[ "$path" == /* && "$path" != "/" && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  [[ "$path" != *//* && "$path" != */./* && "$path" != */../* && "$path" != */. && "$path" != */.. ]]
}

is_standard_macos_alias() {
  local path="$1" target
  [[ "$PLATFORM" == Darwin ]] || return 1
  case "$path" in
    /tmp)
      target="$(readlink "$path")" || return 1
      [[ "$target" == private/tmp || "$target" == /private/tmp ]]
      ;;
    /var)
      target="$(readlink "$path")" || return 1
      [[ "$target" == private/var || "$target" == /private/var ]]
      ;;
    *) return 1 ;;
  esac
}

validate_no_follow_path() {
  local path="$1" label="$2" allow_final_symlink="${3:-0}"
  local rest component current="" final=0
  safe_absolute_path "$path" || fail "$label must be a normalized absolute path: $path"
  rest="${path#/}"
  while [[ -n "$rest" ]]; do
    if [[ "$rest" == */* ]]; then
      component="${rest%%/*}"
      rest="${rest#*/}"
    else
      component="$rest"
      rest=""
      final=1
    fi
    current="$current/$component"
    if [[ -L "$current" ]]; then
      if is_standard_macos_alias "$current"; then
        :
      elif (( final && allow_final_symlink )); then
        :
      else
        fail "$label has a symlink path component: $current"
      fi
    elif [[ -e "$current" ]] && (( ! final )) && [[ ! -d "$current" ]]; then
      fail "$label has a non-directory path component: $current"
    fi
  done
}

validate_configured_paths() {
  validate_no_follow_path "$BIN_DIR" "install bin directory"
  validate_no_follow_path "$LAUNCH_AGENTS_DIR" "LaunchAgents directory"
  validate_no_follow_path "$STATE_DIR" "state directory"
  validate_no_follow_path "$SHARE_DIR" "share directory"
  validate_no_follow_path "$QUEUE_DIR" "queue directory"
  validate_no_follow_path "$FAILED_DIR" "failed directory"
  validate_no_follow_path "$LOG_PATH" "queue log"
  validate_no_follow_path "$DEPLOYED_SHA_PATH" "deployment receipt"
  validate_no_follow_path "$RECEIPT_PATH" "install receipt"
  validate_no_follow_path "$COMMAND_PATH" "installed command" 1
  validate_no_follow_path "$SERVICE_DEST" "LaunchAgent"
}

ensure_directory() {
  local path="$1" label="$2" mode="$3"
  validate_no_follow_path "$path" "$label"
  [[ ! -e "$path" || -d "$path" ]] || fail "$label must be a directory: $path"
  mkdir -p "$path"
  validate_no_follow_path "$path" "$label"
  [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
  chmod "$mode" "$path"
}

validate_regular_file_slot() {
  local path="$1" label="$2" allow_final_symlink="${3:-0}"
  validate_no_follow_path "$path" "$label" "$allow_final_symlink"
  if [[ -L "$path" ]]; then
    (( allow_final_symlink )) && return 0
    fail "$label must not be a symlink: $path"
  fi
  [[ ! -e "$path" || -f "$path" ]] || fail "$label must be a regular file: $path"
  if [[ -e "$path" ]]; then
    [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
    [[ "$(path_nlink "$path")" == "1" ]] || fail "$label must have exactly one hard link: $path"
  fi
}

canonicalize_state_and_share_paths() {
  if [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]]; then
    STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
  fi
  if [[ -d "$SHARE_DIR" && ! -L "$SHARE_DIR" ]]; then
    SHARE_DIR="$(cd "$SHARE_DIR" && pwd -P)"
  fi
  QUEUE_DIR="$SHARE_DIR/queue"
  FAILED_DIR="$SHARE_DIR/failed"
  LOG_PATH="$STATE_DIR/process-queue.log"
  DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
  RECEIPT_PATH="$STATE_DIR/install-receipt"
}

prepare_private_paths() {
  validate_configured_paths
  ensure_directory "$BIN_DIR" "install bin directory" 700
  ensure_directory "$LAUNCH_AGENTS_DIR" "LaunchAgents directory" 700
  ensure_directory "$STATE_DIR" "state directory" 700
  ensure_directory "$SHARE_DIR" "share directory" 700
  canonicalize_state_and_share_paths
  validate_configured_paths
  ensure_directory "$QUEUE_DIR" "queue directory" 700
  ensure_directory "$FAILED_DIR" "failed directory" 700
  validate_regular_file_slot "$LOG_PATH" "queue log"
  validate_regular_file_slot "$DEPLOYED_SHA_PATH" "deployment receipt"
  validate_regular_file_slot "$RECEIPT_PATH" "install receipt"
  validate_regular_file_slot "$COMMAND_PATH" "installed command" 1
  validate_regular_file_slot "$SERVICE_DEST" "LaunchAgent"
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

expected_service_path() {
  local bun="$1" command_path="$2"
  printf '%s:%s:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n' \
    "$(dirname "$bun")" "$(dirname "$command_path")"
}

render_wrapper_content() {
  local root="$1" sha="$2" bun="$3" source="$4" share="$5"
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf '# %s\n' "$COMMAND_MARKER"
  printf '# label: %s\n' "$LABEL"
  printf '# source-root: %s\n' "$root"
  printf '# source-sha: %s\n' "$sha"
  printf '# bun: %s\n' "$bun"
  printf 'export AGENTSCRAPE_DATA_HOME=%s\n' "$(shell_quote "$share")"
  printf 'exec %s %s "$@"\n' "$(shell_quote "$bun")" "$(shell_quote "$source")"
}

wrapper_file_matches_values() {
  local root="$1" sha="$2" bun="$3" source="$4" share="$5"
  [[ -f "$COMMAND_PATH" && ! -L "$COMMAND_PATH" ]] || return 1
  [[ "$(path_owner_uid "$COMMAND_PATH")" == "$OWNER_UID" ]] || return 1
  [[ "$(path_mode "$COMMAND_PATH")" == "755" ]] || return 1
  [[ "$(path_nlink "$COMMAND_PATH")" == "1" ]] || return 1
  cmp -s "$COMMAND_PATH" <(render_wrapper_content "$root" "$sha" "$bun" "$source" "$share")
}

installed_command_is_expected() {
  wrapper_file_matches_values "$ROOT_DIR" "$DEPLOYED_SHA" "$BUN_BIN" "$SOURCE_CLI_CANONICAL" "$SHARE_DIR"
}

wrapper_matches_loaded_receipt() {
  wrapper_file_matches_values "$RECEIPT_ROOT" "$RECEIPT_SHA" "$RECEIPT_BUN" "$RECEIPT_SOURCE" "$RECEIPT_SHARE"
}

escape_xml() {
  local value="$1"
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  value=${value//\"/&quot;}
  value=${value//\'/&apos;}
  printf '%s' "$value"
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

render_plist_content() {
  local command_path="$1" service_path="$2" queue="$3" log_path="$4"
  local program path_value queue_value log_value rendered
  program="$(escape_sed_replacement "$(escape_xml "$command_path")")"
  path_value="$(escape_sed_replacement "$(escape_xml "$service_path")")"
  queue_value="$(escape_sed_replacement "$(escape_xml "$queue")")"
  log_value="$(escape_sed_replacement "$(escape_xml "$log_path")")"
  rendered="$(sed \
    -e "s|__AGENTSCRAPE_PROGRAM__|$program|g" \
    -e "s|__AGENTSCRAPE_PATH__|$path_value|g" \
    -e "s|__AGENTSCRAPE_QUEUE__|$queue_value|g" \
    -e "s|__AGENTSCRAPE_LOG__|$log_value|g" \
    "$TEMPLATE")"
  [[ "$rendered" != *'__AGENTSCRAPE_'* ]] || return 1
  printf '%s' "$rendered"
}

plist_file_matches_values() {
  local command_path="$1" service_path="$2" queue="$3" log_path="$4"
  [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] || return 1
  [[ "$(path_owner_uid "$SERVICE_DEST")" == "$OWNER_UID" ]] || return 1
  [[ "$(path_mode "$SERVICE_DEST")" == "600" ]] || return 1
  [[ "$(path_nlink "$SERVICE_DEST")" == "1" ]] || return 1
  cmp -s "$SERVICE_DEST" <(render_plist_content "$command_path" "$service_path" "$queue" "$log_path")
}

installed_service_is_expected() {
  plist_file_matches_values "$COMMAND_PATH" "$SERVICE_PATH" "$QUEUE_DIR" "$LOG_PATH"
}

service_matches_loaded_receipt() {
  plist_file_matches_values "$RECEIPT_COMMAND" "$RECEIPT_SERVICE_PATH" "$RECEIPT_QUEUE" "$RECEIPT_LOG"
}

render_legacy_receipt_content() {
  printf 'marker=%s\n' "$RECEIPT_MARKER"
  printf 'label=%s\n' "$LABEL"
  printf 'root=%s\n' "$RECEIPT_ROOT"
  printf 'source=%s\n' "$RECEIPT_SOURCE"
  printf 'bun=%s\n' "$RECEIPT_BUN"
  printf 'command=%s\n' "$RECEIPT_COMMAND"
  printf 'service=%s\n' "$RECEIPT_SERVICE"
  printf 'sha=%s\n' "$RECEIPT_SHA"
}

render_receipt_content() {
  local root="$1" source="$2" bun="$3" command_path="$4" service="$5"
  local share="$6" queue="$7" log_path="$8" service_path="$9" sha="${10}"
  printf 'marker=%s\n' "$RECEIPT_MARKER"
  printf 'label=%s\n' "$LABEL"
  printf 'root=%s\n' "$root"
  printf 'source=%s\n' "$source"
  printf 'bun=%s\n' "$bun"
  printf 'command=%s\n' "$command_path"
  printf 'service=%s\n' "$service"
  printf 'share=%s\n' "$share"
  printf 'queue=%s\n' "$queue"
  printf 'log=%s\n' "$log_path"
  printf 'path=%s\n' "$service_path"
  printf 'sha=%s\n' "$sha"
}

load_exact_receipt() {
  local marker_line label_line root_line source_line bun_line command_line service_line next_line
  local share_line queue_line log_line path_line sha_line expected_path
  RECEIPT_FORMAT=""
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

  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || return 1
  [[ "$(path_owner_uid "$STATE_DIR")" == "$OWNER_UID" && "$(path_mode "$STATE_DIR")" == "700" ]] || return 1
  [[ -f "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" ]] || return 1
  [[ "$(path_owner_uid "$RECEIPT_PATH")" == "$OWNER_UID" ]] || return 1
  [[ "$(path_mode "$RECEIPT_PATH")" == "600" ]] || return 1
  [[ "$(path_nlink "$RECEIPT_PATH")" == "1" ]] || return 1

  exec 3<"$RECEIPT_PATH"
  if ! {
    IFS= read -r marker_line <&3 &&
      IFS= read -r label_line <&3 &&
      IFS= read -r root_line <&3 &&
      IFS= read -r source_line <&3 &&
      IFS= read -r bun_line <&3 &&
      IFS= read -r command_line <&3 &&
      IFS= read -r service_line <&3 &&
      IFS= read -r next_line <&3
  }; then
    exec 3<&-
    return 1
  fi

  if [[ "$next_line" == share=* ]]; then
    share_line="$next_line"
    if ! {
      IFS= read -r queue_line <&3 &&
        IFS= read -r log_line <&3 &&
        IFS= read -r path_line <&3 &&
        IFS= read -r sha_line <&3
    }; then
      exec 3<&-
      return 1
    fi
    RECEIPT_FORMAT=current
  elif [[ "$next_line" == sha=* ]]; then
    sha_line="$next_line"
    RECEIPT_FORMAT=legacy
  else
    exec 3<&-
    return 1
  fi
  exec 3<&-

  [[ "$marker_line" == "marker=$RECEIPT_MARKER" ]] || return 1
  [[ "$label_line" == "label=$LABEL" ]] || return 1
  [[ "$root_line" == root=* && "$source_line" == source=* && "$bun_line" == bun=* ]] || return 1
  [[ "$command_line" == command=* && "$service_line" == service=* && "$sha_line" == sha=* ]] || return 1

  RECEIPT_ROOT="${root_line#root=}"
  RECEIPT_SOURCE="${source_line#source=}"
  RECEIPT_BUN="${bun_line#bun=}"
  RECEIPT_COMMAND="${command_line#command=}"
  RECEIPT_SERVICE="${service_line#service=}"
  RECEIPT_SHA="${sha_line#sha=}"
  safe_absolute_path "$RECEIPT_ROOT" || return 1
  safe_absolute_path "$RECEIPT_SOURCE" || return 1
  safe_absolute_path "$RECEIPT_BUN" || return 1
  safe_absolute_path "$RECEIPT_COMMAND" || return 1
  safe_absolute_path "$RECEIPT_SERVICE" || return 1
  [[ "$RECEIPT_SOURCE" == "$RECEIPT_ROOT/src/cli.ts" ]] || return 1
  [[ "$RECEIPT_COMMAND" == "$COMMAND_PATH" && "$RECEIPT_SERVICE" == "$SERVICE_DEST" ]] || return 1
  [[ "$RECEIPT_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1

  if [[ "$RECEIPT_FORMAT" == current ]]; then
    [[ "$share_line" == share=* && "$queue_line" == queue=* && "$log_line" == log=* && "$path_line" == path=* ]] || return 1
    RECEIPT_SHARE="${share_line#share=}"
    RECEIPT_QUEUE="${queue_line#queue=}"
    RECEIPT_LOG="${log_line#log=}"
    RECEIPT_SERVICE_PATH="${path_line#path=}"
    safe_absolute_path "$RECEIPT_SHARE" || return 1
    safe_absolute_path "$RECEIPT_QUEUE" || return 1
    safe_absolute_path "$RECEIPT_LOG" || return 1
    [[ "$RECEIPT_SERVICE_PATH" != *$'\n'* && "$RECEIPT_SERVICE_PATH" != *$'\r'* ]] || return 1
    [[ "$RECEIPT_QUEUE" == "$RECEIPT_SHARE/queue" ]] || return 1
    [[ "$RECEIPT_LOG" == "$STATE_DIR/process-queue.log" ]] || return 1
    expected_path="$(expected_service_path "$RECEIPT_BUN" "$RECEIPT_COMMAND")"
    [[ "$RECEIPT_SERVICE_PATH" == "$expected_path" ]] || return 1
    cmp -s "$RECEIPT_PATH" <(render_receipt_content \
      "$RECEIPT_ROOT" "$RECEIPT_SOURCE" "$RECEIPT_BUN" "$RECEIPT_COMMAND" \
      "$RECEIPT_SERVICE" "$RECEIPT_SHARE" "$RECEIPT_QUEUE" "$RECEIPT_LOG" \
      "$RECEIPT_SERVICE_PATH" "$RECEIPT_SHA") || return 1
  else
    RECEIPT_SHARE="$SHARE_DIR"
    RECEIPT_QUEUE="$SHARE_DIR/queue"
    RECEIPT_LOG="$STATE_DIR/process-queue.log"
    RECEIPT_SERVICE_PATH="$(expected_service_path "$RECEIPT_BUN" "$RECEIPT_COMMAND")"
    cmp -s "$RECEIPT_PATH" <(render_legacy_receipt_content) || return 1
  fi
}

normalize_github_origin() {
  local origin="$1"
  [[ "$origin" != *$'\n'* && "$origin" != *$'\r'* ]] || return 1
  while [[ "$origin" == */ ]]; do origin="${origin%/}"; done
  origin="${origin%.git}"
  [[ "$origin" == https://github.com/*/* ]] || return 1
  printf '%s.git\n' "$origin"
}

prior_checkout_receipt_is_trusted() {
  local checkout_head checkout_root origin normalized_origin
  [[ "$RECEIPT_ROOT" != "$ROOT_DIR" ]] || return 1
  [[ -d "$RECEIPT_ROOT" && ! -L "$RECEIPT_ROOT" ]] || return 1
  checkout_root="$(cd "$RECEIPT_ROOT" 2>/dev/null && pwd -P)" || return 1
  [[ "$checkout_root" == "$RECEIPT_ROOT" ]] || return 1
  [[ -f "$RECEIPT_SOURCE" && ! -L "$RECEIPT_SOURCE" ]] || return 1
  [[ "$(git -C "$RECEIPT_ROOT" rev-parse --show-toplevel 2>/dev/null)" == "$RECEIPT_ROOT" ]] || return 1
  checkout_head="$(git -C "$RECEIPT_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  [[ "$checkout_head" =~ ^[0-9a-f]{40}$ && "$checkout_head" == "$RECEIPT_SHA" ]] || return 1
  origin="$(git -C "$RECEIPT_ROOT" config --get remote.origin.url 2>/dev/null)" || return 1
  normalized_origin="$(normalize_github_origin "$origin")" || return 1
  [[ "$normalized_origin" == 'https://github.com/possibilities/agentscrape.git' ]]
}

receipt_matches_current_checkout() {
  [[ "$RECEIPT_ROOT" == "$ROOT_DIR" && "$RECEIPT_SOURCE" == "$SOURCE_CLI_CANONICAL" ]]
}

receipt_is_trusted_for_install() {
  receipt_matches_current_checkout || prior_checkout_receipt_is_trusted
}

deployed_file_matches_sha() {
  local path="$1" sha="$2"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || return 1
  [[ "$(path_mode "$path")" == "600" ]] || return 1
  [[ "$(path_nlink "$path")" == "1" ]] || return 1
  cmp -s "$path" <(printf '%s\n' "$sha")
}

deployed_file_has_valid_sha() {
  local path="$1" sha
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || return 1
  [[ "$(path_mode "$path")" == "600" ]] || return 1
  [[ "$(path_nlink "$path")" == "1" ]] || return 1
  sha="$(<"$path")"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  cmp -s "$path" <(printf '%s\n' "$sha")
}

receipt_matches_current_values() {
  [[ "$RECEIPT_FORMAT" == current ]] || return 1
  cmp -s "$RECEIPT_PATH" <(render_receipt_content \
    "$ROOT_DIR" "$SOURCE_CLI_CANONICAL" "$BUN_BIN" "$COMMAND_PATH" \
    "$SERVICE_DEST" "$SHARE_DIR" "$QUEUE_DIR" "$LOG_PATH" \
    "$SERVICE_PATH" "$DEPLOYED_SHA")
}

classify_install_artifacts() {
  INSTALL_RECEIPT_PRESENT=0
  INSTALL_RECEIPT_CURRENT=0
  INSTALL_COMMAND_PRESENT=0
  INSTALL_COMMAND_CURRENT=0
  INSTALL_COMMAND_PRIOR=0
  INSTALL_SERVICE_PRESENT=0
  INSTALL_SERVICE_CURRENT=0
  INSTALL_SERVICE_PRIOR=0
  INSTALL_DEPLOYED_PRESENT=0
  INSTALL_DEPLOYED_VALID=0
  INSTALL_DEPLOYED_CURRENT=0
  INSTALL_DEPLOYED_PRIOR=0

  if [[ -e "$RECEIPT_PATH" || -L "$RECEIPT_PATH" ]]; then
    INSTALL_RECEIPT_PRESENT=1
    load_exact_receipt || fail "refusing malformed or unowned install receipt: $RECEIPT_PATH"
    receipt_is_trusted_for_install ||
      fail "refusing install receipt from an untrusted checkout: $RECEIPT_PATH"
    if receipt_matches_current_values; then
      INSTALL_RECEIPT_CURRENT=1
    fi
  fi

  if [[ -e "$COMMAND_PATH" || -L "$COMMAND_PATH" ]]; then
    INSTALL_COMMAND_PRESENT=1
    if installed_command_is_expected; then INSTALL_COMMAND_CURRENT=1; fi
    if (( INSTALL_RECEIPT_PRESENT )) && wrapper_matches_loaded_receipt; then
      INSTALL_COMMAND_PRIOR=1
    fi
  fi

  if [[ -e "$SERVICE_DEST" || -L "$SERVICE_DEST" ]]; then
    INSTALL_SERVICE_PRESENT=1
    if installed_service_is_expected; then INSTALL_SERVICE_CURRENT=1; fi
    if (( INSTALL_RECEIPT_PRESENT )) && service_matches_loaded_receipt; then
      INSTALL_SERVICE_PRIOR=1
    fi
  fi

  if [[ -e "$DEPLOYED_SHA_PATH" || -L "$DEPLOYED_SHA_PATH" ]]; then
    INSTALL_DEPLOYED_PRESENT=1
    if deployed_file_has_valid_sha "$DEPLOYED_SHA_PATH"; then INSTALL_DEPLOYED_VALID=1; fi
    if deployed_file_matches_sha "$DEPLOYED_SHA_PATH" "$DEPLOYED_SHA"; then
      INSTALL_DEPLOYED_CURRENT=1
    fi
    if (( INSTALL_RECEIPT_PRESENT )) &&
      deployed_file_matches_sha "$DEPLOYED_SHA_PATH" "$RECEIPT_SHA"; then
      INSTALL_DEPLOYED_PRIOR=1
    fi
  fi
}

reject_unclassified_install_state() {
  if (( ! INSTALL_RECEIPT_PRESENT )); then
    if (( INSTALL_DEPLOYED_PRESENT )); then
      fail "refusing uncorroborated deployment receipt: $DEPLOYED_SHA_PATH"
    fi
    if (( INSTALL_COMMAND_PRESENT && ! INSTALL_COMMAND_CURRENT )); then
      if [[ -L "$COMMAND_PATH" ]]; then
        fail "refusing to overwrite unrelated symlink: $COMMAND_PATH -> $(readlink "$COMMAND_PATH")"
      fi
      fail "refusing to overwrite unrelated file: $COMMAND_PATH"
    fi
    if (( INSTALL_SERVICE_PRESENT && ! INSTALL_SERVICE_CURRENT )); then
      if [[ -L "$SERVICE_DEST" ]]; then
        fail "refusing to overwrite unrelated LaunchAgent symlink: $SERVICE_DEST -> $(readlink "$SERVICE_DEST")"
      fi
      fail "refusing to overwrite unrelated LaunchAgent file: $SERVICE_DEST"
    fi
    fail "refusing unrecognized first-install transaction state"
  fi

  if (( ! INSTALL_COMMAND_PRESENT || ! INSTALL_SERVICE_PRESENT )); then
    fail "refusing install receipt without both correlated command and LaunchAgent artifacts: $RECEIPT_PATH"
  fi
  if (( ! INSTALL_COMMAND_CURRENT && ! INSTALL_COMMAND_PRIOR )); then
    fail "refusing installed command that does not correlate with install receipt: $COMMAND_PATH"
  fi
  if (( ! INSTALL_SERVICE_CURRENT && ! INSTALL_SERVICE_PRIOR )); then
    fail "refusing LaunchAgent that does not correlate with install receipt: $SERVICE_DEST"
  fi
  if (( ! INSTALL_DEPLOYED_PRESENT )); then
    fail "refusing install receipt without a correlated deployment receipt: $RECEIPT_PATH"
  fi
  if (( ! INSTALL_DEPLOYED_VALID || ! INSTALL_DEPLOYED_PRIOR )); then
    fail "refusing deployment receipt that does not correlate with install receipt: $DEPLOYED_SHA_PATH"
  fi
  fail "refusing unrecognized receipt-backed install transaction state"
}

preflight_install_state() {
  local valid_a=0 valid_b=0 valid_c=0 valid_d=0 valid_count
  classify_install_artifacts

  if (( ! INSTALL_RECEIPT_PRESENT && ! INSTALL_DEPLOYED_PRESENT &&
    (! INSTALL_COMMAND_PRESENT || INSTALL_COMMAND_CURRENT) &&
    (! INSTALL_SERVICE_PRESENT || INSTALL_SERVICE_CURRENT) )); then
    valid_a=1
  fi
  if (( INSTALL_RECEIPT_CURRENT && INSTALL_COMMAND_CURRENT && INSTALL_SERVICE_CURRENT &&
    INSTALL_DEPLOYED_CURRENT )); then
    valid_d=1
  fi
  if (( INSTALL_RECEIPT_CURRENT && INSTALL_COMMAND_CURRENT && INSTALL_SERVICE_CURRENT &&
    (! INSTALL_DEPLOYED_PRESENT ||
      (INSTALL_DEPLOYED_VALID && ! INSTALL_DEPLOYED_CURRENT)) )); then
    valid_c=1
  fi
  if (( INSTALL_RECEIPT_PRESENT && INSTALL_DEPLOYED_PRIOR &&
    INSTALL_COMMAND_PRESENT && (INSTALL_COMMAND_PRIOR || INSTALL_COMMAND_CURRENT) &&
    INSTALL_SERVICE_PRESENT && (INSTALL_SERVICE_PRIOR || INSTALL_SERVICE_CURRENT) &&
    ! valid_d )); then
    valid_b=1
  fi

  valid_count=$((valid_a + valid_b + valid_c + valid_d))
  (( valid_count == 1 )) || reject_unclassified_install_state

  ALLOW_CURRENT_SERVICE_IDENTITY=1
  ALLOW_RECEIPT_SERVICE_IDENTITY=0
  if (( valid_b )); then
    ALLOW_RECEIPT_SERVICE_IDENTITY=1
  fi
}

launchctl_available() {
  [[ "$LAUNCHCTL" != none ]] && command -v "$LAUNCHCTL" >/dev/null 2>&1
}

trim_horizontal_space() {
  local value="$1"
  while [[ "$value" == ' '* || "$value" == $'\t'* ]]; do value="${value#?}"; done
  while [[ "$value" == *' ' || "$value" == *$'\t' ]]; do value="${value%?}"; done
  printf '%s' "$value"
}

loaded_output_matches() {
  local expected_program="$1" expected_path="$2" expected_plist="$3" line trimmed
  local program_count=0 plist_count=0 environment_count=0 environment_path_count=0
  local invalid=0 in_environment=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_horizontal_space "$line")"
    case "$trimmed" in
      'program = '*)
        if [[ "$trimmed" == "program = $expected_program" ]]; then
          (( program_count += 1 ))
        else
          invalid=1
        fi
        ;;
      'path = '*)
        if [[ "$trimmed" == "path = $expected_plist" ]]; then
          (( plist_count += 1 ))
        else
          invalid=1
        fi
        ;;
      'environment = {')
        (( environment_count += 1 ))
        in_environment=1
        ;;
      'environment = { PATH => '*)
        (( environment_count += 1 ))
        if [[ "$trimmed" == "environment = { PATH => $expected_path }" ]]; then
          (( environment_path_count += 1 ))
        else
          invalid=1
        fi
        in_environment=0
        ;;
      '}')
        in_environment=0
        ;;
      'PATH => '*)
        if (( in_environment )); then
          if [[ "$trimmed" == "PATH => $expected_path" ]]; then
            (( environment_path_count += 1 ))
          else
            invalid=1
          fi
        fi
        ;;
    esac
  done <<<"$LOADED_SERVICE_PRINT"
  (( ! invalid && ! in_environment && program_count == 1 && plist_count == 1 &&
    environment_count == 1 && environment_path_count == 1 ))
}

inspect_loaded_service() {
  LOADED_SERVICE_STATE=absent
  LOADED_SERVICE_PRINT=""
  launchctl_available || return 0
  LOADED_SERVICE_PRINT="$("$LAUNCHCTL" print "$SERVICE_TARGET" 2>/dev/null)" || return 0
  if (( ALLOW_CURRENT_SERVICE_IDENTITY )) &&
    loaded_output_matches "$COMMAND_PATH" "$SERVICE_PATH" "$SERVICE_DEST"; then
    LOADED_SERVICE_STATE=owned
  elif (( ALLOW_RECEIPT_SERVICE_IDENTITY )) &&
    loaded_output_matches "$RECEIPT_COMMAND" "$RECEIPT_SERVICE_PATH" "$RECEIPT_SERVICE"; then
    LOADED_SERVICE_STATE=owned
  else
    LOADED_SERVICE_STATE=foreign
  fi
}

check_loaded_service() {
  inspect_loaded_service
  if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
    fail "refusing to unload or replace foreign loaded service: $SERVICE_TARGET"
  fi
}

unload_owned_service() {
  launchctl_available || return 0
  inspect_loaded_service
  if [[ "$LOADED_SERVICE_STATE" == absent ]]; then
    return 0
  fi
  [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "refusing to boot out foreign service: $SERVICE_TARGET"
  "$LAUNCHCTL" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  for _ in {1..40}; do
    inspect_loaded_service
    if [[ "$LOADED_SERVICE_STATE" == absent ]]; then
      return 0
    fi
    [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "service identity changed while waiting for bootout: $SERVICE_TARGET"
    sleep 0.1
  done
  fail "service remained loaded after bootout: $SERVICE_TARGET"
}

make_backup() {
  local source="$1" destination_dir destination_name backup
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    return 0
  fi
  destination_dir="$(dirname "$source")"
  destination_name="$(basename "$source")"
  backup="$(mktemp "$destination_dir/.${destination_name}.backup.XXXXXX")"
  rm -f "$backup"
  cp -pP "$source" "$backup"
  printf '%s\n' "$backup"
}

restore_path() {
  local backup="$1" destination="$2" original_present="$3"
  if (( original_present )); then
    if [[ -n "$backup" && ( -e "$backup" || -L "$backup" ) ]]; then
      mv -f "$backup" "$destination"
    else
      printf 'agentscrape-install: rollback backup missing for %s\n' "$destination" >&2
      return 1
    fi
  else
    rm -f "$destination"
  fi
}

cleanup_backup() {
  local backup="$1"
  if [[ -n "$backup" ]]; then
    rm -f "$backup"
  fi
}

write_command_wrapper() {
  local temporary
  temporary="$(mktemp "$BIN_DIR/.agentscrape.XXXXXX")"
  chmod 700 "$temporary"
  render_wrapper_content "$ROOT_DIR" "$DEPLOYED_SHA" "$BUN_BIN" "$SOURCE_CLI_CANONICAL" "$SHARE_DIR" >"$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$COMMAND_PATH"
  COMMAND_REPLACED=1
}

render_plist() {
  local temporary
  temporary="$(mktemp "$LAUNCH_AGENTS_DIR/.${LABEL}.XXXXXX")"
  chmod 600 "$temporary"
  render_plist_content "$COMMAND_PATH" "$SERVICE_PATH" "$QUEUE_DIR" "$LOG_PATH" >"$temporary" || {
    rm -f "$temporary"
    fail "refusing to install unrendered plist template"
  }
  "$PLUTIL" -lint "$temporary" >/dev/null
  mv -f "$temporary" "$SERVICE_DEST"
  SERVICE_REPLACED=1
}

verify_installed_files() {
  installed_command_is_expected || fail "installed command failed ownership verification: $COMMAND_PATH"
  installed_service_is_expected || fail "installed LaunchAgent failed ownership verification: $SERVICE_DEST"
}

verify_loaded_service() {
  ALLOW_CURRENT_SERVICE_IDENTITY=1
  inspect_loaded_service
  [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "loaded service failed exact program/plist/PATH verification: $SERVICE_TARGET"
}

prepare_deployed_sha() {
  DEPLOYED_SHA_TEMP="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 600 "$DEPLOYED_SHA_TEMP"
  printf '%s\n' "$DEPLOYED_SHA" >"$DEPLOYED_SHA_TEMP"
}

write_install_receipt() {
  local temporary
  temporary="$(mktemp "$STATE_DIR/.install-receipt.XXXXXX")"
  chmod 600 "$temporary"
  render_receipt_content "$ROOT_DIR" "$SOURCE_CLI_CANONICAL" "$BUN_BIN" "$COMMAND_PATH" \
    "$SERVICE_DEST" "$SHARE_DIR" "$QUEUE_DIR" "$LOG_PATH" "$SERVICE_PATH" "$DEPLOYED_SHA" >"$temporary"
  mv -f "$temporary" "$RECEIPT_PATH"
  RECEIPT_REPLACED=1
}

deployed_publication_completed() {
  (( FINAL_PUBLICATION_ARMED )) || return 1
  deployed_file_matches_sha "$DEPLOYED_SHA_PATH" "$DEPLOYED_SHA" || return 1
  if (( DEPLOYED_ORIGINAL_PRESENT )); then
    [[ "$(path_inode "$DEPLOYED_SHA_PATH")" != "$DEPLOYED_ORIGINAL_INODE" ]]
  else
    return 0
  fi
}

cleanup_transaction_artifacts() {
  set +e
  cleanup_backup "$COMMAND_BACKUP"
  cleanup_backup "$SERVICE_BACKUP"
  cleanup_backup "$RECEIPT_BACKUP"
  if [[ -n "$DEPLOYED_SHA_TEMP" ]]; then
    rm -f "$DEPLOYED_SHA_TEMP"
  fi
  set -e
}

rollback_install() {
  local status="$?"
  if (( ROLLBACK_ENABLED )); then
    set +e
    if (( DEPLOYMENT_PUBLISHED )) || deployed_publication_completed; then
      ROLLBACK_ENABLED=0
      cleanup_transaction_artifacts
      exit "$status"
    fi
    inspect_loaded_service
    if [[ "$LOADED_SERVICE_STATE" == owned ]]; then
      "$LAUNCHCTL" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
    fi
    if (( COMMAND_REPLACED )); then
      restore_path "$COMMAND_BACKUP" "$COMMAND_PATH" "$COMMAND_ORIGINAL_PRESENT"
    fi
    if (( SERVICE_REPLACED )); then
      restore_path "$SERVICE_BACKUP" "$SERVICE_DEST" "$SERVICE_ORIGINAL_PRESENT"
    fi
    if (( RECEIPT_REPLACED )); then
      restore_path "$RECEIPT_BACKUP" "$RECEIPT_PATH" "$RECEIPT_ORIGINAL_PRESENT"
    fi
    if [[ -n "$DEPLOYED_SHA_TEMP" ]]; then
      rm -f "$DEPLOYED_SHA_TEMP"
    fi
    if (( PREVIOUS_SERVICE_LOADED )) && [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] && launchctl_available; then
      "$LAUNCHCTL" bootstrap "$DOMAIN" "$SERVICE_DEST" >/dev/null 2>&1 || true
    fi
    cleanup_backup "$COMMAND_BACKUP"
    cleanup_backup "$SERVICE_BACKUP"
    cleanup_backup "$RECEIPT_BACKUP"
    printf 'agentscrape-install: restored previous owned state after failure\n' >&2
  fi
  exit "$status"
}

publish_deployed_sha() {
  FINAL_PUBLICATION_ARMED=1
  mv -f "$DEPLOYED_SHA_TEMP" "$DEPLOYED_SHA_PATH"
  DEPLOYED_SHA_TEMP=""
  DEPLOYMENT_PUBLISHED=1
  ROLLBACK_ENABLED=0
  trap - EXIT HUP INT TERM
}

uninstall_preflight() {
  local evidence=0
  validate_configured_paths
  canonicalize_state_and_share_paths
  validate_configured_paths

  for path in "$COMMAND_PATH" "$SERVICE_DEST" "$RECEIPT_PATH" "$DEPLOYED_SHA_PATH"; do
    if [[ -e "$path" || -L "$path" ]]; then
      evidence=1
    fi
  done

  if (( ! evidence )); then
    ALLOW_CURRENT_SERVICE_IDENTITY=0
    ALLOW_RECEIPT_SERVICE_IDENTITY=0
    check_loaded_service
    return 0
  fi

  [[ -e "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" ]] ||
    fail "refusing uninstall without an exact owned install receipt: $RECEIPT_PATH"
  validate_regular_file_slot "$RECEIPT_PATH" "install receipt"
  load_exact_receipt || fail "refusing malformed or unowned install receipt: $RECEIPT_PATH"
  receipt_matches_current_checkout || fail "refusing install receipt owned by a different checkout: $RECEIPT_PATH"

  if [[ -e "$COMMAND_PATH" || -L "$COMMAND_PATH" ]]; then
    validate_regular_file_slot "$COMMAND_PATH" "installed command"
    wrapper_matches_loaded_receipt || fail "refusing to remove unrelated command: $COMMAND_PATH"
  fi
  if [[ -e "$SERVICE_DEST" || -L "$SERVICE_DEST" ]]; then
    validate_regular_file_slot "$SERVICE_DEST" "LaunchAgent"
    service_matches_loaded_receipt || fail "refusing to remove unrelated LaunchAgent: $SERVICE_DEST"
  fi
  if [[ -e "$DEPLOYED_SHA_PATH" || -L "$DEPLOYED_SHA_PATH" ]]; then
    validate_regular_file_slot "$DEPLOYED_SHA_PATH" "deployment receipt"
    deployed_file_matches_sha "$DEPLOYED_SHA_PATH" "$RECEIPT_SHA" ||
      fail "refusing deployment receipt that does not correlate with install receipt: $DEPLOYED_SHA_PATH"
  fi

  ALLOW_CURRENT_SERVICE_IDENTITY=0
  ALLOW_RECEIPT_SERVICE_IDENTITY=1
  check_loaded_service
}

if [[ "$ACTION" == uninstall ]]; then
  uninstall_preflight
  unload_owned_service
  rm -f "$COMMAND_PATH" "$SERVICE_DEST" "$DEPLOYED_SHA_PATH" "$RECEIPT_PATH"
  printf 'uninstalled owned agentscrape command and service\n'
  exit 0
fi

[[ -f "$SOURCE_CLI" && ! -L "$SOURCE_CLI" ]] || fail "expected source command at $SOURCE_CLI"
[[ -f "$TEMPLATE" && ! -L "$TEMPLATE" ]] || fail "expected plist template at $TEMPLATE"
command -v "$BUN_CMD" >/dev/null 2>&1 || fail "Bun is required"
command -v "$PLUTIL" >/dev/null 2>&1 || fail "plutil is required"
launchctl_available || fail "launchctl is required"

DEPLOYED_SHA="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "source HEAD is not a full lowercase 40-hex SHA"
BUN_BIN="$(command -v "$BUN_CMD")"
safe_absolute_path "$BUN_BIN" || fail "Bun must resolve to a normalized absolute path: $BUN_BIN"
validate_no_follow_path "$BUN_BIN" "Bun executable" 1
[[ -f "$BUN_BIN" && -x "$BUN_BIN" ]] || fail "Bun executable is not a regular executable file: $BUN_BIN"
SERVICE_PATH="$(expected_service_path "$BUN_BIN" "$COMMAND_PATH")"

prepare_private_paths
preflight_install_state
check_loaded_service

(
  cd "$ROOT"
  "$BUN_CMD" install --frozen-lockfile
)

touch "$LOG_PATH"
chmod 600 "$LOG_PATH"

if [[ -e "$COMMAND_PATH" || -L "$COMMAND_PATH" ]]; then COMMAND_ORIGINAL_PRESENT=1; fi
if [[ -e "$SERVICE_DEST" || -L "$SERVICE_DEST" ]]; then SERVICE_ORIGINAL_PRESENT=1; fi
if [[ -e "$RECEIPT_PATH" || -L "$RECEIPT_PATH" ]]; then RECEIPT_ORIGINAL_PRESENT=1; fi
if [[ -e "$DEPLOYED_SHA_PATH" || -L "$DEPLOYED_SHA_PATH" ]]; then
  DEPLOYED_ORIGINAL_PRESENT=1
  DEPLOYED_ORIGINAL_INODE="$(path_inode "$DEPLOYED_SHA_PATH")"
fi
COMMAND_BACKUP="$(make_backup "$COMMAND_PATH")"
SERVICE_BACKUP="$(make_backup "$SERVICE_DEST")"
RECEIPT_BACKUP="$(make_backup "$RECEIPT_PATH")"
if [[ "$LOADED_SERVICE_STATE" == owned ]]; then
  PREVIOUS_SERVICE_LOADED=1
fi
ROLLBACK_ENABLED=1
trap rollback_install EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

unload_owned_service
write_command_wrapper
render_plist
verify_installed_files
ALLOW_CURRENT_SERVICE_IDENTITY=1
"$LAUNCHCTL" bootstrap "$DOMAIN" "$SERVICE_DEST"
verify_loaded_service
prepare_deployed_sha
write_install_receipt
publish_deployed_sha

cleanup_transaction_artifacts
printf 'installed %s\n' "$COMMAND_PATH"
printf 'installed and loaded %s\n' "$SERVICE_DEST"
