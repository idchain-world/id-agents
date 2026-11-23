# ID Agents Quickstart

Follow these steps to find or refresh your local `id-agents` checkout, then deploy your first agent team.

## Prerequisites

- **macOS or Linux**
- **Node.js 22+** — if you don't have it, install via nvm:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.nvm/nvm.sh
  nvm install 22
  ```
  Homebrew (`brew install node`), fnm, or volta also work — just get Node 22+.
- **Claude Code CLI** — install and log in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
- **Codex CLI** (optional) — only if you want Codex agents:
  ```bash
  npm install -g @openai/codex
  codex login
  ```
- **Antigravity CLI** (optional) — install `agy`, then run `agy` once in a terminal to sign in with Google. Set `runtime: antigravity-cli` and `model: neon` on the agent. Preflight checks the sign-in with `/usage`.
- **Cursor Agent CLI** (optional) — only if you want Cursor agents:
  ```bash
  curl https://cursor.com/install -fsS | bash
  cursor-agent login   # or: export CURSOR_API_KEY=...
  ```

## ⚠️ Permissions Notice — Read Before Deploying

ID Agents runs each agent as a background process with no interactive shell to approve tool use. The default across runtimes is to bypass approval prompts:

- `claude-code-cli` agents launch with `--dangerously-skip-permissions`
- `codex` agents launch with `--dangerously-bypass-approvals-and-sandbox`
- `antigravity-cli` agents launch with `--dangerously-skip-permissions`. Opting out selects request-review mode, which can still execute shell commands.
- `cursor-cli` agents launch with `-f` (force-allow commands)

You can opt out by setting `dangerouslySkipPermissions: false` in the YAML config (per agent or under `defaults`), but be warned: any tool-use prompt then has no way to be approved, and a runtime that waits for approval can hang on the first one. If you're not comfortable giving background agents this level of autonomy, ID Agents is not the right tool for you.

## 0. Find or Refresh the Repo

If you do not have the repo yet, clone it and skip to Step 1:

```bash
git clone https://github.com/idchain-world/id-agents.git
cd id-agents
```

If you DO have an `id-agents` clone locally, **do not pull silently**. First inspect state and ask the user before changing anything.

```bash
cd <path-to-id-agents>
echo "branch=$(git branch --show-current)"
echo "dirty=$([ -z "$(git status --porcelain)" ] && echo clean || echo DIRTY)"
git fetch origin main >/dev/null 2>&1 || echo "(could not reach origin)"
local_ver=$(node -p "require('./package.json').version")
remote_ver=$(git show origin/main:package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
echo "local=$local_ver  origin/main=$remote_ver"
```

Then **ask the user explicitly** before doing anything else, choosing the message that fits the state:

- **Already on the latest version** (`local == remote`, branch `main`, clean tree): "Your `id-agents` checkout is already at version `<X>`. Continue with this version?" Default: yes, proceed to Step 1 with no install/build needed.
- **Newer version available** (`local != remote`, branch `main`, clean tree): "Your `id-agents` checkout is on `<local>`. The latest on `origin/main` is `<remote>`. Update? This will run `git pull --ff-only && npm install && npm run build`." Wait for an explicit yes before running the upgrade. If the user declines, continue with the current version.
- **Working tree is dirty**: "Your `id-agents` checkout has uncommitted changes. I won't pull on top of those. Continue with your current state, or stop so you can commit/stash first?" Do not auto-pull.
- **Branch is not `main`**: "Your `id-agents` checkout is on branch `<branch>`, not `main`. I won't pull or check the version. Continue with this branch, or switch to `main` first?" Do not auto-pull.

Only run the upgrade command if the user explicitly approves it:

```bash
git pull --ff-only origin main
npm install
npm run build
```

From this point on, `<path-to-id-agents>` means that working tree.

## 1. Install Dependencies and Rebuild

Skip this step if Step 0 already ran the upgrade (which includes `npm install && npm run build`), or if the repo is already at the current version with `node_modules/` and `dist/` populated.

Run only on a fresh clone, or if you suspect `node_modules/` or `dist/` is missing or stale:

```bash
npm install
npm run build
```

## 2. Add the Admin Control Skill

Copy the `idagents-admin-control` skill into the project where you are running Claude Code (this is your project directory, not the `id-agents` repo). The command below is idempotent: it creates the target folder if needed and refreshes the skill in place on re-run.

```bash
mkdir -p <your-claude-code-project>/.claude/skills/idagents-admin-control
rsync -a --delete <path-to-id-agents>/skills/idagents-admin-control/ <your-claude-code-project>/.claude/skills/idagents-admin-control/
```

For example, if `id-agents` is at `~/projects/id-agents` and you're running Claude Code in `~/projects/my-app`:

```bash
mkdir -p ~/projects/my-app/.claude/skills/idagents-admin-control
rsync -a --delete ~/projects/id-agents/skills/idagents-admin-control/ ~/projects/my-app/.claude/skills/idagents-admin-control/
```

## 3. Start the Manager

```bash
cd <path-to-id-agents>
npm run id-agents
```

This starts the interactive CLI and ensures the manager daemon is available on port 4100. The CLI does not open its own local HTTP port.

> **Running this from a Claude Code session?** Spawn the command in the background (Bash tool with `run_in_background: true`). The readline prompt sits idle with no stdin — that's fine. The daemon on port 4100 comes up normally and every step below works unchanged. If you also want an interactive TTY, open a separate terminal window and run the command there.
>
> **Headless-only alternative:** If you don't need the CLI at all, run `node dist/start-agent-manager.js` and use port 4100. `/deploy` in Step 4 goes through the manager daemon's `/remote` endpoint on port 4100, so the interactive CLI is optional.

## 4. Deploy the Default Team

`configs/default.yaml` ships with two agents — `coder` and `researcher`, both on `claude-code-cli`. The file is the source of truth: whatever is in it is what gets deployed. Before deploying, edit `configs/default.yaml` so the runtime mix matches what is available on this host.

### Detect available runtimes

**Shortcut:** run the helper and it will tell you which of the four cases below applies:

```bash
./scripts/detect-runtimes.sh
```

First line of the output is one of `mixed`, `as-is`, `all-codex`, `abort` — matching the rows below. For `mixed` and `all-codex` the script also prints the exact edit commands you can copy/paste. When **Cursor Agent CLI** is installed and authenticated, the script may print an extra comment line suggesting per-agent `runtime: cursor-cli` for your own configs (the default two-agent flip table below is still Claude ↔ Codex only).

Or check by hand:

```bash
# Claude Code: binary on PATH, and one of api key / ~/.claude/.credentials.json / macOS keychain
command -v claude >/dev/null 2>&1 && \
  { [ -n "$ANTHROPIC_API_KEY" ] || [ -f "$HOME/.claude/.credentials.json" ] || \
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; } \
  && echo "claude: ready" || echo "claude: not ready"

# Codex: binary on PATH, and one of $OPENAI_API_KEY / ~/.codex/auth.json
command -v codex >/dev/null 2>&1 && \
  { [ -n "$OPENAI_API_KEY" ] || [ -f "$HOME/.codex/auth.json" ]; } \
  && echo "codex: ready" || echo "codex: not ready"

# Cursor: cursor-agent on PATH, and CURSOR_API_KEY or logged-in session (see cursor-agent status)
command -v cursor-agent >/dev/null 2>&1 && \
  { [ -n "$CURSOR_API_KEY" ] || cursor-agent status 2>/dev/null | grep -qi 'logged in'; } \
  && echo "cursor: ready" || echo "cursor: not ready"
```

### Apply the matching edit, then deploy

| Claude ready | Codex ready | Action | Final team |
|---|---|---|---|
| ✓ | ✓ | Flip ONLY `researcher`'s runtime to `codex`; leave `coder` on `claude-code-cli`. | `coder` (Claude) + `researcher` (Codex) |
| ✓ | ✗ | No edit. Deploy `configs/default.yaml` as-is. | `coder` + `researcher` (both Claude) |
| ✗ | ✓ | Flip the `defaults.runtime` in `configs/default.yaml` from `claude-code-cli` to `codex`. | `coder` + `researcher` (both Codex) |
| ✗ | ✗ | **Stop.** Run `claude login`, `codex login`, or `cursor-agent login` (see Prerequisites) so at least one of Claude or Codex is ready for the default team flip; use `runtime: cursor-cli` in custom configs when only Cursor is available. | — |

**Mixed (Claude + Codex)** — flip only `researcher`:

```bash
awk '
  /^  - name: researcher$/ { print; in_researcher=1; next }
  in_researcher && /^    description:/ { print; print "    runtime: codex"; in_researcher=0; next }
  { print }
' configs/default.yaml > configs/default.yaml.new && \
  mv configs/default.yaml.new configs/default.yaml
```

**All Codex** — flip the defaults block:

```bash
sed -i.bak 's/^  runtime: claude-code-cli$/  runtime: codex/' configs/default.yaml && \
  rm configs/default.yaml.bak
```

Then deploy:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy default"}'
```

> **Troubleshooting:** If agents show `status: error` after deploy, check the manager's terminal output for the actual error message. Agent log files are at `workspace/logs/local-<name>-*.log`.

## 5. Talk to Your Agents

List agents:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

Ask an agent a question and capture the `queryId` returned by `/ask`:

```bash
QID=$(curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask coder Introduce yourself and tell me what you can do."}' \
  | jq -r '.result.queryId')
```

Wait for the reply with a single long-poll call (blocks up to 30s until the query reaches a terminal state):

```bash
curl -s -H "X-Id-Team: default" \
  "http://localhost:4100/query/$QID?wait=30" \
  | jq -r '.result.result'
```

For prompts that may take longer than 30s, chain the long-poll in a small loop until `status` is `delivered`, `failed`, or `expired`. See [MANAGER-POLLING.md](./MANAGER-POLLING.md) for the full polling guide — patterns, anti-patterns (don't burst-poll `/news` with grep), and the wakeup-service event stream.

## 6. Offer to Act as the Team Manager

After deploy completes, you (Claude) are already connected to the team via `/remote` on `http://localhost:4100`. Don't hand the user off to a separate terminal — offer to continue as their team manager:

> I can act as your team manager and communicate directly to your team via /remote. Shall I ask them to say who they are?

If they accept, keep using the `/remote` endpoint to relay between the user and the team — `/agents` for a roster, `/ask <agent> <message>` to send, `/news <agent>` to poll for replies.

## 7. Suggest Next Steps

After the default team is running, suggest the user create their own team. A good starting point:

> You can create a custom team by making a YAML config in `configs/`. Specify agent names and their working directories (the project folders they should work in):
>
> ```yaml
> version: "1"
> team: default
>
> defaults:
>   local: true
>   runtime: claude-code-cli
>   skills:
>     - identity
>     - inter-agent
>     - catalog
>
> agents:
>   - name: frontend
>     description: "Frontend developer"
>     workingDirectory: /path/to/frontend-project
>
>   - name: backend
>     description: "Backend developer"
>     workingDirectory: /path/to/backend-project
> ```
>
> Then deploy with `/deploy my-config` — either via `/remote` (with you, Claude, as the team manager) or in the interactive CLI.

## 8. Launch a User Surface (Optional)

The daemon on port 4100 runs continuously once Step 3 is up. You can drive the team through any combination of these surfaces — run any, all, or none. They're independent views over the same daemon.

### Claude Code as manager (default)

Nothing to launch. This Claude session is already connected via `/remote` on `http://localhost:4100` using the `idagents-admin-control` skill. Claude relays `/agents`, `/ask`, `/news`, `/deploy` — your whole manager experience happens in the conversation you're in right now.

### TUI dashboard

Real-time view of fleet, tasks, news, calendar, and heartbeats:

```bash
cd <path-to-id-agents>
npm run tui:dev   # source mode, auto-reload during dev
# or
npm run tui       # built mode
```

Key bindings: `a` / `t` / `c` / `h` switch views, `→` drill in, `←` back from drill-down, `q` quit. Full reference at [docs/guides/tui.md](./docs/guides/tui.md).

### Interactive CLI

Manual command entry for scripting or debugging (this is the same surface Step 3 launches):

```bash
cd <path-to-id-agents>
npm run id-agents
```

Type `/help` for commands.

## Next Steps

- [Documentation](https://www.idagents.ai/docs) -- Full docs
- [Configuration](https://www.idagents.ai/docs/configuration) -- YAML config and environment variables
- [Skills](https://www.idagents.ai/docs/skills) -- Extend agent capabilities
- [Manager Polling](./MANAGER-POLLING.md) -- How to wait for query completion (long-poll, anti-patterns)
- [XMTP Messaging](https://www.idagents.ai/docs/xmtp) -- Encrypted messaging via ENS names
- [Onchain Identity](https://www.idagents.ai/docs/identity) -- Register agents on ID Chain
