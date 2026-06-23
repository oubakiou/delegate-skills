---
name: delegate-review
license: MIT
description: >
  コードレビュー（差分の指摘出し）を判断比重の高いモデルの subagent に委譲するスキル。
  変更差分のバグ・設計・規約逸脱などの指摘を、親エージェントの context を汚さずに
  処理したいときに使う。read-only で編集や git の書き込み操作はしない。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-review/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-review/scripts/delegate-codex.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Read
---

# delegate-review

差分のコードレビューを委譲する。task_type=`review`、既定モデル `opus`（指摘品質が成果物に直結し判断比重が高いため）、Claude パスの subagent_type は `general-purpose`（read-only）。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-review/scripts/check-md2idx.sh`（exit 3 なら中止しユーザーに通知）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-review/scripts/resolve-model.sh DELEGATE_REVIEW_MODEL opus)"`
3. **チェーン確認**: 親チェーン（無ければ `[]`）に対し `task_type_chain="$(bash .claude/skills/delegate-review/scripts/check-delegate-chain.sh review "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **ファイル事前確保**: protocol v1 の命名で `request_file` / `response_file` を mktemp
5. **リクエスト作成**: Objective / Scope / Context / Constraints の Markdown を `npx md2idx` で JSON 化し `task_type_chain` 等を前置して `request_file` に書く。レビュー対象の差分範囲（base/head・対象パス等）を Scope に明記する
6. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-review/scripts/delegate-codex.sh "$model" review "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。下記「制約」を prompt に明記して read-only を守らせる
7. **レスポンス読み取り**: `jq -r .status` → `jq -r .index` → Findings section のみ

## 制約

- read-only。ファイル編集・git の書き込み操作・push はしない（差分を読んで指摘を報告するだけ）
- 指摘は報告 Markdown の Findings section に収める
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
