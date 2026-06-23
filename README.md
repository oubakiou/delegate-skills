# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME.md)

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-lightgrey?style=for-the-badge)](./README_ja.md)

**A skill set for LLM agents that delegates implementation, exploration, git operations, review, and chores to a cheaper-model subagent — compressing token cost.**

## Overview

Delegate routine, mechanical work to a cheaper model without polluting the main agent's (expensive model) context. The delegation target **branches on the model name**:

- Claude family (`sonnet`/`haiku`/`opus`/`fable`) → in-session **Agent tool**
- `gpt-*` → **Codex subprocess** (`codex exec`)

Hand-off between main and sub is file-based (request/response). Both files use the [md2idx](https://github.com/oubakiou/md2idx) format (`index` + `sections`) and are read incrementally to save tokens.

## Skills

| skill                | Purpose                                  | subagent_type   | Tool permissions                   | Default model | env                                              |
| -------------------- | ---------------------------------------- | --------------- | ---------------------------------- | ------------- | ------------------------------------------------ |
| `delegate-explore`   | Read-only code & doc exploration         | Explore         | read-only                          | `haiku`       | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`   |
| `delegate-implement` | Code implementation & edits (one commit) | general-purpose | Edit/Write/Bash (no push)          | `sonnet`      | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR` |
| `delegate-git`       | git + gh operations (push/PR allowed)    | general-purpose | git/gh-only via prompt constraints | `haiku`       | `DELEGATE_GIT_MODEL` / `DELEGATE_WORK_DIR`       |
| `delegate-chore`     | Fallback chores                          | general-purpose | Edit/Write/Bash (no push)          | `haiku`       | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`     |
| `delegate-review`    | Code review (diff findings)              | general-purpose | read-only                          | `opus`        | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`    |

Rationale for default models: explore / chore are read-centric and low-risk, so `haiku`; git involves hard-to-undo operations but the subagent makes no judgment calls — main delegates only simple operations with explicit instructions — so `haiku`; implement needs editing judgment, so `sonnet`; review's finding quality directly shapes the result and is judgment-heavy, so `opus`.

## Environment variables

| Variable                | Default                                | Description                         |
| ----------------------- | -------------------------------------- | ----------------------------------- |
| `DELEGATE_<TYPE>_MODEL` | per skill                              | Per-type model override             |
| `DELEGATE_WORK_DIR`     | mktemp default (`TMPDIR`, else `/tmp`) | Location for request/response files |

Model resolution order: `DELEGATE_<TYPE>_MODEL` → skill-specific default.

## Architecture

Each skill bundles its own copy of the shared scripts (self-contained), invoked at the skill-local path `.claude/skills/<skill>/scripts/...`:

```
main agent
  ├─ <skill>/scripts/check-md2idx.sh         Precondition check (npx md2idx, fail-closed)
  ├─ <skill>/scripts/resolve-model.sh        Model resolution (type env → default)
  ├─ <skill>/scripts/check-delegate-chain.sh Recursion guard for multi-hop delegation (same type twice forbidden → exit 4)
  ├─ Pre-allocate request_file / response_file with mktemp (sharing ts + random token)
  ├─ model is gpt* → <skill>/scripts/delegate-codex.sh launches a Codex subprocess
  │                  otherwise → Agent tool (subagent_type per skill)
  └─ Read the response incrementally with jq: status → index → needed sections → verify
```

The canonical copy of each shared script lives in `shared/`; `scripts/sync-shared.ts` copies it into every skill's `scripts/`.

See [docs/design/protocol-v1.md](docs/design/protocol-v1.md) for the protocol details.

## Directory layout

```
delegate-skills/
  skills/                          # gh skill install source (canonical SKILL.md)
    delegate-explore/
      SKILL.md
      scripts/                     # copied from shared/ by sync-shared.ts
    delegate-implement/{SKILL.md, scripts/}
    delegate-git/{SKILL.md, scripts/}
    delegate-chore/{SKILL.md, scripts/}
    delegate-review/{SKILL.md, scripts/}
  shared/                          # canonical shared scripts (type/runtime-agnostic)
    resolve-model.sh
    check-md2idx.sh
    check-delegate-chain.sh
    delegate-codex.sh
  scripts/
    sync-shared.ts                 # shared/ → each skill's scripts/ (+ in-source test)
  docs/
    design/
      spec.md
      protocol-v1.md
  README.md
```

## Prerequisites

- Node.js and `md2idx` (`npx md2idx` must be runnable; a global install via `npm install -g md2idx` is recommended since every skill uses it heavily)
- `jq`
- When using `gpt-*`: the `codex` CLI (logged in)

## Development

See [docs/design/development.md](docs/design/development.md) for the development workflow (setup, `vp` formatting/lint/test, the `shared/` sync pattern, and git hooks).

## License

MIT
