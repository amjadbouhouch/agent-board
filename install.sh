#!/bin/sh
# AgentBoard installer.
#
#   curl -fsSL https://raw.githubusercontent.com/amjadbouhouch/agent-board/main/install.sh | sh
#
# Installs a single self-contained binary. Re-running upgrades in place.
#
# Environment:
#   AGENT_BOARD_VERSION      version to install (default: latest release)
#   AGENT_BOARD_INSTALL_DIR  where to put the binary (default: ~/.agent-board/bin)
#   AGENT_BOARD_REPO         GitHub repo to download releases from
#   AGENT_BOARD_BASE_URL     download from a mirror instead of GitHub releases
#
# Flags:
#   --local            build from the current source tree instead of downloading
#   --uninstall        remove an existing installation
#   --version X        install a specific version
#   --modify-path      add the install dir to your shell profile without asking
#   --no-modify-path   never touch a shell profile
#
# POSIX sh on purpose: this has to run under `| sh` on any machine.
set -eu

REPO="${AGENT_BOARD_REPO:-amjadbouhouch/agent-board}"
INSTALL_DIR="${AGENT_BOARD_INSTALL_DIR:-$HOME/.agent-board/bin}"
VERSION="${AGENT_BOARD_VERSION:-latest}"
BIN_NAME="agent-board"
MODE="download"
# unset = ask when a terminal is available; yes/no = decided by flag or env.
MODIFY_PATH="${AGENT_BOARD_MODIFY_PATH:-}"

# Colour only when stdout is a terminal, so piped output stays clean.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err()  { printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --local)     MODE="local" ;;
    --modify-path)    [ "$MODIFY_PATH" = "no" ] || MODIFY_PATH="yes" ;;
    --no-modify-path) MODIFY_PATH="no" ;;
    --uninstall) MODE="uninstall" ;;
    --version)   shift; [ $# -gt 0 ] || err "--version needs a value"; VERSION="$1" ;;
    --version=*) VERSION="${1#--version=}" ;;
    --dir)       shift; [ $# -gt 0 ] || err "--dir needs a value"; INSTALL_DIR="$1" ;;
    --dir=*)     INSTALL_DIR="${1#--dir=}" ;;
    -h|--help)   sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           err "unknown option: $1" ;;
  esac
  shift
done

TARGET_PATH="$INSTALL_DIR/$BIN_NAME"

# ---------------------------------------------------------------- uninstall
if [ "$MODE" = "uninstall" ]; then
  removed=0
  for candidate in "$TARGET_PATH" "$HOME/.agent-board/bin/$BIN_NAME"; do
    if [ -e "$candidate" ]; then rm -f "$candidate"; info "removed $candidate"; removed=1; fi
  done
  [ "$removed" -eq 1 ] || warn "no installation found"
  # Only remove the directory we own, and only when empty.
  [ -d "$HOME/.agent-board/bin" ] && rmdir "$HOME/.agent-board/bin" 2>/dev/null || true
  [ -d "$HOME/.agent-board" ] && rmdir "$HOME/.agent-board" 2>/dev/null || true
  ok "uninstalled"
  exit 0
fi

# ------------------------------------------------------------------ platform
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os_part="darwin" ;;
    Linux)  os_part="linux" ;;
    *)      err "unsupported operating system: $os (build from source with --local)" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch_part="x64" ;;
    arm64|aarch64) arch_part="arm64" ;;
    *)             err "unsupported architecture: $arch (build from source with --local)" ;;
  esac
  # Alpine and friends need the musl build.
  suffix=""
  if [ "$os_part" = "linux" ] && ! (ldd /bin/sh 2>/dev/null | grep -q GNU); then
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
      suffix="-musl"
    fi
  fi
  printf '%s-%s%s' "$os_part" "$arch_part" "$suffix"
}

previous_version() {
  if [ -x "$TARGET_PATH" ]; then "$TARGET_PATH" --version 2>/dev/null || printf 'unknown'; fi
}

# ------------------------------------------------------------------- install
say ""
say "${BOLD}Installing AgentBoard${RESET}"
say ""

PREVIOUS=$(previous_version)
mkdir -p "$INSTALL_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
TMP_BIN="$TMP_DIR/$BIN_NAME"

if [ "$MODE" = "local" ]; then
  command -v bun >/dev/null 2>&1 || err "bun is required to build from source: https://bun.sh"
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  [ -f "$SCRIPT_DIR/package.json" ] || err "--local must run from inside the AgentBoard source tree"
  info "building from $SCRIPT_DIR"
  # Same flags as the `build` script in package.json.
  ( cd "$SCRIPT_DIR" && bun build --compile --minify --bytecode src/cli.ts --outfile "$TMP_BIN" >/dev/null )
