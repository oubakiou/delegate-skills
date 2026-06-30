# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME.md)

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-lightgrey?style=for-the-badge)](./README_ja.md)

**A skill set for LLM agents that delegates implementation, exploration, review, and chores to a cheaper-model subagent — compressing token cost.**

## Overview

Delegate routine, mechanical work to a cheaper model without polluting the main agent's (expensive model) context. The delegation target **branches on the model name**:

- Claude family (`sonnet`/`haiku`/`opus`/`fable`) → **Claude subprocess** (`claude -p` via `delegate-claude.sh`)
- `gpt-*` → **Codex subprocess** (`codex exec` via `delegate-codex.sh`)
- `swe-*` / `devin-*` → **Devin CLI subprocess** (`devin -p` via `delegate-devin.sh`). `devin-*` is a backend-pinning prefix for non-Cognition models available through Devin CLI (e.g. `devin-glm-5.2` → `glm-5.2`); `swe-*` is passed through as-is.

All three paths launch a child process via a shell wrapper, so the skills work uniformly regardless of whether the requester is Claude Code, Codex, or Devin CLI.

Hand-off between main and sub is file-based (request/response). Both files use the [md2idx](https://github.com/oubakiou/md2idx) format (`index` + `sections`) and are read incrementally to save tokens.

When delegating, use the dedicated skill for the task type (`delegate-explore`, `delegate-implement`, `delegate-review`, `delegate-chore`, `delegate-imagegen`, `delegate-x-research`) rather than bypassing into a generic subagent.

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

| Variable                       | Default                                | Description                                           |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`        | per skill                              | Per-type model override                               |
| `DELEGATE_WORK_DIR`            | mktemp default (`TMPDIR`, else `/tmp`) | Location for request/response files                   |
| `DELEGATE_RESPONSE_INLINE_MAX` | `10240` bytes                          | Inline/stepwise threshold for `read-response.sh auto` |
| `DELEGATE_METRICS_FILE`        | unset                                  | Optional JSONL proxy-metric telemetry output path     |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR` | `delegate-imagegen-output`             | Default output directory for `delegate-imagegen`      |
| `DELEGATE_X_RESEARCH_MODEL`    | `grok-build`                           | Model for `delegate-x-research`                       |

Model resolution order: `DELEGATE_<TYPE>_MODEL` → skill-specific default.

## Model price reference

[`shared/model-token-prices.json`](shared/model-token-prices.json) contains a manually curated token price snapshot for supported delegate model families. `scripts/sync-shared.ts` bundles a copy into each skill directory. It is reference data for cost analysis and reporting only; delegate-skills does not use it as a cost gate.

## Architecture

Each skill bundles its own copy of the shared scripts (self-contained). `gh skill install` places them under `.claude/skills/<skill>/scripts/...` for Claude Code and under the same relative layout at `.agents/skills/<skill>/scripts/...` for Codex.

```
main agent
  ├─ <skill>/scripts/prepare.sh              Precondition check → model resolution → chain check → request generation
  │   ├─ check-md2idx.sh                     Precondition check (npx md2idx, fail-closed)
  │   ├─ resolve-model.sh                    Model resolution (type env → default)
  │   ├─ check-delegate-chain.sh             Recursion guard for multi-hop delegation (same type twice forbidden → exit 4)
  │   └─ build-request.sh                    Create request_file / response_file with mktemp (sharing ts + random token)
  ├─ model is gpt* → <skill>/scripts/delegate-codex.sh launches a Codex subprocess
  │  model is swe*|devin-* → <skill>/scripts/delegate-devin.sh launches a Devin CLI subprocess
  │                  otherwise → <skill>/scripts/delegate-claude.sh launches a Claude subprocess (claude -p)
  └─ Read the response with <skill>/scripts/read-response.sh auto, then stepwise if large → verify
```

`delegate-imagegen` uses `<skill>/scripts/prepare-imagegen.sh` and `<skill>/scripts/delegate-imagegen-codex.sh` to preserve image-output defaults. `prepare-imagegen.sh` still resolves `DELEGATE_IMAGEGEN_MODEL` and returns `model`, but imagegen only accepts the `gpt*`/Codex branch.

`delegate-x-research` uses the shared `prepare.sh` and `<skill>/scripts/delegate-x-research-grok.sh`; the current wrapper calls `grok -p -m "$model"` and writes the worker report through the same response protocol.

The canonical copy of each shared script/asset lives in `shared/`; `scripts/sync-shared.ts` copies it into every skill.

See [docs/design/protocol-v1.md](docs/design/protocol-v1.md) for the protocol details.

## Directory layout

```
delegate-skills/
  fixtures/
    metrics/                        # fixed telemetry scenarios and baseline
      baseline.json
      scriptable-chore/{request.md,response.md}
      read-heavy-chore/{request.md,response.md}
      mixed-chore/{request.md,response.md}
  skills/                          # gh skill install source (canonical SKILL.md)
    delegate-explore/
      SKILL.md
      scripts/                     # copied from shared/ by sync-shared.ts
    delegate-implement/{SKILL.md, scripts/}
    delegate-chore/{SKILL.md, scripts/}
    delegate-review/{SKILL.md, scripts/}
    delegate-imagegen/{SKILL.md, scripts/}
    delegate-x-research/{SKILL.md, scripts/}
  .claude/skills/<skill>/scripts/  # Claude Code gh skill install layout
  .agents/skills/<skill>/scripts/  # Codex gh skill install layout
  shared/                          # canonical shared scripts/assets (type/runtime-agnostic)
    model-token-prices.json
    resolve-model.sh
    check-md2idx.sh
    check-delegate-chain.sh
    delegate-codex.sh
    delegate-claude.sh
    delegate-devin.sh
    prepare.sh
    build-request.sh
    read-request.sh
    build-response.sh
    read-response.sh
  scripts/
    sync-shared.ts                 # shared/ → each skill (+ in-source test)
    summarize-metrics.ts           # summarize telemetry JSONL
    run-metrics-fixtures.sh        # run fixed metrics fixtures
    check-metrics-baseline.sh      # detect fixture baseline drift
  docs/
    design/
      spec.md
      protocol-v1.md
  README.md
```

## Prerequisites

- Node.js and `md2idx` (`npx md2idx` must be runnable; a global install via `npm install -g md2idx` is recommended since every skill uses it heavily)
- `jq`
- When using Claude family models: the `claude` CLI (logged in)
- When using `gpt-*`: the `codex` CLI (logged in)
- When using `swe-*` / `devin-*`: the `devin` CLI (logged in)
- When using `delegate-x-research` with the current backend: the `grok` CLI (logged in, with access to X research)

## Development

See [docs/design/development.md](docs/design/development.md) for the development workflow (setup, `vp` formatting/lint/test, the `shared/` sync pattern, and git hooks).

## License

MIT
