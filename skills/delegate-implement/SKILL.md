---
name: delegate-implement
license: MIT
description: >
  コードの実装・修正を安価なモデルの subagent に委譲するスキル。
  ファイル編集を伴う実装タスク（機能追加・バグ修正・リファクタ等）を、親エージェントの context を
  汚さずに処理したいときに使う。子は Edit/Write/Bash で実作業し、結果はファイル経由で受け取る。
  read-only の調査は delegate-explore、git/PR 操作は delegate-git を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-implement/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/delegate-codex.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(vp:*), Read
---

# delegate-implement

コード実装を委譲する。task_type=`implement`、既定モデル `sonnet`（編集の判断を要するため）、Claude パスの subagent_type は `general-purpose`。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-implement/scripts/check-md2idx.sh`（exit 3 なら中止）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-implement/scripts/resolve-model.sh DELEGATE_IMPLEMENT_MODEL sonnet)"`
3. **チェーン確認**: `task_type_chain="$(bash .claude/skills/delegate-implement/scripts/check-delegate-chain.sh implement "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **ファイル事前確保**: protocol v1 の命名で `request_file` / `response_file` を mktemp
5. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を `npx md2idx` で JSON 化し `task_type_chain` 等を前置して `request_file` に書く。Verification には worker が自ら実行すべき検証コマンド（`vp check` / テスト）を記し、その結果を報告 Markdown の Verification section（実行コマンドと exit code を含む）に収めるよう指示する
6. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-implement/scripts/delegate-codex.sh "$model" implement "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動
7. **レスポンス読み取り**: `jq -r .status` → `jq -r .index` → 必要時 Verification / Summary section のみ
8. **検証フェーズ（必須）**: `status` を先に読み、必要時のみ Verification section を引く。決定論的検証（`vp check` の lint/型・テスト）の exit code は信頼し、意味的・受け入れ基準は Summary を中心に確認する。`status` が `completed` でない時や pass 申告の裏取りが要るときのみ main 側で `vp check` / `git diff` を再実行する

## 制約

- 編集は可。ただし **push はしない**（push・PR は delegate-git）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
