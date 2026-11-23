#!/bin/bash
# Detect which AI coding CLIs are installed and authenticated on this host
# and tell the caller what to do with configs/default.yaml before deploying.
#
# The default team always has 2 agents (coder + researcher). Only the
# runtime mix changes per host.
#
# Output: one action word on the first line of stdout, then optional details.
#
#   mixed       claude + codex both ready.
#               Flip ONLY researcher's runtime to codex; leave coder on
#               claude-code-cli. Final team: 1 claude-code-cli + 1 codex.
#   as-is       claude ready, codex not ready.
#               No file edit. Deploy configs/default.yaml unchanged.
#               Final team: 2 claude-code-cli.
#   all-codex   codex ready, claude not ready.
#               Flip the defaults runtime to codex so both agents run on codex.
#               Final team: 2 codex.
#   abort       neither ready.
#               Install + login to at least one CLI before deploying.
#
# Exit code: 0 when ready to deploy after applying the action, 1 for abort.

set -u

check_claude() {
  command -v claude >/dev/null 2>&1 || return 1
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -f "$HOME/.claude/.credentials.json" ] && return 0
  if [ "$(uname)" = "Darwin" ]; then
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  fi
  return 1
}

check_codex() {
  command -v codex >/dev/null 2>&1 || return 1
  [ -n "${OPENAI_API_KEY:-}" ] && return 0
  [ -f "$HOME/.codex/auth.json" ] && return 0
  return 1
}

# Optional third runtime. Cursor is never used for the default team auto-deploy;
# we only report availability so operators know they can opt in with
# `runtime: cursor-cli` in their own configs.
check_cursor() {
  command -v cursor-agent >/dev/null 2>&1 || return 1
  [ -n "${CURSOR_API_KEY:-}" ] && return 0
  local status_output
  status_output=$(cursor-agent status 2>/dev/null || true)
  if echo "$status_output" | grep -qi 'not logged in'; then
    return 1
  fi
  if echo "$status_output" | grep -qi 'logged in'; then
    return 0
  fi
  return 1
}

claude_ready=false
codex_ready=false
cursor_ready=false
check_claude && claude_ready=true
check_codex && codex_ready=true
check_cursor && cursor_ready=true

note_optional_runtimes() {
  if command -v "${AGY_PATH:-agy}" >/dev/null 2>&1; then
    echo '# Antigravity CLI is installed. Run agy in a terminal to sign in and select runtime: antigravity-cli.'
  fi
  if $cursor_ready; then
    echo "# Cursor Agent CLI is also available. Opt in per-agent with \`runtime: cursor-cli\`."
  fi
}

if $claude_ready && $codex_ready; then
  cat <<'EOF'
mixed
# Flip ONLY the researcher agent to runtime: codex. Leave coder on
# claude-code-cli. One way to apply the edit in place:
#
#   awk '
#     /^  - name: researcher$/ { print; in_researcher=1; next }
#     in_researcher && /^    description:/ { print; print "    runtime: codex"; in_researcher=0; next }
#     { print }
#   ' configs/default.yaml > configs/default.yaml.new && \
#   mv configs/default.yaml.new configs/default.yaml
EOF
  note_optional_runtimes
  exit 0
fi

if $claude_ready; then
  echo "as-is"
  note_optional_runtimes
  exit 0
fi

if $codex_ready; then
  cat <<'EOF'
all-codex
# Flip the defaults runtime to codex so both agents inherit codex.
# One way to apply the edit in place (macOS and GNU sed compatible):
#
#   sed -i.bak 's/^  runtime: claude-code-cli$/  runtime: codex/' configs/default.yaml && \
#   rm configs/default.yaml.bak
EOF
  note_optional_runtimes
  exit 0
fi

echo "abort"
echo "Install and log in to at least one of Claude Code (claude login) or Codex (codex login) before deploying."
note_optional_runtimes
exit 1
