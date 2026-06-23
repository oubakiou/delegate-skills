---
name: delegate-git
license: MIT
description: >
  git 操作と gh コマンドを安価なモデルの subagent に委譲するスキル。
  commit / branch / push / PR 作成（gh pr create 等）などのバージョン管理・GitHub 操作を、
  親エージェントの context を汚さずに処理したいときに使う。判断は main が持ち単純な git/gh 操作のみを
  委譲する前提のため既定モデルは haiku。コード実装は delegate-implement、調査は delegate-explore を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-git/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-git/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-git/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-git/scripts/delegate-codex.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-git

git + gh 操作を委譲する。task_type=`git`、既定モデル `haiku`（判断は main が持ち単純操作のみを委譲する前提のため）。Claude パスの subagent_type は `general-purpose`。git/gh への限定はツール権限ではなくプロンプト制約で担保する（Codex パスと同様）。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-git/scripts/check-md2idx.sh`（exit 3 なら中止）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-git/scripts/resolve-model.sh DELEGATE_GIT_MODEL haiku)"`
3. **チェーン確認**: `task_type_chain="$(bash .claude/skills/delegate-git/scripts/check-delegate-chain.sh git "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **ファイル事前確保**: protocol v1 の命名で `request_file` / `response_file` を mktemp
5. **リクエスト作成**: Objective / Scope / Context / Constraints の Markdown を `npx md2idx` で JSON 化し `task_type_chain` 等を前置して `request_file` に書く
6. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-git/scripts/delegate-codex.sh "$model" git "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。下記「制約」を prompt に明記して git/gh 限定を守らせる
7. **レスポンス読み取り**: `jq -r .status` → `jq -r .index` → 必要時 Verification section のみ
8. **検証フェーズ（必須）**: Verification section の git/gh コマンドと exit code を読み、`git log` / `git diff` / 作成された PR を確認する

## 制約

- git 操作と gh コマンドのみを行う。それ以外のファイル編集（Edit/Write）はしない。push・PR 作成は可
- 検証フェーズで意図しないファイル変更が無いか `git diff` で必ず確認する（ツールレベルでは縛らないため）
- force push / branch 削除 / PR merge など破壊的・取り消し困難な操作はリクエストに明記がない限り行わない
- AGENTS.md / CLAUDE.md の commit / PR 規約に従う
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
