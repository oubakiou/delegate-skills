# 委譲中ワーカー観測性 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdelegate-worker-observability.md)

[GitHub issue #1「委譲中ワーカーの進捗観測・停滞検知のための観測点整備」](https://github.com/oubakiou/delegate-skills/issues/1) に対応するための設計判断と実装手順をまとめる。delegate-skills の最重要目的は token cost の削減であり、本計画の観測機構も「親が子のログや途中経過を読み続けない」ための仕組みとして設計する。完了後は `docs/design/spec.md` / `docs/design/development.md` / README に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                               | 現状                                                                                                   | 完了条件                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [MUST] 親の token 消費を増やさずに観測できる       | 子の進捗確認には CLI 固有ログや stderr を人間・親が直接読む必要がある                                  | 通常経路では shell + `jq` の機械判定だけで待機し、親が読むのは最終 response または閾値超過時の絞り込み結果に限定する                 |
| [MUST] 委譲 run の観測先を機械的に特定できる       | request / response は `DELEGATE_WORK_DIR` 配下だが、実行系ラッパの一時ディレクトリは別途 mktemp される | `prepare` の返却 JSON に `observe_file` を含め、dispatch / heartbeat / stdout / stderr を同じ JSON に集約する                        |
| [MUST] dispatch の開始・終了・exit code を記録する | `DELEGATE_METRICS_FILE` は通常未設定で、dispatch の生存確認に使えない                                  | `dispatch_start` / `dispatch_end` を response_file basename 派生の observe JSON に記録し、終了時刻・exit code・duration を確認できる |
| [MUST] 子 CLI の stdout / stderr を保全する        | stdout は多くの実行系で `/dev/null`、stderr は実行系ごとの mktemp 配下                                 | response_file basename 派生の observe JSON に stdout / stderr を保存し、親の stdout には response_file path だけを維持する           |
| [SHOULD] 子 CLI が無音でも停滞と低速を判定できる   | response_file ができるまで外側から停滞と低速を判別しづらい                                             | 子プロセス実行中に heartbeat と capture byte counters を定期更新し、content を読まずに出力進捗を判定できる                           |
| [SHOULD] 子 CLI 失敗時も親が統一経路で失敗を読める | response_file 未生成時は stderr を親 stderr に出して exit 1                                            | 可能な範囲で短い failed response を生成し、詳細ログは observe JSON の必要部分だけを参照する                                          |
| [SHOULD] 人間用の request / response を維持する    | request_file / response_file 生成時に companion Markdown が生成されている                              | `*_req.md` / `*_res.md` は人間が読む内容確認用として維持し、observe JSON は機械監視用として分離する                                  |
| [SHOULD] repo-local WORK_DIR の運用を推奨できる    | 既定は `/tmp` 系で、日を跨ぐ調査時に消える可能性がある                                                 | README / SKILL.md に `DELEGATE_WORK_DIR=.temp/delegate/work` の推奨例を追加する                                                      |

スコープ外:

- watchdog / timeout の実装: 利用側ベンチハーネスの責務とし、skill 側は観測点のみ提供する
- 子エージェントへの進捗自己申告 prompt 強制: 不遵守・形骸化しやすいため、実行副作用ベースの観測を優先する
- 既定 WORK_DIR の即時 repo-local 化: 導入先リポジトリの gitignore 状況に依存し、ワークツリーを汚すリスクがあるため段階導入にする
- CLI 固有の全イベント正規化: 初期実装では stdout / stderr / heartbeat / observe event の保全に留める

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                                  | 本実装での扱い                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `shared/prepare.sh`                                                | request / response / observe_file を生成し、同じペアトークンで一意な run_dir を確保して返却 JSON に含める                    |
| `shared/build-request.sh`                                          | request / response のペアトークン生成を維持し、run_dir / observe_file 命名にも同じ一意性を使う                               |
| `shared/build-request.sh` の `write_companion_markdown`            | 既存どおり request JSON から人間用の `*_req.md` を生成する                                                                   |
| `shared/build-response.sh` / wrapper の `write_companion_markdown` | 既存どおり response JSON から人間用の `*_res.md` を生成する                                                                  |
| `shared/dispatch.sh`                                               | `exec` で委譲するだけの構造を変更し、run_dir / observe_file を wrapper へ渡し、start / end 記録と exit code の伝播を担当する |
| `shared/observe-json.sh`                                           | observe JSON の初期化・event 追記・heartbeat 更新・stream 保存を `jq` + `flock` で定型化する                                 |
| `shared/delegate-*.sh`                                             | wrapper scratch を一意な run_dir 配下に置き、stdout / stderr 保存先を observe JSON に統一する                                |
| `skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh`      | imagegen 専用ラッパも同じ観測規約に揃える                                                                                    |
| `skills/delegate-x-research/scripts/delegate-x-research-grok.sh`   | Grok 専用ラッパも同じ観測規約に揃える                                                                                        |
| `DELEGATE_METRICS_FILE`                                            | 集計向け proxy metric として維持し、運用監視は response_file basename 派生の observe JSON を主経路にする                     |

## 3. 設計の中核

### 3.1 delegate flow

新しい delegate flow は token cost 削減を最優先に、親が子の生ログを直接読み続けず、まず機械的な observe JSON 監視で待機する形にする。

```text
親: request_file / observe_file を作成する
  ↓
親: dispatch.sh で子 CLI を起動する
  ↓
子: request_file を読み、作業し、最終的に response_file を生成する
  ↓
wrapper / dispatch: observe JSON に state / heartbeat / events / streams を更新する
  ↓
親または watchdog: shell + jq で observe JSON の必要フィールドだけを監視する
  ↓
閾値内: response_file が生成されたら read-response.sh auto で最終結果だけ読む
  ↓
閾値超過: 親が observe JSON の stderr 抜粋、events、*_req.md、*_res.md の有無を読んで高度な状況把握へ進む
```

通常経路では、親は `observe_file` 全体や CLI 生ログを context に入れない。これは「子に読ませ、親は最終結果だけ読む」という delegate-skills の token cost 削減モデルを守るための制約である。たとえば watchdog は次のような機械判定だけを行う。

```bash
jq -e '.state.phase == "ended" and .state.exit_code == 0 and .state.response_present == true' "$observe_file"
jq '{heartbeat: .heartbeat.ts, stdout_bytes: .heartbeat.stdout_bytes, stderr_bytes: .heartbeat.stderr_bytes, last_stream_change_at: .heartbeat.last_stream_change_at}' "$observe_file"
jq -r '.state.started_at // empty' "$observe_file"
```

高度な状況把握へ進む条件は利用側が決める。例:

- heartbeat が一定時間更新されない
- `state.started_at` から現在時刻までの経過時間が timeout 閾値を超える
- heartbeat は更新されているが `stdout_bytes` / `stderr_bytes` / `last_stream_change_at` が一定時間変化しない
- `state.exit_code` が非 0
- `state.response_present` が `false`
- `streams.stderr.content` に quota / auth / permission などの既知 failure が含まれる

この段階で初めて、親は `jq` で observe JSON の必要部分だけを読む。人間が読む場合は `*_req.md` / `*_res.md` を使う。

### 3.2 per-run observe JSON

| 構成要素              | 内容                                                 | 配置 / 寿命                                                                                                        |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `run_dir`             | 1 回の delegate 実行に対応する一意な作業・観測ルート | `DELEGATE_WORK_DIR` 配下に生成。`prepare` の stdout JSON で親へ返し、dispatch / wrapper の scratch root として渡す |
| `<pair>_observe.json` | run の状態・heartbeat・stdout・stderr                | response_file basename から導出。watchdog / ベンチハーネスが読む                                                   |
| `observe-json.sh`     | observe JSON の読み書き helper                       | `shared/` 正本から各 skill へ同期する                                                                              |

`run_dir` は request / response のファイル名に含まれるペアトークンと関連付ける。関連ファイルの正本命名は response_file basename から導出する。たとえば response_file が `delegate_implement_20260704_123456_abcde_res.json` の場合、`<pair>` は `delegate_implement_20260704_123456_abcde` とする。

`dispatch.sh` と各 `delegate-*` wrapper は `run_dir` を必ず受け取り、wrapper-local な scratch file をすべてその配下に置く。既存の `codex-home`、`*-last-message.txt`、一時 report、CLI stderr/stdout 捕捉ファイル、`tmp/` などを共有 `DELEGATE_WORK_DIR` 直下に置かない。同じ `DELEGATE_WORK_DIR` で複数 delegate が並行しても、run ごとの scratch と observe JSON が混ざらないことを契約にする。

```text
delegate_implement_20260704_123456_abcde_req.json
delegate_implement_20260704_123456_abcde_req.md
delegate_implement_20260704_123456_abcde_res.json
delegate_implement_20260704_123456_abcde_res.md
delegate_implement_20260704_123456_abcde_observe.json
delegate_implement_20260704_123456_abcde/
  delegate_implement_20260704_123456_abcde_observe.lock
  tmp/
  codex-home/
  codex-last-message.txt
  worker-stdout.capture
  worker-stderr.capture
```

`*_req.md` / `*_res.md` は既存の human-readable companion として維持する。人間が依頼内容を確認するときは `*_req.md`、作業結果を読むときは `*_res.md`、watchdog やベンチハーネスが進捗・失敗・CLI 出力を見るときは `*_observe.json` を使う。

backend 名は model prefix ではなく実行系名に固定する。`sonnet` / `haiku` などは `claude`、`gpt-*` は `codex`、`composer-*` / `cursor-*` は `cursor`、`swe-*` / `devin-*` は `devin` とする。モデル名は observe event に記録する。

### 3.3 observe JSON schema

response_file は protocol v1 の最終成果物専用に保ち、進捗・生存確認・dispatch 結果・stdout / stderr は `<pair>_observe.json` に集約する。親や watchdog は `jq` で必要なフィールドだけを読む。

| フィールド       | 内容                                                                                                      | 更新主体                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `run`            | `task_type`, `model`, `backend`, `request_file`, `response_file`, `run_dir` などの固定情報                | `prepare.sh` / `dispatch.sh` |
| `state`          | `phase`, `dispatcher_pid`, `started_at`, `ended_at`, `exit_code`, `duration_ms`, `response_present`       | `dispatch.sh`                |
| `heartbeat`      | `ts`, `child_pid`, `backend`, `stdout_bytes`, `stderr_bytes`, `last_stream_change_at`                     | wrapper helper               |
| `events`         | `run_created`, `dispatch_start`, `response_missing`, `dispatch_end`, `failed_response_written` などの履歴 | `observe-json.sh`            |
| `streams.stdout` | stdout の `bytes`, `truncated`, `content`                                                                 | wrapper helper               |
| `streams.stderr` | stderr の `bytes`, `truncated`, `content`                                                                 | wrapper helper               |

`observe-json.sh` はすべての observe JSON 更新を `jq` で定型化し、直接 `jq` コマンドを各ラッパに散らさない。更新は observe file ごとの lock を `flock` で取得し、lock 内で read-modify-write する。書き込みは `tmp` ファイルへ出力してから `mv` する atomic replace にする。atomic replace は部分書き込み対策、`flock` は heartbeat / dispatch / stream 取り込みの同時更新で field を落とさないための read-modify-write 直列化として扱う。

lock file は observe file basename 派生の `<pair>_observe.lock` とし、`run_dir` 配下に置く。heartbeat background process、dispatch start/end、stream import、failed response event はすべて `observe-json.sh` 経由で同じ lock を使う。`flock(1)` を利用できない環境では `mkdir` ベースの lock fallback を検討対象にする。

heartbeat の更新間隔は `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL` で指定し、未設定時は 10 秒とする。heartbeat 更新時は capture file の現在サイズを `stdout_bytes` / `stderr_bytes` に記録し、前回 heartbeat からどちらかの bytes が増えた場合に `last_stream_change_at` を更新する。これにより watchdog は content を読まずに「ラッパは生きているが CLI 出力が進んでいない」状態を検出できる。CLI が進捗を stdout/stderr に出さない場合でも、絶対 timeout は `state.started_at` と現在時刻から利用側が計算する。

`state.duration_ms` は終了時に `dispatch_end` が書く値とし、実行中の timeout 判定には使わない。実行中の経過時間は `state.started_at` を読み、利用側が現在時刻との差分で計算する。

`streams.*.content` は保存上限を持つ。初期値は `DELEGATE_OBSERVE_STREAM_MAX_BYTES`、未設定時は 65536 bytes とする。超過時は末尾を残して `truncated: true` と `bytes` に元の総量を記録する。起動時エラーが先頭に出る CLI もあるため、将来の拡張候補として先頭 n KB + 末尾 m KB を残す方式も比較対象にする。全量ログが必要な用途は上限を明示的に上げ、`0` は無制限として扱う。

異常終了時の例:

```json
{
  "schema_version": 1,
  "run": {
    "task_type": "implement",
    "model": "sonnet",
    "backend": "claude",
    "request_file": ".temp/delegate/work/delegate_implement_20260704_123456_abcde_req.json",
    "response_file": ".temp/delegate/work/delegate_implement_20260704_123456_abcde_res.json",
    "run_dir": ".temp/delegate/work/delegate_implement_20260704_123456_abcde"
  },
  "state": {
    "phase": "ended",
    "dispatcher_pid": 12345,
    "started_at": "2026-07-04T12:34:57Z",
    "ended_at": "2026-07-04T12:49:21Z",
    "exit_code": 1,
    "duration_ms": 864000,
    "response_present": false
  },
  "heartbeat": {
    "ts": "2026-07-04T12:49:10Z",
    "backend": "claude",
    "child_pid": 12346,
    "stdout_bytes": 0,
    "stderr_bytes": 84,
    "last_stream_change_at": "2026-07-04T12:34:59Z"
  },
  "events": [
    { "kind": "run_created", "ts": "2026-07-04T12:34:56Z" },
    {
      "kind": "dispatch_start",
      "ts": "2026-07-04T12:34:57Z",
      "backend": "claude",
      "dispatcher_pid": 12345
    },
    { "kind": "response_missing", "ts": "2026-07-04T12:49:21Z" },
    {
      "kind": "dispatch_end",
      "ts": "2026-07-04T12:49:21Z",
      "backend": "claude",
      "dispatcher_pid": 12345,
      "exit_code": 1
    }
  ],
  "streams": {
    "stdout": { "bytes": 0, "truncated": false, "content": "" },
    "stderr": {
      "bytes": 84,
      "truncated": false,
      "content": "Claude usage limit reached. Try again later.\n"
    }
  }
}
```

watchdog / 親は `jq` で必要な情報だけを読む。

```bash
jq '{phase: .state.phase, heartbeat: .heartbeat.ts, stdout_bytes: .heartbeat.stdout_bytes, stderr_bytes: .heartbeat.stderr_bytes, exit_code: .state.exit_code}' "$observe_file"
jq -r '.streams.stderr.content' "$observe_file"
jq -r '.events[] | select(.kind == "dispatch_end")' "$observe_file"
```

### 3.4 failed response

子 CLI が異常終了し、かつ response_file が未生成の場合、ラッパは protocol v1 の failed response を可能な範囲で生成する。

- `status: failed`
- `responder_session_id: wrapper:<backend>:<response basename>`
- `Summary` / `Error` / `Logs` の短い report
- stderr の全文は埋め込まず、observe JSON の stderr 抜粋を短く要約する

`npx md2idx` や `jq` が使えない段階では failed response 生成に固執せず、observe event と stderr 保存を優先する。

## 4. 実装ステップ

### Step 1: (完了) 観測ファイル仕様の確定

- `run_dir` と `<pair>_observe.json` の命名規則を決める
- `dispatch.sh` / wrapper へ `run_dir` / `observe_file` を渡す引数契約を決める
- observe JSON schema を決める
- heartbeat の既定間隔と `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL` を決める
- observe JSON に追加する dispatch event のフィールドを決める
- response_file には途中状態を書かないことを protocol v1 の運用規約として明記する
- `*_req.md` / `*_res.md` は人間用、`*_observe.json` は機械監視用という役割分担を明記する
- `prepare` stdout JSON の後方互換性を確認する

成果物: event schema と `prepare` 返却 JSON の確定

### Step 2: (完了) run_dir 生成と observe helper

- `shared/prepare.sh` が `run_dir` を作成し、`run_created` を書く
- `prepare` の返却 JSON に `run_dir` / `observe_file` を追加する
- shell から安全に observe JSON を更新する `shared/observe-json.sh` を追加する
- `observe-json.sh` は observe file ごとの `flock` を取得してから `jq` で read-modify-write する
- `flock(1)` が無い環境向けの前提明記または `mkdir` lock fallback 方針を決める
- in-source ではなく shell fixture で JSON shape を検証する

成果物: `shared/prepare.sh` と共通 helper

### Step 3: (完了) dispatch event と exit code 伝播

- `shared/dispatch.sh` で backend 決定後に `dispatch_start` を記録する
- backend wrapper を通常呼び出しに変更し、`run_dir` / `observe_file` を渡し、exit code を捕捉して `dispatch_end` を記録する
- 既存どおり stdout は response_file path のみを返す
- `DELEGATE_METRICS_FILE` にも必要最小限の dispatch event を任意で追記する（未実装。現時点では通常無効の metrics ではなく observe JSON を正本にする）

成果物: dispatch の開始・終了・exit code が観測できる状態

### Step 4: (完了) CLI stdout / stderr 保全と heartbeat

- `shared/delegate-claude.sh` / `shared/delegate-codex.sh` / `shared/delegate-cursor.sh` / `shared/delegate-devin.sh` の stdout / stderr 保存先を observe JSON に統一する
- wrapper-local な scratch file はすべて一意な `run_dir` 配下に置く
- 子 CLI 実行中だけ observe JSON の heartbeat を定期更新し、capture file の `stdout_bytes` / `stderr_bytes` / `last_stream_change_at` を記録する
- 子 CLI 完了後に stdout / stderr を observe JSON の `streams` へ取り込む
- imagegen / x-research 専用ラッパにも同じ規約を適用する
- stdout を親 context に流さないことを regression test で確認する

成果物: CLI 非依存のログ保存と生存確認

### Step 5: (完了) failed response 生成

- response_file 未生成かつ CLI 異常終了時に短い failed response を生成する
- response には observe JSON path と exit code を載せ、ログ全文は載せない
- failed response 生成後も既存どおり `*_res.md` companion を生成する
- failed response 生成自体が失敗した場合は既存の stderr exit に fallback する

成果物: 親が `read-response.sh auto` で失敗要約を読める状態

### Step 6: (完了) ドキュメント更新と同期

- README / README_ja に `DELEGATE_WORK_DIR=.temp/delegate/work` の推奨例を追加する（完了）
- README / README_ja に `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL` / `DELEGATE_OBSERVE_STREAM_MAX_BYTES` を追加する（完了）
- `docs/design/spec.md` に観測ファイル規約を追加する（完了）
- `npm run sync-shared` で `skills/*/scripts` へ同期する（完了）
- `npm run sync-shared:check` / `vp check --fix` / `npx vitest run scripts/observe-json.test.ts scripts/sync-shared.ts` を実行する（完了）

成果物: 公開仕様と配布コピーが実装と一致

### Step 7: (未着手) archive 化

- 実装完了後、永続情報が design docs に移っていることを確認する
- 本ドキュメントを `docs/archive/delegate-worker-observability.archive.md` に移す

成果物: design docs 更新 + archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. 観測の主経路

| 候補                                           | 採用 | 理由                                                                                                      |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| **response_file basename 派生の observe JSON** | ✓    | state / heartbeat / stdout / stderr を 1 ファイルに集約でき、watchdog が metrics 集計ファイルに依存しない |
| 複数 sidecar ファイル                          | ✗    | 監視対象ファイルが増え、request / response との対応関係は明確でも運用上の見通しが悪い                     |
| `DELEGATE_METRICS_FILE` のみ                   | ✗    | 横断集計には向くが、通常未設定であり単一 run の運用監視には使いづらい                                     |
| response_file に途中状態を書く                 | ✗    | response_file は最終成果物として読まれるため、途中 JSON を置くと既存の読み取り契約を壊す                  |
| 子エージェントの report 更新                   | ✗    | prompt 遵守に依存し、CLI 異常終了や quota failure では機能しない                                          |

### b. WORK_DIR の既定

| 候補                                         | 採用 | 理由                                                                              |
| -------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| **現状維持 + repo-local 推奨を docs に追加** | ✓    | 導入先の gitignore を破壊せず、ベンチハーネス利用者には安定した保存先を案内できる |
| 既定を `.temp/delegate/work` に即変更        | ✗    | 既存利用者のワークツリーを汚す可能性がある                                        |
| 常に `mktemp`                                | ✗    | 日を跨ぐ失敗調査や外部 watchdog からの観測に弱い                                  |

### c. stdout の扱い

| 候補                                              | 採用 | 理由                                                                                     |
| ------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| **observe JSON に保存し、親 stdout へは流さない** | ✓    | context isolation と観測性を両立できる                                                   |
| 親 stdout に tee する                             | ✗    | main agent の context を汚し、既存の「stdout は response_file pathのみ」という契約を壊す |
| 破棄を継続する                                    | ✗    | CLI stream-json などの有用な進捗情報を失う                                               |

stdout / stderr は observe JSON の `streams` に保存する。親や watchdog は `jq -r '.streams.stderr.content' "$observe_file"` のように必要な stream だけを読む。

実行中の停滞検知は `streams.*.content` ではなく heartbeat の `stdout_bytes` / `stderr_bytes` / `last_stream_change_at` を使う。`streams.*.content` は完了後または異常終了時の状況把握用に読む。

### d. failed response

| 候補                                         | 採用 | 理由                                                              |
| -------------------------------------------- | ---- | ----------------------------------------------------------------- |
| **短い failed response + observe JSON 参照** | ✓    | 親の読み取り経路を統一しつつ、secret や巨大ログの混入を避けられる |
| stderr 全文を response に埋め込む            | ✗    | context 汚染と秘匿情報混入のリスクが高い                          |
| response 未生成のまま exit 1                 | ✗    | 利用側が backend ごとの stderr 位置を知る必要が残る               |

### e. heartbeat

| 候補                                                                           | 採用 | 理由                                                                            |
| ------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------- |
| **observe JSON の `heartbeat` を上書き更新し、capture byte counters を含める** | ✓    | content を読まずにラッパ生存と CLI 出力進捗を安く判定でき、ファイル数も増えない |
| 独立 heartbeat ファイル                                                        | ✗    | mtime 監視は単純だが、sidecar ファイルが増える                                  |
| capture file を watchdog が直接 `stat` する                                    | ✗    | 判定は軽いが、watchdog が wrapper scratch path 契約を知る必要がある             |
| CLI stdout の内容を見る                                                        | ✗    | token cost が増え、CLI によって stdout の粒度や有無も異なる                     |
| 子エージェントに定期報告させる                                                 | ✗    | prompt 遵守に依存し、長時間 tool 実行中は更新されない                           |

## 6. テスト方針

### 自動テスト

- shell fixture / fake backend による dispatch 検証
  - `dispatch_start` / `dispatch_end` が observe JSON の `events` に書かれる
  - `state.phase` / `state.exit_code` / `state.duration_ms` が更新される
  - 実行中は `state.duration_ms` に依存せず、`state.started_at` を使って timeout 判定できる
  - backend exit code がそのまま dispatch exit code になる
  - stdout が response_file path のみである
- fake CLI による wrapper 検証
  - stdout / stderr が observe JSON の `streams` に保存される
  - 子プロセス実行中に observe JSON の `heartbeat` が更新され、`stdout_bytes` / `stderr_bytes` / `last_stream_change_at` が変化する
  - 子プロセスが生きていて capture bytes が増えない停滞ケースを jq 出力だけで判定できる
  - response_file 未生成の異常終了で failed response が生成される
  - response_file 生成時に既存どおり `*_res.md` が生成される
- request fixture 検証
  - request_file 生成時に既存どおり `*_req.md` が生成される
- observe helper 検証
  - `observe-json.sh` が `flock` + atomic replace で JSON を更新する
  - `jq` で `state` / `heartbeat` / `events` / `streams.stderr.content` だけを抽出できる
  - stream 上限超過時に `truncated: true` と総 `bytes` が記録される
  - heartbeat 間隔の既定値と `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL` override が効く
  - heartbeat 更新、event 追記、stream import を並行実行しても既存 field が消えない
- 並行 run 検証
  - 同じ `DELEGATE_WORK_DIR` で 2 つの fake delegate を同時実行しても、run_dir 配下の scratch と observe JSON が混ざらない
- metrics fixture
  - `DELEGATE_METRICS_FILE` に dispatch event が追記される
  - 既存 metrics summary が未知 kind で壊れない

### 手動確認

- [x] `npm run sync-shared:check`
- [x] `vp check --fix`
- [x] `npx vitest run scripts/observe-json.test.ts scripts/sync-shared.ts`
- [x] repo-local `DELEGATE_WORK_DIR` で delegate prepare を実行し、response_file basename 派生の observe JSON を確認する
- [x] `jq '{phase: .state.phase, heartbeat: .heartbeat.ts, stdout_bytes: .heartbeat.stdout_bytes, stderr_bytes: .heartbeat.stderr_bytes, exit_code: .state.exit_code}' <observe_file>` で監視に必要な部分だけ読める
- [ ] 実行中 timeout は `state.started_at` と現在時刻から計算でき、`state.duration_ms` に依存していない
- [x] 子 CLI を意図的に失敗させ、failed response と observe JSON の stderr 抜粋を確認する
- [ ] `*_req.md` を開き、人間用の依頼内容確認として読めることを確認する
- [ ] `*_res.md` を開き、人間用の作業報告として読めることを確認する
- [x] README / README_ja / design docs の公開仕様と実装が一致している

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 通常経路で親が読む内容は `prepare` の短い JSON、機械判定の小さな `jq` 出力、最終 response に限定される
- 既存の request / response protocol v1 と `read-response.sh auto` の利用方法が壊れていない
- response_file の存在は「読み取り可能な最終 response がある」ことだけを意味し、途中状態は observe JSON にのみ書かれる
- `*_req.md` / `*_res.md` は人間用 companion として従来どおり生成され、observe JSON と役割が混ざらない
- 親 stdout に子 CLI の生ログが流れない
- dispatch / wrapper の scratch file は一意な `run_dir` 配下に閉じ、同じ `DELEGATE_WORK_DIR` の並行 run と混ざらない
- observe JSON の並行更新で heartbeat / events / streams / state の field が失われない
- 実行中に heartbeat の `stdout_bytes` / `stderr_bytes` / `last_stream_change_at` から、content を読まずに出力停滞を判定できる
- heartbeat interval の既定値と env override が文書化されている
- 子 CLI 異常終了時に exit code、stderr 抜粋、response_file の有無を response_file basename 派生の observe JSON から判断できる
- repo-local `DELEGATE_WORK_DIR` の推奨手順が README / README_ja に記載されている
- `npm run sync-shared:check` / `vp check` / `vp test` が通る

## 8. 想定リスクと回避策

| リスク                                             | 回避策                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| stdout / stderr 保存で observe JSON が巨大化する   | `DELEGATE_OBSERVE_STREAM_MAX_BYTES` で既定上限を設け、必要な場合だけ無制限または大きな値にする                                  |
| stderr / stdout に secret が含まれる               | failed response にはログ全文を埋め込まず、observe JSON path と短い要約に留める。保存先は gitignore 推奨の WORK_DIR にする       |
| heartbeat の background process が残る             | trap で停止し、子プロセス終了時に必ず cleanup するテストを追加する                                                              |
| observe JSON 更新が競合する                        | `observe-json.sh` に更新処理を集約し、observe file ごとの `flock` + tmp file + `mv` の atomic replace を使う                    |
| `flock(1)` が利用できない環境がある                | Linux 前提として明記するか、macOS 等向けに `mkdir` ベースの lock fallback を検討する                                            |
| 並行 run の scratch file が混ざる                  | `run_dir` を dispatch / wrapper の必須契約にし、wrapper-local file をすべて一意な `run_dir` 配下に置く                          |
| CLI が stdout / stderr に進捗を出さない            | capture byte counters では停滞と低速を完全には分けられないため、最終的な timeout は `state.started_at` ベースで利用側が判定する |
| stream の重要情報が切り詰めで落ちる                | 初期実装は末尾保持にし、必要に応じて先頭 n KB + 末尾 m KB 保持を追加検討する                                                    |
| `dispatch.sh` の `exec` 廃止で挙動が変わる         | exit code と stdout 契約を regression test で固定する                                                                           |
| repo-local WORK_DIR がワークツリーを汚す           | 既定変更はせず、`.temp/delegate/work` を推奨値として docs に記載する                                                            |
| imagegen / x-research 専用ラッパだけ規約から漏れる | Step 4 の対象に専用ラッパを明示し、sync 対象外ファイルも手動で確認する                                                          |

## 9. 参考

- [Issue #1](https://github.com/oubakiou/delegate-skills/issues/1)
- [spec.md](../design/spec.md)
- [development.md](../design/development.md)
- [protocol-v1.md](../design/protocol-v1.md)
- [README.md](../../README.md)
