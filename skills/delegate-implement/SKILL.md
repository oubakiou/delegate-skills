---
name: delegate-implement
license: MIT
description: >
  コードの実装・修正を安価なモデルの subagent に委譲するスキル。
  複数ファイルまたは既存パターン調査を伴う実装タスク（機能追加・バグ修正・リファクタ等）を、
  親エージェントの context を汚さずに処理したいときに使う。単一ファイルの小変更、明確な一括置換、
  main が既に読んだ箇所の数行修正、設計判断が未確定な実装には使わない。子は Edit/Write/Bash で実作業し、結果はファイル経由で受け取る。
  read-only の調査は delegate-explore、git/PR 操作は親エージェントが直接扱うこと。
  implement の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-implement/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/delegate-claude.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/delegate-devin.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-implement/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(vp:*), Read
---

# delegate-implement

コード実装を委譲する。task_type=`implement`、既定モデル `sonnet`（編集の判断を要するため）。Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-implement`
- Codex: `skill_dir=.agents/skills/delegate-implement`

以降のコマンド例は Claude Code の `.claude/skills/delegate-implement` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-implement` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

implement は、調査・編集・検証を worker にまとめて任せる価値がある規模の実装に使う。複数ファイルにまたがる変更、既存パターン調査を伴う変更、worker が検証コマンドまで実行でき、main が `git diff` / Verification / Summary の確認に集中できる変更を発火条件にする。一方、単一ファイルの小変更、明確な一括置換、main が既に読んだ箇所の数行修正、設計判断が未確定な実装は委譲せず main が直接処理する。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。Verification には worker が自ら実行すべき検証コマンド（`vp check` / テスト）を記し、その結果を報告 Markdown の Verification section（実行コマンドと exit code を含む）に収めるよう指示する。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-implement/scripts/prepare.sh implement DELEGATE_IMPLEMENT_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-implement/scripts/delegate-codex.sh "$model" implement "$request_file" "$response_file"`
   - `model` が `swe*`: `bash .claude/skills/delegate-implement/scripts/delegate-devin.sh "$model" implement "$request_file" "$response_file"`
   - それ以外: `bash .claude/skills/delegate-implement/scripts/delegate-claude.sh "$model" implement "$request_file" "$response_file"`

3. **レスポンス読み取り**: `bash .claude/skills/delegate-implement/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合のみ status を返すので `... "$response_file" index` → Verification / Summary / Changed files section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **検証フェーズ（必須）**: `status` を先に確認し、必要時のみ Verification / Changed files section を引く。決定論的検証（`vp check` の lint/型・テスト）の exit code は信頼し、意味的・受け入れ基準は Summary と `git diff` を中心に確認する。`status` が `completed` でない時、pass 申告の裏取りが要る時、差分が広い時、worker が Verification にリスクや未検証項目を書いた時は main 側で `git diff` / test result を裏取りする

## 制約

- 編集は可。ただし **push はしない**（push・PR は親エージェントが直接扱う）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
