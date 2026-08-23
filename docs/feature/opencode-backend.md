# opencode backend 追加 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fopencode-backend.md)

[spec.md](../design/spec.md) の §5「実行系の四分岐」と README の「How it works / Models and reasoning effort」に対応するための設計判断と実装手順をまとめる。delegate skills の委譲先バックエンドとして、Claude / Codex / Devin / Cursor に続く 5 番目として opencode CLI を追加する。完了後は spec.md に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                          | 開始時の状態 | 完了条件                                                                                                                                                                                                                                                 | 最終状態 | 状態   |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| [MUST] opencode を 5 番目の実行系へ分岐       | 未           | `backendFromModel('opencode/...')` が `opencode` を返し、dispatch が `delegate-opencode.sh` を起動する in-source test が通る                                                                                                                             |          | 未着手 |
| [MUST] 通常 run の protocol v1 往復           | 未           | explore / implement / chore / review / htmldoc の 5 種別で fake CLI golden が通り、実 CLI で 2 種別以上が `completed` を返し、その Summary が request の対象を指している（テンプレート文字列の反復でない）ことを目視確認する                             |          | 未着手 |
| [MUST] read-only 種別の direct edit-tool 抑止 | 未           | explore / review で worker が `edit` / `write` ツールを呼べないことを実機で確認する（Claude パスの denylist と同等の範囲。bash 経由・task 経由の書き込みは抑止対象外）                                                                                   |          | 未着手 |
| [MUST] measured usage / cost の記録           | 未           | observe JSON の `usage.measurement` が `measured`、`source` が `opencode_step_finish`、token 内訳と `cost_usd` が `step_finish` 由来                                                                                                                     |          | 未着手 |
| [MUST] 不正なモデル記法の fail-closed         | 未           | provider 省略形と二重 selector が dispatch 前に exit 6 で停止し、stderr に許容形式を列挙する                                                                                                                                                             |          | 未着手 |
| [MUST] 生成物の同期と配布                     | 未           | `npm run build` → `sync-shared` の後、`build:check` / `sync-shared:check` / `check-no-jq-md2idx` / `vp check` / `npm test` が通る                                                                                                                        |          | 未着手 |
| [MUST] 補助 subprocess の頑健性               | 未           | `export` / `models --verbose` が応答しない場合でも run 全体が hang せず、timeout・出力上限・SIGKILL で打ち切られる。`--version` の失敗は exit 3 で停止し、`export` / `models --verbose` の失敗は telemetry 欠落として run を止めない                     |          | 未着手 |
| [MUST] 失敗の検知と通知                       | 未           | catalog に無いモデルでの失敗が `error.kind = "model_catalog_miss"` に記録され、failed response の Error section 経由で main へ届く（effort 警告は effort を実装する場合の条件として SHOULD 側に置く）                                                    |          | 未着手 |
| [MUST] session lifecycle                      | 未           | session ID を取得できた通常 run が session store を残さず、取得できなかった run は `session_delete_skipped`、削除失敗は `session_delete_failed`、削除の timeout は `session_delete_failed` として必ず observe に残る（残留を許すのは記録された場合だけ） |          | 未着手 |
| [SHOULD] session reuse                        | 未           | resumable で `sessionID` を回収し、follow-up が `-s <sessionID>` で継続する golden が通る                                                                                                                                                                |          | 未着手 |
| [SHOULD] MCP 注入                             | 未           | `DELEGATE_OPENCODE_MCP_SOURCE` 指定時に親 MCP 設定を config の `mcp` セクションへ変換注入し observe に server 名のみ記録する。未指定時は `source: "none"` を記録する                                                                                     |          | 未着手 |
| [SHOULD] effort（`--variant`）対応            | 未           | `@<effort>` が形式検証のみで `--variant` へ渡り、`run.effort.requested` / `effective` が記録される。**実装する場合は**未対応値の `effort_unsupported` event と Summary 警告行の到達まで含めて完了とする                                                  |          | 未着手 |
| [SHOULD] 価格表エントリ                       | 未           | `shared/model-token-prices.json` に opencode の pricing source と主要モデルを追加し、チャートを再生成する                                                                                                                                                |          | 未着手 |

スコープ外:

- `delegate-imagegen` / `delegate-x-research` への opencode 適用: capability bridge のため backend を Codex / Grok に固定している。opencode で代替できるかは別途評価する
- opencode を requester（親エージェント）として使う導線: Codex requester と同種の隔離境界の議論が必要で、別タスクにする
- opencode 経由での anthropic / openai など外部 provider の動作保証: 本環境では未認証で検証できない。selector 上は指定できるが documented model には載せない

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                         | 本実装での扱い                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `shared/src/wrapper-cursor.ts`（Cursor backend）          | wrapper 構造のテンプレートとして採用。config dir 隔離は不要（§5.e）、report は `report.md` ではなく stdout 回収（§5.b） |
| `shared/src/wrapper-codex.ts`（structured 方式）          | JSON schema による構造化最終応答は opencode に相当フラグが無いため不採用                                                |
| `shared/src/wrapper-report.ts` `reportModeForBackend`     | claude / codex = `structured`、他 = `report_md` の 2 値。opencode の扱いは §5.b で決める                                |
| spec.md §5「実行系の四分岐」                              | 「五分岐」へ改題し opencode 列を追加する                                                                                |
| spec.md「sandbox / permission を全開放に統一する理由」    | opencode は技術的抑止が可能なため例外として節を改訂する                                                                 |
| opencode 公式 docs（cli / config / permissions / models） | permission・config マージ順・MCP・session の仕様根拠                                                                    |
| 実機検証（opencode v1.18.21, 2026-08-22）                 | §2.1 に記録。docs 未記載事項の一次情報として扱う                                                                        |

### 2.1 実機検証で確定した事実（opencode v1.18.21）

