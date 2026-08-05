#!/bin/sh
# SPDX-License-Identifier: MIT
#
# The manager deliberately strips CLAUDE_CODE_OAUTH_TOKEN from every child it
# spawns (src/lib/env-hygiene.ts), because on a developer host that variable is
# the parent Claude Code session handing its auth to children, which makes the
# child CLI 401. That behavior is correct and is not weakened here. Instead the
# token is converted at container start into the CLI's own persisted login
# state, which is how a real deployment authenticates an agent: the child
# inherits HOME through the allowlist and reads its credentials from there.
#
# The token is never written into an image layer. It arrives at `docker run`
# time and is unset before the manager starts.
set -e

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  mkdir -p "$HOME/.claude"
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.HOME + "/.claude/.credentials.json", JSON.stringify({
      claudeAiOauth: {
        accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        refreshToken: "",
        expiresAt: Date.now() + 86400000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }));
  '
  chmod 600 "$HOME/.claude/.credentials.json"
fi

# Claude Code needs this separate file as well as the directory; a recreated
# container that lost it refuses to start.
[ -f "$HOME/.claude.json" ] || printf '{}' > "$HOME/.claude.json"

unset CLAUDE_CODE_OAUTH_TOKEN
exec node /app/dist/start-agent-manager.js
