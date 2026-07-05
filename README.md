# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME.md)

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-lightgrey?style=for-the-badge)](./README_ja.md)

**A skill set for LLM agents that delegates implementation, exploration, review, and chores to a subagent running a cheaper model or a model from another vendor (Claude → Codex, etc.) — compressing token cost.**

Keep an expensive model as the main agent and offload routine "read, investigate, fix" work to a cheaper-model child process. For example, when the main agent is Claude Fable 5 (input \$10 / output \$50 per 1M tokens), delegating code exploration to Claude Haiku 4.5 (\$1 / \$5) cuts the token cost of that work to 1/10. Delegation targets are not limited to Claude models: models available through Codex (`gpt-*`), Devin CLI, and Cursor agent CLI can be selected by model name alone. Results come back through files and are read incrementally, so the main agent's context stays small.

## Features

- **Token cost compression** — delegate read/write-heavy routine work to cheaper models, reserving the expensive model's consumption for decision-making and final responsibility
- **Context isolation** — bulk file reading and trial-and-error logs stay in the child process; the main agent reads only the result's index → required sections
- **Multi-CLI support** — works whether the requester is Claude Code, Codex, Devin CLI, or Cursor, and delegation targets across the same four backends are selected by model name alone
- **Capability bridge** — bridges capabilities the main agent lacks, such as image generation (`delegate-imagegen`) and x.com research (`delegate-x-research`), through child processes
- **Fail-safe design** — recursion guard for multi-hop delegation, fail-closed on missing preconditions, and tool-permission limits such as no-push / read-only for delegation targets

## Quick start

### Prerequisites

- Node.js and `md2idx` (`npx md2idx` must be runnable; a global install via `npm install -g md2idx` is recommended since every skill uses it heavily)
- `jq`
- When using Claude family models: the `claude` CLI (logged in)
- When using `gpt-*`: the `codex` CLI (logged in)
- When using `swe-*` / `devin-*`: the `devin` CLI (logged in)
- When using `composer-*` / `cursor-*`: the Cursor agent CLI (command name `agent`; logged in or `CURSOR_API_KEY` set)
- When using `delegate-x-research` with the current backend: the `grok` CLI (logged in, with access to X research)

### Installation

#### gh skill (GitHub CLI v2.90.0+)

```bash
# Install an individual skill for Claude Code
gh skill install oubakiou/delegate-skills delegate-explore --agent claude-code --scope project

# For Codex
gh skill install oubakiou/delegate-skills delegate-explore --agent codex --scope project

# Install all delegate skills at once
for skill in delegate-explore delegate-implement delegate-chore delegate-review delegate-imagegen delegate-x-research; do
  gh skill install oubakiou/delegate-skills "$skill" --agent claude-code --scope project
done
```

#### skills CLI ([vercel-labs/skills](https://github.com/vercel-labs/skills))

```bash
# Pick skills / agents interactively
npx skills add oubakiou/delegate-skills

# List available skills
npx skills add oubakiou/delegate-skills --list

# Install a specific skill for a specific agent non-interactively
npx skills add oubakiou/delegate-skills --skill delegate-explore -a claude-code -y
```

### Try it

No extra configuration is needed after installation. Ask the main agent as usual, and it delegates automatically based on each skill's description.

```text
Find out where authentication is implemented in this repository
```

→ The main agent triggers `delegate-explore`, and a `haiku` child process does the investigation. The main agent reads only the result file's index → required sections.

You can also delegate explicitly by naming a skill.

```text
Review this branch's diff with delegate-review
```

To make the main agent delegate more aggressively, add one line to your project's CLAUDE.md / AGENTS.md.

```markdown
- To save tokens, actively delegate tasks to subagents using the delegate-\* skills
```

## How it works

Delegate routine, mechanical work to a cheaper model without polluting the main agent's (expensive model) context. The execution backend is **determined by the model-name prefix**:

| Model name                            | Backend                     | Launch                             |
| ------------------------------------- | --------------------------- | ---------------------------------- |
| `sonnet` / `haiku` / `opus` / `fable` | Claude subprocess           | `claude -p` (`delegate-claude.sh`) |
| `gpt-*`                               | Codex subprocess            | `codex exec` (`delegate-codex.sh`) |
| `swe-*` / `devin-*`                   | Devin CLI subprocess        | `devin -p` (`delegate-devin.sh`)   |
| `composer-*` / `cursor-*`             | Cursor agent CLI subprocess | `agent -p` (`delegate-cursor.sh`)  |

