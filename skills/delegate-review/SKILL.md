---
name: delegate-review
license: MIT
description: >
  コード/ドキュメントレビュー（差分の指摘出し）を判断比重の高いモデルの subagent に委譲するスキル。
  大きめの diff、複数ファイルにまたがる変更、main が差分全体を読むと重い一次レビューに使う。
  数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューには使わない。
  review の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
  コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-review/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-review/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-response.sh:*), Bash(jq:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Read
---

# delegate-review

差分のコード/ドキュメントレビューを委譲する。task_type=`review`、既定モデル `opus`（指摘品質が成果物に直結し判断比重が高いため）。実行系分岐（Codex / Devin / Cursor / Claude）は `dispatch.sh` が行う。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-review`
- Codex: `skill_dir=.agents/skills/delegate-review`

以降のコマンド例は Claude Code の `.claude/skills/delegate-review` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-review` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

review は、main が差分全体を読むと context を膨らませる一次レビューに使う。大きめの diff、複数ファイルにまたがる変更、広い影響範囲の確認が必要な差分を発火条件にする。一方、数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューは委譲せず main が直接処理する。
レビュー対象はコード差分に限らず、README / spec / design docs / changelog などのドキュメント差分も含める。
review の作業を委譲する場合は、この skill を使う。generic な subagent へ流す運用はしない。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Constraints の Markdown を stdin で渡す。レビュー対象の差分範囲（base/head・対象パス等）を Scope に明記する。request は terse に書く: diff 本体やファイル内容は貼らず、範囲指定とパス参照で渡す（main の出力＝課金トークンを増やさないため）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-review/scripts/prepare.sh review DELEGATE_REVIEW_MODEL opus "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"` / `run_dir="$(printf '%s' "$out" | jq -r .run_dir)"` / `observe_file="$(printf '%s' "$out" | jq -r .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-review/scripts/dispatch.sh "$model" review "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを `jq` で読む。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-review/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、Findings など必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **裏取りフェーズ（必須）**: `status` を先に確認し、必要時のみ Findings section を引く。重要 findings は該当する `file:line` 周辺または該当 diff だけを main が確認する。問題なしの報告や軽微 findings は差分全体を再読せず、Scope と Summary の整合を確認する。

## 制約

- read-only。ファイル編集・git の書き込み操作・push はしない（差分を読んで指摘を報告するだけ）
- 指摘は報告 Markdown の Findings section に収め、各 finding に severity / file:line / 根拠 / 影響 / 推奨対応を含める
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
