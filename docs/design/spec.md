# delegate-skills 仕様

実装・調査・雑務などのタスクを安価なモデルの subagent に委譲し、トークン費用を圧縮する skill 集の仕様。

## 1. 目的

- main agent（高価なモデル）の context を汚さず、定型的・機械的な作業を安価なモデルの subagent に委譲してトークン総量を圧縮する
- 委譲先の品質ブレは main の検証フェーズで吸収し、手戻りによるトークン増を抑える

## 2. アーキテクチャ概要

実装の正本は `shared/src/**/*.ts`（TypeScript）で、`vp build` が単一ファイル CLI `shared/dist/delegate-cli.mjs`（`md2idx` 内包）へバンドルする。各 `<skill>/scripts/*.sh` はこのバンドルの対応サブコマンドへ委譲する exec shim で、実行時に必要なのは Node.js 24+ と対象バックエンド CLI のみ（`jq` / `npx md2idx` 不要）。

```
main agent
  └─ <skill>/scripts/run.sh        → delegate-cli run（通常 run の one-shot: prepare → dispatch → read-response）
      ├─ (prepare)                前提なし → モデル解決 → チェーン確認 → リクエスト生成を集約（md2idx を in-process 利用）
      │   ├─ resolve-model             モデル解決（種別env → デフォルト）
      │   ├─ check-delegate-chain      多段委譲の再帰防止（同一種別2度禁止）
      │   └─ build-request             request_file / response_file を生成（ts + 乱数を共有）
      ├─ (dispatch)                モデル名プレフィックスによる実行系分岐（決定論的なので main の推論に載せない）
      │   ├─ model が gpt* → wrapper codex（Codex 子プロセス）
      │   ├─ model が swe*|devin-* → wrapper devin（Devin CLI 子プロセス、devin -p）
      │   ├─ model が composer*|cursor-* → wrapper cursor（Cursor agent CLI 子プロセス、agent -p）
      │   └─ それ以外 → wrapper claude（Claude 子プロセス、claude -p）
      └─ (read-response)          auto / decision 等の selector で読み取り → 検証
```

通常 run の親側 happy path は `run.sh` が 1 回の Bash 呼び出しに畳む。`run.sh` は成功・失敗とも単一 JSON（`exit_code` / `status` / `content` / `content_truncated` / `response_file` / `observe_file` / `run_dir`）を stdout に返し、内部処理の exit code を透過する。resumable / follow-up、observe 監視、background 実行など途中で親の判断を挟む高度なフローは、従来どおり `prepare.sh` / `dispatch.sh` / `read-response.sh` 等の個別 shim を直接使う。observe JSON / run 出力の読み取りは `read-json.sh`（`jq -r <dotpath>` 相当）を使う。

ファイルプロトコルは実行系（claude -p / Codex / Devin CLI / Cursor agent CLI）に依存しない。request は wrapper が worker の初期 prompt へ埋め込み、response は wrapper が worker の報告を回収して組み立てる。
委譲するときは、task_type に対応する専用 skill（explore / implement / review / chore / imagegen / xresearch / htmldoc）を使い、generic な subagent へ直接流さない。

### 委譲メカニズムの選定理由

- Claude 系は **`claude -p` 子プロセス**（`delegate-claude.sh`）を使う。in-session の Agent tool は requester が Codex のとき利用できないため、Claude / Codex どちらの requester からも一貫して呼べる `claude -p` を採用する
- `gpt-*` は **Codex 子プロセス**（`delegate-codex.sh`）が必須（in-session の実行手段が無い）
- `swe-*` / `devin-*` は **Devin CLI 子プロセス**（`delegate-devin.sh`）を使う。`devin -p` は `claude -p` と同じく非対話 single-turn 起動で、`--permission-mode dangerous` で `claude --dangerously-skip-permissions` と同等の権限スキップができる。AGENTS.md は devin が自動で読む（無効化不可）ため `--ignore-rules` 相当は不要。`swe-*` は devin CLI がそのまま受理する。`devin-*` は非 Cognition モデルを Devin CLI 経由で指定するバックエンド固定プレフィックスで、`delegate-devin.sh` が `devin-` を剥離して devin CLI に渡す（`devin-glm-5.2` → `glm-5.2`）。これにより `glm-*` 等のモデル名プレフィックスを Devin 専用に拘束せず、将来の他バックエンド拡張余地を残す
- `composer-*` / `cursor-*` は **Cursor agent CLI 子プロセス**（`delegate-cursor.sh`）を使う。`agent -p` は非対話 headless 起動で `--trust` が必須。`composer-*` は Cursor 専用モデルなので agent CLI の slug をそのまま渡す（例: `composer-2.5`、`composer-2.5-fast`）。`cursor-*` は Devin 経路と同様のバックエンド固定プレフィックスで、`delegate-cursor.sh` が `cursor-` を剥離して agent CLI に渡す（`cursor-glm-5.2-high` → `glm-5.2-high`）
- requester が Codex でも Claude でも Devin でも Cursor でも、`resolve-model.sh` の出力プレフィックスに基づき適切な子プロセス（`claude -p` / `codex exec` / `devin -p` / `agent -p`）を起動する

## 3. skill 一覧