| 項目                         | 結果                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run --format json` の出力   | JSONL。イベント種別と各フィールドは §2.3 を正とする（§2.1 では列挙しない）                                                                                                                                                                                 |
| session ID                   | 全イベントの `sessionID` に含まれる（例 `ses_fd90596b4ffelwStgDfFGz1b3a`）                                                                                                                                                                                 |
| usage                        | `step_finish` の `part.tokens` = `{total, input, output, reasoning, cache:{write,read}}`                                                                                                                                                                   |
| cost                         | `step_finish` の `part.cost`（数値）                                                                                                                                                                                                                       |
| prompt の渡し方              | stdin パイプで受理する（positional / `--prompt` 以外の経路が使える）                                                                                                                                                                                       |
| session resume               | `-s <sessionID>` で会話継続を確認。応答イベントにも同じ `sessionID` が入る                                                                                                                                                                                 |
| 無効モデル                   | exit 1、stdout に `{"type":"error","error":{"name":"UnknownError",...}}`、stderr は空                                                                                                                                                                      |
| 無効 variant                 | **exit 0**（黙って無視される。fail-open）                                                                                                                                                                                                                  |
| permission 強制              | 実測条件は `OPENCODE_CONFIG_CONTENT='{"permission":{"edit":"deny","bash":"deny"}}'`。利用可能ツールが `glob, grep, invalid, read, skill, task, todowrite, websearch` に縮小し、`bash` 呼び出しは "unavailable tool" で拒否され、ファイルは作成されなかった |
| `session list --format json` | `[{id, title, updated, created, projectId, directory}]`                                                                                                                                                                                                    |
| config マージ順              | グローバル → `OPENCODE_CONFIG` → project `opencode.json` → `.opencode/` → `OPENCODE_CONFIG_CONTENT` → 管理者設定（後勝ち）                                                                                                                                 |

### 2.2 Step 1 PoC で確定した事実（2026-08-22 実施）

| 検証項目                      | 結果                                                                                                                                                                                                                                                                            | 影響                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| prompt の渡し方               | **stdin 必須**。positional 引数に `---` を含む Markdown を渡すと ask 待ちでハングし、timeout まで stdout / stderr とも空のまま返らない。stdin 経由なら prompt 読み込み後に EOF となり、未解決の ask が reject に倒れて完走する                                                  | §3.2                 |
| permission パターンマップ     | `OPENCODE_CONFIG_CONTENT` の指定は既定ルールを置き換えず**追加**され、評価は**先勝ち**。既定の `external_directory: * → ask` が残るため cwd 外パスを後から allow にできない                                                                                                     | §5.b / §5.c          |
| cwd 外への write              | 不可。`edit: "allow"` と `external_directory` の allow パターンを両方与えても `The user rejected permission to use this specific tool call.` で拒否される。cwd 内への write は成功する                                                                                          | §5.b / §8            |
| stdout からの report 回収     | 成立。実測条件は read-only（`edit: "deny"` / `bash: "deny"`）で、front-matter 付き Markdown が最終 `text` イベントに出る                                                                                                                                                        | §5.b                 |
| `--variant` の実効値          | `opencode export <sessionID>` の `info.model.variant` に記録される（未指定時は `"default"`）。ただし low / high で reasoning token に有意差は出ず、CLI が受け取った値の記録であって効果の証明ではない                                                                           | §5.d                 |
| usage の合算                  | `step_finish` の単純合算が export の `info.tokens` と完全一致（7 step で input 18655 / output 775 / reasoning 1749 / cache.read 63104）。`part.tokens.total` は累積表示なので合算に使わない                                                                                     | §3.3                 |
| cost                          | 有料モデル `opencode-go/glm-5.2` で `part.cost` = 0.00793828。free モデルは 0                                                                                                                                                                                                   | §5.g                 |
| 並列実行                      | 3 run 同時実行で session store の競合は観測されず、各 run が独立に完走した                                                                                                                                                                                                      | §5.e                 |
| 未知モデルの失敗形            | 実在 provider + 不明モデル / 不明 provider / provider 欠落の 3 パターンすべてが exit 1 + stdout `{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error...","ref":"err_XXXX"}}}`。stderr は空で `ref` は毎回変わるため signature にできない  | §5.f                 |
| `opencode models` の取得      | 29 モデルの一覧が約 880ms（3 回計測）                                                                                                                                                                                                                                           | §5.f                 |
| 無効 variant の記録           | `--variant bogus-effort-xyz` はそのまま export の `info.model.variant` に記録される。requested と effective は常に一致するため、この比較では乖離を検知できない                                                                                                                  | §5.d                 |
| catalog の `variants`         | `opencode models --verbose` がモデルごとの JSON を返し、`variants` に有効な effort 名が入る（非対応は `{}`）。29 モデル中 15 が対応で、値は `["high","max"]` / `["none","low","medium","high","xhigh","max"]` / `["none","thinking"]` などモデルごとに異なる。約 880ms・34KB    | §5.d / §5.f          |
| catalog の `cost`             | 同じ出力の `cost` に input / output / cache read / write の単価が入る                                                                                                                                                                                                           | §5.g                 |
| project config の優先         | 対象リポジトリの `opencode.json` に `edit: "allow"` を書いても `OPENCODE_CONFIG_CONTENT` の `edit: "deny"` が勝ち、write はツールリストから消えてファイルは作られなかった                                                                                                       | §5.c / §5.e          |
| session の削除                | `opencode session delete <id>` が exit 0 で成功し、`session list` から消えることを確認                                                                                                                                                                                          | Step 6               |
| 採用 profile の実効性         | `edit: "deny"` のみ注入（bash は既定）でも `write` は "unavailable tool" として拒否され、利用可能ツールは `bash, glob, grep, invalid, read, skill, task, todowrite, websearch` に縮小する                                                                                       | §3.2 / §5.c          |
| bash 経由の cwd 外アクセス    | **書き込みは通り読み取りは拒否される**。`echo x > /tmp/f` は completed、`cat /tmp/f` は `external_directory (/tmp/*)` で auto-reject。リダイレクトによる書き込みは拒否されなかった（permission がコマンド文字列から抽出したパスだけを見ていると推測できるが、内部機構は未検証） | §3.2 / §5.b / Step 4 |
| 採用 profile での report 回収 | 成立。front-matter 付き Markdown が最終 `text` に出る。ただし free モデルは Summary のプレースホルダをそのまま返し、指示文を末尾に反復するなど内容品質が低い                                                                                                                    | §5.b / §8            |

### 2.3 parser が依存する実測 schema（2026-08-22 採取）

Step 4 / 5 の parser とテスト fixture はこの構造を前提にする。値は代表例で、秘匿情報は含まない。

**`run --format json` の JSONL**: トップレベルの `type` は `step_start` / `text` / `tool_use` / `step_finish` / `error` の 5 種。全イベントが `{ type, timestamp, sessionID, part }`（`error` だけ `part` の代わりに `error`）。`part.type` はハイフン表記（`step-start` / `step-finish` / `text` / `tool`）でトップレベルとは別物なので、判定にはトップレベルの `type` を使う。

| イベント      | `part` のキー                                                            | 備考                                                                                           |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `step_start`  | `id` / `messageID` / `sessionID` / `type` / `snapshot`                   | `snapshot` は git snapshot の SHA                                                              |
| `text`        | `id` / `messageID` / `sessionID` / `text` / `time` / `type`              | `time` は `{start, end}`。**最終応答は最後の `text` の `text`**                                |
| `tool_use`    | `callID` / `id` / `messageID` / `sessionID` / `state` / `tool` / `type`  | `state` は `{input, metadata, output, status, time, title}`。`status` は `completed` / `error` |
| `step_finish` | `cost` / `id` / `messageID` / `reason` / `sessionID` / `tokens` / `type` | `tokens` は `{input, output, reasoning, total, cache:{read, write}}`                           |
| `error`       | （`part` なし）`error` = `{ name, data: { message, ref } }`              | `name` は `UnknownError`、`ref` は毎回変わるため signature にできない                          |

集約規則と異常系の扱い:

- token / cost は全 `step_finish` の単純合算（`part.tokens.total` は累積表示なので使わない）
- `part.cost` は step 単位の値。合算が `export` の `info.cost` と一致することを fixture で固定する
- `step_finish` が 1 件も取れない、または token フィールドが取れない場合は usage を `measured` として記録せず、既存 event `usage_parse_failed`（spec.md §6 で定義済み）を出して推定 fallback に落とす。全 0 の measured は estimated より質が悪く、backend 横断の集計を汚すため
- `cost` は **キーが存在し数値である `step_finish` だけを合算**し、1 つでも欠落・非数値があれば `cost_usd` を省略する（token は measured のまま残す）。free モデルの正当な `cost` 0 と、欠落を 0 と読んだ結果を区別できなくなるため、0 埋めはしない
- token は **非負の safe integer**、cost は **非負の finite number** として検証し、各加算の後も overflow と safe integer 超過を確認する。`JSON.stringify` は非有限値を `null` に変えるため、検証しないと `measured` を名乗る壊れた値が observe に残る
- optional な token（`cache.read` / `cache.write` / `reasoning`）は **キーが欠落している場合だけ 0** とし、キーが存在して不正値なら `usage_parse_failed` へ倒す
- capture は 1 回だけ逐次走査し、last text・usage 合計・timing count を同じ accumulator で更新する。response 組み立て・timing・usage は終了時の単一 summary を共有し、capture を再走査しない
- `step_finish` が 0 件の capture では `model_turns` を `null` にする（既存 Codex 経路と揃える。0 を実測値として記録しない）
- JSON として parse できない行は無視する（stdout に非 JSON 行が混ざり得る）
- `tokens.cache` や `reasoning` が欠落した step は 0 として扱う
- `timestamp` は **epoch ミリ秒の整数**（例 `1787360343099`）。`part.time` の `start` / `end` も同じ単位
- ただし `timing.time_to_first_useful_event_ms` などの既存 observe 契約は **wrapper の monotonic 経過時間**であり、この epoch 値をそのまま入れない。イベントの順序判定にだけ使い、計測は既存の monotonic 経路を維持する

**`opencode export <sessionID>`**: 先頭に `Exporting session: <id>` の 1 行があり、その後が JSON。トップレベルは `{ info, messages }`。

- `info.model` = `{ id, providerID, variant }`（`variant` は未指定時 `"default"`）
- `info.tokens` = `{ input, output, reasoning, cache: { read, write } }`
- `info.cost` = 数値
- `info` は他に `agent` / `directory` / `path` / `permission` / `projectID` / `slug` / `summary` / `time` / `title` / `version` を持つ

**`opencode models --verbose`**: **JSON 配列ではない**。`<provider>/<model>` の行と、それに続く JSON ブロックの繰り返しなので、行走査で分割してからブロック単位に parse する。各エントリは `api` / `capabilities` / `cost` / `family` / `headers` / `id` / `limit` / `name` / `options` / `providerID` / `release_date` / `status` / `variants` を持つ。

- モデル識別子は `providerID` + `/` + `id` で構成する（見出し行の文字列に依存しない）
- `cost` = `{ input, output, cache: { read, write } }`（per 1M tokens）
- `variants` = 有効な effort 名をキーに持つオブジェクト。非対応モデルは `{}`

## 3. 設計の中核

### 3.1 backend selector とモデル名

記法は `opencode/<provider>/<model>[@<effort>]`。

| 構成要素             | 内容                                                                                             | 配置 / 寿命                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| selector `opencode/` | `backendFromModel` の 5 番目の分岐（`model.startsWith('opencode/')`）                            | `shared/src/backend.ts`、README に載る公開仕様                                                                                                                  |
| CLI model            | selector を 1 回だけ剥離した `<provider>/<model>`。剥離後の `/` がちょうど 1 つでなければ exit 6 | 検証は `shared/src/observe-effort.ts`（`validateModelName`。既存 cursor の二重 prefix 拒否と同じ場所）、CLI へ渡す名前の生成は `shared/src/wrapper-opencode.ts` |
| effort suffix        | `@<effort>` を共通処理で剥がし `--variant <effort>` へ素通しする。検証は形式のみ（§5.d）         | `shared/src/observe-effort.ts`                                                                                                                                  |

指定例:

```sh
DELEGATE_EXPLORE_MODEL=opencode/opencode-go/glm-5.2
DELEGATE_CHORE_MODEL=opencode/opencode/nemotron-3.5-lightning-free
DELEGATE_IMPLEMENT_MODEL=opencode/opencode-go/kimi-k3@high
```

exit 6 の stderr には許容形式に加えて「provider は `opencode models` の出力から取る」を含める。`opencode/glm-5.2` で弾かれたユーザーが `opencode/opencode/glm-5.2` と誤修正すると provider=`opencode` として実行され catalog miss に落ちるため、正しくは `opencode/opencode-go/glm-5.2` である。

selector を剥離した残りは次の grammar を満たすこと。外れた場合は dispatch 前に exit 6 で停止する。

- `/` をちょうど 1 つ含み、前（provider）と後ろ（model）がいずれも非空。`opencode//model` と `opencode/provider/` はここで弾く
- provider / model はそれぞれ `^[A-Za-z0-9._-]+$` に anchored でマッチする（実測モデル名は `opencode-go/deepseek-v4-flash-vision-exp` や `opencode/muse-spark-1.2-contributor-free` のように英数字とドット・ハイフンのみ）
- 長さ上限を設ける（provider / model 各 64 文字）

既存の failure path は response への混入を防ぐため厳格な anchored allowlist を不変条件にしている。上の grammar はそれと同じ強度に揃えたもので、空白・制御文字だけを弾く緩い検証にはしない。observe には raw 値を保存し、failed response の Markdown へ載せる際は別途 escape した表示値を使う（両者を分離する）。

これで provider を欠いた `opencode/glm-5.2` と、selector を重ねた `opencode/opencode/anthropic/claude-opus-4-5` の双方を弾ける（Cursor の `cursor-cursor-*` 拒否と同じ扱い）。provider 名自体が `opencode` のときは `opencode/opencode/big-pickle` が正しい形で、剥離後は `opencode/big-pickle` になる。

記法上は `opencode/anthropic/<model>` のように外部 provider も同じ形に収まるが、本環境では OpenCode Go の 1 credential しか認証されておらず**動作は未検証**である。documented model には載せず、README でも動作を約束しない（§1 スコープ外）。また model ID に `/` を含む provider が存在しないことも未検証で、上記 grammar はその前提に立っている。

### 3.2 prompt の渡し方、read-only の抑止、report 回収方式

3 つは別々の論点に見えるが、PoC の結果ひとつながりに決まる。

**prompt は stdin で渡す。** positional 引数に Markdown を渡すと `---` がオプションとして解釈され、ask 待ちのまま返らない。stdin 経由なら prompt 読み込み後に EOF となり、未解決の permission ask が reject に倒れて必ず完走する。非対話 backend としてはこの性質そのものが前提になる。

**worker に run_dir を書かせる方式は採らない。** opencode は cwd の外側を `external_directory` permission で守っており、既定の `* → ask` を `OPENCODE_CONFIG_CONTENT` で上書きできない（指定は既定ルールへ追加され、評価は先勝ち）。edit / write ツールは cwd 外を書けず、read-only 種別ではツール自体が消える。bash のリダイレクト（`echo x > /tmp/f`）だけは通るが、これは permission がコマンド文字列から抽出したパスを見てリダイレクト先を検出しないためで（§2.2）、将来塞がれ得る検出漏れに report 回収を依存させない。なお bash の明示パス読み取り（`cat /tmp/f`）は拒否された。`read-request.sh` 経路そのものは未実測だが、cwd 外の request file を worker に読ませる前提を置けないため、inline gate 超過は保守的に fail-closed とする（Step 4）。`DELEGATE_WORK_DIR` を repository 内へ向ける運用（development.md 推奨の `.temp/delegate/work`）もあるが、既定構成で成立しない方式は採らない。

**したがって report は stdout から回収する。** read-only のまま front-matter 付き Markdown を最終 `text` イベントに出せることを PoC で確認した。`reportModeForBackend` に第 3 の mode `stdout_text` を足し、wrapper が最終 text から front-matter を剥がして response を組み立てる。

種別ごとの permission:

| task_type                   | wrapper が注入する permission | 結果                                                                                                                     |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| explore / review            | `edit: "deny"` を注入         | edit / write ツールがツール一覧から消える。bash / websearch は既定のまま（実測ツール一覧に `webfetch` は現れない。§2.2） |
| implement / chore / htmldoc | 注入しない（既定のまま）      | cwd 内の edit は可、cwd 外は `external_directory` の既定 `* → ask` が stdin EOF で reject に倒れる                       |

先勝ちで効かないのは `external_directory` のようなパターンリスト内の後置 allow であり、カテゴリ単位（`edit` / `bash`）の deny は既定を締める方向に効くことを実測済み（§2.1）である。

explore / review では `edit` / `write` ツールが CLI レベルで遮断される。これは既存 4 backend のうち Claude パスの denylist だけが持っていた技術的抑止で、`report.md` を書く必要が無くなったぶん Cursor の `--mode plan` が抱えた制約も回避できる。

抑止できる範囲は Claude パスと同じく **direct edit-tool の呼び出しだけ**で、次は抑止されない。要件名・完了条件・README でも「read-only」と言い切らず、この範囲に限定して書く。

- `bash` は explore でも allow にしている（Claude パスと粒度を揃えるため）ので、shell 経由の書き込みは通る
- PoC の利用可能ツール一覧には `task` が残っており、子 task へ permission がどう継承されるかは未検証
- config merge 順の最後にある管理者設定は `OPENCODE_CONFIG_CONTENT` を override し得る（project config が override しないことは実測済み。§2.2）

read-only 性の最終的な担保は、既存 backend と同じく prompt 制約と main の検証フェーズにも依存する。

### 3.3 observe への measured usage / cost

`step_finish` が token 内訳と cost を直接返すため、usage も cost も実測値を記録できる（Devin export と同様に、既存の measured usage 経路へそのまま載る）。フィールド名は `observe-usage.ts` / spec.md §6 の既存契約に合わせる（実測性は `measurement`、`source` は由来を表す別フィールド）。ただし schema drift で `step_finish` が 1 件も取れない、または token フィールドが取れない場合は usage を `measured` として記録せず、既存の `usage_parse_failed` 経路へ乗せて推定 fallback に落とす（新 event は作らない）。全 0 の measured は estimated より質が悪く、backend 横断の集計を汚すためである。

| observe field               | 由来 / 値                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usage.measurement`         | `measured`                                                                                                                                                                                                                                                               |
| `usage.source`              | `opencode_step_finish`（新しい由来値。spec.md §6 の列挙に追加する）                                                                                                                                                                                                      |
| `usage.input_tokens`        | 全 `step_finish` の `part.tokens.input` の合算                                                                                                                                                                                                                           |
| `usage.output_tokens`       | 同 `part.tokens.output` の合算                                                                                                                                                                                                                                           |
| `usage.cached_input_tokens` | 同 `part.tokens.cache.read` の合算（既存名。`cache_read_tokens` ではない）                                                                                                                                                                                               |
| `usage.total_tokens`        | `input_tokens + output_tokens`。`part.tokens.total` は累積表示なので使わない                                                                                                                                                                                             |
| `usage.cost_usd`            | 全 `step_finish` の `part.cost` の合算（実測。`cost_usd_estimated` は付けない）                                                                                                                                                                                          |
| `run.effort.requested`      | 指定値                                                                                                                                                                                                                                                                   |
| `run.effort.effective`      | `{ value: <export の info.model.variant>, source: "opencode_export" }`。`opencode export` は effort 指定がある run でのみ 1 回呼ぶ。未指定 run では呼ばず `run.effort` を記録しない（catalog 取得と同じく、成功パスかつ effort 未指定の run にオーバーヘッドを乗せない） |

PoC で `step_finish` の単純合算が `opencode export` の `info.tokens` と完全一致することを確認済み。

token と cost は 1 つの measured usage object として `observe-usage.ts` に置く（`recordUsage()` は両者をまとめて受け取る契約で、`observe-cost.ts` は費用を報告しない backend 向けの推定専用モジュールである）。opencode は cost を実測で返すため `observe-cost.ts` は変更しない。

既存 schema に無い additive field は spec.md §6 に定義してから使う。

- `usage.cache_write_tokens` / `usage.reasoning_tokens`: opencode は両方を返すが既存 backend には無い。取得できない backend では現れないキーとして定義する
- `effort.effective.source` の `opencode_export`: **`measured` にはしない**。`recordEffort` は `source === "measured"` のときだけ `effort_mismatch` event を出すが、opencode の export は無効値もそのまま返す（§2.2）ため、mismatch 判定の根拠にできない

`recordEffort` は `run.effort` を丸ごと上書きするため、catalog 照合の結果をこのオブジェクトへ後から足すと消える。§3.4 の catalog 照合結果は effort オブジェクトではなく observe event（`effort_unsupported`）として記録する。

### 3.4 失敗・無効の検知と通知

モデル名も effort も dispatch では止めず、まず実行を試みる。代わりに失敗・無効を検知したら必ずユーザーへ届くようにする。判定はどちらも `opencode models --verbose` 1 回でまかなえる。

**通知は stderr ではなく response に載せる。** `run-oneshot.ts` の `collectOutcome` は response file が存在すればそれを読み、dispatch stderr を捨てる（stderr を返すのは response 生成すら無い異常系だけ）。invalid variant は exit 0 かつ completed response になるため、wrapper が stderr へ書いても `run.sh` 経由の main には届かない。

**失敗は既存の `ChildFailure` union に載せる。** `recordChildFailure()` は `kind === 'unknown'` のとき `error` キー自体を作らない契約なので（欠落キーと明示 null を `read-json.sh` が区別できないため）、`unknown` のまま補助フィールドを足す設計は成立しない。既存 union には `model_catalog_unavailable`（`retryable: true`）と `model_not_found`（`retryable: false` + candidates）があり、opencode の状況はその中間にあたる。

| 状況                                                                    | 記録                                                                     | 通知経路                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| 子プロセス非 0 + catalog を引けて指定モデルの行が無い                   | 新 kind `model_catalog_miss`（`retryable: true`、`model` を持つ）        | failed response の Error section   |
| 子プロセス非 0 + catalog 自体を引けない                                 | 既存 `model_catalog_unavailable`（`retryable: true`）                    | failed response の Error section   |
| 子プロセス非 0 + catalog に行がある                                     | 分類しない（`unknown`）。`error` キーは作られない                        | failed response の既定文言         |
| effort 指定あり + **モデル行を取得でき** `variants` に requested が無い | observe event `effort_unsupported`（`requested` / `model` / `variants`） | response Summary の先頭へ警告 1 行 |
| effort 指定あり + モデル行を取得できない                                | 判定不能として何も記録・通知しない                                       | —                                  |

`model_catalog_miss` を `retryable: true` にするのは、catalog 未掲載でも受理されるモデルがあり得るため（§5.f）。miss を不存在の証明として扱わない。

catalog を authoritative（= 指定モデルが無いことの根拠）として扱うのは、`models --verbose` が exit 0・timeout でない・出力上限に達していない・全 block の parse に成功した場合だけである。いずれかを満たさない場合は `model_catalog_unavailable` として扱う。出力上限や壊れた block で前半しか取れないと、後半のモデルを `model_catalog_miss` と誤分類するためである。`retryable` は分類のヒントであって自動リトライの指示ではなく、catalog 照合は参考情報であり allowlist ではない。

**警告の挿入点**: 既存 wrapper は response を組み立てた後に effort を記録するため、Summary へ警告を載せるには catalog 照合を `completeResponse` より前に済ませる必要がある。照合結果の警告文字列を `CompletionConfig` 経由で渡し、`stdout_text` の collector が Summary section の先頭へ 1 行挿入する。挿入は response 組み立ての一部として行い、後から書き戻さない。

**Summary が無い / 複数ある場合の規則**: `read-response.ts` は正確な `# Summary` 見出しだけを抽出するため、worker の応答が見出しを持たない、あるいは複数持つ場合に警告が消える。次を規則として固定する。

- worker の応答に `# Summary` が無い場合、collector が canonical な `# Summary` section を先頭に生成し、そこへ警告行を置く（本文は worker の応答をそのまま後続 section にする）
- `# Summary` が複数ある場合は **最初の 1 つ**へ挿入し、残りはそのまま残す
- 警告文言は固定文字列とし、worker 出力を混ぜない（表示の予測可能性と injection 防止のため）

catalog を引くのは「失敗したとき」と「effort を指定したとき」だけで、成功パスかつ effort 未指定の run には一切のオーバーヘッドを乗せない。

SKILL.md には、run 結果が `failed` なら Error section を、`completed` でも Summary 先頭に警告行があればその旨を main がユーザーへ伝えるよう明記する。警告は response 本体に載るので、`read-response.sh` の selector（`auto` / `decision`）に関わらず Summary とともに必ず返る。

### 3.5 config の構築と継承境界

worker へ渡す config は wrapper が全体を構築し、`OPENCODE_CONFIG_CONTENT` へ JSON 文字列として載せる。呼び出し元の環境に同名の変数があっても**継承せず破棄する**。permission を締める保証を呼び出し元の env で外せないようにするためで、merge しない。

wrapper が構築する config の中身:

| キー         | 内容                               | 条件                                                         |
| ------------ | ---------------------------------- | ------------------------------------------------------------ |
| `permission` | §3.2 の task_type 別 permission    | read-only 種別のみ。implement / chore / htmldoc では載せない |
| `mcp`        | 親設定から抽出した MCP server 定義 | `DELEGATE_OPENCODE_MCP_SOURCE` が指定されたときだけ          |

対象リポジトリの `opencode.json` / `.opencode/` の扱い:

| 設定                                                 | 扱い                                                                                                                                                                        | 根拠                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permission`                                         | explore / review では遮断（注入した `edit: "deny"` が merge 順で勝つ）。implement / chore / htmldoc では wrapper が注入しないため project の設定がそのまま効く              | §2.2 実測 / §3.2                                                                                                                                                         |
| `mcp`                                                | 同名 server は注入側が勝ち、他は継承                                                                                                                                        | merge 順で後段のキーが勝つ（公式 config docs）                                                                                                                           |
| `instructions` / `agent` / `command` / `lsp`         | 継承                                                                                                                                                                        | 委譲先リポジトリの作業文脈であり、遮断すると worker の挙動が repository の想定と乖離する                                                                                 |
| plugin（`.opencode/plugins/` と config の `plugin`） | `implement` / `chore` でのみ継承し、`explore` / `review` / `htmldoc` では `--pure` を付けて無効化する。`DELEGATE_OPENCODE_PURE` が有効なら全 task type で `--pure` を付ける | Codex の project hooks と同じ allowlist（spec.md §5）。plugin も任意コード実行であり、read-only 種別と限定書き込み種別では prompt 制約を迂回してリポジトリを書き換え得る |

`DELEGATE_OPENCODE_PURE` は `1` / `true` / `yes`（大小文字無視、前後の空白は無視）で有効とし、未設定・空文字・その他の値は無効とする。不正値で停止はしない（`DELEGATE_CODEX_HOOKS` と同じく寛容に扱う）。

MCP の入力元は実行時に自動判別できない。protocol v1 の request は requester backend を持たず、wrapper 引数にも無く、`WrapperContext.backend` は worker model 由来だからである。したがって `DELEGATE_OPENCODE_MCP_SOURCE`（`claude` / `cursor` / `codex`）で明示する。抽出は既存 extractor をそのまま使い、renderer だけ opencode 用を新設する（Step 6）。env の値と抽出結果の組み合わせは次の表で確定させ、実装に判断を残さない。

| `DELEGATE_OPENCODE_MCP_SOURCE`                                                          | 抽出   | config の `mcp` | `mcp_config.source` | `mcp_config.servers`         |
| --------------------------------------------------------------------------------------- | ------ | --------------- | ------------------- | ---------------------------- |
| 未設定 / 空文字                                                                         | しない | 載せない        | `shared`            | `[]`                         |
| `claude` / `cursor` / `codex`、1 件以上を変換できた                                     | する   | 載せる          | `injected`          | 載せた server 名             |
| 同上、変換できた entry が 0 件（設定不在 / JSON 不正 / CLI 失敗 / 全 entry が変換不能） | する   | 載せない        | `none`              | `[]`                         |
| 上記以外の値                                                                            | —      | —               | —                   | child 起動前に exit 3 で停止 |

`shared` と `none` の使い分けは spec.md §6 の既存語義に従う。未指定は「wrapper が MCP 構成を所有せず実行環境の設定をそのまま使う」状態なので `shared` とする（project config の `mcp` は継承されるため、worker が MCP を使うことはあり得る）。指定したうえで server が見つからなかった場合だけ `none` とする。

抽出と変換の規則:

- 設定の探索順は既存 wrapper と同じにする。`claude` は `CLAUDE_CONFIG_DIR/.claude.json`、無ければ `HOME/.claude.json`。`cursor` は `CURSOR_CONFIG_DIR` → `XDG_CONFIG_HOME/cursor` → `HOME/.cursor` の順で決めた directory の `mcp.json`。`codex` は `CODEX_HOME`（未設定なら `HOME/.codex`）で `codex mcp list --json`
- `codex` source は subprocess を起動するため、補助 subprocess と同じ bounded helper（timeout・出力上限・SIGKILL）経由で呼ぶ。既存 `mcpExtractCodexUser` は timeout を持たないので helper でラップする。失敗は空の抽出結果として扱い、run は失敗させない
- canonical entry の変換は `{command, args, env}` → `{ type: "local", command: [command, ...args], environment: env }`、`{url}` → `{ type: "remote", url, headers }`。どちらにも当てはまらない entry は捨て、`servers` にも載せない
- 注入する各 entry には `enabled: true` を明示する。opencode の config は deep merge のため、project 側の同名 entry に `enabled: false` があると注入した server が無効化される
- **注入した env 値と header 値は redaction 対象として保持し、capture / observe の `streams.content` / event / response へ書き出す直前に伏字へ置換する**。`OPENCODE_CONFIG_CONTENT` は子プロセスへ継承されるため、worker や MCP server が環境変数を出力すると秘匿値が永続化され得る
- `DELEGATE_OPENCODE_MCP_SOURCE` は trim せず完全一致で検証する。前後に空白を含む値は exit 3 に倒す
- `servers` に記録するのは実際に config へ載せた名前だけで、command / env / headers / 認証情報は記録しない
- `--pure` と MCP 注入は独立に効く。plugin を無効化した run でも MCP は注入する

## 4. 実装ステップ

### Step 1: (完了済み) 設計判断の確定と残 PoC

- §5 の設計判断（selector 記法 / report 方式 / permission / effort）を確定した
- PoC を free モデル中心に実施し、結果を §2.2 に記録した。有料モデルは cost 確認の 1 回のみ使用した
- 追加 PoC（採用 permission profile での再確認、2026-08-22 実施）で次を確定した
  - 採用 profile（`edit: "deny"` のみ注入、bash は既定）でも `edit` / `write` はツール一覧から消える
  - bash 経由の cwd 外アクセスは**書き込みが通り読み取りが拒否される**。前者は permission の検出漏れに見えるため report 回収の根拠にせず、後者は inline gate 超過を fail-closed とする根拠になる
  - 採用 profile のまま front-matter 付き report が最終 `text` に出る。free モデルは形式を守る一方で内容品質が低い
- モデルは `write` が使えないと分かると bash のリダイレクトで同じ目的を達成した。抑止できるのは direct edit-tool の呼び出しだけという §3.2 の限定は実測どおりである

成果物: §2.2 の PoC 結果表。§5.b は `stdout_text` 方式で確定し、prompt の stdin 必須と cwd 外アクセスの非対称を §3.2 へ反映した

### Step 2: (完了済み) config 契約と MCP 入力元の確定

契約は §3.5 に、判断根拠は §5.i / §5.j に書いた。確定したのは次の 4 点。

- `OPENCODE_CONFIG_CONTENT` は wrapper が全体を構築し、呼び出し元の同名変数は継承せず破棄する
- permission と plugin は read-only 種別（explore / review、plugin は htmldoc も）で遮断し、write 系では project の設定を継承する。`DELEGATE_OPENCODE_PURE` で全 task type の plugin を無効化できる
- `instructions` / `agent` / `command` / `lsp` は継承する
- MCP の入力元は `DELEGATE_OPENCODE_MCP_SOURCE`（`claude` / `cursor` / `codex`）で明示する。env の値 × 抽出結果の全組み合わせを §3.5 の決定表で確定した（未指定は `shared`、指定して 0 件は `none`、不正値は exit 3）
- 注入した MCP server 名が project config と衝突した場合は注入側が勝つ

成果物: Step 4 と Step 6 が実装者判断なしに書ける config 契約

### Step 3: (未着手) モデル解決と selector 検証

この Step だけで build とテストが通る範囲に閉じる（wrapper 本体が無い段階で registry へ登録しない）。ただし **登録前に安全側へ倒す変更を先に入れる**。

- `shared/src/dispatch.ts`: 現在の `BACKEND_SCRIPTS[backend] ?? 'delegate-claude.sh'` は未登録 backend を Claude へ fallback させる。この Step では (1) `BACKEND_SCRIPTS` へ `claude: 'delegate-claude.sh'` を明示登録し、(2) その後で `?? 'delegate-claude.sh'` fallback を除去して未登録 backend を **fail-closed（exit 2）** にし、(3) 回帰テストを追加する。(1) を飛ばすと既定モデル（haiku / sonnet / opus / fable）を使う全 delegate が exit 2 で停止する
- `shared/src/prepare.ts`: `resolve-model` の出力を `trimEnd()` していたため、利用者が指定した末尾空白まで消えて grammar 検証が正規化後の値に働いていた。契約として付く末尾 LF だけを除去し raw 入力を検証へ渡す（既存 4 backend の prepare 段階の判定は変わらない）
- `shared/src/backend.ts`: `backendFromModel` に `opencode/` 分岐と in-source test を追加
- `shared/src/observe-effort.ts`: selector 剥離と §3.1 の grammar 検証（`/` がちょうど 1 つ、provider / model が非空、空白・制御文字なし）、二重 selector の exit 6 と stderr 文言。effort は形式検証のみとし、`validateBackendEffort` で opencode を早期 `{ ok: true }` にする
- `shared/src/observe-effort.ts`: `/` を含むのに `opencode/` で始まらないモデル名（selector 欠落の `opencode-go/glm-5.2`、区切り誤りの `opencode:opencode-go/glm-5.2` 等）は現状 `backendFromModel` の既定分岐で claude へ落ちる。既存 4 backend のモデル名に `/` は含まれないため、`/` を含むモデル名は opencode selector を要求すると定義し、grammar を満たさないものを exit 6 で拒否する。省略形・区切り誤りは exit 6 で拒否し、selector 付きで grammar を満たす未知 provider（`opencode/<unknown>/<model>`）は **dispatch して実行後分類に回す**（catalog を allowlist にしない §5.f と揃える）。両者の回帰テストを追加する

成果物: モデル名から opencode backend が決定論的に選ばれ、不正記法が dispatch 前に停止する。wrapper 未実装の中間状態でも誤 backend が起動しない

### Step 4: (未着手) wrapper 本体・共通層の第 3 モード・配線

- `shared/src/wrapper-opencode.ts` を新規作成し、`wrapper-cursor.ts` の構造（`parseWrapperArgs` → `makeWrapperContext` → 子 CLI 起動 → `waitWithHeartbeat` → finalize）を踏襲する
  - CLI 解決: PATH 上の `opencode` を `--version` で検証
  - argv: `run --format json -m <provider/model> [--variant <effort>] [-s <sessionID>]`。prompt は **必ず stdin**（positional に置くと `---` でハングする。§2.2）
  - config 注入: §3.5 の規則で config を構築して `OPENCODE_CONFIG_CONTENT` へ載せる（呼び出し元の同名変数は破棄する）。`explore` / `review` / `htmldoc` では `--pure` を argv に足し、`DELEGATE_OPENCODE_PURE` が有効なら全 task type で足す（§3.5）
  - cwd は `REPO_ROOT`
- **共通層に第 3 の report mode を通す**（現在の `CompletionConfig.reportMode` は `structured | report_md` の union で、`completeMissingResponse` も 2 分岐しかない）
  - `wrapper-common.ts`: `reportMode` に `'stdout_text'` を追加し、対応する completion branch と collector を実装する。`CompletionOutcome.structuredParse` は **`null` を維持する**。spec.md §6 の `timing.structured_output_parse` は「Claude / Codex の schema 強制出力の parse 成否」と定義されており、front-matter parse の成否をここへ入れると既存 consumer の解釈が変わる。front-matter parse の成否を観測したい場合は、方式非依存の新 field（例 `response_parse`）を spec に足してから使う
  - `wrapper-report.ts`: `reportModeForBackend` に `stdout_text` を追加する。front-matter の parse は `report_md` 方式と共有し、status は前後の空白だけを除去して語彙と完全一致で判定する（内部空白を削る既存実装は `status: com pleted` を `completed` として受理していた）。CRLF は parse 前に正規化し、opening から最初の closing delimiter までを front-matter として未知キーを無視する。Summary 見出しの判定は `read-response.ts` と同じ `^#+\s*Summary\s*$` に揃え、fenced code 内の行は見出しとみなさない
- `prompt-constraints.ts`: 現在の `promptConstraints(taskType, responseFile)` は explore / review / htmldoc で「`${responseFile}` への報告生成は可」と明示しており、cwd 外へ書けない stdout mode と矛盾する。report target を意識した形に変え、stdout mode では response path を渡さず「最終応答として front-matter 付き Markdown を返す」制約に差し替える。既存 4 backend 向けの制約文言は変えない（prompt は stdin / argv に載るため既存 golden を壊す）。report target が stdout の場合の分岐だけを足す
- **request inline gate 超過の扱いを決める**（protocol v1 は 256KB 超過時に worker が cwd 外の request file を `read-request.sh` で読む前提だが、opencode worker は cwd 外を読めない）
  - 採用: `DELEGATE_REQUEST_INLINE_MAX` 超過を child 起動前に fail-closed とし、wrapper が failed response を書いて Error section に理由と回避策（request を分割する / 他 backend を使う）を載せる。exit code は 1（`spec.md` §10 の「その他の実行失敗」）。stderr のみの通知は main へ届かないため使わない。cwd 内 staging は cleanup 責任とリポジトリ汚染を招くため採らない
- **補助 subprocess を helper に集約する**: `--version` は bounded timeout 付きの fail-closed preflight とし、CLI 不在・応答なしは exit 3（前提条件不足）で停止する。`DELEGATE_OPENCODE_MCP_SOURCE=codex` の抽出（`codex mcp list --json`）も同じ helper 経由にする。`export` / `models --verbose` / `session delete` を timeout・出力上限・SIGKILL 付き helper 経由の fail-soft にし、失敗は telemetry 欠落として run を止めない
- `shared/delegate-opencode.sh` shim を追加する（既存 shim と同構造。`sync-shared.ts` は `.sh` を自動列挙するため設定変更は不要）
- **中間状態の fail-closed**: session reuse は Step 6 で実装するため、それまで非空の session mode（`resumable` / `followup`）は child 起動前に exit 5 と failed response で止める。`-s` を付けずに通常 run として成功させない
- **child 失敗時の status**: child が非 0 終了または signal を受けた場合、有効な最終 `text` があっても completed envelope を採用せず status=failed と Error section を強制する
- **stdout の逐次走査**: JSONL は全量を配列化せず逐次走査し、最後の `text` イベントだけを保持する。そのイベントの `part.text` が非文字列なら古いイベントへ遡らず failed にする。capture 全体 8 MiB / 行 1 MiB の内部上限を超えたら小さな failed response を書く
- **配線**: `shared/src/dispatch.ts` の `BACKEND_SCRIPTS.opencode = 'delegate-opencode.sh'` と `shared/src/main.ts` の `WRAPPER_BACKENDS.opencode = runWrapperOpencode` をここで足す（wrapper 実体と shim が揃う Step だから）
- **分岐漏れを型で止める**: 現在の `completeMissingResponse` は `if (reportMode === 'structured') ... else completeReportMd(...)` で、union を増やしても `stdout_text` が `report_md` 側へ落ちたままコンパイルが通る。exhaustive な `switch` + `assertNever` に置き換えてから mode を追加する

成果物: 通常 run で request → response が往復し、report mode の分岐漏れが型で検出される

### Step 5: (未着手) observe 正規化と失敗分類

- `shared/src/observe-usage.ts`: `step_finish` の `part.tokens` と `part.cost` を合算し、token と cost を **1 つの measured usage object** として組み立てる（`measurement: "measured"` / `source: "opencode_step_finish"` / `cached_input_tokens`、§3.3 のフィールド契約）。`total_tokens` は input + output とし、`part.tokens.total` は使わない。`step_finish` が 1 件も取れない、または token フィールドが取れない場合は `usage_parse_failed` event を出して推定 fallback に落とし、既存経路を使う（新 event は作らない）。`observe-cost.ts` は費用を報告しない backend 向けの推定専用モジュールなので**変更しない**
- `shared/src/observe-timing.ts`: `model_turns` / `tool_calls` は event の計数から取る。first useful / report ready は **event 到達時点の wrapper monotonic clock** から記録し、event の `timestamp`（epoch ms）は種別判定と順序判定にだけ使う
- `shared/src/observe-effort.ts`: `opencode export` は effort 指定がある run でのみ `opencode export <sessionID>` を 1 回呼び、`run.effort.effective = { value, source: "opencode_export" }` を記録する。未指定 run では呼ばず `run.effort` を記録しない（catalog 取得と同じく、成功パスかつ effort 未指定の run にオーバーヘッドを乗せない）。無効値もそのまま入るため有効性判定には使わず、`source` を `measured` にしない
- effort 指定がある run では catalog の `variants` と照合し、requested が含まれなければ observe event `effort_unsupported` を出し、response の Summary 先頭へ警告行を挿入する（§3.4）
- `shared/src/observe-followup.ts`: `classifiedReportLines()` は kind ごとに専用の Summary / Error 文言を持ち、未知 kind は generic failure へ落ちる。`model_catalog_miss` の分岐と固定文言（原因・model・retryable の 3 行）を追加する
- **補助 subprocess も child と同じ隔離境界で起動する**: `models --verbose` / `export` は child run と同じ sanitized env（呼び出し元の `OPENCODE_CONFIG_CONTENT` を破棄）、`cwd: REPO_ROOT`、`--pure` の付与条件で呼ぶ。caller の config や別 cwd の catalog で分類を誤らないため
- **catalog を authoritative とする条件を厳格化する**: 見出し行 → JSON ブロックの pair が 1 件以上そろっていることを要求し、見出しの無い単独 JSON・空出力・末尾の不完全ブロックは authoritative にしない。stdout が出力上限に達していたら parse 結果によらず `model_catalog_unavailable` に倒す
- **effort 指定時は常に `recordEffort` を 1 回呼ぶ**: session ID 欠落・export 失敗・parse 失敗でも `run.effort.requested` を残し、effective は既存値 `{ value: null, source: "not_exposed" }` に倒す
- **警告は failed response にも載せる**: 分類文と固定警告を単一の response 組み立てへ渡し、非 0 終了や front-matter 不正の fallback response でも Summary 先頭に警告行が入るようにする（後から書き戻さない）
- **opencode 用 post-run classifier を新設する**: 既存の `classifyChildFailure({ backend, stderrTail })` は pure 関数で stdout も requested model も受け取らないため、そのままでは使えない。入力（exit code / stdout tail / requested model / catalog 取得結果）、`/` を含む model 文字列の正規化、`failedResponseOutcome` への受け渡しを実装する。catalog miss は `ChildFailure` の新 kind `model_catalog_miss`（`retryable: true`）として記録する。`unknown` のままでは `recordChildFailure()` が early return して `error` が保存されない（§5.f）
- 各モジュールの in-source test に JSONL fixture を追加する
- spec.md §6 に additive field（`usage.cache_write_tokens` / `usage.reasoning_tokens` / `usage.source` の新値 / `events[].kind = "effort_unsupported"` / `error.kind = "model_catalog_miss"`）を定義する

成果物: observe JSON が既存契約と互換な形で埋まり、失敗と無効 effort が誤分類なしに記録される

### Step 6: (未着手) session reuse・session lifecycle・MCP 注入

- `shared/src/observe-followup.ts`: `RESUMABLE_BACKENDS` に `opencode` を追加する（session 実装が揃うこの Step で行う）
- resumable: 初回 run のイベントから `sessionID` を回収し、既存契約どおり `backend_session.resume_id` へ記録する（`backend_session.id` ではない）。`backend_session` は opt-in run にだけ入る契約なので、通常 run では書かない
- follow-up: `-s <sessionID>` を argv に付ける。session home / handle 欠落時は既存契約どおり fail-closed（exit 5）
- **通常 run の session lifecycle を決める**: opencode は opt-in でない通常 run でも永続 session store（`~/.local/share/opencode/`）を作る。通常 run は非永続という既存契約に合わせ、run 後に `opencode session delete <id>` で回収し、resumable / follow-up のときだけ保持する
  - 削除は `export` など session を参照する処理をすべて終えた後、`finally` 相当で行う
  - event 到達前の child kill / timeout / schema drift では session ID を取得できない穴がある
  - session ID は**認識済みイベント**（`step_start` / `text` / `tool_use` / `step_finish` / `error`）の `sessionID` だけを候補にし、全候補が一致した場合にだけ使う。相異なる ID が現れたら削除を試みない（並列 run の session を誤削除しないため）。不正形式の候補が後続の正しい ID を隠さないようにする
  - session identity は report / usage の妥当性と分離する。capture / 行の上限超過で report を failed にしても、検証済みの session ID による回収は行う
  - child spawn 後の wait・export・response finalize は lifecycle レベルの `try/finally` で囲み、例外や signal でも回収（または skipped / failed の記録）が必ず走るようにする
  - follow-up では capture の ID が `resume_id` と一致することを確認し、欠落・不一致なら成功として古い handle を再記録しない
  - session ID を取得できなかった run では削除を試みず `session_delete_skipped` event を残す（`session list` 差分による推測削除は並列 run の session を誤削除するため採らない）
  - child failure・signal 受信・response parse 失敗の各経路でも削除する（成功パスだけで削除しない）
  - **削除失敗は telemetry 欠落ではなく状態の残留**なので、observe event（`session_delete_failed`）として記録する。delegate 本体は失敗させないが、記録は必ず残す
- project config の継承境界は §3.5 の契約に従う（permission だけ遮断し、plugin は `DELEGATE_OPENCODE_PURE` で opt-out）
- MCP: opencode 用の renderer（`mcpRenderOpencodeConfig` 相当）を新設する。入力は既存の共通型 `McpCanonical` で、renderer だけが backend 別（`mcpRenderClaudeMcpConfig` / `mcpRenderCursorMcpJson` / `mcpRenderCodexToml`）
  - 入力元: `DELEGATE_OPENCODE_MCP_SOURCE` が選ぶ既存 extractor を使う。未指定なら抽出も注入もしない（§3.5）
  - 変換: canonical → opencode の `mcp` セクション（local は `type: "local"` + `command` 配列 + `environment`、remote は `type: "remote"` + `url` + `headers`）
  - observe: `mcp_config.source` は `injected`、`servers` はサーバー名のみ。command / env / headers / 認証情報は記録しない
  - 寿命: 初回・follow-up とも run ごとに親設定から再生成する（Cursor と同じ）
  - fixture: local / remote / env 付き / headers 付き / 変換不能 entry（捨てられて `servers` にも載らないこと）。`enabled` を書き出さないこと
  - **本環境では実効性を実測できない**（親の `~/.claude.json` に MCP サーバーが無く、既存 backend も同条件）。変換は fixture テストで固定し、実効性の確認は MCP 設定がある環境に回す。未確認のまま SHOULD を完了扱いにしない

成果物: review / fix ループで session が継続し、通常 run が session を残さず、親の MCP 設定が worker から使える

### Step 7: (完了済み) fake CLI golden と実 CLI smoke

- `scripts/delegate-wrapper-session.test.ts` に fake `opencode` CLI を追加し、argv / stdin / 3 session mode / permission 内容 / `--pure` の付与条件 / MCP 決定表 / 5 task type × `stdout_text` / inline gate 超過 / 既存 4 backend の回帰を固定した
- `scripts/delegate-run.test.ts` に one-shot 契約と、completed response での警告到達テストを追加した
- 実 CLI smoke（2026-08-23 実施、opencode v1.18.21）の結果:

| 確認項目                                    | 結果                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| explore / implement の 2 種別が `completed` | `opencode/opencode-go/glm-5.2` で両方成功。Summary は request の対象を指しており、テンプレート文字列の反復ではない                                                   |
| measured usage と cost                      | explore で input 15982 / output 395 / cached 10554 / cost 0.02685684、implement で cost 0.03264866。いずれも `measurement: measured`                                 |
| 実在しないモデル                            | exit 1 / `status: failed` / `error.kind = "model_catalog_miss"` / `retryable: true`。Error section に Cause・Model・Retryable が出る                                 |
| `variants` に無い effort                    | run は `completed` のまま `effort_unsupported` を 1 件記録し、Summary 先頭に固定警告が出る。`requested` と `effective` は共に指定値（export は無効値もそのまま返す） |
| resumable → follow-up                       | 1 回目で `backend_session.resume_id` を回収し、2 回目は**対象ファイルパスを request に書かなくても**直前の文脈からファイルを特定して更新した                         |
| 通常 run の session                         | 実行前後で `session list` の件数が変わらない（削除されている）                                                                                                       |
| explore の write 遮断                       | 書き込みを指示しても対象ファイルは作成されない                                                                                                                       |
| free モデルの report 形式                   | `opencode/nemotron-3.5-lightning-free` は**本文を先に書き front-matter を末尾に置いた**ため failed。回答内容自体は正確だった。有料モデルでは形式を守る               |

成果物: CLI レベルの契約が golden で固定され、fake では再現できない挙動が実機で確認された

### Step 8: (未着手) 公開仕様の更新と配布同期

CLI 契約の変更と公開文書の更新を同じ Step に置く。

- `docs/design/protocol-v1.md`: 現在 4 CLI と 2 つの response 組立方式だけを規定している。5 つの target backend と 3 方式（`structured` / `report_md` / `stdout_text`）へ更新し、request inline gate 超過時の backend 別例外（`read-request.sh` fallback は cwd 外を読めない opencode では成立しないため fail-closed）を追加する
- `docs/design/spec.md`:
  - §4 モデル解決（`opencode/` selector）
  - §5「実行系の四分岐」→「五分岐」へ改題し、opencode 起動節を追加、permission 節（全開放に統一する理由）を改訂
  - §6 observe JSON の backend 列挙と additive field（Step 5 で定義したもの、session lifecycle の `session_delete_skipped` / `session_delete_failed` event を含む）
  - §7 セッション再利用・MCP の対応表。`mcp_config.source` の `shared` / `none` を opencode がどう使い分けるか（未指定＝`shared`、指定して 0 件＝`none`）を §6 の語義説明へ追記する（通常 run の session 非永続性を含む）
  - §10 exit code / §11 リポジトリ構成（shim 追加）
  - §12 環境変数（`DELEGATE_OPENCODE_PURE` / `DELEGATE_OPENCODE_MCP_SOURCE`）/ §13 脅威モデル（cwd 外アクセスの非対称と、read-only 抑止が管理者設定のない環境を前提とする点）
  - request inline gate 超過時の backend 別例外（`read-request.sh` fallback は cwd 外を読めない opencode では成立しないため fail-closed）
- 見出し変更は既存リンクを壊すため、`docs/` 配下から旧アンカー（`実行系の四分岐` 等）への参照を洗って追随させる
- `README.md` / `README_ja.md`: prerequisites、How it works の backend 表、Skills 表の env、Supported model names 表、resumable 対応。Effort handling 節では opencode を「delegate は検証せず素通し」と書き分け、既存の「Invalid values and unsupported combinations stop before dispatch」が opencode の effort には当てはまらないことを明記する。cwd 外へ書けない制約、request inline gate 超過時の backend 別例外（`read-request.sh` fallback は cwd 外を読めない opencode では成立しないため fail-closed）、管理者設定のない環境を前提とすること、catalog 照合は参考情報であり allowlist ではなく `retryable` は分類のヒントであって自動リトライの指示ではないことも記載する
- `skills/*/SKILL.md`: 対象は **generic な 5 skill**（explore / implement / chore / review / htmldoc）だけ。`delegate-imagegen`（Codex 固定）と `delegate-x-research`（Grok 固定）は backend が固定でスコープ外なので触らない。実行系分岐・CLI prerequisite・session 対応に加え、§3.4 の通知（failed の Error section / Summary 先頭の警告行）を main がユーザーへ伝える手順、cwd 外アクセスの制約（direct edit / write と明示パス読み取りは拒否され、bash のリダイレクトは通る。出力先を cwd 外に指定する htmldoc / implement は成功が保証されない）、`DELEGATE_OPENCODE_PURE` / `DELEGATE_OPENCODE_MCP_SOURCE` の意味と、request inline gate 超過時の fail-closed、管理者設定のない環境を前提とすることを書く
- `shared/model-token-prices.json`: 次の checklist を検証可能な形で実施する。対象モデル集合は `opencode models --verbose` で `cost` が取れるモデルのうち documented model に載せるもの、`pricing_sources` への source 追加、`retrieved_at` の更新、`pricing_status` の明示、価格チャート 2 枚の再生成、`metrics:baseline:check` の通過とし、該当なしの項目も理由付きで記録する。単価は `opencode models --verbose` の `cost`（input / output / cache read / write）を一次ソースにする
- `docs/design/development.md`: 正本 / 配布 tree、backend 一覧、モデル追加手順に opencode の catalog drift 確認節（`opencode models --verbose`）を追加
- backend 数の増加は **generic な target backend だけ**に効く。requester（delegate を起動する側）は Claude / Codex / Devin / Cursor の 4 種のままなので、「4 → 5」の一律置換をしない。文字列検索でヒットした箇所ごとに requester の話か target の話かを判別する
- `docs/archive/` は完了済みプランの歴史記録なので、検索対象には含めても**書き換えない**
- `docs/design/protocol-v1.md` は 4 CLI と 2 つの response 組立方式に加えて exit 5 / 6 の表記漏れもあるため、同じ Step で直す
- `npm run build` → `npm run sync-shared` → ローカル skill 再インストール

成果物: 公開仕様と実装が一致し、配布コピーが同期される

### Step 9: (未着手) archive 化

- §1 の要件表に最終状態と状態を記入する
- 本ドキュメントを `docs/archive/opencode-backend.archive.md` にリネームする

成果物: archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. backend selector 記法

| 候補                              | 採用 | 理由                                                                                                                                                                                                          |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`opencode/<provider>/<model>`** | ✓    | opencode 自身の `provider/model` 表記の延長として読め、`opencode models` の出力に selector を 1 つ足すだけで指定できる。剥離後に `/` がちょうど 1 つという検証で、provider 欠落と二重 selector の双方を弾ける |
| `opencode:<provider>/<model>`     | ✗    | selector 境界は見た目に明確だが、fail-closed の検出力は `/` 案と同等で優位が無い。既存 delegate に無い区切り記号を増やす分だけ表記の学習コストが上がる                                                        |
| `<provider>/<model>` そのまま     | ✗    | 「`/` を含めば opencode」という暗黙ルールになり、prefix 判定という既存の軸と非対称。将来 `provider/model` 形式を採る CLI が増えると破綻する                                                                   |
| `opencode-<provider>/<model>`     | ✗    | `opencode-go/...` と前方一致で衝突し、剥離結果が `go/...` という存在しない provider になる                                                                                                                    |

### a2. provider 部分の省略

| 候補                         | 採用 | 理由                                                                                                                              |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| **省略不可（フル指定必須）** | ✓    | `opencode models` の出力をそのまま指定でき、解決が実行時の既定値に依存しない。provider を追加認証しても既存指定の意味が変わらない |
| 既定 provider を補完         | ✗    | 既定 provider を README / spec に書く二重管理が生じ、同名モデルが複数 provider に現れたとき解決先が env 次第で変わる              |

### b. report 回収方式

| 候補                                                                 | 採用 | 理由                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stdout 最終 text から front-matter 回収（新 mode `stdout_text`）** | ✓    | run_dir への書き込みを worker に要求しないため、permission の実装詳細に依存せず成立する。read-only 種別では edit / write ツール自体が消え、残る書き込み経路は bash のリダイレクト（permission の検出漏れに見える。§2.2）と、permission 継承が未検証の `task` ツールだけになる。採用 profile のまま front-matter 付き report が返ることを PoC で確認済み |
| `report_md` + run_dir だけ edit allow                                | ✗    | cwd 外を allow にできない（§2.2）。read-only 種別では edit / write が消えるため書き込み経路が bash のリダイレクトだけになり、report 生成が permission の検出漏れと shell quoting に依存する。`DELEGATE_WORK_DIR` を repo 内へ強制すれば回避できるが、opencode backend のためだけに work dir の既定を変えることになり protocol の一貫性を崩す            |
| `structured`（JSON schema 強制）                                     | ✗    | opencode CLI に `--json-schema` / `--output-schema` 相当のフラグが無い                                                                                                                                                                                                                                                                                  |

front-matter の出力はプロンプト依存になるため、front-matter を含まない応答は failed response として扱い、wrapper が status を落とす。

### c. permission 方針（spec.md「全開放に統一」の例外）

| 候補                                          | 採用 | 理由                                                                                                                                                            |
| --------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **種別ごとに permission を出し分け**          | ✓    | 実機で編集ツールの遮断を確認済み。Claude パスの denylist と同等の抑止を 5 番目の backend にも与えられ、read-only 種別の保証が prompt 依存のみだった現状より強い |
| 全開放に統一（Codex / Devin / Cursor と同じ） | ✗    | 技術的に抑止できるのに使わない理由が無い。ただし `bash` は explore でも allow にして Claude パスと粒度を揃える                                                  |

`OPENCODE_CONFIG_CONTENT` で与えた permission は既定ルールを置き換えず追加され、評価は先勝ちになる（§2.2）。したがって「既定より緩める」方向の指定は効かず、`deny` を足して締める方向にだけ使える。先勝ちで効かないのは `external_directory` のようなパターンリスト内の後置 allow であり、カテゴリ単位（`edit` / `bash`）の deny は既定を締める方向に効く。この非対称性が §5.b の選択を決めている。

締める方向については、対象リポジトリの `opencode.json` が `edit: "allow"` を宣言していても `OPENCODE_CONFIG_CONTENT` の `deny` が勝つことを実測した（§2.2）。委譲先リポジトリの設定で read-only 抑止を無効化されない。

### d. effort（`--variant`）

| 候補                                             | 採用 | 理由                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **形式検証のみで素通し + 実行後に catalog 照合** | ✓    | variant 語彙はモデルごとに異なり（`["high","max"]` / `["none","thinking"]` / 6 値など、29 モデル中 15 が対応）、delegate 側 allowlist は保守できない。一方 `opencode models --verbose` の `variants` で有効値を機械的に取得できるため、実行を妨げずに事後検知だけ行える |
| 厳格 allowlist で fail-closed                    | ✗    | 未知の effort が一切使えなくなる。effort が外れても worker は動く（品質・コストのチューニングが効かないだけ）ので、run が失敗する model 名の誤りと同じ強度で止める理由が無い                                                                                            |
| 素通しのみ（検知なし）                           | ✗    | 無効な effort が黙って無視され、ユーザーは effort が効いていると誤解したままになる                                                                                                                                                                                      |

検証は共通の形式チェック（`<model>@<effort>` の形、`@` の重複、空文字）だけで、`validateBackendEffort` は opencode を早期 `{ ok: true }` にする。実効性の可視化は observe と stderr に寄せる（§3.4）。

- `run.effort.requested`: 指定値をそのまま記録する
- `run.effort.effective`: `{ value: <export の info.model.variant>, source: "opencode_export" }`。**CLI が受け取った値であって有効性の証明ではない**（無効値 `bogus-effort-xyz` もそのまま記録される）。`source` を `measured` にすると既存の `effort_mismatch` 判定が誤作動するため使わない
- `opencode export` は effort 指定がある run でのみ 1 回呼ぶ。未指定 run では呼ばず `run.effort` を記録しない（catalog 取得と同じく、成功パスかつ effort 未指定の run にオーバーヘッドを乗せない）
- catalog 照合の結果は `run.effort` へは書かない（`recordEffort` が上書きするため）。**モデル行を取得できて** `variants` に requested が無いときだけ observe event `effort_unsupported` を出し、response の Summary へ警告行を載せる。モデル行を取得できない場合は判定不能として何もしない（§3.4）

### e. config 注入と並列実行の隔離

| 候補                                            | 採用 | 理由                                                                                                                                                                                                    |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`OPENCODE_CONFIG_CONTENT`（インライン env）** | ✓    | ファイルを作らないため Cursor で必要だった config dir コピーと rename 競合が起きない。マージ順で project `opencode.json` より後に効く。代償として session store は実 HOME に残り、§5.h の明示削除が要る |
| `OPENCODE_CONFIG`（パス指定）                   | ✗    | マージ順で project の `opencode.json` に上書きされ、対象リポジトリの設定次第で permission が無効化され得る                                                                                              |

### f. failure classification

| 候補                                                                | 採用 | 理由                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ChildFailure` に `model_catalog_miss`（retryable: true）を足す** | ✓    | catalog miss を記録しつつ恒久エラーへ倒さない。`recordChildFailure()` は `unknown` で `error` キー自体を作らないため、既存 union に載せない限り記録経路が無い                           |
| `kind: "unknown"` のまま補助フィールドを足す                        | ✗    | `recordChildFailure()` が early return し、`error` が保存されない。§1 の MUST を満たせない                                                                                              |
| `model_not_found`（`retryable: false`）を使う                       | ✗    | 一過性障害を恒久エラーと誤記録する。opencode の失敗メッセージは実在 provider + 不明モデル / 不明 provider / provider 欠落のすべてが同一の `UnknownError` で、モデル不存在を断定できない |
| stdout / stderr の signature を登録                                 | ✗    | 上記のとおり 3 パターンが同一メッセージで、`ref` は毎回変わる                                                                                                                           |

`model_catalog_miss` を `retryable: true` にする根拠は「catalog 未掲載でも受理されるモデルがあり得る」ことだが、**これは Cursor で実際に起きた事象（`grok-4.5` が `agent --list-models` に無くても受理される）からの類推で、opencode では未実測である**。実測で否定されれば `retryable: false` へ格上げできる。`retryable` は分類のヒントであって自動リトライの指示ではない。逆に言えば、この不確実性がある限り catalog 照合は参考情報であり allowlist ではなく、dispatch 前の allowlist には使わない。

実装上の注意:

- 既存の `classifyChildFailure({ backend, stderrTail })` は pure 関数で、subprocess も stdout も requested model も受け取らない。opencode のエラーは stdout に出るため、この関数では拾えない
- opencode 用の post-run classifier を別に設け、入力（exit code / stdout tail / requested model / catalog 取得結果）と `ChildFailure` への写像、`recordChildFailure` / `failedResponseOutcome` / failed response の Error section 文言までを Step 5 に列挙する
- 既存 sanitizer は `/` を含む `provider/model` を受理しない。failure に載せる model 文字列の正規化を同時に扱う

### g. 価格表と cost

| 候補                                                         | 採用 | 理由                                                                                                                             |
| ------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| **`part.cost` を measured として記録し価格表は参照用に追加** | ✓    | Claude パスと同じく CLI が cost を直接返すため、推定に落とす理由が無い。価格表は README のチャートで横並び比較するために維持する |
| 価格表からの推定に統一                                       | ✗    | 実測値を捨てることになる                                                                                                         |

### h. 通常 run の session 非永続性

| 候補                                                    | 採用 | 理由                                                                                                                                                      |
| ------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **run 後の `session delete` + 取得不能時の event 記録** | ✓    | 通常 run は既存契約どおり session store を残さず、session ID を取得できない場合は `session_delete_skipped`、削除失敗は `session_delete_failed` に記録する |
| run ごとの XDG data 隔離                                | ✗    | 認証情報の限定注入が必要になり Codex の auth cleanup と同種の複雑性を抱えるため。並列競合が実測されたら §8 の代替案として採る                             |

既存 4 backend は状態の置き場所を run_dir 配下へ向け、run 後に丸ごと捨てることで非永続性を担保している（Claude は `workDir/claude-config`、Codex は `CODEX_HOME`、Cursor は `CURSOR_CONFIG_DIR`。Devin は session が cloud 側にあり local store を持たない）。opencode で同じ手を採れないのは §5.e で config 注入に env を選び、session store の置き場所が実 HOME のままになるためで、e と h はトレードオフの関係にある。削除方式は session ID を取得できた run にしか効かず、event 到達前の失敗では対象を特定できない穴が残る（隔離方式ならこの穴自体が生じない）。

### i. MCP の入力元

| 候補                                   | 採用 | 理由                                                                                                                                                                        |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **env で明示し、未指定なら注入しない** | ✓    | requester backend は wrapper から判別できないため、固定すると requester が使っていない設定を worker へ渡すことになる。Devin が MCP を注入せず `shared` を記録する先例もある |
| Claude user 設定に固定                 | ✗    | 設定不要になる代わりに、Codex / Cursor requester からの委譲で無関係な server 定義を注入する。4 requester を等しく扱う前提と合わない                                         |
| requester を実行時に自動判別           | ✗    | protocol v1 の request にも wrapper 引数にも requester backend が無く、実装できない                                                                                         |

### j. project config の継承境界

| 候補                                                                                                                     | 採用 | 理由                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **read-only 種別で permission と plugin を遮断し、write 系では継承。`DELEGATE_OPENCODE_PURE` で全 task type を opt-out** | ✓    | Codex の project hooks と同じ allowlist（`implement` / `chore` のみ有効、read-only 種別と htmldoc では prompt 制約の迂回を避けて無効）。委譲先は requester が作業中のリポジトリなので、書き込み種別では信頼する |
| 全 task type で `--pure` を付けて plugin を無効化                                                                        | ✗    | plugin 前提のセットアップをした repository では、実装・雑務の worker だけ挙動が変わる。Codex が同種の hook を write 系で有効にしている以上、opencode だけ全面禁止する根拠が無い                                 |

## 6. テスト方針

### 自動テスト

fake CLI で再現できるのは argv・env・stdout の形だけで、stdin EOF による ask reject、permission の実効性、実 catalog / export の schema は再現できない。前者を unit / fake で固定し、後者は実 CLI smoke（§6 手動確認）で担保する。

- `shared/src/backend.ts` の in-source test
  - `opencode/` 分岐、既存 prefix（`gpt` / `swe` / `composer` / `cursor-`）との非衝突、空文字
- `shared/src/observe-effort.ts` の in-source test
  - selector 剥離、`/` 欠落の exit 6、二重 selector の拒否、未知 effort が素通しすること、形式不正（`@` の重複 / 空文字）の拒否
  - `/` を含むのに `opencode/` で始まらない selector 省略形・区切り誤りを exit 6 で拒否し、selector 付きで grammar を満たす未知 provider は拒否しないこと（`opencode-go/glm-5.2`、`opencode:opencode-go/glm-5.2` 等）
  - `variants` に requested が無いとき `effort_unsupported` event を出し、あるときは出さない。`variants: {}` のモデルでも出す。catalog 取得失敗時は event を出さない
  - `run.effort.effective.source` が `opencode_export` であり、`recordEffort` の `effort_mismatch` を誘発しないこと
- `shared/src/observe-usage.ts` の in-source test
  - 単一 / 複数 `step_finish` の合算（token と cost の両方）、`measurement` / `source` / `cached_input_tokens` のフィールド名、`total_tokens` が input + output（`part.tokens.total` を使わない）、`cost_usd_estimated` が付かないこと、`cache` 欠落、壊れた JSONL 行の無視、`step_finish` 欠落・token フィールド欠落で `usage_parse_failed` に落ちること
- `shared/src/observe-timing.ts` の in-source test
  - event 計数からの model turns / tool calls、event 到達時の wrapper monotonic clock からの first useful / report ready（epoch `timestamp` を timing 値に入れないこと）、`structured_output_parse` が `null` のままであること
- opencode post-run classifier の in-source test
  - catalog に無いモデルで `error.kind = "model_catalog_miss"` かつ `retryable: true`、catalog を引けないときは既存 `model_catalog_unavailable`、catalog に行があるときは `unknown`（`error` キーを作らない）、`/` を含む model 文字列の正規化、truncation / 部分 parse 失敗時に `model_catalog_unavailable` へ落ちること
- `shared/src/wrapper-common.ts` の in-source test
  - `stdout_text` branch: 複数 `text` イベントからの最終応答選択、front-matter の剥がし、front-matter 欠落・不正 status で failed response、`error` イベントのみの応答
- `scripts/delegate-wrapper-session.test.ts`（fake `opencode` CLI）
  - argv（prompt が positional に無いこと）/ stdin prompt / 3 session mode / handle 欠落の fail-closed / response 欠落時の failed response / child error / child signal / `OPENCODE_CONFIG_CONTENT` の permission 内容（task_type ごとの差）
  - config 契約（§3.5）: 呼び出し元の `OPENCODE_CONFIG_CONTENT` が破棄されること
  - `--pure` が `explore` / `review` / `htmldoc` で付き `implement` / `chore` では付かないこと、`DELEGATE_OPENCODE_PURE` 有効時は全 task type で付くこと、`0` / 空文字 / 不正値では付かないこと
  - §3.5 の MCP 決定表 4 行（未指定＝`mcp` 無し + `source: "shared"`、抽出成功＝`mcp` 有り + `injected` + server 名、抽出 0 件＝`mcp` 無し + `none`、不正な env 値＝child 起動前に exit 3）
  - 5 task type（explore / implement / chore / review / htmldoc）× `stdout_text` の protocol matrix
  - request が inline gate を超えたとき child 起動前に fail-closed すること
  - 既存 4 backend の argv / response mode に回帰が無いこと（`structured` / `report_md` の既存ケースを無改変で通す）
- `scripts/delegate-run.test.ts`
  - one-shot JSON 契約と exit code 透過
  - **completed response + `effort_unsupported` のとき、警告が one-shot の `content`（Summary）に現れること**（stderr 経路では届かないため）

### 要件とテストの対応

§1 の各要件がどの層で立証されるかを固定する。空欄を残さない。

| §1 の要件                      | unit / in-source                                                                   | fake CLI golden                                                              | 実 CLI smoke                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 5 番目の実行系へ分岐           | `backend.ts` の分岐、`dispatch.ts` の shim 選択                                    | dispatch が `delegate-opencode.sh` を起動                                    | —                                                                          |
| 通常 run の protocol v1 往復   | `stdout_text` collector                                                            | 5 task type × `stdout_text` の matrix                                        | explore / implement の 2 種別（Summary が request を反映しているかも見る） |
| direct edit-tool 抑止          | permission JSON の生成                                                             | `OPENCODE_CONFIG_CONTENT` の内容（種別ごと）                                 | explore / review で拒否、implement で成功                                  |
| measured usage / cost          | `observe-usage.ts` の合算・フィールド名・`cache_write_tokens` / `reasoning_tokens` | usage が observe に入ること                                                  | 実 run の値が export と一致                                                |
| 不正なモデル記法の fail-closed | `observe-effort.ts` の grammar 検証                                                | `prepare` / `run` 経由で exit 6 が透過                                       | —                                                                          |
| 失敗の検知と通知               | post-run classifier の写像、`classifiedReportLines` の文言                         | catalog miss が one-shot の Error section に出ること                         | 実在しないモデル                                                           |
| 生成物の同期と配布             | —                                                                                  | —                                                                            | `build:check` / `sync-shared:check`                                        |
| session reuse                  | `observe-followup.ts` の resumable 判定                                            | 3 session mode                                                               | resumable → follow-up の 2 段                                              |
| session lifecycle              | 削除の呼び出し順と失敗時 fail-soft                                                 | 通常 run で delete が呼ばれ、resumable では呼ばれない                        | 通常 run 後に `session list` へ残らない                                    |
| MCP 注入                       | canonical → opencode config の変換 fixture、入力元 env の解決                      | 生成された config の `mcp` セクション、env 未指定時の `source: "none"`       | **本環境では不可**（§8）                                                   |
| effort 対応                    | `variants` 照合、モデル行欠落時の判定不能                                          | `effort_unsupported` event と Summary 警告行（欠落・重複時の生成規則を含む） | 未対応 effort の警告到達                                                   |
| 補助 subprocess の頑健性       | timeout / 出力上限 / SIGKILL / fail-soft                                           | 応答しない fake `models` での timeout                                        | —                                                                          |
| 価格表エントリ                 | —（`observe-cost.ts` は変更しない）                                                | —                                                                            | `opencode models --verbose` の `cost` と表の一致を目視                     |

gate の規則:

- **MUST の行**は unit / fake / smoke の該当欄がすべて埋まるまで archive しない
- **SHOULD の行**は、実装した場合のみ同じ基準を適用する。実装を見送る場合は §1 の状態欄へ「不採用」と理由を書けば archive できる
- MCP だけは例外で、実装しても実効性を本環境で確認できないため **smoke 未実施のまま archive してよい**（§8 のリスクとして残す）

### 手動確認

- [ ] `vp check`
- [ ] `npm test`
- [ ] `npm run build` / `npm run build:check`
- [ ] `npm run sync-shared` / `npm run sync-shared:check`
- [ ] `bash scripts/check-no-jq-md2idx.sh`
- [ ] 実 CLI smoke（すべて timeout 付きで実行する）
  - [ ] explore / review で編集が拒否され、implement で編集が通る（permission profile。ツール一覧と実際の edit / write 試行の両方で確認する）
  - [ ] measured usage と cost が observe に入る
  - [ ] report の Summary が request の対象を指しており、テンプレート文字列の反復でない（free モデルは形式のみ成立する実測がある。§2.2）
  - [ ] 実在しないモデルで failed response と `error.kind = "model_catalog_miss"` が出る
  - [ ] `variants` に無い effort で警告が response の Summary に出る
  - [ ] resumable → follow-up の 2 段実行で session が継続し、通常 run では session が残らない
  - [ ] 補助 subprocess（`export` / `models --verbose`）が応答しないときに run 全体が hang しない
- [ ] README / README_ja の記述が両言語で対応している
- [ ] ローカル skill 再インストール後に `cmp` でバンドルが一致する

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 既存 4 backend の argv / prompt 文言 / observe / exit code が変わっていない（既存 golden が無改変で通る）
- 新規挙動に対応する in-source test と fake CLI golden がある
- `npm run build:check` / `npm run sync-shared:check` / `vp check` / `npm test` が通る
- README / README_ja / spec.md / protocol-v1.md / development.md / SKILL.md が実装と一致し、backend 一覧と response 組立方式がすべて 5 backend / 3 方式を表している
- §6 の要件対応表の gate 規則を満たす。MUST の行は smoke まで埋まっており、見送った SHOULD は §1 の状態欄に理由がある
- fake CLI では担保できない挙動（stdin EOF の ask reject、permission の実効性、実 catalog / export schema）が実 CLI smoke で確認されている

## 8. 想定リスクと回避策

| リスク                                                                                                  | 回避策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| permission が期待通り効かず read-only が破れる                                                          | PoC でパターン allow が効かないことを確認済みで、`edit: "deny"` + stdout 回収に確定した（§5.b）。実 CLI smoke で explore の編集拒否を毎回確認する                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| config merge 順の最後にある管理者設定が `OPENCODE_CONFIG_CONTENT` を override し read-only 抑止が外れる | delegate の制御外。read-only 抑止は管理者設定のない環境を前提とすることを README / SKILL.md に明記する                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/` を含む model 文字列が failure report の sanitizer を通らない                                        | run / request / response / observe のパスは task type・timestamp・random token から生成され model を使わないため path 破損は起きない。実在する問題は failure に載せる model 名の表示・保存で、既存 sanitizer が `/` を受理しない点に限られる（Step 5）                                                                                                                                                                                                                                                                                                                            |
| 並列 run で session store が競合する                                                                    | PoC の 3 並列では競合が観測されなかった（§2.2）が、競合不在の証明ではない。実 CLI smoke に resumable を含む並列ケースを置き、競合が出たら `HOME` / `XDG_DATA_HOME` の run_dir 隔離を検討する（auth.json のコピーが要る点に注意）                                                                                                                                                                                                                                                                                                                                                  |
| `--variant` が黙って無視され effort が効かない                                                          | 素通し方針のため dispatch では弾かない（§5.d）。catalog の `variants` と照合して `effort_unsupported` event を出し、response の Summary へ警告行を載せる（§3.4）。ただし catalog に載っていても推論量が実際に変わった保証にはならない（PoC で low / high の reasoning token に有意差なし）                                                                                                                                                                                                                                                                                        |
| event schema drift で `step_finish` が取れず usage が 0 の measured になる                              | core field の取得可否を検証し、取れなければ `usage_parse_failed` + 推定 fallback に落とす。部分欠落・型変更・未知 schema を in-source test の fixture に入れる                                                                                                                                                                                                                                                                                                                                                                                                                    |
| worker の cwd 外アクセスに一貫した境界が無い                                                            | direct edit / write ツールは cwd 外を書けず、明示パスの読み取り（`cat /tmp/f`）も拒否されるが、**bash のリダイレクトによる書き込みは通る**（§2.2）。`task` 経由は未検証。したがって cwd 外への出力は「不可能」ではなく「保証・依存できない」ものとして扱う。(1) request が `DELEGATE_REQUEST_INLINE_MAX` を超える場合は child 起動前に fail-closed とする（Step 4 で確定）。(2) 出力先を cwd 外に指定する htmldoc / implement は成功が保証されないため、この制約を SKILL.md と README に明記する。(3) report 回収は stdout に寄せ、どの経路が塞がれても方式が変わらないようにする |
| prompt を positional で渡すとハングする                                                                 | wrapper は必ず stdin で渡す。fake CLI golden の argv assert に「positional に prompt を置かない」を含める                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| front-matter を出せないモデルで failed が頻発する                                                       | **実測で発生**（2026-08-23）。`opencode/nemotron-3.5-lightning-free` は回答内容は正確なまま本文を先に書き、front-matter を末尾に置いて failed になった。prompt は「先頭に front-matter を置き」と明示しているが、タスクが複雑になると形式が崩れる。有料モデル（`opencode-go/glm-5.2`）では守られた。救済（本文全体を report とみなす）は status を偽装するため採らず、failed response の Error section で front-matter 欠落と分かるようにしている。documented model に載せる際は形式維持の実績があるモデルに絞る                                                                  |
| catalog 未掲載だが受理されるモデルを恒久エラーと誤記録する                                              | catalog miss は `model_catalog_miss`（`retryable: true`）に留め、`model_not_found` へ倒さない（§5.f）。dispatch も止めない。`retryable` は分類のヒントであって自動リトライの指示ではない。README に「catalog 照合は参考情報であり allowlist ではない」と明記する                                                                                                                                                                                                                                                                                                                  |
| opencode の catalog / provider が予告なく変わる                                                         | Cursor と同じく「実 CLI で確認できた変換だけを持つ」方針を development.md に明記し、drift 確認手順（`opencode models`）を残す                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ドキュメント各所に「四分岐 / 4 backend」表現が残る                                                      | Step 8 で洗う。ただし requester は 4 種のままで target backend だけが 5 種になるため、一律置換はしない                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| free モデルの PoC 結果を有料モデルへ一般化する                                                          | 有料モデル（`opencode-go/glm-5.2`）で `part.cost` が非 0 になることを確認済み（§2.2）。実 CLI smoke でも有料モデルを 1 回使う                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 補助 subprocess（`export` / `models --verbose`）が hang する                                            | `--version` は preflight として別扱いにし、CLI 不在・応答なしは bounded timeout 付きで exit 3 にする。`export` / `models --verbose` / `session delete` を timeout・出力上限・SIGKILL 付きの共通 helper 経由で呼び、失敗は telemetry 欠落として fail-soft にする（Step 4）                                                                                                                                                                                                                                                                                                         |
| 通常 run の session が削除されず会話データが残る                                                        | `export` 後の `finally` 相当で削除し、child failure / signal / parse 失敗の経路も通す。event 到達前の child kill / timeout / schema drift では session ID を取得できず削除できないため、推測削除はせず `session_delete_skipped` event に残す。削除失敗は `session_delete_failed` event として残す（Step 6）。golden で削除の呼び出し順と失敗時の記録を固定する                                                                                                                                                                                                                    |
| project 側の同名 MCP entry と nested key が混ざる                                                       | opencode の config は deep merge のため、注入した entry と project 側の `environment` / `headers` が混ざり得る。`enabled: true` の明示で無効化だけは防ぐが、nested key の残留は inline 部分 object を載せる現行契約では避けられない。MCP 設定がある環境での実測に回し、衝突時の実効設定を確認する                                                                                                                                                                                                                                                                                 |
| MCP 注入の実効性を本環境で検証できない                                                                  | 親の `~/.claude.json` に MCP サーバーが無い。変換ロジックは fixture テストで固定し、実効性は MCP 設定がある環境で確認する。未確認のまま SHOULD を完了扱いにしない                                                                                                                                                                                                                                                                                                                                                                                                                 |
| opencode の permission 挙動が変わる（bash のリダイレクトが塞がれる / 読み取りが通るようになる）         | report 回収は stdout に寄せてあるため、書き込み側がどちらに転んでも方式は変わらない。読み取り側は inline gate 超過の fail-closed（Step 4）の根拠なので、permission 挙動が変わった場合は §2.2 の実測を取り直して判断を見直す                                                                                                                                                                                                                                                                                                                                                       |
| 共通層の第 3 mode 追加が既存 2 backend を壊す                                                           | `CompletionConfig.reportMode` の union 拡張は型で漏れを検出できる。加えて既存 4 backend の argv / response mode の golden を無改変で通すことを回帰条件にする（§6）                                                                                                                                                                                                                                                                                                                                                                                                                |

## 9. 参考

- [spec.md](../design/spec.md)
- [development.md](../design/development.md)
- [protocol-v1.md](../design/protocol-v1.md)
- opencode docs: <https://opencode.ai/docs/>（cli / config / permissions / agents / models / providers / mcp-servers / plugins）
