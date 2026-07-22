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
PLIST_MARKER="agentscrape-installer-owned: agentscrape.process-queue.v1"
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
COMMAND_BACKUP=""
SERVICE_BACKUP=""
DEPLOYED_SHA_BACKUP=""
RECEIPT_BACKUP=""

path_owner_uid() {
  case "$PLATFORM" in
    Darwin) stat -f '%u' "$1" ;;
    Linux) stat -c '%u' -- "$1" ;;
    *) fail "unsupported platform for ownership checks: $PLATFORM" ;;
  esac
}

ensure_directory() {
  local path="$1" label="$2" mode="$3"
  [[ ! -L "$path" ]] || fail "$label must not be a symlink: $path"
  [[ ! -e "$path" || -d "$path" ]] || fail "$label must be a directory: $path"
  mkdir -p "$path"
  [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
  chmod "$mode" "$path"
}

ensure_file_slot() {
  local path="$1" label="$2"
  [[ ! -L "$path" ]] || fail "$label must not be a symlink: $path"
  [[ ! -e "$path" || -f "$path" ]] || fail "$label must be a regular file: $path"
  if [[ -e "$path" ]]; then
    [[ "$(path_owner_uid "$path")" == "$OWNER_UID" ]] || fail "$label is not owned by uid $OWNER_UID: $path"
  fi
}

normalize_existing_path() {
  local path="$1" dir base
  base="$(basename "$path")"
  dir="$(cd "$(dirname "$path")" && pwd -P)"
  printf '%s/%s\n' "$dir" "$base"
}

canonicalize_install_paths() {
  STATE_DIR="$(normalize_existing_path "$STATE_DIR")"
  SHARE_DIR="$(normalize_existing_path "$SHARE_DIR")"
  QUEUE_DIR="$SHARE_DIR/queue"
  FAILED_DIR="$SHARE_DIR/failed"
  LOG_PATH="$(normalize_existing_path "$STATE_DIR/process-queue.log")"
  DEPLOYED_SHA_PATH="$(normalize_existing_path "$STATE_DIR/deployed-sha")"
  RECEIPT_PATH="$(normalize_existing_path "$STATE_DIR/install-receipt")"
}

symlink_points_to_current_source() {
  local destination="$1" target candidate
  [[ -L "$destination" ]] || return 1
  target="$(readlink "$destination")"
  if [[ "$target" = /* ]]; then
    candidate="$target"
  else
    candidate="$(cd "$(dirname "$destination")" && pwd -P)/$target"
  fi
  [[ "$(normalize_existing_path "$candidate")" == "$SOURCE_CLI_CANONICAL" ]]
}

command_file_is_owned() {
  [[ -f "$COMMAND_PATH" && ! -L "$COMMAND_PATH" ]] || return 1
  [[ "$(path_owner_uid "$COMMAND_PATH")" == "$OWNER_UID" ]] || return 1
  grep -Fq "$COMMAND_MARKER" "$COMMAND_PATH" && grep -Fq "$SOURCE_CLI_CANONICAL" "$COMMAND_PATH"
}

command_path_is_replaceable() {
  if [[ ! -e "$COMMAND_PATH" && ! -L "$COMMAND_PATH" ]]; then
    return 0
  fi
  if command_file_is_owned || symlink_points_to_current_source "$COMMAND_PATH"; then
    return 0
  fi
  if [[ -L "$COMMAND_PATH" ]]; then
    fail "refusing to overwrite unrelated symlink: $COMMAND_PATH -> $(readlink "$COMMAND_PATH")"
  fi
  fail "refusing to overwrite unrelated file: $COMMAND_PATH"
}

service_file_is_owned() {
  [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] || return 1
  [[ "$(path_owner_uid "$SERVICE_DEST")" == "$OWNER_UID" ]] || return 1
  grep -Fq "$PLIST_MARKER" "$SERVICE_DEST" &&
    grep -Fq '<string>agentscrape.process-queue</string>' "$SERVICE_DEST" &&
    grep -Fq "<string>$COMMAND_PATH</string>" "$SERVICE_DEST"
}

service_destination_is_replaceable() {
  if [[ ! -e "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]]; then
    return 0
  fi
  service_file_is_owned && return 0
  if [[ -L "$SERVICE_DEST" ]]; then
    fail "refusing to overwrite unrelated LaunchAgent symlink: $SERVICE_DEST -> $(readlink "$SERVICE_DEST")"
  fi
  fail "refusing to overwrite unrelated LaunchAgent file: $SERVICE_DEST"
}

receipt_file_is_owned() {
  [[ -f "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" ]] || return 1
  [[ "$(path_owner_uid "$RECEIPT_PATH")" == "$OWNER_UID" ]] || return 1
  grep -Fq "$RECEIPT_MARKER" "$RECEIPT_PATH"
}

check_private_slots() {
  ensure_directory "$BIN_DIR" "install bin directory" 700
  ensure_directory "$LAUNCH_AGENTS_DIR" "LaunchAgents directory" 700
  ensure_directory "$STATE_DIR" "state directory" 700
  ensure_directory "$SHARE_DIR" "share directory" 700
  ensure_directory "$QUEUE_DIR" "queue directory" 700
  ensure_directory "$FAILED_DIR" "failed directory" 700
  ensure_file_slot "$LOG_PATH" "queue log"
  ensure_file_slot "$DEPLOYED_SHA_PATH" "deployment receipt"
  ensure_file_slot "$RECEIPT_PATH" "install receipt"
}

launchctl_available() {
  [[ "$LAUNCHCTL" != none ]] && command -v "$LAUNCHCTL" >/dev/null 2>&1
}

inspect_loaded_service() {
  LOADED_SERVICE_STATE=absent
  LOADED_SERVICE_PRINT=""
  launchctl_available || return 0
  LOADED_SERVICE_PRINT="$("$LAUNCHCTL" print "$SERVICE_TARGET" 2>/dev/null)" || return 0
  if printf '%s\n' "$LOADED_SERVICE_PRINT" | grep -Fq "program = $COMMAND_PATH"; then
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

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
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
  cp -P "$source" "$backup"
  printf '%s\n' "$backup"
}

restore_path() {
  local backup="$1" destination="$2"
  if [[ -n "$backup" && ( -e "$backup" || -L "$backup" ) ]]; then
    mv -f "$backup" "$destination"
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
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf '# %s\n' "$COMMAND_MARKER"
    printf '# label: %s\n' "$LABEL"
    printf '# source-root: %s\n' "$ROOT_DIR"
    printf '# source-sha: %s\n' "$DEPLOYED_SHA"
    printf '# bun: %s\n' "$BUN_BIN"
    printf 'export AGENTSCRAPE_DATA_HOME=%s\n' "$(shell_quote "$SHARE_DIR")"
    printf 'exec %s %s "$@"\n' "$(shell_quote "$BUN_BIN")" "$(shell_quote "$SOURCE_CLI_CANONICAL")"
  } >"$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$COMMAND_PATH"
}

render_plist() {
  local temporary program path_value queue log_value rendered
  temporary="$(mktemp "$LAUNCH_AGENTS_DIR/.${LABEL}.XXXXXX")"
  chmod 600 "$temporary"
  program="$(escape_sed_replacement "$(escape_xml "$COMMAND_PATH")")"
  path_value="$(escape_sed_replacement "$(escape_xml "$SERVICE_PATH")")"
  queue="$(escape_sed_replacement "$(escape_xml "$QUEUE_DIR")")"
  log_value="$(escape_sed_replacement "$(escape_xml "$LOG_PATH")")"
  rendered="$(sed \
    -e "s|__AGENTSCRAPE_PROGRAM__|$program|g" \
    -e "s|__AGENTSCRAPE_PATH__|$path_value|g" \
    -e "s|__AGENTSCRAPE_QUEUE__|$queue|g" \
    -e "s|__AGENTSCRAPE_LOG__|$log_value|g" \
    "$TEMPLATE")"
  printf '%s' "$rendered" >"$temporary"
  if grep -Fq '__AGENTSCRAPE_' "$temporary"; then
    rm -f "$temporary"
    fail "refusing to install unrendered plist template"
  fi
  "$PLUTIL" -lint "$temporary" >/dev/null
  mv -f "$temporary" "$SERVICE_DEST"
}

verify_installed_files() {
  command_file_is_owned || fail "installed command failed ownership verification: $COMMAND_PATH"
  service_file_is_owned || fail "installed LaunchAgent failed ownership verification: $SERVICE_DEST"
  grep -Fq "export AGENTSCRAPE_DATA_HOME=" "$COMMAND_PATH" ||
    fail "installed command did not export AGENTSCRAPE_DATA_HOME"
  grep -Fq "$SHARE_DIR" "$COMMAND_PATH" ||
    fail "installed command AGENTSCRAPE_DATA_HOME did not match expected value"
  grep -Fq "<string>$SERVICE_PATH</string>" "$SERVICE_DEST" || fail "installed LaunchAgent PATH did not match expected value"
  grep -Fq "<string>$QUEUE_DIR</string>" "$SERVICE_DEST" || fail "installed LaunchAgent queue directory did not match expected value"
  grep -Fq "<string>$LOG_PATH</string>" "$SERVICE_DEST" || fail "installed LaunchAgent log path did not match expected value"
}

verify_loaded_service() {
  inspect_loaded_service
  [[ "$LOADED_SERVICE_STATE" == owned ]] || fail "loaded service failed ownership verification: $SERVICE_TARGET"
  printf '%s\n' "$LOADED_SERVICE_PRINT" | grep -Fq "$SERVICE_PATH" ||
    fail "loaded service PATH verification failed: $SERVICE_TARGET"
}

write_deployed_sha() {
  local temporary
  temporary="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$DEPLOYED_SHA" >"$temporary"
  mv -f "$temporary" "$DEPLOYED_SHA_PATH"
}

write_install_receipt() {
  local temporary
  temporary="$(mktemp "$STATE_DIR/.install-receipt.XXXXXX")"
  chmod 600 "$temporary"
  {
    printf 'marker=%s\n' "$RECEIPT_MARKER"
    printf 'label=%s\n' "$LABEL"
    printf 'root=%s\n' "$ROOT_DIR"
    printf 'source=%s\n' "$SOURCE_CLI_CANONICAL"
    printf 'bun=%s\n' "$BUN_BIN"
    printf 'command=%s\n' "$COMMAND_PATH"
    printf 'service=%s\n' "$SERVICE_DEST"
    printf 'sha=%s\n' "$DEPLOYED_SHA"
  } >"$temporary"
  mv -f "$temporary" "$RECEIPT_PATH"
}

rollback_install() {
  local status="$?"
  if (( ROLLBACK_ENABLED )); then
    set +e
    inspect_loaded_service
    if [[ "$LOADED_SERVICE_STATE" == owned ]]; then
      "$LAUNCHCTL" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
    fi
    restore_path "$COMMAND_BACKUP" "$COMMAND_PATH"
    restore_path "$SERVICE_BACKUP" "$SERVICE_DEST"
    restore_path "$DEPLOYED_SHA_BACKUP" "$DEPLOYED_SHA_PATH"
    restore_path "$RECEIPT_BACKUP" "$RECEIPT_PATH"
    if (( PREVIOUS_SERVICE_LOADED )) && [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] && launchctl_available; then
      "$LAUNCHCTL" bootstrap "$DOMAIN" "$SERVICE_DEST" >/dev/null 2>&1 || true
    fi
    cleanup_backup "$COMMAND_BACKUP"
    cleanup_backup "$SERVICE_BACKUP"
    cleanup_backup "$DEPLOYED_SHA_BACKUP"
    cleanup_backup "$RECEIPT_BACKUP"
    printf 'agentscrape-install: restored previous owned state after failure\n' >&2
  fi
  exit "$status"
}

if [[ "$ACTION" == uninstall ]]; then
  if [[ -e "$COMMAND_PATH" || -L "$COMMAND_PATH" ]]; then
    if ! command_file_is_owned && ! symlink_points_to_current_source "$COMMAND_PATH"; then
      fail "refusing to remove unrelated command: $COMMAND_PATH"
    fi
  fi
  if [[ -e "$SERVICE_DEST" || -L "$SERVICE_DEST" ]]; then
    service_file_is_owned || fail "refusing to remove unrelated LaunchAgent: $SERVICE_DEST"
  fi
  check_loaded_service
  unload_owned_service
  if command_file_is_owned || symlink_points_to_current_source "$COMMAND_PATH"; then
    rm -f "$COMMAND_PATH"
  fi
  if service_file_is_owned; then
    rm -f "$SERVICE_DEST"
  fi
  if receipt_file_is_owned; then
    rm -f "$RECEIPT_PATH"
  fi
  if [[ -f "$DEPLOYED_SHA_PATH" && ! -L "$DEPLOYED_SHA_PATH" && "$(path_owner_uid "$DEPLOYED_SHA_PATH")" == "$OWNER_UID" ]]; then
    rm -f "$DEPLOYED_SHA_PATH"
  fi
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
SERVICE_PATH="$(dirname "$BUN_BIN"):$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

check_private_slots
canonicalize_install_paths
command_path_is_replaceable
service_destination_is_replaceable
check_loaded_service

(
  cd "$ROOT"
  "$BUN_CMD" install --frozen-lockfile
)

touch "$LOG_PATH"
chmod 600 "$LOG_PATH"

COMMAND_BACKUP="$(make_backup "$COMMAND_PATH")"
SERVICE_BACKUP="$(make_backup "$SERVICE_DEST")"
DEPLOYED_SHA_BACKUP="$(make_backup "$DEPLOYED_SHA_PATH")"
RECEIPT_BACKUP="$(make_backup "$RECEIPT_PATH")"
if [[ "$LOADED_SERVICE_STATE" == owned ]]; then
  PREVIOUS_SERVICE_LOADED=1
fi
ROLLBACK_ENABLED=1
trap rollback_install EXIT

unload_owned_service
write_command_wrapper
render_plist
verify_installed_files
"$LAUNCHCTL" bootstrap "$DOMAIN" "$SERVICE_DEST"
verify_loaded_service
write_deployed_sha
write_install_receipt

ROLLBACK_ENABLED=0
trap - EXIT
cleanup_backup "$COMMAND_BACKUP"
cleanup_backup "$SERVICE_BACKUP"
cleanup_backup "$DEPLOYED_SHA_BACKUP"
cleanup_backup "$RECEIPT_BACKUP"

printf 'installed %s\n' "$COMMAND_PATH"
printf 'installed and loaded %s\n' "$SERVICE_DEST"