What the prefixes mean:

- `swe-*` and `composer-*` are each CLI's native model names and are passed through as-is (e.g. `swe-1.6`, `composer-2.5`)
- `devin-*` and `cursor-*` are backend-pinning prefixes that fix "use this CLI"; the prefix is stripped and the remainder is passed as the model name (e.g. `devin-glm-5.2` → `glm-5.2` on Devin CLI, `cursor-glm-5.2-high` → `glm-5.2-high` on Cursor agent CLI)

All four paths launch a child process via a shell wrapper, so the skills work uniformly regardless of whether the requester is Claude Code, Codex, Devin CLI, or Cursor. Hand-off between main and sub is [file-based (request/response)](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fprotocol-v1.md). Both files use the [md2idx](https://github.com/oubakiou/md2idx) format (`index` + `sections`) and are read incrementally to save tokens.

### Resumable worker sessions

Normal delegate runs stay non-persistent. For larger `delegate-implement` or `delegate-chore` tasks where the main agent expects a review/fix loop, the main agent may explicitly start a resumable initial run. That opt-in records a backend resume handle, `lineage_id`, and `run_context` in the observe JSON so a later follow-up can resume the same backend session while still creating a fresh request/response/observe run.

Follow-up is explicit and fail-closed: it requires a previous observe JSON whose `backend_session.persistence` is `resumable`, a resume handle, matching backend/model/repo/worktree context, and a compatible git HEAD. If validation fails, delegation does not silently fall back to a new session; the main agent must issue a normal delegate run instead. Claude, Codex, Devin, and Cursor backends support the resumable path. No new environment variables are required.

`delegate-imagegen` resolves a Codex model with the same env/default mechanism as the other delegates, but it remains a Codex-only capability bridge: `DELEGATE_IMAGEGEN_MODEL` selects the child model, `gpt*` routes to Codex, and non-`gpt*` fails closed instead of falling through to Claude.

`delegate-x-research` resolves `DELEGATE_X_RESEARCH_MODEL` with default `grok-build`, then launches the current X research backend, currently Grok CLI, to investigate x.com / X posts, accounts, threads, and reactions. It does not route through Claude or Codex.

## Skills

| skill                 | Purpose                                  | Tool permissions          | Default model | env                                                                              |
| --------------------- | ---------------------------------------- | ------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `delegate-explore`    | Read-only code & doc exploration         | read-only                 | `haiku`       | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| `delegate-implement`  | Code implementation & edits (one commit) | Edit/Write/Bash (no push) | `sonnet`      | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| `delegate-chore`      | Fallback chores                          | Edit/Write/Bash (no push) | `haiku`       | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| `delegate-review`     | Code/doc review (diff findings)          | read-only                 | `opus`        | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`   | Image generation/editing via Codex       | Codex subprocess          | `gpt-5`       | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |
| `delegate-x-research` | x.com / X research                       | X research subprocess     | `grok-build`  | `DELEGATE_X_RESEARCH_MODEL` / `DELEGATE_WORK_DIR`                                |

Rationale for default models: explore / chore are read-centric and low-risk, so `haiku`; implement needs editing judgment, so `sonnet`; review's finding quality directly shapes the result and is judgment-heavy, so `opus`.

`delegate-imagegen` intentionally has no user-facing model prompt, but operators can set `DELEGATE_IMAGEGEN_MODEL`. If the user does not specify an output directory, generated files go under `delegate-imagegen-output/`.

`delegate-x-research` is a capability bridge for X research, so operators can set `DELEGATE_X_RESEARCH_MODEL` but the main agent should not ask users to pick a backend model.

## Environment variables

| Variable                                 | Default                                | Description                                                       |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`                  | per skill                              | Per-type model override                                           |
| `DELEGATE_WORK_DIR`                      | mktemp default (`TMPDIR`, else `/tmp`) | Location for request/response files                               |
| `DELEGATE_RESPONSE_INLINE_MAX`           | `10240` bytes                          | Inline/stepwise threshold for `read-response.sh auto`             |
| `DELEGATE_METRICS_FILE`                  | unset                                  | Optional JSONL proxy-metric telemetry output path                 |
| `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL`    | `10` seconds                           | Worker observe JSON heartbeat interval                            |
| `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` | `0` (disabled)                         | Kill a child after this many seconds without stream byte growth   |
| `DELEGATE_OBSERVE_STREAM_MAX_BYTES`      | `65536` bytes (`0` = unlimited)        | Max stdout/stderr content stored in observe JSON                  |
| `DELEGATE_RUN_RETENTION_DAYS`            | `0` (disabled)                         | Delete old per-run scratch directories during request preparation |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR`           | `delegate-imagegen-output`             | Default output directory for `delegate-imagegen`                  |
| `DELEGATE_X_RESEARCH_MODEL`              | `grok-build`                           | Model for `delegate-x-research`                                   |

Model resolution order: `DELEGATE_<TYPE>_MODEL` → skill-specific default.

For reproducible local debugging and external watchdogs, set `DELEGATE_WORK_DIR=.temp/delegate/work` so request, response, observe JSON, and per-run scratch files stay under a repo-local ignored directory.
Set `DELEGATE_RUN_RETENTION_DAYS` to prune old per-run scratch directories in that work directory; request, response, and observe JSON files are kept for audit/debugging.
Worker token usage is recorded in observe JSON as `usage.measurement: "measured" | "estimated"` when a run ends. Claude stream-json, Codex JSON/session JSONL, and Devin ATIF export can provide measured values; unsupported or unparsable backends fall back to a chars/4 estimate and emit a `usage_parse_failed` observe event.

Documented model names for `DELEGATE_<TYPE>_MODEL`:

| Runtime          | Model names                                                                                                                        | Notes                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Claude CLI       | `fable`, `opus`, `sonnet`, `haiku`                                                                                                 | Aliases for Claude family models                                          |
| Codex CLI        | `gpt-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex-spark`                                               | `delegate-imagegen` only accepts the `gpt*` / Codex branch                |
| Devin CLI        | `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`                                                                | `devin-*` strips the prefix before passing the model to Devin CLI         |
| Cursor agent CLI | `composer-2.5`, `composer-2.5-fast`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code`, `cursor-glm-5.2-high`, `cursor-glm-5.2-max` | `cursor-*` strips the prefix before passing the model to Cursor agent CLI |

The list above is documented support, not a hard allowlist. The target CLI must also expose the requested model. `delegate-x-research` uses `DELEGATE_X_RESEARCH_MODEL` instead, with documented model `grok-build`.

Effort handling for those documented names:

delegate-skills passes only the resolved model string to the target CLI. It does not pass Claude `--effort`, Codex `model_reasoning_effort`, Cursor parameter overrides, or any Devin effort option. Codex delegates also run with `--ignore-user-config`, so user config `model_reasoning_effort` is not loaded.

| Model name(s)                                                                         | Effort behavior                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `fable`, `opus`, `sonnet`, `haiku`                                                    | No explicit Claude `--effort`; the Claude CLI default for the alias applies.                                 |
| `gpt-5`                                                                               | No explicit Codex effort; if the installed Codex CLI accepts the model, its runtime default applies.         |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`                                                  | Codex catalog default is `medium`; supported levels are `low`, `medium`, `high`, and `xhigh`.                |
| `gpt-5.4-nano`                                                                        | No explicit Codex effort; if the installed Codex CLI accepts the model, its runtime default applies.         |
| `gpt-5.3-codex-spark`                                                                 | No explicit Codex effort; Spark availability and defaults are determined by the installed Codex CLI/runtime. |
| `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`                   | No separate Devin effort flag is passed; the Devin-side default for the selected model applies.              |
| `composer-2.5`, `composer-2.5-fast`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code` | No effort suffix or Cursor parameter override; the Cursor model default applies.                             |
| `cursor-glm-5.2-high`                                                                 | Cursor receives `glm-5.2-high`; `high` is encoded in the model slug.                                         |
| `cursor-glm-5.2-max`                                                                  | Cursor receives `glm-5.2-max`; `max` is encoded in the model slug.                                           |
| `grok-build` (`DELEGATE_X_RESEARCH_MODEL`)                                            | No separate effort setting is passed; the X research backend default applies.                                |

## Model price reference

[`shared/model-token-prices.json`](shared/model-token-prices.json) contains a manually curated token price snapshot for supported delegate model families. `scripts/sync-shared.ts` bundles a copy into each skill directory. It is reference data for cost analysis and reporting only; delegate-skills does not use it as a cost gate.

![Model token prices](docs/assets/model-token-prices.svg)

Models with input prices at or below \$1 or output prices at or below \$5 per 1M tokens:

![Low-cost model token prices](docs/assets/model-token-prices-low-cost.svg)

## Architecture

See [docs/design/spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md#p:2).

## Development

See [docs/design/development.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fdevelopment.md).

## License

MIT
