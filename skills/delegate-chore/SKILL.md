---
name: delegate-chore
license: MIT
description: >
  token cost の削減を第一目標として、explore / implement / review のどれにも明確に当てはまらない雑務のうち、
  対象 content を読んで判断する必要があり、
  親エージェントの context を膨らませたくない作業を安価な subagent に委譲するフォールバックスキル。
  単一コマンドで処理できる軽微な整形・リネーム・一括置換・定型コマンド実行は原則として main が直接実行し、
  この skill は使わない。専用スキルが当てはまる場合はそちらを優先する。
  chore の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-chore/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-response.sh:*), Bash(jq:*), Read
---

# delegate-chore

雑務のフォールバック先。task_type=`chore`、既定モデル `haiku`（最安）。実行系分岐（Codex / Devin / Cursor / Claude）は `dispatch.sh` が行う。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-chore`
- Codex: `skill_dir=.agents/skills/delegate-chore`

以降のコマンド例は Claude Code の `.claude/skills/delegate-chore` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-chore` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

委譲はオーバーヘッド（worker 起動・request/response の往復・main 側の読み取り）を伴う。**この chore が単一コマンド（`sed` / `find` / `chmod` / `jq` 等）でスクリプト化でき、対象内容をモデル context に載せずに済むなら、委譲は純損**になりやすい（オーバーヘッドが context 衛生・トークン両面の利得を上回る）。その場合は委譲せず main が直接実行するか、繰り返すなら下記フィードバックループの自動化提案へ回す。委譲が見合うのは、content をモデルが読み込んで処理する必要がある嵩んだ作業。根拠は [docs/design/delegate-chore.md §5](../../docs/design/delegate-chore.md)。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む（個別呼び出しの bash 往復と main context への出力を削減）。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。request は terse に書く: Context にファイル内容を貼らず、パス（必要なら行範囲）で参照させる（main の出力＝課金トークンを増やさないため）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-chore/scripts/prepare.sh chore DELEGATE_CHORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"` / `run_dir="$(printf '%s' "$out" | jq -r .run_dir)"` / `observe_file="$(printf '%s' "$out" | jq -r .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-chore/scripts/dispatch.sh "$model" chore "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを `jq` で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で jq では null 相当）なので、usage を集計する場合は分母から除外する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-chore/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。

## セッション再利用（resumable / follow-up）

既定は通常 run。大きめの横断修正など、親レビューで差し戻す可能性が高い場合だけ初回から resumable initial run を明示する。過剰使用しない。

- resumable initial run: `prepare.sh` の第 6 引数に `resumable` を渡す。dispatch は第 7 引数に `resumable`、第 8・9 引数に空文字を渡す。
  - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-chore/scripts/prepare.sh chore DELEGATE_CHORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID" resumable)"`
  - `session_mode="$(printf '%s' "$out" | jq -r .session_mode)"` / `lineage_id="$(printf '%s' "$out" | jq -r .lineage_id)"`
  - `bash .claude/skills/delegate-chore/scripts/dispatch.sh "$model" chore "$request_file" "$response_file" "$run_dir" "$observe_file" "$session_mode" "" ""`
  - response 読了後に `jq -r .backend_session.persistence "$observe_file"` を確認する。`resumable` 以外なら follow-up 不可としてその場で判断し、後から暗黙 fallback を期待しない。
- follow-up run: 親の差分確認で不具合が見つかった場合のみ使う。`prepare.sh` の第 6 引数に `followup=<前回observe_file>` を渡す。exit 5 は検証失敗なので中止し、通常 delegate として出し直す。暗黙 fallback しない。
  - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-chore/scripts/prepare.sh chore DELEGATE_CHORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID" "followup=$previous_observe_file")"`
  - `session_mode="$(printf '%s' "$out" | jq -r .session_mode)"` / `resume_id="$(printf '%s' "$out" | jq -r .resume_id)"` / `backend_session_home="$(printf '%s' "$out" | jq -r .backend_session_home)"`
  - `bash .claude/skills/delegate-chore/scripts/dispatch.sh "$model" chore "$request_file" "$response_file" "$run_dir" "$observe_file" "$session_mode" "$resume_id" "$backend_session_home"`
  - follow-up request には、親が見つけた不具合、最新 `git diff` の見るべき範囲、前回 `response_file` の参照を必ず含める。worker の古い会話文脈だけに依存させない。

## skill 昇格提案（フィードバックループ）

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。レスポンス消費後、その作業が

- 繰り返し現れる / 明確にスコープされた再利用可能なカテゴリ

であれば、専用 `delegate-<name>` skill の新規作成を `AskUserQuestion` でユーザーに提案する（想定名 / 既定モデル / ツール権限 / 起動種別を添える）。合意後は skill-creator で雛形を作り本プロトコルに沿わせる。一度きりの些末な chore では提案しない。

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断を要さないと気づいたら、`AskUserQuestion` でスクリプト化 / git hook / npm script / CI など適切な自動化手段を提案する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない。

## 制約

- 編集は可。ただし **push はしない**（push・PR は親エージェントが直接扱う）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
