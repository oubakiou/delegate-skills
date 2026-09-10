---
name: delegate-prose
license: MIT
description: >
  token cost の削減を第一目標として、汎用の文章（技術記事・リリースノート・README・議事録・説明文など）の
  生成・改稿・推敲・リライトを subagent に委譲するスキル。
  ユーザーが「文章を書いて」「記事にして」「推敲して」「リライトして」といった形で、
  文章自体を成果物として求める場合に使う。
  Notion / docs / README / issue など後から読まれる文書へ、日本語 200 文字以上（英語 100 words）
  または箇条書き 3 項目以上の説明文を書く場合は、分析・実装が主目的でもこの skill を通す。
  HTML 成果物は delegate-htmldoc、コード実装は delegate-implement、調査は delegate-explore を使う。
  コード・構造化データ・表構造の変更・リンクや番号の差し替え・1〜2 文修正には使わない。
  prose の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-prose/scripts/run.sh:*), Bash(bash .claude/skills/delegate-prose/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-prose/scripts/dispatch.sh:*), Bash(bash .claude/skills/delegate-prose/scripts/read-request.sh:*), Bash(bash .claude/skills/delegate-prose/scripts/read-response.sh:*), Bash(bash .claude/skills/delegate-prose/scripts/read-json.sh:*), Bash(test -f:*), Bash(ls:*), Read
---

# delegate-prose

汎用の文章（Markdown / プレーンテキスト）の生成・改稿・推敲を委譲する。task_type=`prose`、既定モデル `sonnet`（文章生成の判断比重があるため）。実行系分岐（Codex / Devin / Cursor / Claude / OpenCode）は `dispatch.sh` が行う。`opencode/<provider>/<model>` を使う場合は `opencode` CLI（ログイン済み）が必要。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-prose`
- Codex: `skill_dir=.agents/skills/delegate-prose`

以降のコマンド例は Claude Code の `.claude/skills/delegate-prose` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-prose` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に（コストゲート）

**分量で判定する。タスクの主目的では判定しない。** Notion / docs / README / issue 本文やコメントなど、後から読まれる文書へ次のいずれかを書く場合は委譲する。分析・調査・実装が主目的のタスクに付随する説明文でも同じ扱いにする。

- 日本語 200 文字以上（英語なら 100 words 程度）の説明文
- 箇条書き 3 項目以上の説明文

分量は**同一タスクで同一文書へ加える説明文の合計**で数える。ツール呼び出しの回数では数えない。150 文字ずつ 4 回に分けて書いても、README の英日 2 ファイルへ同じ内容を書いても、合計が閾値に達すれば委譲する。初稿・全面改稿・複数セクションの文書は、この合計で判定すれば通常は閾値に達する。

除外は目的ではなく**形式**で決める。次は main が直接書く。

- コード、コードブロック、JSON / YAML などの構造化データ
- 表の行・列の追加削除や並べ替え、セル内の数値・識別子・リンクの置換
- リンク・番号・パス・識別子の差し替え
- 既存文の 1〜2 文修正、typo 修正、コミットメッセージ

表のセルであっても、中身が自然言語の説明文なら通常どおり分量で判定する。格納場所ではなく書くものの形式で決める。

見積もりを外した分を拾うため**事後にも判定する**。main が直接書き終えた説明文が閾値に達していたら、そのまま確定せず delegate-prose の推敲に通す。対象範囲・形式除外・合計の数え方は事前判定と同じものを使う。

request は骨子で足りる。worker は MCP を使えるため、Notion の URL やコメント ID を渡せば本文を main が読み込んで貼り直す必要はない。

## 実行フロー（one-shot）

1. **リクエスト作成**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。request は terse に書く: ファイルや URL として存在する source（元データ・調査結果・参照文書）はパスで参照させ、本文を貼らない。会話内にしか存在しない原稿・素材（ユーザーが貼り付けた文章、会話で整理した情報）は worker に渡らないため、request に直接埋め込むか、`.temp/` 配下の一時ファイルへ書き出してパスで渡す。文体・トーン・分量・言語・読者層を request で明示する。Constraints に出力ファイルパスを明記する（ユーザー指定がなければ `delegate-prose-output/` 配下）。
   - ユーザーが会話でモデルや effort を指定した場合は、run 呼び出しにインライン env を前置する（例: `DELEGATE_PROSE_MODEL=gpt-5.5@high bash .../run.sh ...`）。exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
