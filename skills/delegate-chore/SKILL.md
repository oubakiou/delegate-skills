---
name: delegate-chore
license: MIT
description: >
  explore / implement / git のどれにも明確に当てはまらない雑務を、最安のモデル(haiku)の subagent に
  委譲するフォールバックスキル。軽微な整形・リネーム・一括置換・定型コマンド実行などの雑用を、
  親エージェントの context を汚さず安く片付けたいときに使う。専用スキルが当てはまる場合はそちらを優先する。
allowed-tools: Bash(bash .claude/skills/delegate-chore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-chore

雑務のフォールバック先。task_type=`chore`、既定モデル `haiku`（最安）、Claude パスの subagent_type は `general-purpose`。

## 実行フロー

1. **前提条件チェック**: `bash .claude/skills/delegate-chore/scripts/check-md2idx.sh`（exit 3 なら中止）
2. **モデル解決**: `model="$(bash .claude/skills/delegate-chore/scripts/resolve-model.sh DELEGATE_CHORE_MODEL haiku)"`
3. **チェーン確認**: `task_type_chain="$(bash .claude/skills/delegate-chore/scripts/check-delegate-chain.sh chore "$PARENT_TASK_TYPE_CHAIN")"`（exit 4 なら中止）
4. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria の Markdown を `build-request.sh` に stdin で渡し、`request_file` / `response_file` のパスを得る（命名・md2idx 変換・envelope 付与・空 index の fail-fast を内包）:
   - `paths="$(printf '%s' "$req_md" | bash .claude/skills/delegate-chore/scripts/build-request.sh chore "$task_type_chain" "$REQUESTER_SESSION_ID")"`
   - `request_file="$(printf '%s' "$paths" | jq -r .request_file)"` / `response_file="$(printf '%s' "$paths" | jq -r .response_file)"`
5. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-chore/scripts/delegate-codex.sh "$model" chore "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。worker には `read-request.sh` で読み `build-response.sh <status> <sid> "$response_file"` で報告を書くよう指示
6. **レスポンス読み取り**: `bash .claude/skills/delegate-chore/scripts/read-response.sh "$response_file"`（status）→ `... "$response_file" index` →（検証コマンドを伴う場合のみ）Verification section

## skill 昇格提案（フィードバックループ）

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。レスポンス消費後、その作業が

- 繰り返し現れる / 明確にスコープされた再利用可能なカテゴリ

であれば、専用 `delegate-<name>` skill の新規作成を `AskUserQuestion` でユーザーに提案する（想定名 / 既定モデル / ツール権限 / 起動種別を添える）。合意後は skill-creator で雛形を作り本プロトコルに沿わせる。一度きりの些末な chore では提案しない。

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断を要さないと気づいたら、`AskUserQuestion` でスクリプト化 / git hook / npm script / CI など適切な自動化手段を提案する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない。

## 制約

- 編集は可。ただし **push はしない**（push・PR は delegate-git）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
