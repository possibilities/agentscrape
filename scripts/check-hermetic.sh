#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/check-hermetic.sh <check|test> [--] [bun test arguments...]

  check  Run typecheck, lint, then the serial bounded test command.
  test   Run only the serial bounded test command.
EOF
}

fail() {
  printf 'check-hermetic: %s\n' "$1" >&2
  usage
  exit 64
}

if (( $# == 0 )); then
  fail "missing mode (expected 'check' or 'test')"
fi

mode="$1"
shift
case "$mode" in
  check | test) ;;
  -h | --help)
    usage
    exit 0
    ;;
  -*) fail "unknown option: $mode" ;;
  *) fail "unknown mode: $mode" ;;
esac

# Bun consumes `bun run ... --`, while direct callers leave it for this script.
if [[ "${1-}" == "--" ]]; then
  shift
fi
test_args=("$@")

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd -P)"
cd -- "$repo_root"

# Bun treats non-test-named fixture paths as filters unless an explicit relative path starts `./`.
normalized_test_args=()
for argument in "${test_args[@]}"; do
  if [[ "$argument" != -* && "$argument" != /* && "$argument" != ./* && -f "$argument" ]]; then
    normalized_test_args+=("./$argument")
  else
    normalized_test_args+=("$argument")
  fi
done
test_args=("${normalized_test_args[@]}")

original_umask="$(umask)"
umask 077
temp_parent="${TMPDIR:-/tmp}"
if [[ "$temp_parent" != /* || ! -d "$temp_parent" ]]; then
  temp_parent="/tmp"
fi
private_home="$(mktemp -d "${temp_parent%/}/agentscrape-hermetic.XXXXXXXXXX")"
private_home="$(CDPATH='' cd -- "$private_home" && pwd -P)"
chmod 0700 "$private_home"
umask "$original_umask"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$private_home" && -d "$private_home" && ! -L "$private_home" ]]; then
    # Make owned read-only directories removable without traversing symlink targets.
    find -P "$private_home" -type d -exec chmod u+rwx {} \; 2>/dev/null || true
    rm -rf -- "$private_home" || true
  fi
  return "$status"
}
trap cleanup EXIT

# Keep only the narrow environment needed by the toolchain and runners. The test-only marker
# communicates the poisoned HOME identity to the probe without retaining poisoned HOME state.
while IFS= read -r variable; do
  case "$variable" in
    HOME | PATH | TMPDIR | LANG | LANGUAGE | LC_* | CI | NO_COLOR | HERMETIC_TEST_POISON_HOME) ;;
    *) unset "$variable" ;;
  esac
done < <(compgen -e)
# Keep these explicit as well as covered by the dynamic loop so non-exported shell values cannot
# become exported by a later command.
unset NODE_OPTIONS BUN_OPTIONS
export HOME="$private_home"
export PATH="$repo_root/node_modules/.bin:${PATH:-/usr/bin:/bin}"

run_tests() {
  bun test --parallel=1 --max-concurrency=1 --timeout 60000 "${test_args[@]}"
}

case "$mode" in
  check)
    tsc --noEmit
    biome check .
    run_tests
    ;;
  test)
    run_tests
    ;;
esac