2. **実行**: `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-prose/scripts/run.sh prose DELEGATE_PROSE_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）。
   - run は内部で prepare → dispatch → read-response を順に実行し、stdout は成功・失敗とも単一 JSON（`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`）を返す。
   - selector 省略時の既定は `auto`。第 6 位置引数は read-response の selector であり、prepare.sh の第 6 位置引数 session_mode とは意味が異なる。
   - exit code は内部スクリプトを透過する。exit 3=前提不足 / exit 4=委譲サイクルなら中止する。
   - `run.sh` は dispatch 前に `observe_file: <path>` を stderr へ先出しする。`run.sh` が Bash timeout で background へ退避した場合・強制終了された場合は**再実行しない**（再実行は worker の二重起動になり、implement / chore では同一 worktree の同時書き換えになる）。復旧は `bash .claude/skills/delegate-prose/scripts/read-json.sh .state.phase "$observe_file"` が `ended` になるまで待ち、`bash .claude/skills/delegate-prose/scripts/read-json.sh .run.response_file "$observe_file"` で応答パスを取得して `bash .claude/skills/delegate-prose/scripts/read-response.sh` で読む。background 退避した出力ファイルは stdout と stderr が合流するが、`read-json.sh` は JSON object を囲む行を読み飛ばすのでそのまま読める。
   - 非対話モードの親（`claude -p` 等）では run を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。
3. **レスポンス消費と検証**: `status="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .status)"` / `content="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .content)"` を読む。`content_truncated` が `true` なら `response_file="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .response_file)"` を取り出し、`bash .claude/skills/delegate-prose/scripts/read-response.sh "$response_file" <N>` で必要 section だけ段階読みする。読了後、worker の本文を **要約し直さない（echo しない）**。`status` が `failed` なら Error section をユーザーへ伝える。`completed` でも Summary 先頭に警告行があればその旨を伝える（警告は response 本体に載るので selector に関わらず Summary とともに返る）。`Changed files` のパスが存在することを `test -f` で確認し、生成した文章全文は main の context に読み込まない。HTML 文書として仕上げる必要がある場合は、生成した Markdown を source として delegate-htmldoc に渡す。

## 高度なフロー（個別スクリプト）

dispatch 中の observe 監視、background 実行など、途中で親の判断を挟むフローでは従来の個別スクリプトを使う。

1. **準備（集約）**: 前提チェック→モデル解決→チェーン確認→リクエスト生成を `prepare.sh` 1 本に畳む。Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。request は terse に書く: ファイルや URL として存在する source（元データ・調査結果・参照文書）はパスで参照させ、本文を貼らない。会話内にしか存在しない原稿・素材（ユーザーが貼り付けた文章、会話で整理した情報）は worker に渡らないため、request に直接埋め込むか、`.temp/` 配下の一時ファイルへ書き出してパスで渡す。文体・トーン・分量・言語・読者層を request で明示する。Constraints に出力ファイルパスを明記する（ユーザー指定がなければ `delegate-prose-output/` 配下）。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - ユーザーが会話でモデルや effort を指定した場合は、prepare 呼び出しにインライン env を前置する（例: `DELEGATE_PROSE_MODEL=gpt-5.5@high bash .../prepare.sh ...`）。prepare が exit 6 の場合は、許容値列挙を含む stderr の 1 行をそのままユーザーへの説明に使う。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-prose/scripts/prepare.sh prose DELEGATE_PROSE_MODEL sonnet "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .model)"` / `request_file="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .request_file)"` / `response_file="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .response_file)"` / `run_dir="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .run_dir)"` / `observe_file="$(printf '%s' "$out" | bash .claude/skills/delegate-prose/scripts/read-json.sh .observe_file)"`
2. **実行**: `bash .claude/skills/delegate-prose/scripts/dispatch.sh "$model" prose "$request_file" "$response_file" "$run_dir" "$observe_file"`。モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude / OpenCode）は dispatch.sh が行う。stdout は response_file のパスのみ。非対話モードの親（`claude -p` 等）では dispatch を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを read-json.sh で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で read-json.sh では null 相当）なので、usage を集計する場合は分母から除外する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-prose/scripts/read-response.sh "$response_file" auto`。`auto` は response が小さい（既定 10KB 未満）なら status と全 section を 1 回で丸読みし、大きい場合は status + index + Summary section を返すので、必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を **要約し直さない（echo しない）**。`status` が `failed` なら Error section をユーザーへ伝える。`completed` でも Summary 先頭に警告行があればその旨を伝える（警告は response 本体に載るので selector に関わらず Summary とともに返る）。main のユーザー向け応答は Summary を指す 1 行に留める（main の出力＝課金トークンを増やさないため。spec.md §6）。
4. **検証**: `Changed files` のパスが存在することを `test -f` で確認する。生成した文章全文は main の context に読み込まない。HTML 文書として仕上げる必要がある場合は、生成した Markdown を source として delegate-htmldoc に渡す。

## 待ち時間の隠蔽（対話親向け）

対話親では体感待ち時間を隠蔽できる。経路は起動スクリプトで異なる。`dispatch.sh` 経由は `prepare.sh` で `response_file` を事前取得済みなので、`dispatch.sh` を background で実行し、`observe_file` の `state.phase` / `heartbeat` を確認して `ended` 後に `read-response.sh` する。`run.sh` 経由は `response_file` を事前に取得できないので、`run.sh` を background で実行した場合は `read-json.sh .run.response_file "$observe_file"` で応答パスを取るか、合流した出力 JSON をそのまま `read-json.sh` で読む。総所要時間（wall time）は変わらない体感改善であり、非対話モードの親では従来どおりフォアグラウンド実行必須。

## Worker report

report の見出しは共有 wrapper が固定する標準構成（`Summary / Changed files / Commands / Verification / Findings / Blockers / Error`）に従う。prose では各見出しを次のように使う。

- `Summary`: 書いた文章の短い説明
- `Changed files`: 作成・更新したファイルのパス
- `Verification`: 本文中の事実・数値・日付・固有名詞が source に存在すること、指定された言語・分量・文体の遵守、指定外ファイルを変更していないことの確認
- `Findings`: 構成の判断、表現上の選択、source の特記事項
- `Blockers`: source 不足・内容の矛盾・指定が満たせない要求

## 制約

- 書き込みは request で指定された出力ファイル / ディレクトリ配下と response の生成のみ。コードファイルの編集・git 書き込み・push はしない
- 事実・数値・日付・固有名詞・引用は request と明示された source からのみ取り、推測で補完しない。不足は埋めずに Blockers で報告させる
- 単発生成の種別のため session reuse（resumable / follow-up）は使わない。修正が必要なら新しい delegate run として出し直す
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker 出力を echo / 再要約しない。ユーザー向けは生成ファイルパスと Summary を指す 1 行に留める（出力＝課金トークンを増やさないため。spec.md §6）
- OpenCode: cwd 外への出力は保証されない（direct な edit / write と明示パスの読み取りは拒否され、bash のリダイレクトは通る）。出力先を cwd 外に指定すると成功は保証されない。request が `DELEGATE_REQUEST_INLINE_MAX` を超えると child 起動前に fail-closed する
- OpenCode の read-only 抑止は管理者設定のない環境を前提とする（管理者設定は注入した permission を override し得る）
- この種別は常に `--pure` で起動し、OpenCode の project plugin を読み込まない（plugin は任意コード実行で prompt 制約を迂回し得るため）。`DELEGATE_OPENCODE_PURE` が `1` / `true` / `yes` なら implement / chore を含む全 task type へ広げる。`DELEGATE_OPENCODE_MCP_SOURCE`（`claude` / `cursor` / `codex`）で MCP 入力元を明示し、未指定なら注入しない
