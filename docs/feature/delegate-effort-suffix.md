# effort 指定（`model@effort` suffix）設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdelegate-effort-suffix.md)

delegate-skills は現在 reasoning effort を一切指定せず、各 CLI のモデル既定値に委ねている（公開仕様）。本計画は `DELEGATE_<TYPE>_MODEL=gpt-5.5@high` のように **モデル名への `@<effort>` suffix** で effort を宣言可能にし、あわせて [issue #16](https://github.com/oubakiou/delegate-skills/issues/16) の最小案（observe JSON への実効 effort / fast 記録）を実装する。suffix は opt-in であり、`@` なしの起動 argv（backend 既定 effort・全モデル同一起動）は一切変えない。

宣言経路の開通は backend の CLI 仕様確認（PoC）を前提とする。特に Cursor agent CLI には独立した `--effort` フラグが**存在しない**こと（2026.07.16-899851b で実測）が判明しており、bracket parameter override のモデル別挙動を PoC で確定するまで Cursor への宣言は fail-closed とする（§3.3 / §5-c）。

完了後は README / README_ja の Effort behavior 表と `docs/design/spec.md` に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                                            | 開始時の状態                                                                                              | 完了条件                                                                                                                                                                                                                                                                                     | 最終状態                                                                                                                         | 状態 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [MUST] observe JSON に実効 effort を記録（issue #16 最小案）    | `run` に effort 相当フィールドなし。実効値は run artifacts を掘らないと分からない                         | `run.effort` が **全 wrapper**（generic 4 backend + imagegen + x-research）で記録される。宣言値（`requested`）と実効値（`effective.value` / `effective.source`）は別フィールドで判別でき、Cursor は `fast` パラメータも記録する                                                              | 全 wrapper の正常完走パスで `run.effort` を記録（子プロセス起動前に止まる fail-closed 経路は対象外）                             | 完了 |
| [MUST] `model@effort` suffix による effort 宣言                 | effort の指定経路が存在しない                                                                             | `DELEGATE_<TYPE>_MODEL`（設定 env およびインライン env による会話由来 override。§3.2）で `<model>@<effort>` が使え、Claude / Codex backend の CLI に effort が渡る。Cursor は PoC で変換方式を確定してから開通（確定まで fail-closed）                                                       | Claude（`--effort`）/ Codex（`-c model_reasoning_effort`）/ Cursor（PoC 確定モデルの bracket override）で開通                    | 完了 |
| [MUST] 非対応 backend・不正値の fail-closed                     | -                                                                                                         | Devin backend への `@` 指定、backend 許容外の effort 値、Cursor の未確定変換・slug（`-high` / `-max`）二重指定は dispatch 前に明示エラー（exit 6）で停止し、黙って無視しない                                                                                                                 | prepare（exit 6）と wrapper（二重検証、CLI 起動前）で停止。imagegen も `@` 一律 exit 6                                           | 完了 |
| [MUST] resumable / follow-up での suffix 保持                   | Claude / Codex wrapper は単一の `$MODEL` 変数で observe の `usage.model` / `backend_session.model` も書く | 初回 resumable run で `backend_session.model` に suffix 込み文字列が記録され、follow-up が前回指定子（suffix 込み）を継承して同じ effort フラグで再起動されることが e2e テストで検証されている。dispatch / wrapper 直接起動で異なる指定子を渡した場合は既存 validation が fail-closed にする | Claude / Codex に `ORIGINAL_MODEL` 分離を導入し、resumable → follow-up の suffix 保持と model mismatch fail-closed を e2e で検証 | 完了 |
| [SHOULD] suffix 付きモデル名の下流互換（価格 lookup / metrics） | 価格 lookup は `gpt-5.5@high` にマッチせず cost estimate が付かない（実測確認済み）                       | 価格 lookup・`cost_usd_estimated` が suffix を剥離して従来どおり機能する。metrics / observe の model 系フィールドの扱いが §5-b の正規形どおりに統一されている                                                                                                                                | 価格 lookup が `@` 以降を剥離（alias 経由含む）。observe の model 系フィールドは suffix 込み正規形で統一                         | 完了 |

スコープ外:

- **専用 wrapper（imagegen / x-research）への宣言経路**: 記録（`run.effort`）は全 wrapper に適用するが、`@` suffix による宣言は generic 4 backend に限定する。`delegate-imagegen` は Codex 固定のため generic Codex 経路の確定後に低コストで追随できる。`delegate-x-research`（Grok）は宣言対象外とし、記録は `not_exposed` から始める
- **`DELEGATE_<TYPE>_EFFORT` env の追加**: suffix と二重の指定経路を作らない（§5-a）。将来必要になれば suffix への正規化層として検討する
- **effort ベースの自動 routing / break-even gate**: [delegate-latency-reduction.md](delegate-latency-reduction.md) §1 スコープ外に記載の別計画のまま。本計画は「宣言できる・記録される」までを扱い、「いつどの effort を使うべきか」の判断は扱わない
- **Codex `reasoning_output_tokens` の usage 取り込み**: usage 計測の拡張は effort 記録とは独立した変更のため含めない
- **`agent` コマンドの PATH 衝突対策**: 調査中に `shared/delegate-cursor.sh` の `command -v agent` が Grok CLI 同梱の `agent` バイナリ（`~/.grok/bin/agent`）を解決しうる環境問題を発見した（§2 検証補記）。effort とは独立の欠陥のため別 issue で扱う

## 2. リファレンス / 確認済み事実

### CLI 側の effort 指定手段（2026-07-18、devcontainer 内の実 CLI で確認）

| Backend | 指定手段                                                                                    | 許容値                                                    | 確認状況                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude  | `--effort <level>`                                                                          | `low \| medium \| high \| xhigh \| max`（help 列挙）      | **PoC 確定**（claude 2.1.195）。alias モデル（haiku / sonnet）でも全値受理。**不正値はエラーにならず warning のみで無視して既定 effort で続行**（exit 0）→ prepare 側 exit 6 検証が必須（§5-e 裏付け）                                                                               |
| Codex   | `-c model_reasoning_effort=<value>`                                                         | `low \| medium \| high \| xhigh`（gpt-5.4-mini API 実測） | **PoC 確定**。指定値は session JSONL `turn_context.payload.effort` に反映（= requested/effective 突合の土台）。未指定は `effort: null`。不正値は API が `invalid_request_error` で拒否し run 失敗（exit 1、run 消費が無駄になる）。CLI は `ultra` → `max` へ写像し新系モデルのみ許容 |
| Cursor  | 独立フラグ**なし**。`--model 'model[effort=high,fast=false]'` の bracket parameter override | モデル別（下記 PoC 結果表）                               | **PoC 確定**（agent 2026.07.16-899851b、フルパス起動）。headless `-p` で bracket override を受理。誤パラメータ名・許容外値・非対応モデル・slug+bracket 二重指定は CLI が起動前に `Cannot use this model` で拒否（exit 1）                                                            |
| Devin   | なし                                                                                        | -                                                         | `--help` に effort 相当フラグなし → fail-closed 対象                                                                                                                                                                                                                                 |

### Cursor bracket override PoC 結果（2026-07-18、agent 2026.07.16-899851b で実測）

| Cursor モデル（CLI 渡し名）         | パラメータ        | 許容値                         | 備考                                                                                                   |
| ----------------------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `glm-5.2`                           | `reasoning`       | `high \| max`                  | bare 名は非公開（`--list-models` に無い）が bracket 付きで受理。`reasoning=low` / `effort=high` は拒否 |
| `grok-4.5`                          | `effort` / `fast` | `low \| medium \| high` / bool | bare 名も受理され config の `modelParameters` が適用される                                             |
| `composer-2.5`                      | `fast` のみ       | bool                           | effort 相当パラメータなし → `@effort` は fail-closed 対象                                              |
| `kimi-k2.7-code` / `gemini-3.1-pro` | なし              | -                              | bracket 指定は拒否 → fail-closed 対象                                                                  |

- 実効値は 2 経路で観測できる: stream-json イベントの model 表示名（例 `"GLM 5.2 High"`）と、run 後の隔離 cli-config.json（CLI が `selectedModel` と `modelParameters` の**両方**を実効値へ更新する。bracket 指定・slug 指定のどちらでも）。Step 1 の cli-config 抽出が run 後の実効値を読むことは実測で裏付けられた
- slug（例 `glm-5.2-max`）は CLI 内部で base + parameters へ正規化される（selectedModel は `{glm-5.2, reasoning=max}` になる）

**検証補記**: 本ドキュメント初版は「Cursor agent CLI に `--effort` フラグが実在する」としていたが、これは PATH 上で先に解決される Grok CLI 同梱の `agent` バイナリ（`~/.grok/bin/agent`、`grok 0.2.73`）の help を誤認したもの。本物の Cursor agent CLI（`~/.local/bin/agent`、2026.07.16-899851b）には独立した `--effort` はなく、[Cursor 公式 CLI リファレンス](https://docs.cursor.com/en/cli/reference/parameters)にも存在しない。この PATH 衝突は `delegate-cursor.sh:101` の `command -v agent` にも影響しうるため別 issue で扱う（§1 スコープ外）。

### 実装タッチポイント（2026-07-18、main HEAD の行番号）

| 箇所                                                                    | 現状                                                                                                                                   | 本実装での扱い                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/resolve-model.sh`                                               | env → デフォルトの単純解決。文字列をそのまま echo                                                                                      | 変更なし（suffix は透過）                                                                                                                                        |
| `shared/prepare.sh:147-176`                                             | `resolve-model.sh` 呼び出し後に backend 判定 → `build-request.sh` → `delegate_observe_init`                                            | この区間で suffix を検証（分解ヘルパ呼び出し）。不正なら dispatch 前に exit 6 で fail-closed                                                                     |
| `shared/observe-json.sh:19-26`（`delegate_observe_backend_from_model`） | プレフィックスマッチ（`gpt*` / `swe*\|devin-*` / `composer*\|cursor-*`）                                                               | 変更なし（suffix はマッチに影響しない）                                                                                                                          |
| `shared/observe-json.sh:169-170`                                        | `run.model_source` の optional 追加 jq パターン（`if $model_source == "" then . else ... end`）                                        | 同パターンで `run.effort` を optional 追加                                                                                                                       |
| `shared/observe-json.sh:520-523`                                        | follow-up validation は `.backend_session.model` と完全一致比較                                                                        | 比較ロジックは変更なし。ただし成立には wrapper 側の `ORIGINAL_MODEL` 分離（下記）が**前提**であり、自動では成立しない                                            |
| `shared/delegate-codex.sh:208-224` / `shared/delegate-claude.sh`        | `usage.model` / `backend_session.model` の observe 書き込みが CLI 用と同一の `$MODEL` 変数を使う                                       | `ORIGINAL_MODEL`（suffix 込み、observe 記録用）と `MODEL`（base、CLI argv 用）を分離。放置すると resumable 初回で suffix が消え、follow-up が壊れる              |
| `shared/observe-json.sh:781-808`                                        | 価格 lookup。devin/cursor prefix 剥離と cursor `-(high\|max)` fallback あり。`@high` 付きはマッチせず cost estimate が付かない（実測） | `normalized_model` に `@` 以降の剥離を追加                                                                                                                       |
| `shared/delegate-codex.sh:149-173`                                      | `codex exec -m "$MODEL" ...`。followup のみ `-c sandbox_mode=...` を使用                                                               | base model を `-m` に、effort があれば `-c model_reasoning_effort=<v>` を追加                                                                                    |
| `shared/delegate-codex.sh:120-123`                                      | `RESPONDER_SESSION_ID="codex:${MODEL}:..."`                                                                                            | base model を使用（Cursor / Devin wrapper が剥離後 model を使う既存慣習と整合）                                                                                  |
| `shared/delegate-claude.sh:131-137`                                     | `claude -p "$PROMPT" --model "$MODEL" ...`                                                                                             | effort があれば `--effort <v>` を `--model` 直後に追加                                                                                                           |
| `shared/delegate-cursor.sh:19-36, 167-187`                              | `cursor-*` 剥離（`ORIGINAL_MODEL` 保持 + `MODEL="${MODEL#cursor-}"`）→ `agent -p ... --model "$MODEL"`                                 | 同じ剥離パターンに `@effort` 分解を重ねる。宣言の変換（bracket override）は PoC 確定後。確定まで `@` 指定は fail-closed                                          |
| `shared/delegate-devin.sh:19-36, 124-135`                               | `devin-*` 剥離 → `devin -p ... --model "$MODEL"`                                                                                       | effort 指定手段がないため、`@` 付きは wrapper 到達前（prepare）に fail-closed                                                                                    |
| `shared/observe-json.sh:744-763`                                        | `delegate_observe_usage_from_codex_sessions` が session JSONL を find → parse。`reasoning_effort` は現状読んでいない                   | 同じ探索パターンで `reasoning_effort` を抽出（`null` は `backend_default`）                                                                                      |
| `shared/delegate-cursor.sh:105-123`                                     | 隔離 `cursor-config/cli-config.json` は real config のコピー。wrapper は selectedModel / parameters を編集しない                       | 実効値の記録 source: slug（`-high` / `-max`）→ `measured`。cli-config の parameters（`effort` / `reasoning` / `fast`）からの抽出可否は Step 1 で実 config を確認 |
| `shared/build-request.sh:113-125`                                       | run ファイル名は `delegate_<type>_<ts>_<token>_*` で model 非含有                                                                      | 変更なし（`@` がパスに入る経路はない）                                                                                                                           |
| `scripts/delegate-wrapper-session.test.ts:233-256, 434-442, 1147-1159`  | fake CLI が argv を capture し `log.args` で assert                                                                                    | effort 渡しと fail-closed、resumable → follow-up の suffix 保持 e2e の assert を追加                                                                             |

## 3. 設計の中核

### 3.1 記法と正規形

- 記法は `<model>@<effort>`。例: `gpt-5.5@high` / `sonnet@low`。`@` は既存のドキュメント済みモデル名・エイリアスのいずれにも含まれず、shell 上も安全で、プレフィックスベースの backend 分岐に影響しない
- **suffix 込み文字列を正規形とし、そのまま流す**: `resolve-model.sh` → `prepare.sh` → request JSON `.model` → `dispatch.sh` → observe の model 系フィールド（`run.model` / `usage.model` / `backend_session.model`）まで、モデル指定子は `gpt-5.5@high` のまま扱う
- 剥離は各 wrapper の冒頭（既存の `devin-*` / `cursor-*` prefix 剥離と同位置）で行う。**Claude / Codex wrapper にも `ORIGINAL_MODEL`（suffix 込み、observe 記録用）/ `MODEL`（base、CLI argv・`RESPONDER_SESSION_ID` 用）の分離を新規導入する**。現行の Claude / Codex は単一の `$MODEL` 変数で observe の `usage.model` / `backend_session.model` も書いており、単純に base へ置換すると resumable 初回の `backend_session.model` から suffix が消え、follow-up validation（suffix 込みの解決値と比較）が黙って壊れる。この分離が suffix 保持の要である（§1 MUST）
- 分解・検証は共有ヘルパ `delegate_observe_split_model_effort <model>`（`shared/observe-json.sh` に追加。全 wrapper と prepare が source 済み）に集約する。出力は `base_model` と `effort`（未指定は空）。パースを一箇所に集約し、wrapper ごとの再実装を禁止する

### 3.2 指定経路（env とインライン env）

effort の指定は `DELEGATE_<TYPE>_MODEL` の値としてのみ行う。経路は 2 つで、どちらも機構は同一（`prepare.sh` が `${!type_env}` を読む）:

- **設定 env**: 操作者が環境・プロジェクト設定で `DELEGATE_REVIEW_MODEL=gpt-5.5@high` を設定する
- **インライン env（会話由来 override）**: ユーザーが会話でモデル・effort を指定した場合、main agent が prepare 呼び出しに env を前置する: `DELEGATE_REVIEW_MODEL=gpt-5.5@high bash <skill_dir>/scripts/prepare.sh review ...`。これを会話由来指定の公式経路として各 SKILL.md に明記する（Step 5）

`run.model_source` は両経路とも `"env"` のままとする（設定 env と会話由来を区別しない）。区別が必要になった場合の拡張（例: `model_source: "inline"`）は本計画に含めない。exit 6（effort 指定不正）の stderr メッセージは「backend 名・指定値・許容値の列挙」を含む 1 行とし、main agent がそのままユーザーへの説明に使えるようにする。

**follow-up には指定経路がない（既存契約の維持）**: `session_mode=followup` の prepare は env を解決せず、前回 observe の `.backend_session.model` からモデル指定子を無条件に継承する（`shared/prepare.sh:139`、`model_source: "followup"`）。suffix 込み文字列を継承するため、follow-up は初回と同じ effort フラグで再起動される。effort や model を変えた再開は通常 API 上存在せず、変更したい場合は follow-up ではなく新規の通常 run を発行する。`observe-json.sh:520-523` の model 完全一致検証は、dispatch / wrapper を直接起動して異なる指定子を渡す非常経路に対する防御として機能する。

### 3.3 backend 別マッピングと fail-closed

| Backend | `@effort` 指定時                                                                          | 許容値検証（Step 2 PoC 確定）                                                                                                                                    | 未指定時               |
| ------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Claude  | `--effort <v>` を追加                                                                     | `low \| medium \| high \| xhigh \| max`                                                                                                                          | フラグなし（現状維持） |
| Codex   | `-c model_reasoning_effort=<v>` を追加                                                    | `low \| medium \| high \| xhigh`                                                                                                                                 | フラグなし（現状維持） |
| Cursor  | `--model 'model[<param>=<v>]'` の bracket override（`<param>` はモデル別。§2 PoC 結果表） | `cursor-glm-5.2` 系: `reasoning=high\|max` / `cursor-grok-4.5`: `effort=low\|medium\|high`。`composer-2.5` / `kimi-k2.7-code` / `gemini-3.1-pro` への `@` は拒否 | 現状維持               |
| Devin   | エラー（指定手段なし）                                                                    | -                                                                                                                                                                | 現状維持               |

fail-closed は **prepare 時点**（dispatch 前）で行う。`prepare.sh` の既存 exit code（3=前提不足 / 4=委譲サイクル / 5=follow-up validation 失敗）に **exit 6=effort 指定不正** を追加する。wrapper 側でもヘルパ経由で同じ検証を通し、wrapper 直接起動の経路でも黙って無視されないようにする（二重検証。判定はヘルパ一箇所なので乖離しない）。prepare 検証は CLI 側検証の代替ではなく前倒しである: Claude は不正値を黙って無視し（warning のみ）、Codex は起動後に API エラーで run を無駄にし、Cursor は起動前に拒否するが backend ごとにエラー表現が異なるため、統一された exit 6 + 許容値列挙 stderr を dispatch 前に返す。

Cursor の宣言経路は Step 2 PoC でモデル × パラメータ名 × 許容値が確定した（§2 の結果表）。PoC 対象外のモデル・許容値は引き続き exit 6 で停止する。slug（`-high` / `-max`）と `@` の二重指定は CLI 側でも拒否されることが確認されたが、prepare 時点で常に禁止する。

### 3.4 observe JSON への記録

`run.effort` を optional オブジェクトとして追加する（`run.model_source` と同じ optional 引数 + jq 条件付き追加パターン）。**宣言値と実効値は別フィールドに分離する**:

```json
"effort": {
  "requested": "high",
  "effective": { "value": "high", "source": "measured", "fast": false }
}
```

- `requested`: `@effort` suffix の宣言値。宣言なしなら `null`
- `effective.value`: run artifacts から抽出した実効値。抽出不能なら `null`
- `effective.source`: 実効値の出所

| effective.source  | 意味                                                                                     | 対象                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `measured`        | run artifacts から実効値を抽出できた                                                     | Codex resumable / follow-up（session JSONL `turn_context.payload.effort` が文字列）/ Cursor（slug または cli-config parameters） |
| `backend_default` | CLI 既定に委ねられたことが artifacts で確認できた（turn_context はあるが effort 値なし） | Codex resumable / follow-up                                                                                                      |
| `not_exposed`     | backend が実効値を露出していない / artifacts から確認できない（`effective.value: null`） | Claude / Devin / Grok（x-research）/ Codex 通常 run・imagegen（`--ephemeral`）                                                   |

**Codex の通常 run は `--ephemeral`（session 非永続）で起動するため session JSONL が残らず、実効 effort は `not_exposed` になる**（`delegate-imagegen-codex.sh` も常に `--ephemeral`）。`--ephemeral` を外して抽出可能にする選択は取らない: `@` なし argv の不変（§3.5 / §7）と session 非永続の既存挙動を維持する方を優先する。`measured` / `backend_default` が取れるのは session が永続する resumable / follow-up 経路のみ（2026-07-18 実測: ephemeral run の `--json` stdout / stderr にも effort 相当イベントは無い）。

- `effective.fast`: Cursor のみの optional boolean。cli-config parameters の `fast` を effort と同じ場所から抽出する（issue #16 が要求する Cursor の `effort` / `fast` 両方をカバー）
- requested / effective の突合による一致不一致の判定は、`effective.source` が `measured` の場合にのみ可能とする。`requested` 非 null かつ source が `not_exposed` / `backend_default` の組合せは「判定不能（宣言はしたが実効値を検証できない）」を機械可読に表す三値目として扱う
- `requested` が非 null かつ `effective.source` が `measured` で両者が食い違う場合、`effort_mismatch` observe event を追記する（宣言が CLI に効いていない事故の検出）。event は通知用の補助であり、判定の正本は requested / effective フィールドの突合とする
- 記録は**全 wrapper に適用する**: generic 4 backend に加え、`delegate-imagegen-codex.sh` は Codex 用抽出 helper を流用、`delegate-x-research-grok.sh` は `not_exposed` を記録する
- `schema_version` は optional 追加のため据え置く（issue #16 補足の判断に従う）

### 3.5 公平性との整合

issue #16 が最小案（記録）と宣言経路を分けたのは、宣言が起動条件を変えるためである。本計画では suffix を opt-in にすることでこれを両立する: `@` なしの起動 argv はバイト単位で現状と同一であり、ベンチの「全モデル同一起動」性質は保たれる。ベンチ側が effort を揃えたい場合は、全モデルに同じ `@<effort>` を宣言する（`requested` と `effective` の両方が記録に残るため、後から起動条件と実効値を説明できる）。

## 4. 実装ステップ

### Step 1: (完了) 実効 effort / fast の記録（issue #16 最小案）

- `delegate_observe_record_effort` helper を `shared/observe-json.sh` に追加し、`run.effort`（`requested` / `effective`）の optional 書き込みを実装（この時点で `requested` は常に `null`）
- Codex: `delegate_observe_effort_from_codex_sessions` が session JSONL の `turn_context.payload` から抽出。実 CLI 確認（2026-07-18）でフィールド名は現行 `effort`（旧 `reasoning_effort` / `model_reasoning_effort` も許容）。文字列 → `measured`、turn_context はあるが値なし → `backend_default`、session JSONL なし → `not_exposed`。通常 run と imagegen は `--ephemeral` のため session JSONL が残らず常に `not_exposed`（§3.4。measured が取れるのは resumable / follow-up のみ）。`delegate-imagegen-codex.sh` にも同 helper を適用
- Cursor: `delegate_observe_effort_from_cursor_config` が model slug の `-(high|max)` 終端 → `measured`（cli-config より優先）。実 config 確認（2026-07-18）で `modelParameters.<modelId>` と `selectedModel.parameters` の双方に `{id, value}` 配列（id は `effort` / `reasoning` / `fast`）を確認し、modelParameters → selectedModel（modelId 一致時）の順で抽出。effort が取れず `fast` のみの場合は `not_exposed` + `fast` 記録（誤 `measured` による突合誤判定を避ける）。`fast` は `effective.fast` に記録
- Claude / Devin / Grok（x-research）: `effective: {value: null, source: "not_exposed"}` を明示記録
- `scripts/observe-json.test.ts` に `describe('effort')` を追加（JSONL fixture / 旧フィールド名 / null・欠落 fixture / cli-config fixture（effort・reasoning・fast・slug・selectedModel fallback）/ not_exposed / requested+effective 分離）

成果物: 宣言経路なしでも「この run が何 effort / fast で走ったか」が全 wrapper の observe JSON から機械可読になる（issue #16 の要求範囲を充足）。記録は正常完走パスで行い、子プロセス起動前に止まる fail-closed 経路（`finish_without_child`）は対象外

### Step 2: (完了) PoC — CLI ごとの effort 受理確認

実モデルを呼ぶ live 実行で確定した事実（2026-07-18。詳細は §2 の表）:

- Claude: 許容値は `low | medium | high | xhigh | max`。alias モデル（haiku / sonnet）でも全値受理。**不正値は warning のみで無視して既定 effort で続行する（exit 0）**ため、CLI のエラーに任せる検証は成立しない（§5-e の採用理由を実測で裏付け）
- Codex: `-c model_reasoning_effort=<v>` は session JSONL の `turn_context.payload.effort` に反映され、requested / effective 突合が成立する。未指定は `effort: null`（= `backend_default`）。不正値は API が `invalid_request_error` で拒否し run が失敗する（起動後の失敗なので run 消費が無駄になる → prepare 検証で事前に止める価値がある）。ただし §3.4 のとおり session JSONL が残るのは resumable / follow-up のみで、通常 run（`--ephemeral`）の effective は `not_exposed` のまま
- Cursor: bracket override は headless `-p` で受理され、宣言経路を開通できる。パラメータ名・許容値はモデル別（§2 の PoC 結果表: `glm-5.2[reasoning=high|max]` / `grok-4.5[effort=low|medium|high][fast=bool]` / `composer-2.5` は `fast` のみ / `kimi-k2.7-code`・`gemini-3.1-pro` は非対応）。誤指定・slug+bracket 二重指定は CLI が起動前に拒否する。実効値は run 後の隔離 cli-config（`selectedModel` / `modelParameters` とも実効値へ更新される）と stream-json の model 表示名で観測できる

成果物: backend 別マッピングの「PoC」項目解消。Cursor は `cursor-glm-5.2-*`（slug 経由）と `cursor-grok-4.5` / `composer-2.5`（`fast` のみ）の範囲で bracket 変換を開通できることが確定。`composer-2.5` への `@effort`、`kimi-k2.7-code` / `gemini-3.1-pro` への `@` は fail-closed 対象として確定

### Step 3: (完了) 分解ヘルパと prepare 検証

- `delegate_observe_split_model_effort`（`@` 分解、JSON `{base_model, effort}` を返す）と `delegate_observe_validate_model_effort <backend> <model>`（PoC 確定済み許容値による backend 別検証。不正時は 1 行 stderr + 非 0）を `shared/observe-json.sh` に追加
- `shared/prepare.sh` に検証を組み込み、exit 6（effort 指定不正）を追加。Devin / Grok backend への `@`、許容外の値、Cursor の非対応モデル・slug 二重指定・malformed（`@` のみ / 二重 `@`）を dispatch 前に停止。follow-up は前回指定子を無条件継承するため検証しない（初回時点で検証済み）
- `prepare-imagegen.sh` も `@` を一律 exit 6 で fail-closed（imagegen への宣言経路はスコープ外のため）
- README 記載の全ドキュメント済みモデル名 × suffix 有無の分解、backend 別の受理・拒否、prepare の exit 6 / suffix 保持を in-source test で検証（`describe('model effort suffix')`）

成果物: 不正な effort 指定が子プロセス起動前に明示エラーで止まる。`gpt-5.5@high` 等の有効な suffix は prepare 出力と observe `run.model` に suffix 込みで流れる（正規形）

### Step 4: (完了) wrapper 改修と下流互換

- Claude / Codex wrapper に `ORIGINAL_MODEL`（suffix 込み、observe 記録用）/ `MODEL`（base、CLI argv・`RESPONDER_SESSION_ID` 用）分離を導入し、observe 書き込み（`run.model` / `usage.model` / `backend_session.model`）を `ORIGINAL_MODEL` に統一。effort があれば `delegate-claude.sh` は `--effort <v>`（`--model` 直後）、`delegate-codex.sh` は `-c model_reasoning_effort=<v>`（`-m` 直後。通常 / resumable / followup 全経路）を argv に追加
- `delegate-cursor.sh` は effort 分解 → `cursor-*` 剥離の順で base を得て、PoC 確定モデルのみ bracket override（`glm-5.2[reasoning=<v>]` / `grok-4.5[effort=<v>]`）へ変換。`delegate-devin.sh` はヘルパ検証のみ（fail-closed）
- 全 generic wrapper に prepare と同じ検証を二重化（`finish_without_child 6`。CLI 起動前に停止し failed response を書く）
- 価格 lookup の `normalized_model` に `@` 以降の剥離を追加（prefix 剥離・alias 解決より前）。`cost_usd_estimated` が suffix 付き・alias 経由でも付くことをテスト
- `run.effort.requested` の記録と `effort_mismatch` event（requested / effective 突合。`measured` 時のみ判定）を `delegate_observe_record_effort` に組み込み
- `scripts/delegate-wrapper-session.test.ts` に argv assert（`--effort` 位置 / `-c model_reasoning_effort` / bracket override）・fail-closed（CLI 未起動確認）・suffix なし argv 純度・resumable → follow-up suffix 保持 + model mismatch fail-closed の e2e を追加
- `npm run sync-shared` で全 skill コピーへ同期

成果物: `DELEGATE_<TYPE>_MODEL=gpt-5.5@high` が end-to-end で機能し、resumable / follow-up でも suffix が保持される

### Step 5: (未着手) ドキュメント反映と archive 化

- README / README_ja: 「delegate-skills は effort を渡さない」とする Effort handling 節を suffix 記法前提に書き換え。Documented model names 表に記法と backend 別の開通状況（Cursor のモデル別対応・Devin 非対応）を追記
- 各 SKILL.md: インライン env による会話由来 override の記載と、exit 6 の扱い（ユーザーへの許容値提示）を追加
- `docs/design/spec.md`: モデル指定子の正規形（suffix 込み）・分解位置・`ORIGINAL_MODEL` / `MODEL` の役割分担を記載
- issue #16 へ実装結果をコメントしクローズ
- 本ドキュメントを `docs/archive/delegate-effort-suffix.archive.md` へリネーム（ユーザー確認後）

成果物: 公開仕様と実装の一致

## 5. 設計判断

### a. 指定経路

| 候補                         | 採用 | 理由                                                                                                                                                                                                                                       |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`model@effort` suffix**    | ✓    | モデル文字列は resolve → prepare → dispatch → wrapper へ単一値として流れており、suffix は配管変更なしで同乗できる。設定 env とインライン env（会話由来。§3.2）の両方で同じ記法が使え、effort が model なしで意味を持たない実態とも一致する |
| `DELEGATE_<TYPE>_EFFORT` env | ✗    | 種別数 × effort の env が増殖し、`dispatch.sh`（既に位置引数 9 個）以下の全経路へ新引数の配管が必要。model と effort の組合せ検証も指定箇所と離れる                                                                                        |
| 両方サポート                 | ✗    | 同じことを言う経路が 2 つあると優先順位規則が必要になり、observe の `requested` の出所も曖昧になる                                                                                                                                         |

### b. 正規形と分解位置

| 候補                                                  | 採用 | 理由                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **suffix 込みを正規形とし、wrapper 冒頭でヘルパ分解** | ✓    | `devin-*` / `cursor-*` の `ORIGINAL_MODEL` / `MODEL` 分離と同型で、既存コードの慣習に馴染む。`dispatch.sh` の引数追加が不要。follow-up は前回指定子（suffix 込み）を継承するため effort フラグも自動で再現され、完全一致検証（§3.2、直接起動への防御）も observe 書き込みを `ORIGINAL_MODEL` に統一すること（§3.1、Claude / Codex への分離導入が前提）で正しく働く |
| prepare で早期分解し effort を別引数で配管            | ✗    | `prepare.sh` 出力 → 親 LLM → `dispatch.sh` → wrapper の全段に引数追加が必要で、親 LLM が組み立てる呼び出し（SKILL.md）も全 skill 分変わる。データモデルの純度より変更面積の小ささを優先する                                                                                                                                                                        |
| observe `run.model` からも suffix を剥がす            | ✗    | 「委譲時に指定されたモデル指定子」という事実が失われ、follow-up validation の突合も別配管が必要になる。ベンチ集計は `run.effort` を見ればよく、`run.model` の suffix は冗長だが無害                                                                                                                                                                                |

### c. Cursor への宣言の渡し方

| 候補                                                                     | 採用 | 理由                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PoC 確定まで fail-closed、確定後に bracket parameter override で開通** | ✓    | 独立した `--effort` フラグは存在しない（実測）。bracket override はパラメータ名がモデル別（`effort` / `reasoning`）のため、無検証で変換すると黙って無視・誤適用の恐れがある。確定した事実の分だけ開通する fail-closed 原則に従う |
| `@high` を slug `-high` へ書き換え                                       | ✗    | slug に effort を載せられるモデルは一部で、対応表の鮮度管理が bracket 変換表と二重に必要になる                                                                                                                                   |
| Cursor では `@` を恒久的に全面禁止（slug のみ）                          | ✗    | slug で表現できない effort・モデルの組合せに宣言経路がなくなり、env 一つでモデルを差し替える運用（ベンチ等）で Cursor だけ記法が分岐したままになる                                                                               |

### d. 非対応 backend（Devin）の扱い

| 候補                           | 採用 | 理由                                                                                                                                  |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **prepare 時点で fail-closed** | ✓    | 「宣言したのに効いていない」は effort 記録の動機（ベンチの公平性説明）を静かに破壊する。前提不足系の既存 fail-closed 原則とも一致する |
| 警告して無視                   | ✗    | 警告は親 LLM に読み飛ばされ得る。observe の `requested` と実挙動が乖離し、事故に気づけない                                            |

### e. 検証の置き場所

| 候補                                                            | 採用 | 理由                                                                                                                                |
| --------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **prepare で早期検証 + wrapper で再検証（判定はヘルパ一箇所）** | ✓    | 通常フローでは子プロセス起動前に止まり、wrapper 直接起動の経路でも素通りしない。検証ロジック自体は共有ヘルパ 1 実装なので乖離しない |
| prepare のみ                                                    | ✗    | dispatch / wrapper を直接呼ぶ経路（テスト・デバッグ・外部ツール）で不正値が CLI まで届く                                            |
| CLI のエラーに任せる                                            | ✗    | エラー表現が backend ごとにバラバラで、observe 上は一般の run 失敗と区別できない                                                    |

### f. 宣言値と実効値の分離（requested / effective）

| 候補                                                        | 採用 | 理由                                                                                                                                                                     |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`run.effort.requested` と `run.effort.effective` に分離** | ✓    | 「宣言したが効かなかった」場合に両者の食い違いがフィールドだけで判別でき、event を探す必要がない。ベンチ集計は effective を、起動条件の説明は requested を参照すればよい |
| 単一 `{value, source: declared \| ...}`（初版案）           | ✗    | 宣言値と実効値が同じフィールドを奪い合い、不一致時に `value` が何を指すか曖昧になる。「`run.effort` だけ見れば判別できる」という受け入れ基準を満たせない                 |

## 6. テスト方針

### 自動テスト

- `shared/observe-json.sh` の in-source shell test（`scripts/observe-json.test.ts`）
  - `delegate_observe_split_model_effort`: ドキュメント済み全モデル名 × suffix 有無 / 不正値 / Devin 拒否 / Cursor 未確定モデル・slug 二重指定拒否
  - `run.effort` 記録: `requested` あり / なし × `effective` の `measured`（Codex JSONL fixture / Cursor cli-config fixture: `effort`・`reasoning`・`fast` 各パラメータ名）/ `backend_default`（`reasoning_effort: null` fixture）/ `not_exposed`
  - 価格 lookup: `gpt-5.5@high` で `gpt-5.5` の価格が引けること、alias（`gpt-5.6@low` → `gpt-5.6-sol`）経由でも引けること
  - `effort_mismatch` event: requested `high` × JSONL 実測 `medium` fixture
- `scripts/delegate-wrapper-session.test.ts`（fake CLI）
  - Claude: `--effort high` が argv に含まれ、`--model` が base model であること。observe の `usage.model` / `backend_session.model` が suffix 込みであること
  - Codex: `-c model_reasoning_effort=high` が argv に含まれること（通常 run / resumable / followup）。observe の model 系フィールドが suffix 込みであること
  - Cursor: PoC 開通モデルで bracket override が `--model` 引数に含まれること。未確定モデルは wrapper が非ゼロ exit すること
  - Devin: `@` 付きで wrapper が非ゼロ exit し、CLI が起動されないこと
  - **suffix なし時の起動 argv が現状とバイト単位で同一であること**（公平性条件の回帰検証）
  - **resumable e2e**: 初回 `gpt-5.5@high`（resumable）→ observe の `backend_session.model` が `gpt-5.5@high` → follow-up の prepare が同指定子を継承し（`model_source: "followup"`）、wrapper が初回と同じ effort フラグ（`-c model_reasoning_effort=high`）を argv に含めること。dispatch / wrapper を直接 `gpt-5.5` / `gpt-5.5@medium` で起動した場合に既存 follow-up validation が model mismatch で fail-closed になること
- `prepare.sh` の exit 6 経路（既存 exit 3/4/5 テストと同形式）

### 手動確認

- [x] Step 2 PoC の全項目を実 CLI で確定済み（Claude 許容値 / Codex JSONL 反映 / Cursor bracket override のモデル別挙動）
- [x] `DELEGATE_EXPLORE_MODEL=gpt-5.5@high` の実 delegate（2026-07-18）で observe JSON に `run.effort: {requested: "high", effective: {value: null, source: "not_exposed"}}`（通常 run は `--ephemeral` のため実効値は露出しない。§3.4）と `cost_usd_estimated`（suffix 剥離後の単価で算出、`pricing_source: openai`）が両方付き、worker が completed を返すこと
- [x] suffix なし時の起動 argv が本実装前と同一であること（fake CLI の argv capture で `--effort` / `model_reasoning_effort` 不在を回帰検証。observe JSON の差分は `run.effort` の追加のみ）
- [x] `npm run sync-shared:check` / `vp check` / `vp test` が全パス

## 7. 受け入れ基準

- §1 の MUST 要件を満たす
- `@` なしの全既存フロー（通常 run / resumable / followup、4 backend + 専用 2 wrapper）で起動 argv が不変であり、observe JSON の差分が `run.effort` の追加のみである
- 不正な effort 指定（非対応 backend / 許容外値 / Cursor 未確定モデル / slug 二重指定）が dispatch 前に明示エラーで止まる
- observe JSON の `run.effort` だけを見れば、宣言の有無（`requested`）・実効値（`effective.value` / `effective.source`）が判別でき、宣言と実効の一致・不一致（`measured` 時）または判定不能（`not_exposed` / `backend_default` 時）の三値が機械可読に判別できる
- resumable 初回 → follow-up で suffix と effort フラグが継承され、直接起動で指定子を変えた場合は既存 validation で fail-closed になる
- `npm run sync-shared:check` が通る（生成コピーの直接編集なし）
- README / README_ja の Effort handling 節・各 SKILL.md が実装と一致している

## 8. 想定リスクと回避策

| リスク                                                                              | 回避策                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `--effort` の許容値・alias モデルへの適用可否が不明                          | Step 2 PoC で確定してから wrapper 改修に入る。非対応の組合せは検証ヘルパの許容値セットで fail-closed にする                                                                                                       |
| Cursor の bracket override がモデル別に揺れ、変換表の鮮度管理が負担になる           | PoC で確定したモデルのみ開通し、未確定は fail-closed。変換表は検証ヘルパ 1 箇所に集約し、README の対応表・テストと同時更新する運用を Step 5 でドキュメント化する                                                  |
| 宣言したのに CLI に効いていない（フラグ無視・バージョン差）                         | requested / effective の突合で検出し `effort_mismatch` event を追記する。実効値を露出しない backend（Claude / Devin / ephemeral Codex 通常 run・imagegen）は README の Effort behavior 表に検証不能である旨を明記 |
| resumable / follow-up で suffix が消え、follow-up が黙って壊れる                    | Claude / Codex への `ORIGINAL_MODEL` 分離（§3.1）で observe 記録を suffix 込みに統一し、resumable → follow-up の e2e テスト（§6)で回帰を防ぐ                                                                      |
| suffix 付き model 文字列が下流の未知の消費者（外部の observe 集計等）を壊す         | `run.model` の形式変更は opt-in 時のみ発生。README に正規形（suffix 込み）を明記し、集計側には `run.effort` の参照を案内する                                                                                      |
| effort だけ変えた再開（follow-up）ができない                                        | 意図した挙動として仕様化する（§3.2。follow-up は前回指定子を無条件継承し、effort 変更は起動条件の変更なので新規 run とすべき）。必要になれば指定経路の追加を別途検討する                                          |
| `command -v agent` が Grok CLI の `agent` バイナリを解決し、誤った CLI が起動される | 本計画とは独立の環境問題として別 issue で扱う（§1 スコープ外）。PoC・手動確認では Cursor agent CLI をフルパスまたはバージョン確認付きで起動して切り分ける                                                         |

## 9. 参考

- [issue #16: observe JSON に effort level（reasoning effort）を記録する](https://github.com/oubakiou/delegate-skills/issues/16)（本計画の Step 1 が最小案 + Cursor `fast` を含む記録、Step 2 以降がオプション節の具体化）
- [delegate-latency-reduction.md](delegate-latency-reduction.md) §1 スコープ外: effort routing は別計画（本計画完了後も routing は扱わない）
- [Cursor CLI parameters リファレンス](https://docs.cursor.com/en/cli/reference/parameters)（独立した `--effort` フラグは存在しない）
- [docs/design/spec.md](../design/spec.md) / [docs/design/development.md](../design/development.md)
- 既存実装: `shared/resolve-model.sh` / `shared/prepare.sh` / `shared/dispatch.sh` / `shared/observe-json.sh` / generic 4 backend wrapper / 専用 2 wrapper
- 調査記録: §2（2026-07-18、実 CLI 確認 + コードタッチポイント調査。Cursor `--effort` 不在・Grok `agent` バイナリとの PATH 衝突・価格 lookup の suffix 不一致は実測確認済み）
