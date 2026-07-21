# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME_ja.md)

[![English](https://img.shields.io/badge/Language-English-lightgrey?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-blue?style=for-the-badge)](./README_ja.md)

📖 紹介記事: [高級モデルに全部やらせない — 標準機能(skill)だけでカジュアルに実現するマルチモデルの仕組み『delegate-skills』](https://zenn.dev/oubakiou/articles/c6f632dd0a9e92)

**実装・調査・レビュー・雑務などのタスクを、より安価なモデルや別ベンダーのモデル（Claude → Codex 等）の subagent に委譲してトークン費用を圧縮する LLM エージェント向け skill 集。**

高価なモデルを main agent に据えたまま、「読む・調べる・直す」といった定型作業だけを安価なモデルの子プロセスへ逃がす。たとえば main が Claude Fable 5（input \$10 / output \$50 per 1M tokens）のとき、コード探索を Claude Haiku 4.5（\$1 / \$5）へ委譲すれば、その作業のトークン単価は 1/10 になる。委譲先は Claude 系モデルに限らず、Codex（`gpt-*`）・Devin CLI・Cursor agent CLI 経由のモデルもモデル名だけで指定できる。委譲結果はファイル経由で必要な部分だけ段階的に読み取るため、main の context も膨らまない。

## 特徴

- **トークン費用の圧縮** — 読む量・書く量の多い定型作業を安価なモデルへ委譲し、高価なモデルの消費を意思決定と最終責任に集中させる
- **context の分離** — 大量のファイル読解や試行錯誤のログは子プロセス側に隔離され、main は結果の index → 必要 section だけを読む
- **マルチ CLI 対応** — 呼び出し元（requester）が Claude Code / Codex / Devin CLI / Cursor のいずれでも動作し、委譲先もモデル名だけで同じ 4 系統から選べる
- **capability bridge** — 画像生成（`delegate-imagegen`）や x.com 調査（`delegate-x-research`）など、main 側にない能力を子プロセスで橋渡しする
- **安全側に倒した設計** — 多段委譲の再帰防止、前提不足時の fail-closed、委譲先の push 禁止・read-only などのツール権限制限

## クイックスタート

### 前提条件

- Node.js 24+（delegate スクリプトは `md2idx` を内包した単一バンドル CLI。`jq` も `npx md2idx` も不要で、初回実行にネットワークもいらない）
- `.sh` shim を実行する POSIX シェル。follow-up セッションを使う場合は `git`
- Claude 系モデルを使う場合: `claude` CLI（ログイン済み）
- `gpt-*` を使う場合: `codex` CLI（ログイン済み）
- `swe-*` / `devin-*` を使う場合: `devin` CLI（ログイン済み）
- `composer-*` / `cursor-*` を使う場合: Cursor agent CLI（コマンド名は `agent`。ログイン済み、または `CURSOR_API_KEY` 設定済み）
- 現在の backend で `delegate-x-research` を使う場合: `grok` CLI（ログイン済み、X 調査へアクセス可能）

> [!WARNING]
> Codex worker は `codex exec --sandbox danger-full-access` で動くため、child Codex の sandbox は security boundary にならない。requester も Codex で、delegate または process contract test を起動する場合は、隔離された runner / Dev Container 内に限って `codex --sandbox danger-full-access --ask-for-approval on-request` で起動すること。その環境へ mount または認証した repository、Codex / GitHub credential、MCP authority は agent から到達可能になる。host Docker socket や広い host directory を mount しないこと。同梱 Dev Container は現在 privileged Docker-in-Docker を使うため、Docker Desktop では Linux VM が外側の境界になる。native Linux ではこの feature を外すか、別の hardened runner を使う。詳細は [Dev Container boundary 計画](./docs/feature/codex-devcontainer-delegation.md)を参照。

### インストール

#### gh skill（GitHub CLI v2.90.0+）

```bash
# Claude Code 向けに個別 skill をインストール
gh skill install oubakiou/delegate-skills delegate-explore --agent claude-code --scope project

# Codex 向け
gh skill install oubakiou/delegate-skills delegate-explore --agent codex --scope project

# 全 delegate skill をまとめてインストール
for skill in delegate-explore delegate-implement delegate-chore delegate-review delegate-imagegen delegate-x-research delegate-htmldoc; do
  gh skill install oubakiou/delegate-skills "$skill" --agent claude-code --scope project
done
```

#### skills CLI（[vercel-labs/skills](https://github.com/vercel-labs/skills)）

```bash
# 対話的に skill / agent を選んでインストール
npx skills add oubakiou/delegate-skills

# 利用可能な skill を一覧表示
npx skills add oubakiou/delegate-skills --list

# 特定 skill を特定 agent へ非対話でインストール
npx skills add oubakiou/delegate-skills --skill delegate-explore -a claude-code -y
```

### 使ってみる

インストール後の追加設定は不要。main agent に普段どおり依頼すれば、各 skill の description に基づいて自動で委譲される。

```text
このリポジトリの認証処理がどこで実装されているか調べて
```

→ main agent が `delegate-explore` を発動し、`haiku` の子プロセスが調査する。main は結果ファイルの index → 必要 section だけを読む。

skill 名を指定して明示的に委譲することもできる。

```text
delegate-review でこのブランチの差分をレビューして
```

より積極的に委譲させたい場合は、プロジェクトの CLAUDE.md / AGENTS.md に一文足しておくとよい。

```markdown
- token を節約するため delegate-\* skill を利用して積極的にタスクをサブエージェントに委譲してください
```

## 仕組み

main agent（高価なモデル）の context を汚さず、定型的・機械的な作業を安価なモデルへ委譲する。委譲先の実行系は**モデル名のプレフィックスで決まる**:

| モデル名                              | 実行系                      | 起動方法                            |
| ------------------------------------- | --------------------------- | ----------------------------------- |
| `sonnet` / `haiku` / `opus` / `fable` | Claude 子プロセス           | `claude -p`（`delegate-claude.sh`） |
| `gpt-*`                               | Codex 子プロセス            | `codex exec`（`delegate-codex.sh`） |
| `swe-*` / `devin-*`                   | Devin CLI 子プロセス        | `devin -p`（`delegate-devin.sh`）   |
| `composer-*` / `cursor-*`             | Cursor agent CLI 子プロセス | `agent -p`（`delegate-cursor.sh`）  |

プレフィックスの意味:

- `swe-*` と `composer-*` は各 CLI ネイティブのモデル名なのでそのまま渡す（例: `swe-1.7`、`composer-2.5`）
- `devin-*` と `cursor-*` は「この CLI 経由で使う」ことを固定するバックエンド固定プレフィックスで、剥がした残りをモデル名として渡す（例: `devin-glm-5.2` → Devin CLI に `glm-5.2`、`cursor-glm-5.2-high` → Cursor agent CLI に `glm-5.2-high`）

いずれのパスもシェルラッパ経由で子プロセスを起動するため、requester が Claude Code / Codex / Devin CLI / Cursor でも同じように動作する。各 `delegate-*.sh` は単一の自己完結型 TypeScript バンドル（`delegate-cli.mjs`、`md2idx` 内包）への薄い exec shim なので、実行時に必要なのは Node.js と対象バックエンド CLI だけで、`jq` も `npx` も要らない。main↔sub の受け渡しは[ファイルベース（リクエスト/レスポンス）](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fprotocol-v1.md)で、両方とも [md2idx](https://github.com/oubakiou/md2idx) 形式（`index` + `sections`）を採用し段階読み取りでトークンを節約する。

親側の happy path は one-shot 1 回の呼び出しに畳まれている: 各 skill の `run.sh`（専用 2 skill は `run-imagegen.sh` / `run-x-research.sh`）が prepare → dispatch → read-response を 1 回の Bash 呼び出しで連結し、成功・失敗とも単一 JSON（`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`）を返して内部の exit code を透過する。`content` は `DELEGATE_RUN_CONTENT_MAX` バイトで切り詰められ、全文は `response_file` から読める。resumable / follow-up・observe 監視・background dispatch などの高度なフローは従来どおり個別スクリプトを使う。対話親は dispatch を background 実行して observe JSON を確認してから response を読む運用で待ち時間を隠蔽できる（体感改善のみで総所要時間は不変）。

request 本文は正本の request JSON から worker の初期 prompt へ埋め込まれる（`DELEGATE_REQUEST_INLINE_MAX`、既定 256KB まで。超過時は `read-request.sh` 指示へ fallback）ため、worker は request 読取に往復を使わない。prompt は argv ではなく stdin（Claude / Codex / Cursor）または `--prompt-file`（Devin）で渡す。worker の報告は worker が書くのではなく wrapper が回収する: Claude / Codex の worker は構造化最終応答 `{status, report_markdown}` を返し（`--json-schema` / `--output-schema` で schema 強制）、Cursor / Devin / Grok の worker は front-matter 付き Markdown report を 1 回書く。wrapper がどちらの形式も protocol response（md2idx + envelope）へ変換するため、報告のための追加 LLM 往復はゼロになる。回収失敗は failed response（fail-closed）とし、構造化 parse の成否は observe の `timing` に記録される。

Claude の bypass permissions mode が managed policy で無効化されている環境では、Claude backend の worker は default 権限モードで動く。wrapper は request 読み取りに必要な最小ツールを事前許可する（報告は構造化最終応答で返るため protocol response の書き込み許可は不要）。それ以外の Bash コマンドやツールは拒否され得る。この環境でタスク全体を動かすには、project settings に必要な allowlist を追加するか、`DELEGATE_<TYPE>_MODEL` で非 Claude backend を選ぶ。managed policy が明示 deny しているツールは wrapper では許可できない。

### 再開可能な worker session

通常の delegate run は非永続のまま。大きめの `delegate-implement` / `delegate-chore` で、main agent が review/fix の往復を見込む場合だけ、初回 run を明示的に resumable initial run として起動できる。この opt-in により observe JSON に backend の resume handle、`lineage_id`、`run_context` が記録され、後続 follow-up は新しい request / response / observe run を作りながら同じ backend session を再開できる。

follow-up は明示的かつ fail-closed。前回 observe JSON の `backend_session.persistence` が `resumable` であること、resume handle があること、backend / model / repo / worktree context が一致すること、git HEAD が互換であることを要求する。検証に失敗した場合、新規 session へ暗黙 fallback せず、main agent は通常 delegate run として出し直す。resumable path は Claude / Codex / Devin / Cursor backend で対応する。新しい環境変数は不要。

Claude / Codex の follow-up は、初回 resumable run で捕捉した MCP サーバー構成を使い続ける。Cursor は run ごとに親の global config から隔離 MCP config を再生成する。

`delegate-explore` はコード・リポジトリ内ドキュメントに加え、WebSearch / WebFetch による Web 調査と、実行環境に設定済みの MCP ツール（Notion・Atlassian 等）経由の社内ナレッジ調査も対象にする。4 backend とも親の user スコープ MCP 設定を既定で利用する。Claude / Devin は実行環境の共有設定を継承し、resumable Claude / Codex / Cursor wrapper は親設定を抽出して隔離 config として worker に注入する。MCP ツールの実行品質は各 CLI に依存する。Claude backend は bypass permissions が有効な環境では denylist 方式（built-in のファイル編集ツール `Edit` / `MultiEdit` / `Write` / `NotebookEdit` のみ deny）のため WebSearch / WebFetch が利用でき、bypass が無効な managed-policy 環境では事前許可された最小ツール以外は拒否され得る。他 backend は各 CLI の内蔵ツールとサンドボックス設定に依存する。worker が Web 到達不可を報告した場合は、Web 到達可能な backend への再委譲または main 側での処理に切り替える。worker の MCP 利用は常に読み取り系ツールのみに制限される（プロンプトレベルの制約）。MCP への書き込みを伴う作業は `delegate-chore` / `delegate-implement` に委譲する。取得した Web / MCP コンテンツ（prompt injection リスクを含む）は子プロセスに隔離され、main agent には worker の報告だけが返る。

observe JSON には `mcp_config: {source, servers}` を記録する。`servers` は `injected` で wrapper が注入した MCP サーバー名の配列にする。`shared` は wrapper が所有しない自然継承のため空配列、`none` も空配列にする。定義本体や認証情報は observe JSON に記録しない。worker に見せる MCP サーバーは親の user スコープ設定で管理する。注入 config は token を含む env を持ち得るため run directory 配下に限定し、`DELEGATE_RUN_RETENTION_DAYS` の cleanup 対象にする。

`delegate-imagegen` は画像生成向けだが、モデル解決は他 delegate と同じ形に揃える。`DELEGATE_IMAGEGEN_MODEL` で子モデルを選び、`gpt*` は Codex、非 `gpt*` は Claude へフォールバックせず中止する。

`delegate-x-research` は `DELEGATE_X_RESEARCH_MODEL`（既定 `grok-build`）を解決し、現在の X 調査 backend（現時点では Grok CLI）を起動して x.com / X の投稿・アカウント・スレッド・反応を調査する。Claude / Codex へはフォールバックしない。

## skill 一覧

| skill                 | 用途                                               | ツール権限                                | 既定モデル   | env                                                                              |
| --------------------- | -------------------------------------------------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `delegate-explore`    | read-only のコード/ドキュメント/Web/MCP 探索・読解 | read-only（Web・MCP 可）                  | `haiku`      | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| `delegate-implement`  | コード実装・修正（1 コミットに収まる単位）         | Edit/Write/Bash（push なし）              | `sonnet`     | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| `delegate-chore`      | フォールバック雑務                                 | Edit/Write/Bash（push なし）              | `haiku`      | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| `delegate-review`     | コード/ドキュメントレビュー（差分の指摘）          | read-only                                 | `opus`       | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`   | Codex による画像生成/編集                          | Codex 子プロセス                          | `gpt-5`      | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |
| `delegate-x-research` | x.com / X 調査                                     | X 調査子プロセス                          | `grok-build` | `DELEGATE_X_RESEARCH_MODEL` / `DELEGATE_WORK_DIR`                                |
| `delegate-htmldoc`    | HTML ドキュメント生成（固定テンプレート）          | 出力ディレクトリ書き込みのみ（push なし） | `haiku`      | `DELEGATE_HTMLDOC_MODEL` / `DELEGATE_WORK_DIR`                                   |

既定モデルの根拠: explore / chore は read 中心・低リスクで `haiku`、implement は編集の判断を要するため `sonnet`、review は指摘品質が成果物に直結し判断比重が高いため `opus`、htmldoc は同梱固定テンプレートへの content 流し込みだけで判断比重が低いため `haiku`。

`delegate-imagegen` はユーザーにモデル選択を求めないが、運用側は `DELEGATE_IMAGEGEN_MODEL` で切り替えられる。出力先の明示がなければ生成物は `delegate-imagegen-output/` 配下に置く。

`delegate-x-research` は X 調査の capability bridge として扱い、運用側は `DELEGATE_X_RESEARCH_MODEL` で切り替えられるが、ユーザーに backend モデル選択を求めない。

`delegate-htmldoc` は skill 同梱の固定テンプレート（`references/template.html` + `references/styleguide.md`）へ content を流し込んで自己完結型の HTML ドキュメントを生成する。デザインは実行・モデルによらず同一で、worker は CSS を生成・編集しない。グラフ・画像素材は親側で用意して（チャートは dataviz-svg、ラスタ画像は `delegate-imagegen` 等）パスで渡し、SVG は文書へインライン埋め込み、ラスタ画像は出力 HTML の隣へコピーして相対参照する。出力先の明示がなければ生成物は `delegate-htmldoc-output/` 配下に置く。

## 環境変数

| 環境変数                                 | 既定                                     | 説明                                                          |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`                  | skill 毎                                 | 種別別のモデル上書き                                          |
| `DELEGATE_WORK_DIR`                      | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | リクエスト/レスポンスファイルの置き場                         |
| `DELEGATE_RESPONSE_INLINE_MAX`           | `10240` bytes                            | `read-response.sh auto` / `decision` の inline/段階読みの閾値 |
| `DELEGATE_RUN_CONTENT_MAX`               | `16384` bytes（`0` は無制限）            | one-shot `run.sh` の JSON 出力の `content` 上限               |
| `DELEGATE_REQUEST_INLINE_MAX`            | `262144` bytes                           | request 本文を worker prompt へ埋め込むサイズ gate            |
| `DELEGATE_METRICS_FILE`                  | 未設定                                   | proxy-metric / timing テレメトリの JSONL 出力先（任意）       |
| `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL`    | `10` 秒                                  | observe JSON の heartbeat 更新間隔                            |
| `DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS`  | `30` 秒                                  | observe JSON symlink lock の bounded wait（超過時はエラー）   |
| `DELEGATE_CHILD_BASH_TIMEOUT_MS`         | `300000` ms（`0` は注入なし）            | Claude backend の子へ注入する Bash tool timeout 上限          |
| `DELEGATE_CODEX_HOME_PRUNE`              | `1`（有効、`0` で残す）                  | 正常終了時に codex-home のキャッシュと auth コピーを削除      |
| `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` | `0`（無効）                              | stdout/stderr bytes が増えない子を指定秒数後に kill           |
| `DELEGATE_OBSERVE_STREAM_MAX_BYTES`      | `65536` bytes（`0` は無制限）            | observe JSON に保存する stdout/stderr content 上限            |
| `DELEGATE_RUN_RETENTION_DAYS`            | `0`（無効）                              | request 準備時に古い run ごとの scratch directory を削除      |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR`           | `delegate-imagegen-output`               | `delegate-imagegen` の既定出力先                              |
| `DELEGATE_X_RESEARCH_MODEL`              | `grok-build`                             | `delegate-x-research` のモデル                                |

モデル解決順: `DELEGATE_<TYPE>_MODEL` → skill 固有デフォルト。

ローカルでの再現調査や外部 watchdog からの監視には `DELEGATE_WORK_DIR=.temp/delegate/work` を設定し、request / response / observe JSON / run ごとの scratch file をリポジトリ内の ignore 済みディレクトリに集約する。
`DELEGATE_RUN_RETENTION_DAYS` を設定すると、その work directory 内の古い run ごとの scratch directory を削除する。監査・デバッグ用の request / response / observe JSON は削除しない。
worker の token usage は run 終了時に observe JSON の `usage.measurement: "measured" | "estimated"` として記録する。Claude stream-json、Codex JSON/session JSONL、Devin ATIF export、Cursor stream-json は実測値を返せる場合があり、未対応または parse 不能な backend では chars/4 推定に fallback し、`usage_parse_failed` observe event を残す。推定 usage には `estimation_basis: "protocol_payload_only"` が入る。これは request/response のプロトコルペイロード分だけを数えた確定的な下限値で、子ワーカーの実消費（コンテキスト読み込み・ツール往復・思考）を含まないため、実測 backend とのモデル間比較には使わないこと。cursor backend は agent CLI を `--output-format stream-json` で起動して最終 result イベントの usage をパースする（cursor-agent 2026.07.09 以降で実測化）。usage を出さない旧 CLI ではこの推定に fallback する。

`usage` と並んで、完走した run は observe JSON に `timing` を記録する: `total_ms`（子プロセスの wall time）、`time_to_first_useful_event_ms`（起動から最初の tool 実行または本文 delta まで。1 秒 poll の分解能で検出）、`report_ready_at_ms`（起動から response 確定まで）、stream 由来の `model_turns` / `tool_calls`、`measurement_source`（`claude_stream_json` / `codex_json` / `cursor_stream_json` / `devin_atif` / `grok_streaming_json` / `unavailable`）。時間値はすべて monotonic clock 由来の経過 ms で、時刻は記録しない。backend の stream から取得できない項目は `null` とする。Grok wrapper は現在 plain text 出力で起動するため、その run は `measurement_source: "unavailable"` と null の stream 由来フィールドを記録する。`grok_streaming_json` は wrapper が streaming JSON へ切り替わるまでの予約値。`structured_output_parse` は Claude / Codex run で構造化最終応答の parse 成否（`true` / `false`）を記録し、report.md 方式の backend では `null` のまま。

`DELEGATE_METRICS_FILE` を設定すると、`prepare` / `read_response` record に `duration_ms` が入り、dispatch 完了時に `dispatch` record（wall time・exit code・response 有無と observe `timing` の転記）が追記される。`scripts/summarize-metrics.ts` は backend / model 別の p50/p95 を nearest-rank で集計する: `null` は分母から除外して除外数を併記し、p95 は 20 サンプル以上でのみ報告する（未満は p50 と件数のみ）。

`DELEGATE_<TYPE>_MODEL` で指定できるドキュメント済みモデル名:

| 実行系           | モデル名                                                                                                                                              | 補足                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Claude CLI       | `fable`, `opus`, `sonnet`, `haiku`                                                                                                                    | Claude 系モデルの alias                                  |
| Codex CLI        | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex-spark`       | `delegate-imagegen` は `gpt*` / Codex 分岐のみ受け付ける |
| Devin CLI        | `swe-1.7`, `swe-1.7-lightning`, `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`                                                   | `devin-*` は prefix を剥がして Devin CLI に渡す          |
| Cursor agent CLI | `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code`, `cursor-glm-5.2-high`, `cursor-glm-5.2-max` | `cursor-*` は prefix を剥がして Cursor agent CLI に渡す  |

上記はドキュメント済みの対応モデルであり、厳密な allowlist ではない。実行先 CLI 側でも指定モデルが利用可能である必要がある。`delegate-x-research` は別途 `DELEGATE_X_RESEARCH_MODEL` を使い、ドキュメント済みモデルは `grok-build`。

上記モデル名の effort 挙動:

reasoning effort はモデル文字列へ `@<effort>` suffix を付けて opt-in で宣言する。例: `DELEGATE_IMPLEMENT_MODEL=gpt-5.5@high`。`@` が無い場合、delegate-skills は従来どおり実行先 CLI argv に effort flag を追加しない。

suffix 対応は backend ごとに明示され、非対応指定は fail-closed する。Claude は `low`, `medium`, `high`, `xhigh`, `max` を受け付け、`--effort` として渡す。Codex は `low`, `medium`, `high`, `xhigh`, `max`, `ultra` を受け付け、`-c model_reasoning_effort=<value>` として渡す（`max` / `ultra` は Codex CLI v0.144.1 + `gpt-5.6-sol` で受理確認済み。古い CLI では実行時に拒否されうる）。Cursor はモデル別対応で、`cursor-glm-5.2@high|max` は `glm-5.2[reasoning=<value>]`、`cursor-grok-4.5@low|medium|high` は `grok-4.5[effort=<value>]` へ変換する。Devin、`delegate-imagegen`、`delegate-x-research` は effort suffix 宣言に対応しない。不正値、非対応 backend、Cursor の `-high` / `-max` slug と `@...` の二重指定は dispatch 前に exit 6 で停止し、stderr 1 行に許容値を列挙する。

observe JSON には wrapper が完走した run の `run.effort.requested` と `run.effort.effective` を記録する。実効値が measured になるのは run artifacts が実効値を露出する場合のみ（Codex の resumable / follow-up は永続 session JSONL、Cursor は model slug または run 後の cli-config）。Claude、Devin、Grok、および ephemeral な Codex run（通常 run と `delegate-imagegen`）は `not_exposed` を記録し、宣言した effort を実 run と突合できない。model 系フィールドは suffix 込みのモデル指定子を保持し、費用概算では suffix を剥がして価格 lookup する。

suffix 未指定時の backend 既定挙動:

| モデル名                                                                                                 | 既定 effort 挙動                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `fable`, `opus`, `sonnet`, `haiku`                                                                       | Claude `--effort` は明示しない。Claude CLI の alias 既定が適用される。                                     |
| `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`                                                | Codex effort は明示しない。インストール済み Codex CLI が受け付ける場合、その runtime 既定になる。          |
| `gpt-5`                                                                                                  | Codex effort は明示しない。インストール済み Codex CLI が受け付ける場合、その runtime 既定になる。          |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`                                                                     | Codex catalog 既定は `medium`。明示 suffix 対応 level は `low`, `medium`, `high`, `xhigh`。                |
| `gpt-5.4-nano`                                                                                           | Codex effort は明示しない。インストール済み Codex CLI が受け付ける場合、その runtime 既定になる。          |
| `gpt-5.3-codex-spark`                                                                                    | Codex effort は明示しない。Spark の availability と既定値はインストール済み Codex CLI/runtime 側で決まる。 |
| `swe-1.7`, `swe-1.7-lightning`, `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`      | Devin の separate effort flag は渡さない。選択モデルの Devin 側既定が適用される。                          |
| `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code` | Cursor effort override は渡さない。Cursor model 既定が適用される。                                         |
| `cursor-glm-5.2-high`                                                                                    | Cursor には `glm-5.2-high` を渡す。`high` は model slug に含まれる。                                       |
| `cursor-glm-5.2-max`                                                                                     | Cursor には `glm-5.2-max` を渡す。`max` は model slug に含まれる。                                         |
| `grok-build`（`DELEGATE_X_RESEARCH_MODEL`）                                                              | separate effort setting は渡さない。X 調査 backend の既定が適用される。                                    |

## モデル価格参照データ

[`shared/model-token-prices.json`](shared/model-token-prices.json) に、delegate 対象モデルファミリの token 単価スナップショットを置く。`scripts/sync-shared.ts` が各 skill ディレクトリへコピーを同梱する。これはコスト分析やレポート用の参照データであり、delegate-skills は cost gate としては使わない。

backend がトークン実測を返すが費用を報告しない場合（Codex 等）、observe usage にはこの単価表から換算した `cost_usd_estimated` を実測 `cost_usd` とは別フィールドで併記する（下流の集計が実測と換算を区別できるようにするため）。`cost_estimate_basis` に cached 単価適用の有無が入り、単価表に該当モデルが無い場合はフィールドごと省略する。

![モデル token 単価](docs/assets/model-token-prices.svg)

input が 100 万 token あたり \$1 以下、または output が 100 万 token あたり \$5 以下のモデル:

![低価格モデル token 単価](docs/assets/model-token-prices-low-cost.svg)

## アーキテクチャ

[docs/design/spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md#p:2) を参照。

## 開発

[docs/design/development.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fdevelopment.md) を参照。

## ライセンス

MIT
