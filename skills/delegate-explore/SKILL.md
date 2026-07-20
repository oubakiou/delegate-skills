---
name: delegate-explore
license: MIT
description: >
  token cost の削減を第一目標として、read-only な探索・読解を安価なモデルの subagent に委譲するスキル。
  対象はコードベース・ドキュメントに加え、WebSearch / WebFetch による Web 上のライブラリ仕様・OSS・技術情報の調査、
  Notion・Confluence・Jira など MCP ツール経由の社内ドキュメント・チケット調査まで含む。
  コードの定義・参照・挙動の調査、仕様書・README・設計資料の内容確認・要約・該当箇所特定、Web や社内ナレッジの下調べに使う。
  複数ファイル・長い文書・複数の Web ページを読む調査を、親エージェントの context を汚さずに安く処理したいときに使う。
  単一の短いファイル確認や rg 一発で済む調査には使わない。コード変更を伴う場合は delegate-implement を使うこと。
  explore の委譲はこの skill を使い、generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-explore/scripts/run.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-response.sh:*), Bash(bash .claude/skills/delegate-explore/scripts/read-json.sh:*), Read
---

# delegate-explore

read-only の探索・読解を委譲する。対象はコード（定義・参照・挙動の調査）、ドキュメント（仕様書・README・設計資料等の内容確認・要約・該当箇所特定）、Web（WebSearch / WebFetch によるライブラリ仕様・OSS・技術情報の調査）、MCP（Notion・Atlassian 等、実行環境に設定済みの MCP ツール経由の社内ドキュメント・チケット調査）。task_type=`explore`、既定モデル `haiku`。実行系分岐（Codex / Devin / Cursor / Claude）は `dispatch.sh` が行う。

## 探索手段と実行系の対応

- **Claude 系モデル（`fable` / `opus` / `sonnet` / `haiku`）**: bypass permissions が有効な環境では denylist 方式（built-in のファイル編集ツール `Edit` / `MultiEdit` / `Write` / `NotebookEdit` のみ deny）のため WebSearch / WebFetch を含む読み取り系ツールが開放される。bypass が無効な managed-policy 環境では、事前許可された最小ツール以外は拒否され得る
- **Codex / Devin / Cursor**: Web 取得・検索は各 CLI の内蔵ツールとサンドボックス設定に依存する
- worker が Web 到達不可を failed / Blockers で報告した場合は、Web 到達可能な backend で再委譲するか main 側で処理する
- MCP ツールは 4 backend とも親の user スコープ MCP 設定を既定で利用する（wrapper が backend に応じて共有または抽出・注入）。対象の MCP サーバーが親設定に無いなら、その調査は委譲せず main 側で扱う
- worker の MCP 利用は読み取り系ツールのみに制限される（プロンプトレベルの常時制約）。MCP への書き込みを伴う作業は explore ではなく delegate-chore / delegate-implement に委譲する
- Web / MCP 由来のコンテンツ（prompt injection リスクを含む）は子プロセス内に隔離され、main には worker の報告だけが返る

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-explore`
- Codex: `skill_dir=.agents/skills/delegate-explore`

以降のコマンド例は Claude Code の `.claude/skills/delegate-explore` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-explore` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

explore は読む量が大きいほど効果が出る。複数ファイル・長めの設計資料・広い参照関係・複数の Web ページや MCP 経由の長い社内ドキュメントなど、main が直接読むと context を膨らませる調査に使う。一方、単一の短いファイルを確認すれば済む調査、`rg` / `git grep` 一発で答えが出る調査、main が既に読んだ箇所の確認には使わず、main が直接処理する。

## 実行フロー（one-shot）

1. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria の Markdown を stdin で渡す。request は terse に書く: Context にファイル内容を貼らず、パス（必要なら行範囲）で参照させる。Web / MCP 調査では対象の URL・ページタイトル・issue key・検索観点を Scope に明記し、コンテンツ本文は貼らない（main の出力＝課金トークンを増やさないため）。
   - ユーザーが会話でモデルや effort を指定した場合は、run 呼び出しにインライン env を前置する（例: `DELEGATE_EXPLORE_MODEL=gpt-5.5@high bash .../run.sh ...`）。exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
2. **実行**: `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-explore/scripts/run.sh explore DELEGATE_EXPLORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）。
   - run は内部で prepare → dispatch → read-response を順に実行し、stdout は成功・失敗とも単一 JSON（`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`）を返す。
   - selector 省略時の既定は `auto`。第 6 位置引数は read-response の selector であり、prepare.sh の第 6 位置引数 session_mode とは意味が異なる。
   - exit code は内部スクリプトを透過する。exit 3=前提不足 / exit 4=委譲サイクルなら中止する。
   - run は dispatch 前に `observe_file: <path>` を stderr へ先出しする。強制終了時はその path を復旧経路にする。
   - 非対話モードの親（`claude -p` 等）では run を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。
3. **レスポンス消費**: `status="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .status)"` / `content="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .content)"` を読む。`content_truncated` が `true` なら `response_file="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .response_file)"` を取り出し、`bash .claude/skills/delegate-explore/scripts/read-response.sh "$response_file" <N>` で必要 section だけ段階読みする。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。

## 高度なフロー（個別スクリプト）

dispatch 中の observe 監視、background 実行など、途中で親の判断を挟むフローでは従来の個別スクリプトを使う。

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria の Markdown を stdin で渡す。request は terse に書く: Context にファイル内容を貼らず、パス（必要なら行範囲）で参照させる。Web / MCP 調査では対象の URL・ページタイトル・issue key・検索観点を Scope に明記し、コンテンツ本文は貼らない（main の出力＝課金トークンを増やさないため）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - ユーザーが会話でモデルや effort を指定した場合は、prepare 呼び出しにインライン env を前置する（例: `DELEGATE_EXPLORE_MODEL=gpt-5.5@high bash .../prepare.sh ...`）。prepare が exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-explore/scripts/prepare.sh explore DELEGATE_EXPLORE_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .model)"` / `request_file="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .request_file)"` / `response_file="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .response_file)"` / `run_dir="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .run_dir)"` / `observe_file="$(printf '%s' "$out" | bash .claude/skills/delegate-explore/scripts/read-json.sh .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-explore/scripts/dispatch.sh "$model" explore "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを read-json.sh で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で read-json.sh では null 相当）なので、usage を集計する場合は分母から除外する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-explore/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。

## 待ち時間の隠蔽（対話親向け）

対話親では `dispatch.sh`（または `run.sh`）を background で実行し、`observe_file` の `state.phase` / `heartbeat` を確認して `ended` 後に `read-response.sh` する運用で体感待ち時間を隠蔽できる。総所要時間（wall time）は変わらない体感改善であり、非対話モードの親では従来どおりフォアグラウンド実行必須。

## 制約

- read-only。リポジトリのファイル編集・push はしない。MCP も読み取り系ツールのみ（プロンプトレベルの常時制約）
- read-only 種別のため session reuse（resumable / follow-up）は使わない
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
