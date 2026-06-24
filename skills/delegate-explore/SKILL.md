---
name: delegate-explore
license: MIT
description: >
  コードベースおよびドキュメントの read-only な探索・読解を安価なモデルの subagent に委譲するスキル。
  「どこで定義/記載されているか」「どう動くか」「どこから参照されているか」などのコード調査に加え、
  仕様書・README・設計ドキュメント等の Markdown/テキストの内容確認・要約・該当箇所特定にも使う。
  親エージェントの context を汚さずに安く処理したいときに使う。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-explore/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-explore

read-only の探索・読解を委譲する。コード（定義・参照・挙動の調査）とドキュメント（仕様書・README・設計資料等の内容確認・要約・該当箇所特定）の両方を対象とする。task_type=`explore`、既定モデル `haiku`、Claude パスの subagent_type は `Explore`。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-explore`
- Codex: `skill_dir=.agents/skills/delegate-explore`

以降のコマンド例は Claude Code の `.claude/skills/delegate-explore` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-explore` に読み替える。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria の Markdown を stdin で渡す。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-explore/scripts/prepare.sh explore DELEGATE_EXPLORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-explore/scripts/delegate-codex.sh "$model" explore "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: Explore` / `model: $model` で起動。worker には `read-request.sh "$request_file" all` で指示全文を読み、`build-response.sh <status> <sid> "$response_file"` で報告を書くよう protocol v1 とあわせて指示
3. **レスポンス読み取り**: `bash .claude/skills/delegate-explore/scripts/read-response.sh "$response_file" auto`。大きい response の場合のみ `... "$response_file" index` → 必要 section（`... "$response_file" <N>`）の段階読みに切り替える。

## 制約

- read-only。ファイル編集・push はしない
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