else
  command -v curl >/dev/null 2>&1 || err "curl is required"
  TARGET=$(detect_target)
  info "platform  $TARGET"

  if [ -n "${AGENT_BOARD_BASE_URL:-}" ]; then
    # Mirror or air-gapped host serving the same asset names.
    BASE="${AGENT_BOARD_BASE_URL%/}"
  elif [ "$VERSION" = "latest" ]; then
    BASE="https://github.com/$REPO/releases/latest/download"
  else
    BASE="https://github.com/$REPO/releases/download/$VERSION"
  fi
  ASSET="$BIN_NAME-$TARGET"
  info "source    $BASE/$ASSET"

  # curl stderr is discarded so the actionable message below is the only output.
  if ! curl -fsSL --retry 3 -o "$TMP_BIN" "$BASE/$ASSET" 2>/dev/null; then
    err "download failed. No release asset for $TARGET at $BASE/$ASSET.
      If you have the source tree, build it instead:  ./install.sh --local"
  fi

  # Verify the checksum when the release publishes one.
  if curl -fsSL --retry 2 -o "$TMP_DIR/sum" "$BASE/$ASSET.sha256" 2>/dev/null; then
    expected=$(cut -d' ' -f1 < "$TMP_DIR/sum")
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$TMP_BIN" | cut -d' ' -f1)
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$TMP_BIN" | cut -d' ' -f1)
    else
      actual=""
      warn "no sha256 tool available; skipping checksum verification"
    fi
    if [ -n "$actual" ]; then
      [ "$actual" = "$expected" ] || err "checksum mismatch: expected $expected, got $actual"
      info "checksum  verified"
    fi
  else
    warn "release published no .sha256 checksum; skipping verification"
  fi
fi

chmod +x "$TMP_BIN"

# Prove the binary runs before it replaces a working installation.
NEW_VERSION=$("$TMP_BIN" --version 2>/dev/null) || err "the downloaded binary failed to run"

# mv within the same filesystem is atomic, so a concurrent invocation never
# sees a half-written binary.
mv -f "$TMP_BIN" "$TARGET_PATH"

say ""
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$NEW_VERSION" ]; then
  ok "upgraded AgentBoard $PREVIOUS -> $NEW_VERSION"
elif [ -n "$PREVIOUS" ]; then
  ok "reinstalled AgentBoard $NEW_VERSION"
else
  ok "installed AgentBoard $NEW_VERSION"
fi
info "$TARGET_PATH"

# -------------------------------------------------------------- shadow check
# An older copy earlier on PATH would silently win, which looks exactly like
# "the upgrade did nothing". Name it and say how to fix it.
SHADOW=$(command -v "$BIN_NAME" 2>/dev/null || true)
if [ -n "$SHADOW" ] && [ "$SHADOW" != "$TARGET_PATH" ]; then
  SHADOW_VERSION=$("$SHADOW" --version 2>/dev/null || printf 'unknown')
  say ""
  warn "another $BIN_NAME ($SHADOW_VERSION) is earlier on your PATH and will win:"
  info "  $SHADOW"
  say ""
  info "Remove it, or put $INSTALL_DIR first on PATH:"
  info "  ${DIM}rm $SHADOW${RESET}"
fi

# ------------------------------------------------------------- shell profile
# The file this shell actually reads at startup.
shell_profile() {
  case "$(basename "${SHELL:-sh}")" in
    fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
    zsh)  printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
    bash) if [ -f "$HOME/.bashrc" ]; then printf '%s/.bashrc' "$HOME"
          else printf '%s/.bash_profile' "$HOME"; fi ;;
    *)    printf '%s/.profile' "$HOME" ;;
  esac
}

# Written with $HOME rather than the expanded path so the line survives being
# copied to another machine.
path_line() {
  dir_expr=$1
  case "${dir_expr}" in "$HOME"/*) dir_expr="\$HOME${dir_expr#"$HOME"}" ;; esac
  case "$(basename "${SHELL:-sh}")" in
    fish) printf 'fish_add_path "%s"' "$dir_expr" ;;
    *)    printf 'export PATH="%s:$PATH"' "$dir_expr" ;;
  esac
}

# Appends the line unless it is already there, so re-running is a no-op.
add_to_profile() {
  profile=$(shell_profile)
  line=$(path_line "$INSTALL_DIR")

  if [ -f "$profile" ] && grep -Fqx "$line" "$profile"; then
    info "$profile already sets the PATH."
    return 0
  fi

  mkdir -p "${profile%/*}"
  printf '\n# AgentBoard\n%s\n' "$line" >> "$profile"
  ok "added $INSTALL_DIR to $profile"
  say ""
  info "Start a new shell, or run: ${DIM}. $profile${RESET}"
}

# ---------------------------------------------------------------------- PATH
case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ON_PATH=1 ;;
  *)                  ON_PATH=0 ;;
esac

if [ "$ON_PATH" -eq 1 ]; then
  say ""
  info "Run ${BOLD}agent-board help${RESET} to get started."
elif [ "$MODIFY_PATH" = "no" ]; then
  say ""
  info "Add $INSTALL_DIR to your PATH with:"
  info "  ${DIM}$(path_line "$INSTALL_DIR")${RESET}"
elif [ "$MODIFY_PATH" = "yes" ]; then
  say ""
  add_to_profile
else
  say ""
  warn "$INSTALL_DIR is not on your PATH."
  say ""
  # Under `curl | sh` stdin is the script itself, so the prompt has to come
  # from the terminal directly. No terminal (CI, pipelines) means no prompt and
  # no edit — just the instruction.
  if [ -e /dev/tty ] && ( : <>/dev/tty ) 2>/dev/null; then
    exec 3<>/dev/tty
    printf '  Add it to %s now? [Y/n] ' "$(shell_profile)" >&3
    IFS= read -r reply <&3 || reply=""
    exec 3>&-
    case "$reply" in
      n|N|no|NO) info "Add it yourself with:"
                 info "  ${DIM}$(path_line "$INSTALL_DIR")${RESET}" ;;
      *)         add_to_profile ;;
    esac
  else
    info "Add it with:"
    info "  ${DIM}$(path_line "$INSTALL_DIR")${RESET}"
    info "  ${DIM}(or re-run with --modify-path)${RESET}"
  fi
fi
say ""
