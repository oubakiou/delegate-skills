# 子ワーカー backend usage / stream 観測 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdelegate-worker-backend-usage-streams.md)

[GitHub issue #2「子ワーカーの token usage 実測値を observe JSON に記録したい（claude / cursor / devin backend）」](https://github.com/oubakiou/delegate-skills/issues/2) と [GitHub issue #3「claude backend では stream 無変化ベースの stall 検出（DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS）が機能しない」](https://github.com/oubakiou/delegate-skills/issues/3) に対応するための設計判断と実装手順をまとめる。

既存の observe JSON / heartbeat / stream capture の基盤は [delegate-worker-observability archive](../archive/delegate-worker-observability.archive.md) と `docs/design/spec.md` に移管済み。本計画ではその上に、backend ごとの構造化出力を取り込み、usage の実測値と stall 検知に使える stream 変化を observe JSON へ正規化する。

完了後は `docs/design/spec.md` / `docs/design/development.md` / README / README_ja に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                                      | 現状                                                                                     | 完了条件                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [MUST] observe JSON に worker usage を記録する            | 現状は proxy telemetry の chars/4 推定が中心で、worker usage の実測抽出は未実装          | `observe.usage` に `input_tokens` / `output_tokens` / `cost_usd` / `measurement` / `source` を記録できる       |
| [MUST] usage の実測と推定を区別する                       | backend ごとの精度差が observe JSON から機械判定できない                                 | 実測値は `measurement: "measured"`、推定値は `measurement: "estimated"` として downstream が分岐できる         |
| [MUST] Claude backend の stall 検知を実効化する           | `claude -p` text 出力は完了まで stdout が動かず、正常作業中でも stream idle と見なされる | Claude backend で作業中イベントが stdout/stderr capture に流れ、`last_stream_change_at` が進む                 |
| [MUST] worker の最終 status 応答を構造化出力から取り出す  | Claude / Cursor は text の最終一語を前提にしている                                       | JSON / stream-json の最終 result から `completed \| partial \| failed \| needs_input` を検証して扱える         |
| [SHOULD] Cursor backend も構造化出力へ移行する            | `agent -p` text 出力を capture するだけ                                                  | Cursor agent CLI の JSON / stream-json 出力で usage と stream 進捗を取れる場合は Claude と同じ正規化を使う     |
| [SHOULD] Devin backend の usage 取得可否を調査する        | `devin -p` の usage 出力モードが未確定                                                   | usage を取れるなら実測値を記録し、取れないなら `measurement: "estimated"` を明示して fallback する             |
| [SHOULD] 既存の低コスト監視契約を維持する                 | 親は通常 `state` / `heartbeat` の小さい field だけを読む                                 | 構造化イベント全文を親 context に流さず、通常監視は既存 field と `usage.measurement` などの小さい field に限る |
| [SHOULD] backend 差異をテスト可能な pure 変換に閉じ込める | wrapper shell 内で CLI 出力形式を直接扱うことになりやすい                                | CLI 出力サンプルから observe usage / final status を抽出する parser を fixture で検証できる                    |

スコープ外:

- observe JSON 基盤そのものの再設計: `run_dir` / `heartbeat` / `streams` / `events` は既存仕様を維持する
- token usage を課金制御に使うこと: 本機能は観測・比較・集計用であり、delegate 実行可否の gate にはしない
- 全 backend で実測値を必須にすること: CLI が usage を公開しない backend は推定値を明示する
- prompt による進捗自己申告の強制: stall 検知は CLI の構造化イベントまたは capture bytes に基づける

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                       | 本実装での扱い                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `shared/observe-json.sh`                                | `usage` 更新 helper と、必要なら構造化 stream event 由来の heartbeat 更新 helper を追加する             |
| `shared/delegate-claude.sh`                             | `claude -p --output-format stream-json --verbose` を第一候補にし、最終 result と usage を parser に渡す |
| `shared/delegate-cursor.sh`                             | Cursor agent CLI の JSON / stream-json 出力可否を確認し、可能なら Claude と同じ parser 境界へ寄せる     |
| `shared/delegate-devin.sh`                              | Devin CLI の usage 出力可否を調査し、未対応なら推定値 fallback を明示する                               |
| `shared/delegate-codex.sh`                              | isolated `CODEX_HOME` の session JSONL を探索・解析し、取れない場合は推定 fallback に落とす             |
| `shared/model-token-prices.json`                        | `cost_usd` が CLI から取れない場合の推定コスト計算に使う候補。ただし delegate 実行の gate にはしない    |
| `docs/archive/delegate-worker-observability.archive.md` | observe JSON / heartbeat / stream capture の既存設計として扱い、本計画では差分だけを扱う                |
| GitHub issue #2                                         | usage schema と backend 横断の実測 / 推定の要件                                                         |
| GitHub issue #3                                         | Claude backend の stream idle 誤検知を解消する要件                                                      |

## 3. 設計の中核

### 3.1 observe JSON の usage schema

`observe.usage` を追加し、backend による精度差を明示する。存在しない場合は未計測を意味するが、wrapper が正常終了した後は可能な限り `measurement: "measured"` または `"estimated"` のどちらかを書き込む。

```json
{
  "usage": {
    "input_tokens": 12345,
    "output_tokens": 678,
    "total_tokens": 13023,
    "cost_usd": 0.0123,
    "measurement": "measured",
    "source": "claude_stream_json",
    "model": "sonnet",
    "backend": "claude"
  }
}
```

| フィールド      | 内容                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| `input_tokens`  | 入力 token 数。取得不能なら `null`                                                           |
| `output_tokens` | 出力 token 数。取得不能なら `null`                                                           |
| `total_tokens`  | 入力 + 出力。CLI が合計だけ返す場合は合計値を優先し、片方が不明なら `null` を許容する        |
| `cost_usd`      | CLI が実測 cost を返す場合はその値。単価表から計算した場合は推定値                           |
| `measurement`   | `"measured"` または `"estimated"`                                                            |
| `source`        | `codex_session_jsonl` / `claude_stream_json` / `cursor_json` / `devin_json` / `chars_4` など |
| `model`         | 実行時の model 名                                                                            |
| `backend`       | `claude` / `codex` / `cursor` / `devin`                                                      |

`measurement` は最重要 field とする。downstream のベンチハーネスは、実測値のみ比較する、推定値を別集計にする、推定値を警告扱いにする、といった判断をこの field だけで行える。

`cost_usd` は CLI が `total_cost_usd` などを返す場合のみ実測扱いにする。`model-token-prices.json` から計算した値は token 数が実測でも価格が外部表由来なので、`source` で価格由来を識別できるようにする。初期実装では `cost_usd` を `null` 許容にし、token 実測の導入を優先する。

### 3.2 backend 出力の正規化

構造化出力の parser は shell wrapper に埋め込まず、backend ごとの小さな変換境界に閉じ込める。

| backend | 目標出力                               | 取り出す値                                      | fallback                                     |
| ------- | -------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Codex   | isolated `CODEX_HOME` の session JSONL | input/output tokens、可能なら cost              | chars/4 推定                                 |
| Claude  | `--output-format stream-json`          | final result の status / usage / total_cost_usd | JSON 出力未対応なら text 出力 + chars/4 推定 |
| Cursor  | JSON または stream-json 出力           | final result の status / usage                  | 出力仕様未対応なら text 出力 + chars/4 推定  |
| Devin   | usage を含む出力モードがあれば採用     | usage / cost                                    | 未対応なら text 出力 + chars/4 推定          |

parser の入力は CLI stdout capture file とし、出力は observe JSON に merge できる小さい JSON にする。

```json
{
  "final_status": "completed",
  "usage": {
    "input_tokens": 12345,
    "output_tokens": 678,
    "total_tokens": 13023,
    "cost_usd": 0.0123,
    "measurement": "measured",
    "source": "claude_stream_json"
  }
}
```

wrapper は parser の `final_status` を信頼する前に、protocol v1 の status 値に含まれるかを検証する。未知値や parser failure は wrapper failure にせず、response_file の有無と子 CLI exit code を従来どおり優先し、observe event に parser failure を残す。

### 3.3 Claude backend の stream-json 移行

Claude backend は `claude -p` の text 出力が完了までほぼ動かないため、`DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` を有効化すると正常作業中でも stall と判定される。`--output-format stream-json --verbose` を使い、進行中イベントを stdout capture に流すことで既存の `heartbeat.last_stream_change_at` を実効化する。

採用方針:

- `delegate-claude.sh` は `claude_args` に `--output-format stream-json --verbose` を追加する
- stdout capture は JSONL / event stream として保存する
- 最終 result event から worker の最終一語 status と usage を取り出す
- response_file は従来どおり worker が `build-response.sh` で生成する
- 親へ返す wrapper stdout は従来どおり response_file path のみとする

注意点:

- stream-json のイベント本文を親が通常読む運用にはしない
- stream-json に含まれる assistant message が大きい場合でも、`streams.stdout.content` は既存の `DELEGATE_OBSERVE_STREAM_MAX_BYTES` 上限を適用する
- CLI の出力仕様差分に備え、parser fixture で代表サンプルを固定する

### 3.4 推定 fallback

usage 実測に失敗した場合でも、observe JSON には推定値を書けるようにする。推定値は request / response の文字数ベースを基本にし、既存の proxy metric と同じく chars/4 を目安にする。

推定 fallback の条件:

- CLI が usage を公開しない
- parser が usage field を見つけられない
- CLI 出力形式が想定と異なる
- response_file が未生成で output token 推定ができない

推定値の扱い:

- `measurement: "estimated"` を必ず付ける
- `source: "chars_4"` など、推定方法を明示する
- 片方の token だけ推定不能な場合は `null` を許容する
- parser failure は `events` に `usage_parse_failed` として残すが、delegate 実行全体を失敗にはしない

## 4. 実装ステップ

### Step 1: (未着手) usage schema と parser 境界の確定

- `observe.usage` の field 名と `measurement` / `source` の値を確定する
- Codex / Claude / Cursor / Devin の parser 入出力 JSON を揃える
- parser failure を observe event に残す形式を決める
- `cost_usd` を初期実装で必須にするか `null` 許容にするか確定する

成果物: observe usage schema と parser contract

### Step 2: (未着手) fixture と pure parser

- `.temp/` ではなく repo に残すべき fixture を `fixtures/` 配下に追加する
- Claude stream-json の成功・失敗・usage 欠落サンプルを固定する
- Codex session JSONL の既存 usage 抽出を schema に合わせる
- Cursor / Devin は CLI 仕様確認後、サンプルを追加する。仕様未確定なら fallback fixture だけを置く
- parser は shell から呼べる小さい script にし、in-source test または Vitest で検証する

成果物: backend 出力 parser と fixture test

### Step 3: (未着手) observe-json helper 拡張

- `shared/observe-json.sh` に `delegate_observe_usage_update` を追加する
- `usage_parse_failed` event helper を追加する
- 既存の lock / atomic replace 方針を維持する
- `skills/*/scripts/observe-json.sh` は `npm run sync-shared` で同期する

成果物: observe JSON に usage を安全に merge する共通 helper

### Step 4: (未着手) Codex backend の session JSONL usage 抽出

- isolated `CODEX_HOME` 配下で対象 run の session JSONL を特定する
- Codex session JSONL の input / output token field を解析する parser と fixture を追加する
- Codex session JSONL 由来の値を `observe.usage` に記録する
- session JSONL が見つからない場合は推定 fallback に落とす
- 既存 metrics / observe JSON の後方互換性を確認する

成果物: Codex backend の measured / estimated usage 記録

### Step 5: (未着手) Claude backend を stream-json 化する

- `shared/delegate-claude.sh` に `--output-format stream-json --verbose` を追加する
- final result event から status / usage / cost を抽出する
- stream-json stdout capture により `heartbeat.last_stream_change_at` が作業中に更新されることを確認する
- response_file 未生成時の failed response 生成は既存挙動を維持する

成果物: Claude backend の measured usage と実効的な stall 検知

### Step 6: (未着手) Cursor / Devin backend の対応範囲を確定する

- Cursor agent CLI の JSON / stream-json 出力オプションを確認する
- Cursor で usage が取れる場合は parser と wrapper を追加する
- Devin CLI の usage 出力モードを確認する
- Devin で usage が取れない場合は推定 fallback を明示し、設計文書に残す

成果物: Cursor / Devin の measured または estimated usage 記録

### Step 7: (未着手) docs と archive 化

- README / README_ja の observe JSON 説明に `usage` を追加する
- `docs/design/spec.md` の observe JSON schema と backend 起動説明を更新する
- `docs/design/development.md` に parser fixture / sync-shared の注意点を追記する
- 実装完了後、本ファイルを `docs/archive/delegate-worker-backend-usage-streams.archive.md` に移す

成果物: 永続設計文書への反映と feature plan の archive

## 5. 設計判断

### a. #2 と #3 を同じ feature plan で扱うか

| 候補                         | 採用 | 理由                                                                                 |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------ |
| **同じ feature plan で扱う** | ✓    | Claude の stream-json 化は usage 実測と stall 検知の両方に効くため、実装境界が重なる |
| 別々の feature plan にする   | ✗    | `delegate-claude.sh` と parser の変更を二重に設計することになり、判断が分散する      |

### b. Claude backend の出力形式

| 候補                        | 採用 | 理由                                                                                       |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| **`stream-json --verbose`** | ✓    | 作業中イベントが capture に流れ、usage 実測と `last_stream_change_at` 更新を同時に満たせる |
| `json`                      | ✗    | 最終 usage は取りやすいが、完了まで stream が動かない場合は stall 検知の問題が残る         |
| text 出力のまま             | ✗    | issue #2 / #3 の根本原因を解消できない                                                     |

### c. usage が取れない backend の扱い

| 候補                               | 採用 | 理由                                                                    |
| ---------------------------------- | ---- | ----------------------------------------------------------------------- |
| **推定値を明示して fallback する** | ✓    | backend 横断の集計形式を維持しつつ、精度差を `measurement` で判別できる |
| usage 未記録にする                 | ✗    | downstream が「未対応」と「失敗」を区別しづらい                         |
| 実測できない backend を失敗にする  | ✗    | usage 観測は補助情報であり、delegate 本体の成否を左右すべきではない     |

### d. parser の置き場所

| 候補                                     | 採用 | 理由                                                                 |
| ---------------------------------------- | ---- | -------------------------------------------------------------------- |
| **backend 別 parser を小さい境界にする** | ✓    | CLI 出力仕様の変化を wrapper 全体へ広げず、fixture test で固定できる |
| wrapper shell に直接 jq を埋め込む       | ✗    | backend ごとの分岐が増え、テストと保守が難しくなる                   |
| observe-json.sh に全 parser を入れる     | ✗    | observe 更新 helper と CLI 出力解釈の責務が混ざる                    |

## 6. テスト方針

### 自動テスト

- Claude stream-json parser
  - final result から `final_status` と usage を抽出できる
  - usage 欠落時に parser failure ではなく estimated fallback へ進める
  - 不正 JSON 行を含んでも必要な event を抽出できる
- Codex session JSONL parser
  - 既存 session JSONL から schema 通りの `observe.usage` を生成できる
  - session JSONL 不在時に estimated fallback になる
- observe-json helper
  - `usage` を既存 observe JSON に merge して他 field を壊さない
  - `usage_parse_failed` event を追記できる
- wrapper integration
  - wrapper stdout は response_file path のみ
  - response_file がある場合は status が従来どおり読める
  - response_file 未生成時は failed response と observe event が残る

### 手動確認

- [ ] `npm run sync-shared:check`
- [ ] `vp check`
- [ ] `vp test`
- [ ] Claude backend で `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` を短めに設定し、正常作業中に誤 stall しないことを確認する
- [ ] Claude backend の observe JSON に `usage.measurement == "measured"` が入ることを確認する
- [ ] Cursor / Devin backend は対応可否に応じて measured または estimated が入ることを確認する

## 7. 受け入れ基準

- `observe.usage.measurement` で measured / estimated を機械判定できる
- Claude backend で作業中に stdout/stderr bytes または `last_stream_change_at` が更新され、stream idle ベースの stall 検知が正常作業を誤 kill しない
- Codex backend で session JSONL 由来の usage 実測または推定 fallback が `observe.usage` に記録されている
- usage 取得不能時も delegate 本体は失敗せず、推定 fallback または parser failure event が残る
- wrapper stdout が response_file path のみに保たれている
- `npm run sync-shared:check` / `vp check` / `vp test` が通る
- README / README_ja / `docs/design/spec.md` / `docs/design/development.md` が実装と一致している

## 8. 想定リスクと回避策

| リスク                                     | 回避策                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Claude CLI の stream-json 仕様が変わる     | fixture を複数持ち、parser failure は delegate failure ではなく estimated fallback にする |
| stream-json の stdout content が大きくなる | 既存の `DELEGATE_OBSERVE_STREAM_MAX_BYTES` 上限を維持し、親は通常 content を読まない      |
| final result の status 抽出に失敗する      | response_file の有無と子 CLI exit codeを優先し、parser failure event を残す               |
| backend ごとの usage 定義が微妙に違う      | `source` を必ず記録し、比較側が source / measurement で絞り込めるようにする               |
| cost 推定が古い単価表に依存する            | 初期実装では `cost_usd` を必須にせず、CLI 実測 cost がある場合だけ measured とする        |
| Cursor / Devin の構造化出力が想定と違う    | 対応可否を Step 6 で明示し、取れない場合は estimated fallback を正式仕様にする            |

## 9. 参考

- [GitHub issue #2](https://github.com/oubakiou/delegate-skills/issues/2)
- [GitHub issue #3](https://github.com/oubakiou/delegate-skills/issues/3)
- [delegate-skills spec](../design/spec.md)
- [development.md](../design/development.md)
- [protocol-v1.md](../design/protocol-v1.md)
- [delegate-worker-observability archive](../archive/delegate-worker-observability.archive.md)
