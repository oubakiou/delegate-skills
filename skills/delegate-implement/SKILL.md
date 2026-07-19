---
name: delegate-implement
license: MIT
description: >
  token cost の削減を第一目標として、コードの実装・修正を安価なモデルの subagent に委譲するスキル。
  複数ファイルまたは既存パターン調査を伴う実装タスク（機能追加・バグ修正・リファクタ等）を、
  親エージェントの context を汚さずに処理したいときに使う。単一ファイルの小変更、明確な一括置換、
  main が既に読んだ箇所の数行修正、設計判断が未確定な実装には使わない。
  read-only の調査は delegate-explore、git/PR 操作は親エージェントが直接扱うこと。
  implement の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-implement/scripts/run.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-response.sh:*), Bash(jq:*), Bash(vp:*), Read
---

# delegate-implement

コード実装を委譲する。task_type=`implement`、既定モデル `sonnet`（編集の判断を要するため）。実行系分岐（Codex / Devin / Cursor / Claude）は `dispatch.sh` が行う。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-implement`
- Codex: `skill_dir=.agents/skills/delegate-implement`

以降のコマンド例は Claude Code の `.claude/skills/delegate-implement` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-implement` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

implement は、調査・編集・検証を worker にまとめて任せる価値がある規模の実装に使う。複数ファイルにまたがる変更、既存パターン調査を伴う変更、worker が検証コマンドまで実行でき、main が `git diff` / Verification / Summary の確認に集中できる変更を発火条件にする。一方、単一ファイルの小変更、明確な一括置換、main が既に読んだ箇所の数行修正、設計判断が未確定な実装は委譲せず main が直接処理する。

## 実行フロー（one-shot）

1. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。Verification には worker が自ら実行すべき検証コマンド（`vp check` / テスト）を記し、その結果を報告 Markdown の Verification section（実行コマンドと exit code を含む）に収めるよう指示する。request は terse に書く: Context にファイル内容を貼らず、パス（必要なら行範囲）で参照させる（main の出力＝課金トークンを増やさないため）。
   - ユーザーが会話でモデルや effort を指定した場合は、run 呼び出しにインライン env を前置する（例: `DELEGATE_IMPLEMENT_MODEL=gpt-5.5@high bash .../run.sh ...`）。exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