| skill                                           | 用途                                               | ツール権限                                       | 既定モデル   | env                                                                              |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------- |
| [`delegate-explore`](delegate-explore.md)       | read-only のコード/ドキュメント/Web/MCP 探索・読解 | read-only（repo 書き込みツール除外、Web/MCP 可） | `haiku`      | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| [`delegate-implement`](delegate-implement.md)   | コード実装・修正（1 コミットに収まる単位）         | Edit/Write/Bash（push なし）                     | `sonnet`     | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| [`delegate-chore`](delegate-chore.md)           | フォールバック雑務                                 | Edit/Write/Bash（push なし）                     | `haiku`      | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| [`delegate-review`](delegate-review.md)         | コード/ドキュメントレビュー（差分の指摘）          | read-only（Read/Grep/Glob）                      | `opus`       | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`                             | 画像生成/編集の capability bridge                  | Codex 子プロセス                                 | `gpt-5`      | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |
| [`delegate-x-research`](delegate-x-research.md) | x.com / X 調査の capability bridge                 | X 調査子プロセス                                 | `grok-build` | `DELEGATE_X_RESEARCH_MODEL` / `DELEGATE_WORK_DIR`                                |
| `delegate-htmldoc`                              | 固定テンプレートによる HTML ドキュメント生成       | 出力ディレクトリ書き込みのみ（push なし）        | `haiku`      | `DELEGATE_HTMLDOC_MODEL` / `DELEGATE_WORK_DIR`                                   |

delegate-review は README / spec / design docs / changelog などのドキュメント差分も対象に含める。既存の read-only / Findings 優先の枠組みは維持し、記述の矛盾、古い前提、欠けた根拠、実装との不整合を指摘対象に含める。

### 既定モデルの根拠

- explore / chore は read 中心・低リスクのため `haiku`
- implement も編集の判断を要するため `sonnet`
- review は指摘品質が成果物に直結し判断比重が高いため `opus`
- 個々のタスクが軽微なときは、その種別の既定モデルを `DELEGATE_<TYPE>_MODEL=haiku` で明示的に引き下げてコストを抑えられる
- imagegen は `DELEGATE_IMAGEGEN_MODEL` → 既定 `gpt-5` で解決するが、Codex 限定の実行系として扱う。`gpt*` 以外に解決された場合は Claude パスへフォールバックせず中止する。主目的は token cost 削減ではなく capability bridge と context isolation で、ユーザー向けには画像生成モデル選択の概念を持たせない。出力先は明示がなければ `delegate-imagegen-output/` 配下
- xresearch は `DELEGATE_X_RESEARCH_MODEL` → 既定 `grok-build` で解決し、X 調査 capability bridge として扱う。現在の実装 backend は Grok CLI。X の投稿・検索結果は時点依存なので、worker report に確認時刻と根拠 URL を残す
- htmldoc は skill 同梱の固定テンプレート（CSS + component 語彙）へ content を流し込むだけで判断比重が低いため `haiku`。デザインの一貫性はモデルではなくテンプレート資産で担保する。図・画像素材は親側で用意して request にパスで渡し（チャートは dataviz-svg、ラスタ画像は delegate-imagegen 等）、worker は SVG のインライン埋め込みとラスタ画像の出力ディレクトリへのコピー・相対参照のみ行う

## 4. モデル解決

共有 `resolve-model.sh` にロジックを一元化し、skill 固有デフォルトは各 SKILL.md が引数で渡す。

```
resolve-model.sh <種別env名> <skill固有デフォルト>
解決順: $種別env → 引数デフォルト
出力: Claude エイリアス(sonnet|haiku|opus|fable) / gpt-* / swe-* / devin-* / composer-* / cursor-* モデルID
```

env に入れる値は Claude エイリアス（claude -p の --model 引数対応）、`gpt-*` モデルID（Codex へ渡す）、`swe-*` モデルID（Devin CLI へそのまま渡す）、`devin-*` モデルID（Devin CLI へ渡す際にプレフィックスを剥離）、`composer-*` モデルID（agent CLI へそのまま渡す）、`cursor-*` モデルID（agent CLI へ渡す際にプレフィックスを剥離）の6系統に限定する。

`prepare.sh` / `prepare-imagegen.sh` は解決した `model` に加え、解決元を `model_source: "env" | "default"` として stdout JSON と observe JSON の `run.model_source` に記録する。種別 env が未設定または空文字の場合は `default`、非空の場合は `env` とする。

モデル指定子の正規形は、reasoning effort suffix を含む解決済み文字列である。`DELEGATE_<TYPE>_MODEL=<model>@<effort>` のように指定された場合、suffix 込みの文字列が `resolve-model.sh` → `prepare.sh` stdout JSON → request JSON → `dispatch.sh` → observe JSON の `run.model` / `usage.model` / `backend_session.model` まで流れる。CLI argv を組む直前に各 wrapper 冒頭で共有ヘルパ `delegate_observe_split_model_effort` が `{base_model, effort}` へ分解し、`ORIGINAL_MODEL` は observe 記録・follow-up 検証用の suffix 込み指定子、`MODEL` は target CLI に渡す base model として扱う。follow-up は前回 observe の suffix 込み指定子を継承するため、同じ effort flag で再起動される。

effort suffix は opt-in で、`@` が無い場合の起動 argv は backend 既定のまま変えない。不正な suffix、backend 非対応の suffix、Cursor の slug（`-high` / `-max`）と `@` の二重指定は `prepare.sh` が dispatch 前に exit 6 で fail-closed し、wrapper 直接起動でも同じ共有検証で CLI 起動前に停止する。

## 5. 実行系の四分岐

`resolve-model.sh` の出力プレフィックスで選ぶ。分岐は決定論的なので main agent には委ねず、`dispatch.sh` が行う。

| 種別      | Claude パス（`claude -p -m <model>`）                                                                    | Codex パス（`codex exec -m <model>`）        | Devin パス（`devin -p --model <model>`）    | Cursor パス（`agent -p --model <model>`） |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| explore   | `--dangerously-skip-permissions` + `--disallowedTools "Edit,MultiEdit,Write,NotebookEdit"` + constraints | `--sandbox danger-full-access` + constraints | `--permission-mode dangerous` + constraints | `--trust` + `--force` + constraints       |
| implement | `--dangerously-skip-permissions`                                                                         | `--sandbox danger-full-access`               | `--permission-mode dangerous`               | `--trust` + `--force`                     |
| chore     | `--dangerously-skip-permissions`                                                                         | `--sandbox danger-full-access`               | `--permission-mode dangerous`               | `--trust` + `--force`                     |
| review    | `--dangerously-skip-permissions` + `--allowedTools "Read,Bash"`                                          | `--sandbox danger-full-access` + constraints | `--permission-mode dangerous` + constraints | `--trust` + `--force` + constraints       |
| htmldoc   | `--dangerously-skip-permissions` + constraints                                                           | `--sandbox danger-full-access` + constraints | `--permission-mode dangerous` + constraints | `--trust` + `--force` + constraints       |

Devin パスの `<model>` は `swe-*` はそのまま、`devin-*` はプレフィックス剥離後の値。Cursor パスの `<model>` は `composer-*` はそのまま、`cursor-*` はプレフィックス剥離後の値。

`delegate-imagegen` は同じモデル解決を使うが、画像生成 capability bridge のため `gpt*` → `delegate-imagegen-codex.sh` のみを許可し、非 `gpt*` では fail-closed する。

`delegate-x-research` は同じ request/response protocol を使うが、モデル名プレフィックスでは分岐せず現在は `delegate-x-research-grok.sh` で Grok CLI を直接起動する。Claude / Codex へフォールバックしない。

### Claude パスの起動

`delegate-claude.sh` は `delegate-codex.sh` と対称構造の Claude 子プロセスラッパ。

- `claude -p` で非対話モードの子プロセスを起動
- `--model "$MODEL"` でモデル指定（effort suffix があれば分解後の base model を渡し、`ORIGINAL_MODEL` を observe 記録に使う）
- effort suffix がある場合は `--effort <value>` を追加する
- `--dangerously-skip-permissions`（非対話のため permission prompt は使えない）
- `--no-session-persistence`（エフェメラル実行。セッションをディスクに残さない）
- read-only 種別ではリポジトリ書き込みツールを技術的に除外する。explore は WebSearch / WebFetch / MCP 探索を開放するため `--disallowedTools "Edit,MultiEdit,Write,NotebookEdit"`（denylist。MCP ツール名は実行環境の MCP 設定依存で allowlist に事前列挙できない）、review は従来どおり `--allowedTools "Read,Bash"`（allowlist）。Codex パスでは sandbox が同等の制約を提供できないため、この防御層は Claude パス固有
- explore の MCP 利用は読み取り系ツールのみに常時制限する。制約（プロンプトレベル）は全 backend の worker プロンプトに注入する（`shared/src/prompt-constraints.ts`）。MCP への書き込みを伴う作業は read-only でない種別（chore / implement）へ委譲する
- 通常 run は親の user スコープ MCP 設定を実行環境の共有設定として自然継承し、observe JSON には `mcp_config.source: "shared"` を記録する。resumable initial run では親 `~/.claude.json`（`CLAUDE_CONFIG_DIR` 設定時は `$CLAUDE_CONFIG_DIR/.claude.json`）の `mcpServers` を `delegate-mcp.ts`（`mcpExtract*`）で抽出し、session home の `mcp-config.json` を `--mcp-config` で注入する。follow-up は初回生成物を再利用し、初回と同じ MCP サーバー集合を保つ。親設定に MCP サーバーが無ければ生成物を作らず `source: "none"` とする
- cwd を `$REPO_ROOT` に切り替えて起動（対象リポジトリ root で実作業）
- worker は構造化最終応答 `{status, report_markdown}` だけを返す。wrapper は `--json-schema` で schema を強制し、stream-json result event の `structured_output` を回収して response_file を組み立てる
- stdout は response_file のパスのみ

### Codex パスの起動

`delegate-codex.sh` は [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) の起動骨格を流用する。

- 隔離 `CODEX_HOME`（通常 run / resumable initial / follow-up の各起動直前に root requester の `auth.json` だけコピーしログイン維持）/ TMPDIR 隔離
- 正常終了時（response 生成済みかつ protocol status が failed でない場合）に隔離 codex-home のキャッシュ類（`.tmp` / `tmp` / `cache` / `models_cache.json` / `plugins` / `shell_snapshots`）を prune する（`DELEGATE_CODEX_HOME_PRUNE=0` で無効化）。`auth.json` は同じ directory の一意な owned staging file へ `COPYFILE_EXCL` 相当で書き、hard-link publish により stale destination を置換せず、partial-copy failure は staging file を削除して child 起動前に fail-closed する。lifecycle lease は staging 開始前に登録し、owned staging / published artifact だけを追跡して cleanup 完了後に signal handler を解除する。lifecycle は stage → spawn/wait → auth cleanup → response/session/dispatch finalize の順で各1回とし、stage / cleanup 中または spawn / child exit と競合する SIGINT / SIGTERM でも lease が cleanup する。cleanup failure または同期 operation exception は resumable success metadata を残さない exactly-once の sanitized failed terminal state と非 0 exit に変える。cleanup は cache prune と分離し、child error、response 欠落、child signal、wrapper termination を含む全終了経路で行う。follow-up home は所有 user、非 symlink、`delegate_*` run、隣接 previous observe の backend / model / resume id / persistence / home_dir 一致を起動前に検証し、root requester home と無関係な外部 home を拒否する。sessions JSONL と `config.toml` は follow-up と診断のため常に残す
- 親の user スコープ MCP 設定を `codex mcp list --json` で抽出し、隔離 `CODEX_HOME/config.toml` に `mcp_servers` のみを書き出す。worker は生成済み config だけを読むため `--ignore-user-config` は付けない。follow-up は初回 run の隔離 `CODEX_HOME/config.toml` を再利用し、初回と同じ MCP サーバー集合を保つ。親設定に MCP サーバーが無ければ config を作らず `mcp_config.source: "none"` とする
- `--skip-git-repo-check --ephemeral`
- `--ignore-rules` は**付けない**（AGENTS.md を読ませ規約遵守させる）
- `--sandbox danger-full-access`
- `-C "$REPO_ROOT"`（隔離 cwd ではなく対象リポジトリ root で実作業）
- worker は構造化最終応答 `{status, report_markdown}` だけを返す。wrapper は `--output-schema` で schema を強制し、`--output-last-message` の出力から回収して response_file を組み立てる
- stdout は response_file のパスのみ

### Devin パスの起動

`delegate-devin.sh` は `delegate-claude.sh` と対称構造の Devin CLI 子プロセスラッパ。

- `devin -p` で非対話 single-turn モードの子プロセスを起動
- `--model "$MODEL"` でモデル指定（`devin-*` プレフィックスは剥離済み、`swe-*` は `resolve-model.sh` の出力をそのまま渡す）
- `--permission-mode dangerous`（非対話のため permission prompt は使えない。`claude --dangerously-skip-permissions` と同等）
- 親の user スコープ MCP 設定を実行環境の共有設定として自然継承し、observe JSON には `mcp_config.source: "shared"` を記録する
- AGENTS.md は devin が自動で読む（無効化不可）ため `--ignore-rules` 相当のオプションは付けない
- read-only 種別（explore / review）のツール制限は Claude パスの `--allowedTools` 相当の CLI フラグが無いため、Codex パスと同様に prompt の constraints と main の検証フェーズに依存する
- cwd を `$REPO_ROOT` に切り替えて起動（対象リポジトリ root で実作業）
- worker は run_dir 配下の `report.md` に front-matter `status: <completed | partial | failed | needs_input>` 付き Markdown を 1 回で書く。wrapper は front-matter を剥がして response_file を組み立てる
- stdout は response_file のパスのみ

### Cursor パスの起動

`delegate-cursor.sh` は `delegate-claude.sh` と対称構造の Cursor agent CLI 子プロセスラッパ。

- `agent -p` で非対話 headless モードの子プロセスを起動
- 隔離 `CURSOR_CONFIG_DIR`（run_dir 配下の disposable config dir に、authInfo を含む既存 `cli-config.json` をコピーしログイン維持）/ TMPDIR 隔離。agent CLI は起動時に `<config dir>/cli-config.json` を tmp ファイル + rename で書き換えるため、共有 config のままだと並列 dispatch 同士で rename が競合し片方が ENOENT で即死し得る。コピー元の config dir 解決順（`CURSOR_CONFIG_DIR` → `XDG_CONFIG_HOME/cursor` → `~/.cursor`）は CLI 本体と揃える。`CURSOR_CONFIG_DIR` 未対応の古い CLI では env が無視され従来の共有 config 動作（並列競合リスクあり）になる
- 親 global `mcp.json` の `mcpServers` を `delegate-mcp.ts`（`mcpExtract*`）で抽出し、隔離 `CURSOR_CONFIG_DIR/mcp.json` へ書き出す。MCP サーバーがある場合は `--approve-mcps` を付け、observe JSON には `mcp_config.source: "injected"` とサーバー名を記録する。Cursor は初回 run / follow-up とも run ごとに親設定から再生成する
- `--model "$MODEL"` でモデル指定（`cursor-*` プレフィックスは剥離済み、`composer-*` は resolve-model.sh の出力をそのまま渡す）
- `--trust` + `--force`（headless 起動のため workspace trust / permission prompt に応答できない）
- read-only 種別（explore / review）の編集抑止は Claude パスの `--allowedTools` 相当の CLI フラグが無いため、Codex / Devin パスと同様に prompt の read-only 制約と main の検証フェーズに依存する（`--mode plan` は report.md 方式と相性が悪いため使わない。下記参照）
- cwd を `$REPO_ROOT` に切り替えて起動（対象リポジトリ root で実作業）
- worker は run_dir 配下の `report.md` に front-matter `status: <completed | partial | failed | needs_input>` 付き Markdown を 1 回で書く。wrapper は front-matter を剥がして response_file を組み立てる
- stdout は response_file のパスのみ

#### `--mode plan` を使わない理由

Cursor agent CLI の `--mode plan`（`--plan` の shorthand）は **read-only / planning モード** で、リポジトリへの編集ツールを CLI 側で抑止する。一見 explore / review に適合するが、Cursor パスの報告は report.md 方式であり、worker は run_dir 配下へ `report.md` を書く必要がある。plan mode は no edits 前提のため、この書き込みと両立しない。

そのため Cursor パスは Codex / Devin パスと同方針とし、全 task_type で `--trust` + `--force` を付与する。explore / review の read-only 性は prompt に明示する制約と main の検証フェーズで担保する。

### sandbox / permission を全開放に統一する理由

- Codex: implement / chore / htmldoc は作業自体にリポジトリや出力先への書き込みが必要で、検証コマンドも通常の shell 権限で実行する。read-only 種別の編集抑止は sandbox ではなく prompt constraints と main の検証フェーズに依存する。構造化最終応答方式により protocol response 書き込みは wrapper 側に移ったため、今後 read-only sandbox を適用できる余地は従来より広い
- Claude: `claude -p` は非対話なので permission prompt に応答できない。`--dangerously-skip-permissions` が必須
- Devin: `devin -p` は非対話なので permission prompt に応答できない。`--permission-mode dangerous` が必須
- Cursor: `agent -p` は headless なので workspace trust prompt に応答できない。`--trust` + `--force` が必須。read-only 種別の編集抑止は prompt 制約と main の検証フェーズに依存する（`--mode plan` は report.md 方式と相性が悪いため使わない）
- トレードオフ: push 抑止・explore の read-only 性は sandbox / permission では強制されず prompt の constraints と main の検証フェーズに依存する

## 6. ファイルプロトコル（protocol v1）

main が request_file / response_file を事前確保する。詳細は [protocol-v1.md](protocol-v1.md)。

### 命名

`build-request`（`shared/src/build-request.ts`）が命名する。置き場は `DELEGATE_WORK_DIR`、無ければ `TMPDIR`、無ければ `/tmp`。ファイル名は `delegate_<type>_<ts>_<token>_req.json` で、`<ts>` は `runTimestamp()`（`YYYYMMDD_HHMMSS`）、`<token>` は `randomToken(5)`。名前衝突時は `openSync(..., 'wx')`（排他作成）が EEXIST を返すので token を引き直す（bash 版の mktemp 相当。予約は 0600 で作る）。

```
delegate_<type>_<ts>_<token>_req.json     # request（0600）
delegate_<type>_<ts>_<token>_res.json     # response（0600）
delegate_<type>_<ts>_<token>_observe.json # observe（0600）
delegate_<type>_<ts>_<token>/             # run_dir（run ごとの scratch）
```

- request_file と response_file は `<ts>` とランダムトークンを共有し、末尾の `_req`/`_res` だけが異なる → 同一秒に並列実行してもファイル名から両者の対応関係を一意特定できる
- 乱数の出所は request 予約時の `randomToken(5)` 1 箇所。一意性も保たれる
- クリーンアップ: request / response / observe JSON は残す（監査・デバッグ用）。run ごとの scratch directory は `DELEGATE_RUN_RETENTION_DAYS` に正の整数を指定した場合だけ、request 準備時に同じ `DELEGATE_WORK_DIR` 配下の古い directory を削除する。`state.phase == "running"` の observe JSON を持つ directory は active とみなして削除しない。既定では自動削除しない
- **main 事前確保の利点**: main は sub の最終メッセージをパースせずに response_file パスを決定的に知れる。sub の返答が崩れてもパスを見失わない

### 人間向け Markdown 派生物

request / response の JSON は protocol の source of truth とし、agent 間通信・互換性判定・段階読み取りは JSON だけを見る。一方、監査・デバッグで人間が読みやすいよう、JSON 書き出し後に同じ basename の `.md` を best-effort で生成する。実装は `protocol.ts` の `writeCompanionMarkdown` が `sections` を `\n\n` で結合して `<basename>.md` に書く（`build-response` / wrapper が呼ぶ）。

`.md` は `sections` を結合した補助成果物であり、`task_type_chain` / `requester_session_id` / `status` / `responder_session_id` などの構造化メタデータは正本 JSON に残す。`.md` 生成に失敗しても protocol の成否は JSON 生成結果で判定する。

### observe JSON（機械監視）

request / response と同じペアトークンから `<pair>_observe.json` と `<pair>/` run_dir を導出する。`prepare.sh` は `request_file` / `response_file` に加えて `run_dir` / `observe_file` を stdout JSON で返し、親は通常経路では observe JSON 全体や stdout/stderr content を読まず、`read-json.sh`（`jq -r <dotpath>` 相当）で必要な小さい field だけを読む。

`dispatch.sh` と各 delegate wrapper は `run_dir` を必ず受け取り、wrapper-local な scratch file（隔離 home、last-message、stdout/stderr capture file、observe lock、`tmp/` 等）をすべてその配下に置く。共有 `DELEGATE_WORK_DIR` 直下には置かず、同じ `DELEGATE_WORK_DIR` で複数 delegate が並行しても run ごとの scratch と observe JSON が混ざらないことを契約とする。

observe JSON に記録する `backend` は model prefix ではなく実行系名（`claude` / `codex` / `devin` / `cursor`）に固定する。モデル名は `run.model` に持つ。

```json
{
  "schema_version": 1,
  "run": {
    "task_type": "implement",
    "model": "sonnet",
    "model_source": "default",
    "backend": "claude",
    "request_file": "..._req.json",
    "response_file": "..._res.json",
    "run_dir": ".../delegate_implement_...",
    "requester_session_id": "..."
  },
  "state": {
    "phase": "running",
    "dispatcher_pid": 12345,
    "started_at": "2026-07-04T12:34:57Z",
    "ended_at": null,
    "exit_code": null,
    "duration_ms": null,
    "response_present": false
  },
  "heartbeat": {
    "ts": "2026-07-04T12:35:07Z",
    "backend": "claude",
    "child_pid": 12346,
    "stdout_bytes": 0,
    "stderr_bytes": 84,
    "last_stream_change_at": "2026-07-04T12:34:59Z"
  },
  "usage": {
    "input_tokens": 12345,
    "output_tokens": 678,
    "total_tokens": 13023,
    "cost_usd": 0.0123,
    "measurement": "measured",
    "source": "claude_stream_json",
    "model": "sonnet",
    "backend": "claude"
  },
  "mcp_config": {
    "source": "injected",
    "servers": ["notion", "atlassian"]
  },
  "events": [
    { "kind": "run_created", "ts": "2026-07-04T12:34:56Z" },
    {
      "kind": "dispatch_start",
      "ts": "2026-07-04T12:34:57Z",
      "backend": "claude",
      "dispatcher_pid": 12345
    },
    {
      "kind": "stall_timeout",
      "ts": "2026-07-04T12:42:57Z",
      "backend": "claude",
      "child_pid": 12346,
      "timeout_seconds": 300,
      "idle_seconds": 300,
      "stdout_bytes": 0,
      "stderr_bytes": 84
    }
  ],
  "streams": {
    "stdout": { "bytes": 0, "truncated": false, "content": "" },
    "stderr": { "bytes": 84, "truncated": false, "content": "..." }
  }
}
```

- `state.phase`: `prepared | running | superseded | stalled | ended`。observe JSON は prepare 時点で作られるため、main が dispatch 前にリクエストを作り直すと放棄された observe が `prepared` のまま WORK_DIR に残留し得る。集計・監視は observe の全数を往復の全数とみなさず、`state.phase` で除外すること。特に usage を集計する消費者は、dispatch されなかった observe（`prepared` / `superseded`。`usage` は未設定で read-json では null 相当）を分母から除外すること。この判定には `state.started_at == null` も同値に使える。dispatch は同一 WORK_DIR / 同一 task_type / 同一 requester で dispatch 時点より mtime が古い prepared-only observe に `superseded` を付ける（basename の timestamp は秒精度で同一秒内の順序を表せないため mtime で判定する。run_dir が `DELEGATE_RUN_RETENTION_DAYS` で削除済みの候補は、削除済み directory を復活させないため触らない）。マークは best-effort であり `prepared` 残留が完全に無くなる保証はない
- `run.model_source`: `env | default`。`prepare.sh` / `prepare-imagegen.sh` 経由で初期化された observe JSON に入り、wrapper が直接初期化した fallback 経路では省略される場合がある
- `state.dispatcher_pid`: `dispatch.sh` または専用 wrapper の管理プロセス PID。子 CLI の kill 対象ではない
- `heartbeat.child_pid`: 実際の子 CLI PID。子 CLI 起動前の preflight failure では dispatcher PID が入る場合がある
- `state.duration_ms`: 終了時だけ設定する。実行中 timeout は `state.started_at` と現在時刻から利用側が計算する
- `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes`: capture file の現在サイズ。content を読まずに低コストで stream 進捗を判定する
- `heartbeat.last_stream_change_at`: 直近 heartbeat で stdout/stderr bytes が増えた時刻
- `usage.measurement`: `measured | estimated`。CLI の構造化出力や Codex session JSONL から実測できた場合は `measured`、取得不能時の chars/4 fallback は `estimated`
- `usage.cached_input_tokens`: 実測でキャッシュ読みトークンの内訳が取れた場合に入る（取れない backend では null）
- `usage.cost_usd_estimated` / `usage.cost_estimate_basis` / `usage.pricing_source`: 実測トークンはあるが CLI が費用を報告しない（`cost_usd` が null の）場合に、同梱の `model-token-prices.json` から換算した概算を**実測 `cost_usd` とは別フィールドで**併記する（下流の集計が精度を区別できるようにするため）。`cached_input_tokens` が取れた場合は cached 単価を適用し `cost_estimate_basis: "cached_input_rate_applied"`、取れない場合は非キャッシュ単価による上限寄り概算で `"uncached_input_rate_upper_bound"` になる。単価表に該当モデルが無い・単価が null の場合はフィールドごと省略する（null は埋めない）
- `usage.estimation_basis`: `estimated` のときだけ入る。`protocol_payload_only` は request/response のプロトコルペイロード分だけを数えた値で、子ワーカーの実消費（コンテキスト読み込み・ツール往復・思考）を含まない**下限値**を意味する。実測近似ではないため、実測 backend とのモデル間比較には使わないこと（usage を出さない cursor backend は常にこの推定になる）
- `usage.source`: `claude_stream_json` / `codex_json` / `codex_session_jsonl` / `devin_atif_export` / `cursor_json` / `devin_json` / `chars_4` など、usage の由来
- `mcp_config.source`: `shared | injected | none`。`shared` は親の user スコープ MCP 設定を実行環境の共有設定として自然継承したこと、`injected` は wrapper が親設定から worker 用 config を run dir / session home 配下に生成して注入したこと、`none` は親設定に利用可能な MCP サーバーが無く生成物も注入フラグも無いことを示す
- `mcp_config.servers`: wrapper が注入した MCP サーバー名の配列。`shared`（実設定の自然継承）では wrapper が構成を所有しないため列挙せず空配列にする。`none` も空配列。定義本体・command・env・認証情報は observe JSON に記録しない
- `events[].kind == "usage_parse_failed"`: 実測 usage が取れず推定 fallback に落ちたことを示す。usage 観測は補助情報のため、この event 自体では delegate 本体を失敗にしない
- `timing`: 完了 run の所要時間テレメトリ。`total_ms` / `time_to_first_useful_event_ms` / `report_ready_at_ms` は monotonic clock 由来の経過 ms とし、backend stream から取れる `model_turns` / `tool_calls` と `measurement_source` を併記する。Claude / Codex の構造化最終応答方式では `structured_output_parse` に parse 成否（`true` / `false`）を記録し、report.md 方式では `null` とする
- `events[].kind == "superseded"`: dispatch 済みの新しい run が、放棄された古い prepared-only observe に付けるマーク。`superseded_by` に新しい observe の basename が入る。並列 dispatch 直前の observe を誤マークしても、その run の dispatch_start が phase を `running` で上書きするため自己修復する
- `events[].kind == "stall_timeout"`: `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` 有効時、stdout/stderr bytes が指定秒数増えず wrapper が子 CLI を kill したことを示す。wrapper は exit code `124` を返し、response 未生成なら failed response を書く。event の `process_tree`（pid / ppid / 経過秒 / コマンドの行配列）に kill 時点の子プロセスツリーを残し、何を待って停滞したかを stream content の目視なしで切り分けられるようにする
- `streams.*.content`: 終了時または preflight failure 時の状況把握用。既定で末尾 `DELEGATE_OBSERVE_STREAM_MAX_BYTES` bytes だけを残し、超過時は `truncated: true` と総 bytes を記録する
- `lineage`: opt-in の resumable / follow-up run だけに入る。`lineage_id` と、follow-up では前回 `observe_file` への `followup_of` を持つ
- `backend_session`: opt-in の resumable / follow-up run だけに入る backend resume metadata。`backend` / `model` / `resume_id` / `resume_source` / `persistence` / `home_dir` を持ち、`persistence: "resumable"` のときだけ follow-up 対象になる
- `run_context`: opt-in の resumable / follow-up run だけに入る stale-context 判定情報。`repo_root` / `worktree_root` / `git_head` は必須、`git_branch` / `dirty` は補助情報

observe JSON の更新は `shared/src/observe-{store,lock,followup,…}.ts` に集約し、observe file basename 派生の lock を `run_dir` 配下に置く。lock は **symlink lock**（`ln -s` / `fs.symlinkSync` の atomic 作成で target に保持者 `<pid> <token>` を埋め込む）に統一する（Node に `flock` が無く bash=flock / TS=symlink の混在では相互排他が破れるため）。更新は temporary file に書いてから `mv` する atomic replace とする。

watchdog の通常判定は `read-json.sh`（`jq -r <dotpath>` 相当のバンドル内蔵リーダ）で必要 field だけを読む:

```bash
phase="$(read-json.sh .state.phase "$observe_file")"          # prepared|running|superseded|stalled|ended
exit_code="$(read-json.sh .state.exit_code "$observe_file")"
present="$(read-json.sh .state.response_present "$observe_file")"
# 正常終了は phase=ended && exit_code=0 && present=true。監視は heartbeat の
# .heartbeat.ts / .heartbeat.stdout_bytes / .heartbeat.last_stream_change_at 等を同様に読む
```

内部 stall watchdog は既定では無効で、`DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` に正の整数を指定したときだけ動く。判定は heartbeat が更新する byte counter と `last_stream_change_at` だけを使い、通常経路では stdout/stderr content を読まない。CLI が長時間 silent でも正常な backend では、この値を未設定または十分大きくする。

### リクエストファイル（main → sub）

```json
{
  "protocol_version": 1,
  "type": "request",
  "task_type": "implement",
  "model": "sonnet",
  "task_type_chain": ["implement"],
  "requester_session_id": "...",
  "index": "...",
  "sections": ["..."]
}
```

- `type`: 固定値 `request`（ファイル種別の自己記述）
- `model`: 依頼先のモデル名。`prepare.sh` で解決した値を格納する
- `task_type_chain`: 委譲チェーン（先祖種別 + 自種別）。再帰防止に使う
- `requester_session_id`: 必須。リクエスト元（親）のプロセス / セッション ID（追跡・デバッグ用）
- `index` / `sections`: 指示 Markdown（Objective / Scope / Context / Acceptance criteria / Verification / Constraints）の md2idx 出力
- response_file パスは prompt で渡す（request file には含めない）
- JSON 書き出し後、人間向けに `${request_file%.json}.md` を補助生成する

### レスポンスファイル（sub → main）

```json
{
  "protocol_version": 1,
  "type": "response",
  "status": "completed",
  "responder_session_id": "...",
  "index": "...",
  "sections": ["..."]
}
```

- `protocol_version`: リクエストと揃える（バージョン差検出用）
- `type`: 固定値 `response`（ファイル種別の自己記述）
- `status`: `completed | partial | failed | needs_input`（構造化フィールド。main が最優先・最安に読む）
- `responder_session_id`: 必須。リクエスト先（子）のプロセス / セッション ID（追跡・デバッグ用）
- `index` / `sections`: 報告 Markdown（Summary / Changed files / Commands / Verification / Findings / Blockers / Error）の md2idx 出力。検証結果は構造化フィールドに持たず、報告 Markdown の Verification section に収め、main は `status` の次にこの section だけを必要時に引く
- JSON 書き出し後、人間向けに `${response_file%.json}.md` を補助生成する

### response 組み立ての責務

response_file の組み立ては wrapper 側の責務とする。worker は md2idx / jq / build-response.sh を実行せず、報告本体だけを返す。

- Claude / Codex は構造化最終応答方式。worker は `{status, report_markdown}` を最終応答として返し、wrapper が schema 強制済みの出力を回収して response_file を組み立てる。Claude は stream-json result event の `structured_output`、Codex は `--output-last-message` の内容を使う
- Cursor / Devin / Grok は report.md 方式。worker は run_dir 配下の `report.md` に front-matter `status:` 付き Markdown を 1 回で書き、wrapper が front-matter を剥がして response_file を組み立てる
- いずれも回収失敗（構造化出力欠落、status 不正、report.md 欠落や front-matter 不正）は wrapper が failed response を生成する fail-closed とする。構造化最終応答方式の parse 成否は observe JSON の `timing.structured_output_parse` に記録する

### failed response（wrapper 生成）

子 CLI が異常終了し、かつ response_file が未生成の場合、wrapper は protocol v1 の短い failed response を best-effort で生成する。親の読み取り経路を `read-response.sh auto` に統一しつつ、secret や巨大ログの混入を避ける。

- `status: failed`
- `responder_session_id: wrapper:<backend>:<response basename>`
- report は Summary / Error / Logs の短い section に留め、stderr の全文は埋め込まず observe JSON path と短い要約だけを載せる
- response 生成が失敗する段階では failed response 生成に固執せず、observe event と stderr 保存を優先して既存の stderr exit に fallback する

### md2idx（トークン圧縮の核）

`md2idx` は CLI バンドルに npm 依存として内包され、`build-request` / `build-response` が in-process で library として呼ぶ（`npx` や jq の子プロセスは無い）。request は指示 Markdown を md2idx に通して `index` / `sections` を生成し、その前に構造化キー（`protocol_version` / `type` / `task_type` / `model` / `task_type_chain` 等）を前置する。response は wrapper が worker から回収した報告 Markdown を build-response に渡し、`index` / `sections` と構造化キー（`protocol_version` / `type` / `status` 等）を持つ JSON に変換する。

response の読み手（main）は `status` → `index` → 必要 section の順で段階読み取りする。ただし段階読みは複数往復を要するため、`read-response.sh auto` は response が小さい（`DELEGATE_RESPONSE_INLINE_MAX`、既定 10KB 未満）ときは status と全 section を 1 回で丸読みし、大きいときは status + index + Summary section だけを返して残りを `<N>` のオンデマンド取得に回す（小さな report では丸読みの方が往復が少なく安く、大きな report では main が要る情報の多くは Summary で足りる）。observe JSON / run 出力の個別フィールド抽出は `read-json.sh`（`jq -r <dotpath>` 相当のバンドル内蔵リーダ）を使う。

request の worker への受け渡しは、wrapper が検証済み request JSON の `.sections` と `task_type_chain` を初期 prompt へ埋め込む運用を既定とする。gate は `DELEGATE_REQUEST_INLINE_MAX`（既定 256KB）で、超過時のみ `read-request.sh` 指示へ fallback する。prompt は Claude / Codex / Cursor が stdin、Devin が `--prompt-file`。Grok と Codex follow-up は argv 渡しが残るため、未実測の暫定措置として埋め込み gate を 96KB に縮小する。md2idx はバンドルに内包されるため runtime 前提条件ではない（Node.js が動けば使える）。

### 任意 telemetry（proxy metric）

`DELEGATE_METRICS_FILE` が設定されたときだけ、共有スクリプトは JSONL に proxy metric を追記する。通常運用では未設定で、挙動も出力も変えない。metrics 書き込みは best-effort であり、書き込み先の作成や追記に失敗しても本処理は継続する。記録対象は `prepare.sh` / `build-request.sh` / `read-request.sh` / `build-response.sh` / `read-response.sh` と dispatch 完了で、主なフィールドは `kind`、対象ファイル、selector、inline 判定、section 数、`bytes` / `chars` / `lines` / `estimated_tokens`、`duration_ms`、observe JSON 由来の `timing`。`read-request.sh` / `read-response.sh` はファイル全体サイズに加え、実際に stdout へ出した `selected` 量を記録する。この telemetry は実課金額ではなく、main が読んだ response 量、worker が読んだ request 量、orchestration event 数を比較するための近似である。

`shared/model-token-prices.json` はモデルごとの token 単価スナップショットを持つ基礎データであり、`scripts/sync-shared.ts` で各 skill ディレクトリへ同梱する。metrics の分析やレポートで参照するためのデータであり、delegate の起動可否を判定する cost gate には使わない。価格は外部サービス側で変わるため、実行時制御の source of truth ではなく、更新日と参照元を含む手動更新データとして扱う。参照元に明示価格が無いモデルは、推測値を入れず `null` と `pricing_status` で表す。

### main 側の context / cache 規律（コスト最適化）

main が最高級モデルのとき、削減は「委譲」とは独立の別レイヤーとしても効く。md2idx 圧縮と乗算で効く原則:

- **append-only**: 過去ターン（SKILL.md / プロトコルの規約文、既読の response）を再注入・再要約しない。プレフィックスを保てば prompt cache のヒット率が上がる
- **最小・一度きりの読み取り**: 各 response は `status` → 必要 section を1回で済ませ、同じ response_file を後続ターンで再 Read しない（再読は tool result として二重計上される）
- **echo しない**: sub の出力本文を main が要約し直さない（main の出力が次ターンの入力として二重計上される）。response の Summary section を参照させる
- **多段委譲は TTL 内に詰める**: §8 の多段（`implement ⇒ explore` 等）は間を空けず連続実行し、確認待ちは1点に集約して cache TTL 跨ぎの再キャッシュを避ける

## 7. セッション再利用（opt-in）

通常 delegate run は非永続のまま維持する。親が初回 request の時点で follow-up 可能性が高いと判断した場合だけ、`prepare.sh` の第 6 引数に `resumable` を渡して resumable initial run を作る。`prepare.sh` は `lineage_id` と `run_context` を observe JSON に記録し、`dispatch.sh` は第 7〜9 引数（`session_mode` / `resume_arg` / `session_home`）を backend wrapper へ渡す。

follow-up は新しい request/response/observe/run_dir を作る別 run として扱う。親は `prepare.sh` 第 6 引数に `followup=<前回observe_file>` を渡す。prepare は前回 observe JSON の `lineage` / `backend_session` / `run_context` を読み、backend / model / repository context / git HEAD の互換性を検証する。成功時は stdout JSON に `session_mode: "followup"`、`resume_id`、`resume_source`、`backend_session_home` を返し、親はそれを `dispatch.sh` 第 7〜9 引数へ渡す。

`responder_session_id` は protocol v1 response の追跡 ID であり、backend resume handle ではない。resume handle は observe JSON の optional metadata `backend_session.resume_id` にだけ持つ。通常 run や handle 抽出失敗 run は follow-up 対象にしない。

Claude / Codex / Devin / Cursor wrapper は resumable initial run と follow-up run を support する。Codex follow-up は `codex exec resume` が cwd を復元せず `-C` / `--sandbox` を受けないため、wrapper が `cd "$REPO_ROOT"` してから起動し、`-c sandbox_mode=...` で初回 run と同等の sandbox を指定する。

MCP 構成は backend ごとに扱いが異なる。Claude / Codex follow-up は初回 resumable run で生成した session home 配下の MCP config を再利用し、初回と同じサーバー集合を保つ。Cursor follow-up は run ごとに親 global `mcp.json` から隔離 config を再生成する。Devin は通常 run と同じく実行環境の共有設定を使う。

follow-up は fail-closed であり、次の条件では新規実行へ暗黙 fallback しない:

- 前回 observe JSON が無い、または `backend_session.persistence` が `resumable` ではない
- `backend_session.resume_id`、`run_context.repo_root`、`run_context.worktree_root`、`run_context.git_head` のいずれかが無い
- backend / model / repo root / worktree root が現在の request と一致しない
- lineage 最新 run の run 終了後 `git_head` が現在の HEAD と一致せず、かつ現在 HEAD の ancestor でもない
- 前回 run_dir の retention などにより backend session home が失われている

`git_head` は prepare 時にも記録するが、wrapper が run 終了後に更新する。`delegate-implement` は worker がコミットを作るため、follow-up 検証では run 終了後 HEAD との一致を優先し、親が追加コミットした場合は記録 HEAD が現在 HEAD の ancestor なら許容する。dirty worktree は許容するが、親は follow-up request に最新の確認結果、対象 diff、前回 response_file / Verification の参照を含める。

## 8. 多段委譲ポリシー（再帰防止）

- delegate された sub も別種別の delegate skill を呼べる（`implement ⇒ explore` は可）
- **同一種別がチェーンに二度登場することを禁止**（`implement ⇒ implement` も `implement ⇒ explore ⇒ implement` も不可、`implement ⇒ explore ⇒ review` は可）
- 種別が有限（explore / implement / chore / review / imagegen / xresearch / htmldoc）なのでチェーン長が頭打ちになり無限ループが構造的に発生しない
- チェーンは request file の構造化キー `task_type_chain`（先祖種別 + 自種別）で持ち回る。Claude パスは env が Bash 呼び出し間で持続しないため `task_type_chain` を source of truth とし子起動時に明示的に渡す
- 起動エントリで `check-delegate-chain.sh <task_type> <parent_task_type_chain>` を実行、該当すれば exit 4

## 9. delegate-chore からの skill 昇格提案

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。親エージェントはレスポンス消費後に評価する。

- **トリガ**: その chore が繰り返し現れる / 明確にスコープされた再利用可能なカテゴリのとき（一度きりの些末な chore では提案しない）
- **提案**: `AskUserQuestion` で専用 `delegate-<name>` skill 作成を提案（想定名 / 既定モデル / ツール権限 / 起動種別を添える）
- **生成**: 合意後 skill-creator で雛形を作り本プロトコル（resolve-model 既定の引数渡し / delegate-claude.sh・delegate-codex.sh 対称構造 / md2idx / 多段委譲チェーン参加）に沿わせる。新種別は `task_type_chain` 禁止対象に自動的に加わる

### TODO: 有望な追加・拡張候補

- `delegate-test-analysis`: 長い test / CI / typecheck / snapshot / coverage log を read-only に解析し、main が巨大ログを直接読まずに失敗原因・関連ファイル・再実行すべき検証だけを受け取る専用 skill を検討する。修正作業は `delegate-implement` に分け、test-analysis はログ読解と仮説提示に閉じる

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、**LLM の判断を要さず決定論的に自動化できる手順**を検出したら、親エージェントは自動化を提案する。

- **トリガ**: 同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断が要らないとき（毎回同じ `git` 連打、固定パイプライン、機械的な一括置換など）
- **提案**: `AskUserQuestion` で、スクリプト化 / git hook / npm script / CI など適切な自動化手段を提示する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない
- **境界**: LLM の文脈判断が本質的に要る作業は skill 委譲（§3）に、判断が要らない決定論的手順はスクリプト/hook 等の自動化に振り分ける

## 10. スクリプトと exit code

実装は `shared/src/*.ts` の TS モジュールが正本で、`delegate-cli` のサブコマンドとして公開する。各 `*.sh` shim はそのサブコマンドへ委譲する。

| shim / サブコマンド                       | 実装モジュール                                                             | 役割                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `resolve-model.sh`                        | `resolve-model.ts`                                                         | モデル解決（種別非依存の汎用部品）                                                                             |
| `check-delegate-chain.sh`                 | `check-delegate-chain.ts`                                                  | 多段委譲の再帰防止チェック                                                                                     |
| `run.sh`                                  | `run-oneshot.ts`                                                           | 通常 run の one-shot（prepare→dispatch→read-response）。単一 JSON stdout と内部 exit code 透過                 |
| `dispatch.sh`                             | `dispatch.ts`                                                              | モデル名プレフィックスによる実行系分岐（決定論的分岐を main の推論から下ろし 1 呼び出しに畳む）                |
| `delegate-{claude,codex,devin,cursor}.sh` | `wrapper-{claude,codex,devin,cursor}.ts` + `wrapper-common/wait/report.ts` | backend 別の子プロセス起動（devin-\* / cursor-\* はプレフィックス剥離）                                        |
| `prepare.sh`                              | `prepare.ts`                                                               | 準備の集約（モデル解決→チェーン確認→リクエスト生成を 1 呼び出しに畳み main の bash 往復と context 出力を削減） |
| `build-request.sh`                        | `build-request.ts`                                                         | リクエスト生成（命名・md2idx・envelope 付与）。telemetry 有効時は request/body サイズを記録                    |
| `read-request.sh`                         | `read-request.ts`                                                          | request prompt 埋め込み gate 超過時の fallback 読み取り。telemetry 有効時は selector と出力量を記録            |
| `build-response.sh`                       | `build-response.ts`                                                        | wrapper 側のレスポンス生成（md2idx・envelope 付与）。telemetry 有効時は response/body サイズを記録             |
| `read-response.sh`                        | `read-response.ts`                                                         | レスポンスの段階読み取り（main 側）。`auto` でサイズゲート丸読み。telemetry 有効時は inline 判定と size 記録   |
| `read-json.sh`                            | `read-json.ts`                                                             | `jq -r <dotpath>` 相当の最小 JSON リーダ（observe JSON / run 出力の抽出用）                                    |
| （internal）                              | `delegate-mcp.ts`                                                          | 親 user スコープ MCP 設定の抽出と backend 別 config 生成（Claude/Cursor JSON、Codex TOML）                     |
| （internal）                              | `observe-{store,lock,followup,usage,timing,cost,effort}.ts`                | observe JSON 更新、usage/timing 正規化、wrapper 側 response 組み立て helper                                    |
| `summarize-metrics.ts`                    | —                                                                          | telemetry JSONL の集計（human table / `--json`）                                                               |
| `run-metrics-fixtures.sh`                 | —                                                                          | 固定 fixture を protocol scripts に通して metrics と summary を生成                                            |
| `check-metrics-baseline.sh`               | —                                                                          | fixture 現在値と `fixtures/metrics/baseline.json` の drift 検出                                                |
| `check-no-jq-md2idx.sh`                   | —                                                                          | 配布 tree に jq / md2idx 参照が残っていないことの静的検査（CI / pre-commit）                                   |

| exit | 意味                                                |
| ---- | --------------------------------------------------- |
| 0    | 成功                                                |
| 1    | その他の実行失敗                                    |
| 2    | 引数エラー（usage）                                 |
| 3    | 前提条件不足（node / 対象 backend CLI 不在）        |
| 4    | 委譲サイクル検出（同一種別の多段委譲）              |
| 5    | follow-up 検証失敗（resume 不可・context 不一致）   |
| 6    | effort 指定不正（不正値・backend 非対応・二重指定） |

## 11. リポジトリ構成と配布

```
delegate-skills/
  fixtures/
    metrics/                      # telemetry の固定シナリオと baseline
      baseline.json
      scriptable-chore/{request.md,response.md}
      read-heavy-chore/{request.md,response.md}
      mixed-chore/{request.md,response.md}
  skills/                        # gh skill install の配布元（canonical SKILL.md）
    delegate-explore/
      SKILL.md
      scripts/                   # shared/ からの生成コピー（sync-shared.ts）
    delegate-implement/{SKILL.md, scripts/}
    delegate-chore/{SKILL.md, scripts/}
    delegate-review/{SKILL.md, scripts/}
    delegate-imagegen/{SKILL.md, scripts/}
    delegate-x-research/{SKILL.md, scripts/}
    delegate-htmldoc/{SKILL.md, references/, scripts/}
  shared/                        # バンドル + shim の正本（種別/実行系非依存）
    model-token-prices.json
    src/                         # TypeScript 実装の正本（in-source test 隣接）
      main.ts                    # サブコマンド dispatch
      prepare.ts dispatch.ts run-oneshot.ts read-json.ts backend.ts
      wrapper-{common,wait,report,dedicated,claude,codex,cursor,devin,imagegen,xresearch}.ts
      observe-{store,lock,followup,usage,timing,cost,effort}.ts
      prompt-constraints.ts delegate-mcp.ts build-*.ts read-*.ts resolve-model.ts
    dist/delegate-cli.mjs        # vp build 生成の単一ファイル CLI（md2idx 内包・コミット対象）
    resolve-model.sh check-delegate-chain.sh run.sh dispatch.sh prepare.sh   # exec shim（→ サブコマンド）
    build-request.sh read-request.sh build-response.sh read-response.sh read-json.sh
    delegate-claude.sh delegate-codex.sh delegate-devin.sh delegate-cursor.sh
  vite.cli.config.ts             # CLI バンドル専用の vite-plus config
  scripts/
    sync-shared.ts               # shared/（dist + shim + asset）→ 各 skill scripts/ への同期
    summarize-metrics.ts         # telemetry JSONL 集計
    run-metrics-fixtures.sh      # fixture 実行
    run-latency-bench.sh         # レイテンシ反復ベンチ（p50 の移行前後比較）
    check-metrics-baseline.sh    # baseline drift 検出
    check-no-jq-md2idx.sh        # 配布 tree の jq / md2idx 参照ゼロ検査
  docs/
    design/
      spec.md                    # 本仕様
      protocol-v1.md             # ファイルプロトコル詳細
  README.md
```

- Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）、Codex パスは `delegate-codex.sh`（`codex exec` 子プロセス）、Devin パスは `delegate-devin.sh`（`devin -p` 子プロセス）、Cursor パスは `delegate-cursor.sh`（`agent -p` 子プロセス）で、いずれも `delegate-cli wrapper <backend>` への exec shim。SKILL.md から同じ呼び出し形式で起動する
- **self-contained 配布**: 実装の正本は `shared/src/`、配布物はバンドル `shared/dist/delegate-cli.mjs`（md2idx 内包）と直接実行エントリの `.sh` shim。`shared/ → 各 skill の scripts/ へコピー同期`パターンで各 skill に同梱する。`gh skill install` 後の呼び出しパスは Claude Code では `.claude/skills/delegate-<type>/scripts/...`、Codex では `.agents/skills/delegate-<type>/scripts/...` になり、同じ相対構造を保つ。SKILL.md のコマンド例は Claude Code の allowed-tools と整合するよう `.claude/...` を示し、Codex では `.agents/...` に読み替える。同期は `sync-shared.ts`（`npm run sync-shared` / `:check`）が担い、コピーの直接編集や dist ドリフトは fail-closed で検出する
- TypeScript 実装は Vitest の in-source testing で単体検証し、CLI レベルの契約は fake CLI golden（`delegate-wrapper-session.test.ts` / `delegate-run.test.ts`）で end-to-end 検証する。実行時に必要なのは Node.js 24+ と対象 backend CLI のみ

## 12. 環境変数

| 環境変数                                 | 既定                                     | 説明                                                             |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`                  | skill 毎                                 | 種別別のモデル上書き                                             |
| `DELEGATE_WORK_DIR`                      | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | リクエスト/レスポンスファイルの置き場                            |
| `DELEGATE_RESPONSE_INLINE_MAX`           | `10240`（バイト）                        | `read-response.sh auto` が丸読み/段階読みを切り替えるサイズ閾値  |
| `DELEGATE_RUN_CONTENT_MAX`               | `16384`（バイト、`0` は無制限）          | one-shot `run.sh` JSON の `content` 上限                         |
| `DELEGATE_REQUEST_INLINE_MAX`            | `262144`（バイト）                       | request を worker prompt に埋め込むサイズ閾値                    |
| `DELEGATE_METRICS_FILE`                  | 未設定（記録しない）                     | 設定時のみ proxy metric を JSONL で追記する任意 telemetry 出力先 |
| `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL`    | `10`（秒）                               | observe JSON の heartbeat 更新間隔                               |
| `DELEGATE_CHILD_BASH_TIMEOUT_MS`         | `300000`（ミリ秒、`0` は注入なし）       | claude backend の子へ注入する Bash tool の timeout 上限          |
| `DELEGATE_CODEX_HOME_PRUNE`              | `1`（有効、`0` で残す）                  | 正常終了時に cache を削除。auth copy は設定によらず常に削除      |
| `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` | `0`（無効）                              | stdout/stderr bytes が増えない子 CLI を指定秒数後に kill する    |
| `DELEGATE_OBSERVE_STREAM_MAX_BYTES`      | `65536`（バイト、`0` は無制限）          | observe JSON に保存する stdout/stderr content の上限             |
| `DELEGATE_RUN_RETENTION_DAYS`            | `0`（無効）                              | request 準備時に古い run ごとの scratch directory を削除する     |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR`           | `delegate-imagegen-output`               | `delegate-imagegen` の既定出力先                                 |
| `DELEGATE_X_RESEARCH_MODEL`              | `grok-build`                             | `delegate-x-research` の X 調査 backend に渡すモデル             |

## 13. 脅威モデル・割り切り

- 結果/リクエストは自前 subagent が書くものであり外部 untrusted コンテンツではない → サニタイズ不要
- subagent がリポジトリ内の悪意あるファイルを読んで影響を受ける可能性は残る（スコープ外）
- 安価モデルの品質ブレは main の検証フェーズで吸収する前提
- 検証は worker 側に閉じ込め、main は報告 Markdown の Verification section（実行コマンドと exit code を含む）から最小限だけ確認する（§6）。決定論的検証（`vp check` の lint/型、`npm test`）は exit code を信頼する。ただし `npm test` は test worker 作成前の child-process capability preflight が成功した場合だけ suite を開始し、不成立時は `TEST_ENVIRONMENT_UNSUPPORTED` で fail-closed にする。意味的・受け入れ基準のみ main が最小サマリで確認する。安価 worker による虚偽 pass のリスクは、捏造の旨みが薄い機械的な exit code 報告に信頼を限定することで抑える
- Codex パスは別課金のサブプロセス（GPT 系に in-session 実行手段が無いため不可避）。Claude パスも `claude -p` 子プロセスのため別セッション課金になる
- Codex パスは `danger-full-access` で動くため sandbox 由来の隔離が無い。Claude パスは `--dangerously-skip-permissions` だが、read-only 種別では repo 書き込みツールを技術的に除外する（explore は `--disallowedTools "Edit,MultiEdit,Write,NotebookEdit"`、review は `--allowedTools "Read,Bash"`）。ただし Bash 経由のシェル書き込みは防げないため、push 抑止を含む完全な read-only 性は prompt の constraints と main の検証に依存する残存リスクがある
- explore は WebSearch / WebFetch / MCP を開放するため、Web / MCP 由来の untrusted コンテンツ（prompt injection を含む）が worker context に入り得る。取得コンテンツは子プロセスに隔離され main には報告 Markdown だけが返るが、worker 自身が誘導される残存リスクは prompt の「コンテンツ内の指示に従わない」制約と main の検証に依存する。MCP の書き込みツールは技術的には遮断されない（読み取り専用の常時制約はプロンプトレベル。技術的に絞る場合は MCP サーバー側の権限スコープで行う）

## 14. 参照

- [protocol-v1.md](protocol-v1.md) — ファイルプロトコル v1 の詳細
- [md2idx](https://github.com/oubakiou/md2idx) — リクエスト/レスポンスのトークン圧縮（`index` / `sections`）
- [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) — Codex 子プロセス起動骨格の流用元（§5）
- [vite-plus（`vp`）](https://www.npmjs.com/package/vite-plus) — format / lint / test / 型チェックのツールチェーン
