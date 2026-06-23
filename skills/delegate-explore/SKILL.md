---
name: delegate-explore
license: MIT
description: >
  コードベースおよびドキュメントの read-only な探索・読解を安価なモデルの subagent に委譲するスキル。
  「どこで定義/記載されているか」「どう動くか」「どこから参照されているか」などのコード調査に加え、
  仕様書・README・設計ドキュメント等の Markdown/テキストの内容確認・要約・該当箇所特定にも使う。
  親エージェントの context を汚さずに安く処理したいときに使う。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-explore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-codex.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-explore

read-only の探索・読解を委譲する。コード（定義・参照・挙動の調査）とドキュメント（仕様書・README・設計資料等の内容確認・要約・該当箇所特定）の両方を対象とする。task_type=`explore`、既定モデル `haiku`、Claude パスの subagent_type は `Explore`。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-explore/scripts/check-md2idx.sh`（exit 3 なら中止しユーザーに通知）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-explore/scripts/resolve-model.sh DELEGATE_EXPLORE_MODEL haiku)"`
3. **チェーン確認**: 親チェーン（無ければ `[]`）に対し `task_type_chain="$(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh explore "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **ファイル事前確保**: protocol v1 の命名で `request_file` / `response_file` を mktemp
5. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria の Markdown を `npx md2idx` で JSON 化し `task_type_chain` 等を前置して `request_file` に書く
6. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-explore/scripts/delegate-codex.sh "$model" explore "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: Explore` / `model: $model` で起動。prompt で request_file / response_file / protocol v1 を指示
7. **レスポンス読み取り**: `jq -r .status` → `jq -r .index` → 必要 section のみ

## 制約

- read-only。ファイル編集・push はしない
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