2. **実行**: `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/run.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）。
   - run は内部で prepare → dispatch → read-response を順に実行し、stdout は成功・失敗とも単一 JSON（`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`）を返す。
   - selector 省略時の既定は `auto`。第 6 位置引数は read-response の selector であり、prepare.sh の第 6 位置引数 session_mode とは意味が異なる。
   - exit code は内部スクリプトを透過する。exit 3=前提不足 / exit 4=委譲サイクルなら中止する。
   - run は dispatch 前に `observe_file: <path>` を stderr へ先出しする。強制終了時はその path を復旧経路にする。
   - 非対話モードの親（`claude -p` 等）では run を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。
3. **レスポンス消費と検証**: `status="$(printf '%s' "$out" | jq -r .status)"` / `content="$(printf '%s' "$out" | jq -r .content)"` を読む。`content_truncated` が `true` なら `response_file="$(printf '%s' "$out" | jq -r .response_file)"` を取り出し、`bash .claude/skills/delegate-implement/scripts/read-response.sh "$response_file" <N>` で Verification / Changed files など必要 section だけ段階読みする。読了後、worker の本文を **要約し直さない（echo しない）**。`status` が `completed` でない時、pass 申告の裏取りが要る時、差分が広い時、worker が Verification にリスクや未検証項目を書いた時は main 側で `git diff` / test result を裏取りする。

## 高度なフロー（個別スクリプト）

dispatch 中の observe 監視、background 実行、resumable / follow-up など、途中で親の判断を挟むフローでは従来の個別スクリプトを使う。

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。Verification には worker が自ら実行すべき検証コマンド（`vp check` / テスト）を記し、その結果を報告 Markdown の Verification section（実行コマンドと exit code を含む）に収めるよう指示する。request は terse に書く: Context にファイル内容を貼らず、パス（必要なら行範囲）で参照させる（main の出力＝課金トークンを増やさないため）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - ユーザーが会話でモデルや effort を指定した場合は、prepare 呼び出しにインライン env を前置する（例: `DELEGATE_IMPLEMENT_MODEL=gpt-5.5@high bash .../prepare.sh ...`）。prepare が exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/prepare.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"` / `run_dir="$(printf '%s' "$out" | jq -r .run_dir)"` / `observe_file="$(printf '%s' "$out" | jq -r .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-implement/scripts/dispatch.sh "$model" implement "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを `jq` で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で jq では null 相当）なので、usage を集計する場合は分母から除外する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-implement/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、Verification / Changed files など必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **検証フェーズ（必須）**: `status` を先に確認し、必要時のみ Verification / Changed files section を引く。決定論的検証（`vp check` の lint/型・テスト）の exit code は信頼し、意味的・受け入れ基準は Summary と `git diff` を中心に確認する。`status` が `completed` でない時、pass 申告の裏取りが要る時、差分が広い時、worker が Verification にリスクや未検証項目を書いた時は main 側で `git diff` / test result を裏取りする

## セッション再利用（resumable / follow-up）

resumable / follow-up は one-shot 対象外のため、個別スクリプトを使う。

既定は通常 run。複数ファイル実装や大きめ修正など、親レビューで差し戻す可能性が高い場合だけ初回から resumable initial run を明示する。過剰使用しない。

- resumable initial run: `prepare.sh` の第 6 引数に `resumable` を渡す。dispatch は第 7 引数に `resumable`、第 8・9 引数に空文字を渡す。
  - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/prepare.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID" resumable)"`
  - `session_mode="$(printf '%s' "$out" | jq -r .session_mode)"` / `lineage_id="$(printf '%s' "$out" | jq -r .lineage_id)"`
  - `bash .claude/skills/delegate-implement/scripts/dispatch.sh "$model" implement "$request_file" "$response_file" "$run_dir" "$observe_file" "$session_mode" "" ""`
  - response 読了後に `jq -r .backend_session.persistence "$observe_file"` を確認する。`resumable` 以外なら follow-up 不可としてその場で判断し、後から暗黙 fallback を期待しない。
- follow-up run: 親の差分確認で不具合が見つかった場合のみ使う。`prepare.sh` の第 6 引数に `followup=<前回observe_file>` を渡す。exit 5 は検証失敗なので中止し、通常 delegate として出し直す。暗黙 fallback しない。
  - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/prepare.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID" "followup=$previous_observe_file")"`
  - `session_mode="$(printf '%s' "$out" | jq -r .session_mode)"` / `resume_id="$(printf '%s' "$out" | jq -r .resume_id)"` / `backend_session_home="$(printf '%s' "$out" | jq -r .backend_session_home)"`
  - `bash .claude/skills/delegate-implement/scripts/dispatch.sh "$model" implement "$request_file" "$response_file" "$run_dir" "$observe_file" "$session_mode" "$resume_id" "$backend_session_home"`
  - follow-up request には、親が見つけた不具合、最新 `git diff` の見るべき範囲、前回 `response_file` の参照を必ず含める。worker の古い会話文脈だけに依存させない。

## 待ち時間の隠蔽（対話親向け）

対話親では `dispatch.sh`（または `run.sh`）を background で実行し、`observe_file` の `state.phase` / `heartbeat` を確認して `ended` 後に `read-response.sh` する運用で体感待ち時間を隠蔽できる。総所要時間（wall time）は変わらない体感改善であり、非対話モードの親では従来どおりフォアグラウンド実行必須。

## 制約

- 編集は可。ただし **push はしない**（push・PR は親エージェントが直接扱う）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
