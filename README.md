# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME.md)

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-lightgrey?style=for-the-badge)](./README_ja.md)

**A skill set for LLM agents that delegates implementation, exploration, review, and chores to a cheaper-model subagent — compressing token cost.**

## Overview

Delegate routine, mechanical work to a cheaper model without polluting the main agent's (expensive model) context. The delegation target **branches on the model name**:

- Claude family (`sonnet`/`haiku`/`opus`/`fable`) → **Claude subprocess** (`claude -p` via `delegate-claude.sh`)
- `gpt-*` → **Codex subprocess** (`codex exec` via `delegate-codex.sh`)

Both paths launch a child process via a shell wrapper, so the skills work uniformly regardless of whether the requester is Claude Code or Codex.

Hand-off between main and sub is file-based (request/response). Both files use the [md2idx](https://github.com/oubakiou/md2idx) format (`index` + `sections`) and are read incrementally to save tokens.

`delegate-imagegen` is the exception to the model-branching rule: it is a Codex-only capability bridge for image generation/editing, not a cheaper-model delegation path.

## Skills

| skill                | Purpose                                  | Tool permissions          | Default model | env                                                  |
| -------------------- | ---------------------------------------- | ------------------------- | ------------- | ---------------------------------------------------- |
| `delegate-explore`   | Read-only code & doc exploration         | read-only                 | `haiku`       | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`       |
| `delegate-implement` | Code implementation & edits (one commit) | Edit/Write/Bash (no push) | `sonnet`      | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`     |
| `delegate-chore`     | Fallback chores                          | Edit/Write/Bash (no push) | `haiku`       | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`         |
| `delegate-review`    | Code/doc review (diff findings)          | read-only                 | `opus`        | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`        |
| `delegate-imagegen`  | Image generation/editing via Codex       | Codex subprocess          | Codex default | `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |

Rationale for default models: explore / chore are read-centric and low-risk, so `haiku`; implement needs editing judgment, so `sonnet`; review's finding quality directly shapes the result and is judgment-heavy, so `opus`.

`delegate-imagegen` intentionally has no user-facing model selector. If the user does not specify an output directory, generated files go under `.temp/imagegen/`.

## Environment variables

| Variable                       | Default                                | Description                                           |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`        | per skill                              | Per-type model override                               |
| `DELEGATE_WORK_DIR`            | mktemp default (`TMPDIR`, else `/tmp`) | Location for request/response files                   |
| `DELEGATE_RESPONSE_INLINE_MAX` | `10240` bytes                          | Inline/stepwise threshold for `read-response.sh auto` |
| `DELEGATE_METRICS_FILE`        | unset                                  | Optional JSONL proxy-metric telemetry output path     |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR` | `.temp/imagegen`                       | Default output directory for `delegate-imagegen`      |

Model resolution order: `DELEGATE_<TYPE>_MODEL` → skill-specific default.

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
  │                  otherwise → <skill>/scripts/delegate-claude.sh launches a Claude subprocess (claude -p)
  └─ Read the response with <skill>/scripts/read-response.sh auto, then stepwise if large → verify
```

`delegate-imagegen` uses `<skill>/scripts/prepare-imagegen.sh` and `<skill>/scripts/delegate-imagegen-codex.sh` instead of `prepare.sh` model resolution and the Claude/Codex model branch.

The canonical copy of each shared script lives in `shared/`; `scripts/sync-shared.ts` copies it into every skill's `scripts/`.

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
  .claude/skills/<skill>/scripts/  # Claude Code gh skill install layout
  .agents/skills/<skill>/scripts/  # Codex gh skill install layout
  shared/                          # canonical shared scripts (type/runtime-agnostic)
    resolve-model.sh
    check-md2idx.sh
    check-delegate-chain.sh
    delegate-codex.sh
    delegate-claude.sh
    prepare.sh
    build-request.sh
    read-request.sh
    build-response.sh
    read-response.sh
  scripts/
    sync-shared.ts                 # shared/ → each skill's scripts/ (+ in-source test)
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

## Development

See [docs/design/development.md](docs/design/development.md) for the development workflow (setup, `vp` formatting/lint/test, the `shared/` sync pattern, and git hooks).

## License

MIT
