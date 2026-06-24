---
name: delegate-review
license: MIT
description: >
  コードレビュー（差分の指摘出し）を判断比重の高いモデルの subagent に委譲するスキル。
  変更差分のバグ・設計・規約逸脱などの指摘を、親エージェントの context を汚さずに
  処理したいときに使う。read-only で編集や git の書き込み操作はしない。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-review/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-review/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-review/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-review/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-review/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Read
---

# delegate-review

差分のコードレビューを委譲する。task_type=`review`、既定モデル `opus`（指摘品質が成果物に直結し判断比重が高いため）、Claude パスの subagent_type は `general-purpose`（read-only）。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-review`
- Codex: `skill_dir=.agents/skills/delegate-review`

以降のコマンド例は Claude Code の `.claude/skills/delegate-review` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-review` に読み替える。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Constraints の Markdown を stdin で渡す。レビュー対象の差分範囲（base/head・対象パス等）を Scope に明記する。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-review/scripts/prepare.sh review DELEGATE_REVIEW_MODEL opus "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-review/scripts/delegate-codex.sh "$model" review "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。下記「制約」を prompt に明記して read-only を守らせ、worker には `read-request.sh "$request_file" all` で指示全文を読み `build-response.sh <status> <sid> "$response_file"` で報告を書くよう指示
3. **レスポンス読み取り**: `bash .claude/skills/delegate-review/scripts/read-response.sh "$response_file" auto`。大きい response の場合のみ `... "$response_file" index` → Findings section（`... "$response_file" <N>`）の段階読みに切り替える。

## 制約

- read-only。ファイル編集・git の書き込み操作・push はしない（差分を読んで指摘を報告するだけ）
- 指摘は報告 Markdown の Findings section に収める
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
