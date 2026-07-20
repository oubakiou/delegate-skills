# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME.md)

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-lightgrey?style=for-the-badge)](./README_ja.md)

📖 Introduction article: [Don't Make the Expensive Model Do Everything — delegate-skills, a Casual Multi-Model Setup Built on Nothing but Standard Skills](https://dev.to/kiou_ouba_afbd120335456f3/dont-make-the-expensive-model-do-everything-delegate-skills-a-casual-multi-model-setup-built-on-1c9j)

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

- Node.js 24+ (the delegate scripts are a single bundled CLI that inlines `md2idx`; no `jq`, no `npx md2idx`, and no network access on first run)
- A POSIX shell to run the `.sh` shims, plus `git` when using follow-up sessions
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
for skill in delegate-explore delegate-implement delegate-chore delegate-review delegate-imagegen delegate-x-research delegate-htmldoc; do
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

- `swe-*` and `composer-*` are each CLI's native model names and are passed through as-is (e.g. `swe-1.7`, `composer-2.5`)
- `devin-*` and `cursor-*` are backend-pinning prefixes that fix "use this CLI"; the prefix is stripped and the remainder is passed as the model name (e.g. `devin-glm-5.2` → `glm-5.2` on Devin CLI, `cursor-glm-5.2-high` → `glm-5.2-high` on Cursor agent CLI)

All four paths launch a child process via a shell wrapper, so the skills work uniformly regardless of whether the requester is Claude Code, Codex, Devin CLI, or Cursor. Each `delegate-*.sh` is a thin exec shim over a single self-contained TypeScript bundle (`delegate-cli.mjs`, `md2idx` inlined), so at runtime only Node.js and the target backend CLI are required — no `jq` and no `npx`. Hand-off between main and sub is [file-based (request/response)](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fprotocol-v1.md). Both files use the [md2idx](https://github.com/oubakiou/md2idx) format (`index` + `sections`) and are read incrementally to save tokens.

The parent-side happy path is a single one-shot call: each skill's `run.sh` (`run-imagegen.sh` / `run-x-research.sh` for the two dedicated skills) chains prepare → dispatch → read-response in one Bash invocation and prints a single JSON object (`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`) on success and failure alike, passing internal exit codes through. `content` is capped at `DELEGATE_RUN_CONTENT_MAX` bytes; the full response stays readable via `response_file`. Advanced flows — resumable / follow-up sessions, observe monitoring, background dispatch — keep using the individual scripts. Interactive parents can hide the wait by dispatching in the background and polling the observe JSON before reading the response; this improves perceived latency only, total wall time is unchanged.

The request body is embedded into the worker's initial prompt from the canonical request JSON (up to `DELEGATE_REQUEST_INLINE_MAX`, default 256KB; larger requests fall back to the `read-request.sh` instruction), so the worker spends no round trip on reading it. Prompts are passed via stdin (Claude / Codex / Cursor) or `--prompt-file` (Devin) rather than argv. Worker reports are collected by the wrapper, not written by the worker: Claude and Codex workers return a structured final answer `{status, report_markdown}` (schema-enforced via `--json-schema` / `--output-schema`), while Cursor / Devin / Grok workers write a single front-matter Markdown report file. The wrapper converts either form into the protocol response (md2idx + envelope) with zero extra LLM round trips; collection failures produce a failed response (fail-closed), and structured-parse success is recorded in the observe `timing`.

In managed-policy environments where Claude's bypass permissions mode is disabled, Claude backend workers run in default permission mode. The wrapper pre-approves the minimal tools needed to read the request — the report comes back through the structured final answer, so no write permission is needed for the protocol response — but other Bash commands or tools may be rejected. To run full tasks in that environment, add the required allowlist entries to project settings or select a non-Claude backend with `DELEGATE_<TYPE>_MODEL`; tools explicitly denied by managed policy cannot be enabled by the wrapper.

### Resumable worker sessions

Normal delegate runs stay non-persistent. For larger `delegate-implement` or `delegate-chore` tasks where the main agent expects a review/fix loop, the main agent may explicitly start a resumable initial run. That opt-in records a backend resume handle, `lineage_id`, and `run_context` in the observe JSON so a later follow-up can resume the same backend session while still creating a fresh request/response/observe run.

Follow-up is explicit and fail-closed: it requires a previous observe JSON whose `backend_session.persistence` is `resumable`, a resume handle, matching backend/model/repo/worktree context, and a compatible git HEAD. If validation fails, delegation does not silently fall back to a new session; the main agent must issue a normal delegate run instead. Claude, Codex, Devin, and Cursor backends support the resumable path. No new environment variables are required.

Claude and Codex follow-ups keep using the MCP server set captured for the initial resumable run. Cursor regenerates the isolated MCP config from the parent global config on each run.

`delegate-explore` covers not only code and repository documents but also web research via WebSearch / WebFetch and internal-knowledge research via MCP tools (Notion, Atlassian, etc.) configured in the runtime environment. All four backends use the parent user-scope MCP configuration by default: Claude/Devin inherit shared runtime settings, while resumable Claude, Codex, and Cursor wrappers extract the parent config and inject an isolated config into the worker. MCP tool execution quality still depends on each CLI. For Claude backends with bypass permissions enabled, the denylist approach (only the built-in file-editing tools `Edit` / `MultiEdit` / `Write` / `NotebookEdit` are denied) leaves WebSearch / WebFetch available; in managed-policy environments where bypass is disabled, tools beyond the pre-approved minimum may be rejected. The other backends depend on their own built-in web tools and sandbox settings. If a worker reports it cannot reach the web, the main agent re-delegates to a backend with working web access or handles the research itself. The worker is always limited to read-only MCP tools via a prompt-level constraint; delegate MCP-writing work to `delegate-chore` / `delegate-implement` instead. Fetched web/MCP content (including prompt-injection risk) stays isolated in the child process; only the worker's report returns to the main agent.

Each observe JSON records `mcp_config: {source, servers}`. `servers` lists wrapper-injected MCP server names for `injected`; `shared` uses natural inheritance that the wrapper does not own, so it records an empty list, and `none` also records an empty list. Server definitions and credentials are never written to observe JSON. Manage which MCP servers workers can see in the parent user-scope config. Injected config files may include token-bearing environment entries, so they stay under the run directory and are covered by `DELEGATE_RUN_RETENTION_DAYS` cleanup.

`delegate-imagegen` resolves a Codex model with the same env/default mechanism as the other delegates, but it remains a Codex-only capability bridge: `DELEGATE_IMAGEGEN_MODEL` selects the child model, `gpt*` routes to Codex, and non-`gpt*` fails closed instead of falling through to Claude.

`delegate-x-research` resolves `DELEGATE_X_RESEARCH_MODEL` with default `grok-build`, then launches the current X research backend, currently Grok CLI, to investigate x.com / X posts, accounts, threads, and reactions. It does not route through Claude or Codex.

## Skills

| skill                 | Purpose                                      | Tool permissions                 | Default model | env                                                                              |
| --------------------- | -------------------------------------------- | -------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `delegate-explore`    | Read-only code / doc / web / MCP exploration | read-only (web & MCP allowed)    | `haiku`       | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| `delegate-implement`  | Code implementation & edits (one commit)     | Edit/Write/Bash (no push)        | `sonnet`      | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| `delegate-chore`      | Fallback chores                              | Edit/Write/Bash (no push)        | `haiku`       | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| `delegate-review`     | Code/doc review (diff findings)              | read-only                        | `opus`        | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`   | Image generation/editing via Codex           | Codex subprocess                 | `gpt-5`       | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |
| `delegate-x-research` | x.com / X research                           | X research subprocess            | `grok-build`  | `DELEGATE_X_RESEARCH_MODEL` / `DELEGATE_WORK_DIR`                                |
| `delegate-htmldoc`    | HTML document generation (fixed template)    | output-dir writes only (no push) | `haiku`       | `DELEGATE_HTMLDOC_MODEL` / `DELEGATE_WORK_DIR`                                   |

Rationale for default models: explore / chore are read-centric and low-risk, so `haiku`; implement needs editing judgment, so `sonnet`; review's finding quality directly shapes the result and is judgment-heavy, so `opus`; htmldoc only fills content into a bundled fixed template, so `haiku`.

`delegate-imagegen` intentionally has no user-facing model prompt, but operators can set `DELEGATE_IMAGEGEN_MODEL`. If the user does not specify an output directory, generated files go under `delegate-imagegen-output/`.

`delegate-x-research` is a capability bridge for X research, so operators can set `DELEGATE_X_RESEARCH_MODEL` but the main agent should not ask users to pick a backend model.

`delegate-htmldoc` generates self-contained HTML documents by filling content into a fixed template bundled with the skill (`references/template.html` + `references/styleguide.md`), so the design stays identical across runs and models. The worker never generates or edits CSS. Chart and image assets are prepared by the parent (e.g. via dataviz-svg or `delegate-imagegen`) and passed by path: SVGs are inlined into the document, raster images are copied next to the output HTML and referenced relatively. If the user does not specify an output path, generated files go under `delegate-htmldoc-output/`.

## Environment variables

| Variable                                 | Default                                | Description                                                        |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `DELEGATE_<TYPE>_MODEL`                  | per skill                              | Per-type model override                                            |
| `DELEGATE_WORK_DIR`                      | mktemp default (`TMPDIR`, else `/tmp`) | Location for request/response files                                |
| `DELEGATE_RESPONSE_INLINE_MAX`           | `10240` bytes                          | Inline/stepwise threshold for `read-response.sh auto` / `decision` |
| `DELEGATE_RUN_CONTENT_MAX`               | `16384` bytes (`0` = unlimited)        | `content` cap in the one-shot `run.sh` JSON output                 |
| `DELEGATE_REQUEST_INLINE_MAX`            | `262144` bytes                         | Request-size gate for embedding the request into the worker prompt |
| `DELEGATE_METRICS_FILE`                  | unset                                  | Optional JSONL proxy-metric / timing telemetry output path         |
| `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL`    | `10` seconds                           | Worker observe JSON heartbeat interval                             |
| `DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS`  | `30` seconds                           | Bounded wait for the observe JSON symlink lock (error on timeout)  |
| `DELEGATE_CHILD_BASH_TIMEOUT_MS`         | `300000` ms (`0` = no injection)       | Bash tool timeout caps injected into Claude backend children       |
| `DELEGATE_CODEX_HOME_PRUNE`              | `1` (enabled, `0` = keep)              | Prune codex-home caches and the auth copy after successful runs    |
| `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` | `0` (disabled)                         | Kill a child after this many seconds without stream byte growth    |
| `DELEGATE_OBSERVE_STREAM_MAX_BYTES`      | `65536` bytes (`0` = unlimited)        | Max stdout/stderr content stored in observe JSON                   |
| `DELEGATE_RUN_RETENTION_DAYS`            | `0` (disabled)                         | Delete old per-run scratch directories during request preparation  |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR`           | `delegate-imagegen-output`             | Default output directory for `delegate-imagegen`                   |
| `DELEGATE_X_RESEARCH_MODEL`              | `grok-build`                           | Model for `delegate-x-research`                                    |

Model resolution order: `DELEGATE_<TYPE>_MODEL` → skill-specific default.

For reproducible local debugging and external watchdogs, set `DELEGATE_WORK_DIR=.temp/delegate/work` so request, response, observe JSON, and per-run scratch files stay under a repo-local ignored directory.
Set `DELEGATE_RUN_RETENTION_DAYS` to prune old per-run scratch directories in that work directory; request, response, and observe JSON files are kept for audit/debugging.
Worker token usage is recorded in observe JSON as `usage.measurement: "measured" | "estimated"` when a run ends. Claude stream-json, Codex JSON/session JSONL, Devin ATIF export, and Cursor stream-json can provide measured values; unsupported or unparsable backends fall back to a chars/4 estimate and emit a `usage_parse_failed` observe event. Estimated usage carries `estimation_basis: "protocol_payload_only"`: it counts only the request/response protocol payload and is a guaranteed lower bound of the worker's real consumption (context reads, tool round-trips, thinking are not included), so do not compare it against measured backends. The cursor backend launches the agent CLI with `--output-format stream-json` and parses the final result event's usage (measured since cursor-agent 2026.07.09); older CLIs that report no usage fall back to this estimate.

Alongside `usage`, each completed run records `timing` in observe JSON: `total_ms` (child wall time), `time_to_first_useful_event_ms` (launch to the first tool execution or content delta, detected at 1-second poll resolution), `report_ready_at_ms` (launch to response availability), plus stream-derived `model_turns` / `tool_calls` and a `measurement_source` (`claude_stream_json` / `codex_json` / `cursor_stream_json` / `devin_atif` / `grok_streaming_json` / `unavailable`). All time values are elapsed milliseconds from a monotonic clock, never wall-clock timestamps; values a backend's stream does not expose are `null`. The Grok wrapper currently runs with plain text output, so its runs record `measurement_source: "unavailable"` with null stream-derived fields; `grok_streaming_json` is a reserved value until the wrapper switches to streaming JSON. `structured_output_parse` records the structured-final-answer parse outcome (`true` / `false`) on Claude / Codex runs and stays `null` on report.md-mode backends.

When `DELEGATE_METRICS_FILE` is set, `prepare` and `read_response` records carry `duration_ms`, and dispatch completion appends a `dispatch` record (wall time, exit code, response presence, and a copy of the observe `timing` fields). `scripts/summarize-metrics.ts` aggregates p50/p95 per backend/model with nearest-rank percentiles: `null` values are excluded from the denominator with the exclusion count reported, and p95 is only reported at 20 or more samples (below that, p50 and counts only).

Documented model names for `DELEGATE_<TYPE>_MODEL`:

| Runtime          | Model names                                                                                                                                           | Notes                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Claude CLI       | `fable`, `opus`, `sonnet`, `haiku`                                                                                                                    | Aliases for Claude family models                                          |
| Codex CLI        | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex-spark`       | `delegate-imagegen` only accepts the `gpt*` / Codex branch                |
| Devin CLI        | `swe-1.7`, `swe-1.7-lightning`, `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`                                                   | `devin-*` strips the prefix before passing the model to Devin CLI         |
| Cursor agent CLI | `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code`, `cursor-glm-5.2-high`, `cursor-glm-5.2-max` | `cursor-*` strips the prefix before passing the model to Cursor agent CLI |

The list above is documented support, not a hard allowlist. The target CLI must also expose the requested model. `delegate-x-research` uses `DELEGATE_X_RESEARCH_MODEL` instead, with documented model `grok-build`.

Effort handling for those documented names:

Reasoning effort is declared opt-in by appending an `@<effort>` suffix to the model string, for example `DELEGATE_IMPLEMENT_MODEL=gpt-5.5@high`. Without `@`, delegate-skills keeps the previous behavior and does not add an effort flag to the target CLI argv.

Backend support for suffixes is explicit and fail-closed. Claude accepts `low`, `medium`, `high`, `xhigh`, and `max` and passes them as `--effort`. Codex accepts `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` and passes them as `-c model_reasoning_effort=<value>` (`max` / `ultra` verified against Codex CLI v0.144.1 with `gpt-5.6-sol`; older CLIs may reject them at runtime). Cursor support is model-specific: `cursor-glm-5.2@high|max` becomes `glm-5.2[reasoning=<value>]`, and `cursor-grok-4.5@low|medium|high` becomes `grok-4.5[effort=<value>]`. Devin, `delegate-imagegen`, and `delegate-x-research` do not support suffix effort declarations. Invalid values, unsupported backends, and Cursor double declarations such as a `-high` / `-max` slug plus `@...` stop before dispatch with exit 6 and a single stderr line listing the allowed values.

Observe JSON records `run.effort.requested` and `run.effort.effective` for completed wrapper runs. The effective value is measured only where run artifacts expose it: Codex resumable / follow-up runs (persisted session JSONL) and Cursor (model slug or post-run cli-config). Claude, Devin, Grok, and ephemeral Codex runs (normal runs and `delegate-imagegen`) record `not_exposed`, so a declared effort cannot be verified against the actual run there. Model fields keep the suffix-bearing model specifier; cost estimates strip the suffix for price lookup.

When no suffix is specified, the backend default behavior is:

| Model name(s)                                                                                            | Default effort behavior                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `fable`, `opus`, `sonnet`, `haiku`                                                                       | No explicit Claude `--effort`; the Claude CLI default for the alias applies.                                 |
| `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`                                                | No explicit Codex effort; if the installed Codex CLI accepts the model, its runtime default applies.         |
| `gpt-5`                                                                                                  | No explicit Codex effort; if the installed Codex CLI accepts the model, its runtime default applies.         |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`                                                                     | Codex catalog default is `medium`; supported explicit suffix levels are `low`, `medium`, `high`, `xhigh`.    |
| `gpt-5.4-nano`                                                                                           | No explicit Codex effort; if the installed Codex CLI accepts the model, its runtime default applies.         |
| `gpt-5.3-codex-spark`                                                                                    | No explicit Codex effort; Spark availability and defaults are determined by the installed Codex CLI/runtime. |
| `swe-1.7`, `swe-1.7-lightning`, `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`      | No separate Devin effort flag is passed; the Devin-side default for the selected model applies.              |
| `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code` | No Cursor effort override is passed; the Cursor model default applies.                                       |
| `cursor-glm-5.2-high`                                                                                    | Cursor receives `glm-5.2-high`; `high` is encoded in the model slug.                                         |
| `cursor-glm-5.2-max`                                                                                     | Cursor receives `glm-5.2-max`; `max` is encoded in the model slug.                                           |
| `grok-build` (`DELEGATE_X_RESEARCH_MODEL`)                                                               | No separate effort setting is passed; the X research backend default applies.                                |

## Model price reference

[`shared/model-token-prices.json`](shared/model-token-prices.json) contains a manually curated token price snapshot for supported delegate model families. `scripts/sync-shared.ts` bundles a copy into each skill directory. It is reference data for cost analysis and reporting only; delegate-skills does not use it as a cost gate.

When a backend reports measured tokens but no cost (e.g. Codex), the observe usage additionally carries `cost_usd_estimated` converted from this table, kept separate from the measured `cost_usd` field so downstream aggregation can tell the two apart. `cost_estimate_basis` records whether cached-input rates were applied, and the fields are omitted entirely when the table has no usable entry for the model.

![Model token prices](docs/assets/model-token-prices.svg)

Models with input prices at or below \$1 or output prices at or below \$5 per 1M tokens:

![Low-cost model token prices](docs/assets/model-token-prices-low-cost.svg)

## Architecture

See [docs/design/spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md#p:2).

## Development

See [docs/design/development.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fdevelopment.md).

## License

MIT
