---
name: delegate-git
license: MIT
description: >
  git 操作と gh コマンドを安価なモデルの subagent に委譲するスキル。
  commit / branch / push / PR 作成（gh pr create 等）などのバージョン管理・GitHub 操作を、
  親エージェントの context を汚さずに処理したいときに使う。判断は main が持ち単純な git/gh 操作のみを
  委譲する前提のため既定モデルは haiku。コード実装は delegate-implement、調査は delegate-explore を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-git/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-git/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-git/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-git/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-git/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-git/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-git/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-git/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-git/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-git

git + gh 操作を委譲する。task_type=`git`、既定モデル `haiku`（判断は main が持ち単純操作のみを委譲する前提のため）。Claude パスの subagent_type は `general-purpose`。git/gh への限定はツール権限ではなくプロンプト制約で担保する（Codex パスと同様）。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-git`
- Codex: `skill_dir=.agents/skills/delegate-git`

以降のコマンド例は Claude Code の `.claude/skills/delegate-git` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-git` に読み替える。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Constraints の Markdown を stdin で渡す。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-git/scripts/prepare.sh git DELEGATE_GIT_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-git/scripts/delegate-codex.sh "$model" git "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。下記「制約」を prompt に明記して git/gh 限定を守らせ、worker には `read-request.sh "$request_file" all` で指示全文を読み `build-response.sh <status> <sid> "$response_file"` で報告を書くよう指示
3. **レスポンス読み取り**: `bash .claude/skills/delegate-git/scripts/read-response.sh "$response_file" auto`。大きい response の場合のみ `... "$response_file" index` → 必要時 Verification section（`... "$response_file" <N>`）の段階読みに切り替える。
4. **検証フェーズ（必須）**: Verification section の git/gh コマンドと exit code を読み、`git log` / `git diff` / 作成された PR を確認する

## 制約

- git 操作と gh コマンドのみを行う。それ以外のファイル編集（Edit/Write）はしない。push・PR 作成は可
- 検証フェーズで意図しないファイル変更が無いか `git diff` で必ず確認する（ツールレベルでは縛らないため）
- force push / branch 削除 / PR merge など破壊的・取り消し困難な操作はリクエストに明記がない限り行わない
- AGENTS.md / CLAUDE.md の commit / PR 規約に従う
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
