---
name: delegate-htmldoc
license: MIT
description: >
  token cost の削減とデザインの一貫性確保を目標として、固定デザインテンプレートに沿った
  自己完結型 HTML ドキュメントの生成を安価な subagent に委譲するスキル。
  調査結果・レポート・issue まとめ・技術資料・議事録などを「HTML で」「ドキュメントにして」
  「レポート化して」といった形で文書化する要求に使う。
  同梱テンプレートの CSS と component 語彙に content を流し込むため、実行ごとのデザイン揺れがない。
  デザインの新規設計や Web アプリの UI 実装には使わない（delegate-implement を使う）。
  htmldoc の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-htmldoc/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-htmldoc/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-htmldoc/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-htmldoc/scripts/read-response.sh:*), Bash(jq:*), Bash(test -f:*), Bash(ls:*), Read
---

# delegate-htmldoc

固定テンプレートに沿った HTML ドキュメント生成を委譲する。task_type=`htmldoc`、既定モデル `haiku`（テンプレート固定の流し込み作業のため判断比重が低い）。実行系分岐（Codex / Devin / Cursor / Claude）は `dispatch.sh` が行う。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-htmldoc`
- Codex: `skill_dir=.agents/skills/delegate-htmldoc`

以降のコマンド例は Claude Code の `.claude/skills/delegate-htmldoc` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-htmldoc` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## テンプレートと component 語彙

デザインは skill 同梱の固定資産で担保する。worker に CSS やレイアウトを生成させない。

- `<skill_dir>/references/template.html`: 完成した CSS と全 component の使用例を含むテンプレート
- `<skill_dir>/references/styleguide.md`: component 語彙と執筆ルール

request の Context には両ファイルのパスを必ず記載し、worker にテンプレートをコピーして content だけを流し込ませる。main がテンプレート本文を読み込んで request に貼ることはしない（パス参照で足りる）。

## 委譲する前に（コストゲート）

htmldoc は文書本文の生成（出力 token）が嵩むほど効果が出る。まとまった分量の調査結果・レポート・複数セクションの資料は委譲する。一方、main が既に全 content を持っていて数行の HTML 断片を書けば済む場合や、既存 HTML の 1 箇所修正は main が直接処理する。

## 実行フロー

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。request は terse に書く: 文書化する source（ファイル・issue・調査結果）はパスや URL で参照させ、本文を貼らない。Context に `references/template.html` と `references/styleguide.md` のパスを記載する。Constraints に出力ファイルパスを明記する（ユーザー指定がなければ `delegate-htmldoc-output/` 配下）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-htmldoc/scripts/prepare.sh htmldoc DELEGATE_HTMLDOC_MODEL haiku "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"` / `run_dir="$(printf '%s' "$out" | jq -r .run_dir)"` / `observe_file="$(printf '%s' "$out" | jq -r .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-htmldoc/scripts/dispatch.sh "$model" htmldoc "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを `jq` で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で jq では null 相当）なので、usage を集計する場合は分母から除外する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-htmldoc/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **検証**: `Changed files` のパスが存在することを `test -f` で確認する。生成 HTML 全文は main の context に読み込まない。

## Worker report

report の見出しは共有 wrapper が固定する標準構成（`Summary / Changed files / Commands / Verification / Findings / Blockers / Error`）に従う。htmldoc では各見出しを次のように使う。

- `Summary`: 生成したドキュメントの短い説明
- `Changed files`: 作成した HTML ファイルのパス
- `Verification`: テンプレート CSS を変更していないこと、単一ファイルで完結していることの確認
- `Findings`: 使用した component（hero / section / table / conclusion / tasks 等）と文書構成、source の特記事項
- `Blockers`: source 不足・内容の矛盾・テンプレートで表現できない要求

## 制約

- 書き込みは指定された出力 HTML ファイルと response の生成のみ。それ以外のリポジトリファイル編集・push はしない
- テンプレートの CSS・component 構造を変更しない。content の流し込みだけを行う（デザイン揺れを排除するため）
- 単発生成の種別のため session reuse（resumable / follow-up）は使わない。修正が必要なら新しい delegate run として出し直す
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは生成ファイルパスと Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
