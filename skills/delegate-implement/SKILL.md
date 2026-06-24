---
name: delegate-implement
license: MIT
description: >
  コードの実装・修正を安価なモデルの subagent に委譲するスキル。
  ファイル編集を伴う実装タスク（機能追加・バグ修正・リファクタ等）を、親エージェントの context を
  汚さずに処理したいときに使う。子は Edit/Write/Bash で実作業し、結果はファイル経由で受け取る。
  read-only の調査は delegate-explore、git/PR 操作は親エージェントが直接扱うこと。
allowed-tools: Bash(bash .claude/skills/delegate-implement/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(vp:*), Read
---

# delegate-implement

コード実装を委譲する。task_type=`implement`、既定モデル `sonnet`（編集の判断を要するため）、Claude パスの subagent_type は `general-purpose`。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-implement`
- Codex: `skill_dir=.agents/skills/delegate-implement`

以降のコマンド例は Claude Code の `.claude/skills/delegate-implement` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-implement` に読み替える。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。Verification には worker が自ら実行すべき検証コマンド（`vp check` / テスト）を記し、その結果を報告 Markdown の Verification section（実行コマンドと exit code を含む）に収めるよう指示する。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/prepare.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-implement/scripts/delegate-codex.sh "$model" implement "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。worker には `read-request.sh "$request_file" all` で指示全文を読み、`build-response.sh <status> <sid> "$response_file"` で報告を書くよう指示
3. **レスポンス読み取り**: `bash .claude/skills/delegate-implement/scripts/read-response.sh "$response_file" auto`。大きい response の場合のみ `... "$response_file" index` → Verification / Summary section（`... "$response_file" <N>`）の段階読みに切り替える。
4. **検証フェーズ（必須）**: `status` を先に確認し、必要時のみ Verification section を引く。決定論的検証（`vp check` の lint/型・テスト）の exit code は信頼し、意味的・受け入れ基準は Summary を中心に確認する。`status` が `completed` でない時や pass 申告の裏取りが要るときのみ main 側で `vp check` / `git diff` を再実行する

## 制約

- 編集は可。ただし **push はしない**（push・PR は親エージェントが直接扱う）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
