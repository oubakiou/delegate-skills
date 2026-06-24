---
name: delegate-chore
license: MIT
description: >
  explore / implement / git のどれにも明確に当てはまらない雑務のうち、対象 content を読んで判断する必要があり、
  親エージェントの context を膨らませたくない作業を安価な subagent に委譲するフォールバックスキル。
  単一コマンドで処理できる軽微な整形・リネーム・一括置換・定型コマンド実行は原則として main が直接実行し、
  この skill は使わない。専用スキルが当てはまる場合はそちらを優先する。
allowed-tools: Bash(bash .claude/skills/delegate-chore/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/delegate-codex.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/build-response.sh:*), Bash(bash .claude/skills/delegate-chore/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-chore

雑務のフォールバック先。task_type=`chore`、既定モデル `haiku`（最安）、Claude パスの subagent_type は `general-purpose`。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-chore`
- Codex: `skill_dir=.agents/skills/delegate-chore`

以降のコマンド例は Claude Code の `.claude/skills/delegate-chore` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-chore` に読み替える。

## 委譲する前に（コストゲート）

委譲はオーバーヘッド（worker 起動・request/response の往復・main 側の読み取り）を伴う。**この chore が単一コマンド（`sed` / `find` / `chmod` / `jq` 等）でスクリプト化でき、対象内容をモデル context に載せずに済むなら、委譲は純損**になりやすい（オーバーヘッドが context 衛生・トークン両面の利得を上回る）。その場合は委譲せず main が直接実行するか、繰り返すなら下記フィードバックループの自動化提案へ回す。委譲が見合うのは、content をモデルが読み込んで処理する必要がある嵩んだ作業。根拠は [docs/design/delegate-chore.md §5](../../docs/design/delegate-chore.md)。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む（個別呼び出しの bash 往復と main context への出力を削減）。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-chore/scripts/prepare.sh chore DELEGATE_CHORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-chore/scripts/delegate-codex.sh "$model" chore "$request_file" "$response_file"`
   - それ以外: Agent tool を `subagent_type: general-purpose` / `model: $model` で起動。**worker への指示は下記の固定テンプレを `<REQUEST_FILE>` / `<RESPONSE_FILE>` だけ実パスに差し替えてそのまま渡す**。タスク本体は request_file に入っているので、main は指示文を作文し直さない（main の出力＝課金トークンを増やさないため）:

     ```
     あなたは delegate-chore の worker。タスク指示は request_file にある。
     1. `bash .claude/skills/delegate-chore/scripts/read-request.sh <REQUEST_FILE> all` で指示全文を読む（小さいので丸読みでよい）。
     2. 指示どおり作業する（編集可・push 不可。AGENTS.md / CLAUDE.md の規約に従う）。
     3. 報告 Markdown を stdin で `bash .claude/skills/delegate-chore/scripts/build-response.sh <status> claude-chore-worker <RESPONSE_FILE>` に渡して書く。status は completed|partial|failed|needs_input。見出しは canonical 英語 section 名に固定: `Summary`（必須）／該当時 `Verification`（実行コマンドと exit code）・`Changed files`・`Findings`・`Blockers`・`Error`。アドホックな見出しは使わない。
     4. 最終メッセージは status 一語と 1 行要約のみ（詳細は response_file に書く。main の context を膨らませない）。
     ```

3. **レスポンス読み取り**: `bash .claude/skills/delegate-chore/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合のみ status を返すので `... "$response_file" index` → 必要 section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。

## skill 昇格提案（フィードバックループ）

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。レスポンス消費後、その作業が

- 繰り返し現れる / 明確にスコープされた再利用可能なカテゴリ

であれば、専用 `delegate-<name>` skill の新規作成を `AskUserQuestion` でユーザーに提案する（想定名 / 既定モデル / ツール権限 / 起動種別を添える）。合意後は skill-creator で雛形を作り本プロトコルに沿わせる。一度きりの些末な chore では提案しない。

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断を要さないと気づいたら、`AskUserQuestion` でスクリプト化 / git hook / npm script / CI など適切な自動化手段を提案する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない。

## 制約

- 編集は可。ただし **push はしない**（push・PR は delegate-git）
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
- worker 起動プロンプトは step 2 の固定テンプレをそのまま使い、タスク本体を作文し直さない（同上）
