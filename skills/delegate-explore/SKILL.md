---
name: delegate-explore
license: MIT
description: >
  コードベースおよびドキュメントの read-only な探索・読解を安価なモデルの subagent に委譲するスキル。
  「どこで定義/記載されているか」「どう動くか」「どこから参照されているか」などのコード調査に加え、
  仕様書・README・設計ドキュメント等の Markdown/テキストの内容確認・要約・該当箇所特定にも使う。
  複数ファイルや長めの文書を読む必要があり、親エージェントの context を汚さずに安く処理したいときに使う。
  単一の短いファイル確認や rg 一発で済む調査には使わない。結果はファイル経由で受け取り、
  index → 必要 section の順で段階的に読む。コード変更を伴う場合は delegate-implement を使うこと。
  explore の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-explore/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-claude.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/delegate-devin.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-explore

read-only の探索・読解を委譲する。コード（定義・参照・挙動の調査）とドキュメント（仕様書・README・設計資料等の内容確認・要約・該当箇所特定）の両方を対象とする。task_type=`explore`、既定モデル `haiku`。Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-explore`
- Codex: `skill_dir=.agents/skills/delegate-explore`

以降のコマンド例は Claude Code の `.claude/skills/delegate-explore` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-explore` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

explore は読む量が大きいほど効果が出る。複数ファイル・長めの設計資料・広い参照関係など、main が直接読むと context を膨らませる調査に使う。一方、単一の短いファイルを確認すれば済む調査、`rg` / `git grep` 一発で答えが出る調査、main が既に読んだ箇所の確認には使わず、main が直接処理する。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria の Markdown を stdin で渡す。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-explore/scripts/prepare.sh explore DELEGATE_EXPLORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-explore/scripts/delegate-codex.sh "$model" explore "$request_file" "$response_file"`
   - `model` が `swe*`: `bash .claude/skills/delegate-explore/scripts/delegate-devin.sh "$model" explore "$request_file" "$response_file"`
   - それ以外: `bash .claude/skills/delegate-explore/scripts/delegate-claude.sh "$model" explore "$request_file" "$response_file"`

3. **レスポンス読み取り**: `bash .claude/skills/delegate-explore/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合のみ status を返すので `... "$response_file" index` → 必要 section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。

## 制約

- read-only。ファイル編集・push はしない
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
