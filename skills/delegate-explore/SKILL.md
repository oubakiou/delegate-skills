---
name: delegate-explore
license: MIT
description: >
  コードベースおよびドキュメントの read-only な探索・読解を安価なモデルの subagent に委譲するスキル。
  「どこで定義/記載されているか」「どう動くか」「どこから参照されているか」などのコード調査に加え、
  仕様書・README・設計ドキュメント等の Markdown/テキストの内容確認・要約・該当箇所特定にも使う。
  親エージェントの context を汚さずに安く処理したいときに使う。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-explore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-explore

read-only の探索・読解を委譲する。コード（定義・参照・挙動の調査）とドキュメント（仕様書・README・設計資料等の内容確認・要約・該当箇所特定）の両方を対象とする。task_type=`explore`、既定モデル `haiku`、Claude パスの subagent_type は `Explore`。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-explore/scripts/check-md2idx.sh`（exit 3 なら中止しユーザーに通知）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-explore/scripts/resolve-model.sh DELEGATE_EXPLORE_MODEL haiku)"`
3. **チェーン確認**: 親チェーン（無ければ `[]`）に対し `task_type_chain="$(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh explore "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria の Markdown を `build-request.sh` に stdin で渡し、`request_file` / `response_file` のパスを得る（命名・md2idx 変換・envelope 付与・空 index の fail-fast を内包）:
   - `paths="$(printf '%s' "$req_md" | bash .claude/skills/delegate-explore/scripts/build-request.sh explore "$task_type_chain" "$REQUESTER_SESSION_ID")"`
   - `request_file="$(printf '%s' "$paths" | jq -r .request_file)"` / `response_file="$(printf '%s' "$paths" | jq -r .response_file)"`
5. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-explore/scripts/delegate-codex.sh "$model" explore "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: Explore` / `model: $model` で起動。worker には `read-request.sh`（`index` → 必要 section）で読み、`build-response.sh <status> <sid> "$response_file"` で報告を書くよう protocol v1 とあわせて指示
6. **レスポンス読み取り**: `bash .claude/skills/delegate-explore/scripts/read-response.sh "$response_file"`（status）→ 同 `... "$response_file" index` → 必要 section（`... "$response_file" <N>`）

## 制約

- read-only。ファイル編集・push はしない
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
