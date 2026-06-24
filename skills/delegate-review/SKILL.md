---
name: delegate-review
license: MIT
description: >
  コードレビュー（差分の指摘出し）を判断比重の高いモデルの subagent に委譲するスキル。
  大きめの diff、複数ファイルにまたがる変更、main が差分全体を読むと重い一次レビューに使う。
  数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューには使わない。
  read-only で編集や git の書き込み操作はしない。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
allowed-tools: Bash(bash .claude/skills/delegate-review/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-review/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-review/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-review/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-review/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-review/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-review/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Read
---

# delegate-review

差分のコードレビューを委譲する。task_type=`review`、既定モデル `opus`（指摘品質が成果物に直結し判断比重が高いため）、Claude パスの subagent_type は `general-purpose`（read-only）。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-review`
- Codex: `skill_dir=.agents/skills/delegate-review`

以降のコマンド例は Claude Code の `.claude/skills/delegate-review` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-review` に読み替える。

## 委譲する前に（コストゲート）

review は、main が差分全体を読むと context を膨らませる一次レビューに使う。大きめの diff、複数ファイルにまたがる変更、広い影響範囲の確認が必要な差分を発火条件にする。一方、数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューは委譲せず main が直接処理する。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Constraints の Markdown を stdin で渡す。レビュー対象の差分範囲（base/head・対象パス等）を Scope に明記する。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-review/scripts/prepare.sh review DELEGATE_REVIEW_MODEL opus "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-review/scripts/delegate-codex.sh "$model" review "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。**worker への指示は下記の固定テンプレを `<REQUEST_FILE>` / `<RESPONSE_FILE>` だけ実パスに差し替えてそのまま渡す**。タスク本体は request_file に入っているので、main は指示文を作文し直さない（main の出力＝課金トークンを増やさないため）:

     ```
     あなたは delegate-review の worker。タスク指示は request_file にある。
     1. `bash .claude/skills/delegate-review/scripts/read-request.sh <REQUEST_FILE> all` で指示全文を読む（小さいので丸読みでよい）。
     2. 指定範囲の差分を read-only でレビューする。ファイル編集・git 書き込み・push は禁止。AGENTS.md / CLAUDE.md の規約に従う。
     3. 報告 Markdown を stdin で `bash .claude/skills/delegate-review/scripts/build-response.sh <status> claude-review-worker <RESPONSE_FILE>` に渡して書く。status は completed|partial|failed|needs_input。見出しは canonical 英語 section 名に固定: `Summary`（必須）・`Findings`（必須）／該当時 `Blockers`・`Error`。各 finding には severity、file:line、根拠、影響、推奨対応を含める。main が裏取りすべき重要 finding の該当 diff 条件を `Summary` または `Findings` に書く。アドホックな見出しは使わない。
     4. 最終メッセージは status 一語と 1 行要約のみ（詳細は response_file に書く。main の context を膨らませない）。
     ```

3. **レスポンス読み取り**: `bash .claude/skills/delegate-review/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合のみ status を返すので `... "$response_file" index` → Findings section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **裏取りフェーズ（必須）**: `status` を先に確認し、必要時のみ Findings section を引く。重要 findings は該当する `file:line` 周辺または該当 diff だけを main が確認する。問題なしの報告や軽微 findings は差分全体を再読せず、Scope と Summary の整合を確認する。

## 制約

- read-only。ファイル編集・git の書き込み操作・push はしない（差分を読んで指摘を報告するだけ）
- 指摘は報告 Markdown の Findings section に収め、各 finding に severity / file:line / 根拠 / 影響 / 推奨対応を含める
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
- worker 起動プロンプトは step 2 の固定テンプレをそのまま使い、タスク本体を作文し直さない（同上）
