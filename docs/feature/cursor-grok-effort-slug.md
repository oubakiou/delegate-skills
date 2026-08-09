# cursor backend の grok effort 変換を catalog slug 方式へ移行 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fcursor-grok-effort-slug.md)

[issue #26](https://github.com/oubakiou/delegate-skills/issues/26) に対応するための設計判断と実装手順をまとめる。README / README_ja の「推論強度」節と `docs/design/spec.md` の model 正規化・usage 契約に永続情報を移し、本ファイルは archive する。

## 0. 事実確認（2026-08-09、agent `2026.08.04-aaa8809` で実測）

issue の記述は症状としては正しいが、原因の切り分けが 2 点ずれている。実装方針を左右する事実は本節で確定済みなので、着手時の PoC は不要。

### 0.1 `--model` 引数の受理・拒否

| 検証した `--model` 引数                            | rc  | 結果                                         |
| -------------------------------------------------- | --- | -------------------------------------------- |
| `grok-4.5[effort=medium]`（現行 wrapper が渡す値） | 1   | `Cannot use this model:`（stderr 1 行）      |
| `grok-4.5[reasoning=medium]`                       | 1   | 同上（パラメータ名の問題ではない）           |
| `cursor-grok-4.5[effort=medium]`                   | 1   | 同上（prefix を残しても bracket は通らない） |
| `grok-4.5`（bracket なし）                         | 0   | 成功                                         |
| `cursor-grok-4.5-medium`                           | 0   | 成功                                         |
| `glm-5.2[reasoning=high]`（現行 wrapper が渡す値） | 0   | **成功**（bracket 機構自体は生きている）     |
| `glm-5.2-high`                                     | 0   | 成功                                         |

`agent --list-models` に `grok-4.5` は無く、`cursor-grok-4.5-{low,medium,high}[-fast]` だけがある（`glm-5.2` も bare は無いが bracket 経由では受理される）。

### 0.2 run 後の隔離 cli-config が記録する実効値

`CURSOR_CONFIG_DIR` を隔離し、`modelParameters["grok-4.5"]` に別の effort を seed してから 1 回 run し、上書きされるかを確認した。

| seed           | `--model`                 | run 後の `selectedModel`                                                   | 判定                         |
| -------------- | ------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `effort: high` | `cursor-grok-4.5-low`     | `{modelId: "grok-4.5", parameters: [{effort: "low"}, {fast: "false"}]}`    | slug の値で上書きされる      |
| `effort: low`  | `cursor-grok-4.5-high`    | `{modelId: "grok-4.5", parameters: [{effort: "high"}, {fast: "false"}]}`   | 同上                         |
| `effort: high` | `grok-4.5`（effort なし） | `{modelId: "grok-4.5", parameters: [{effort: "medium"}, {fast: "false"}]}` | catalog 既定 `medium` に戻る |

### 0.3 ここから確定する事実

1. **bracket override は壊れていない。Grok 4.5 だけが parameterized model でなくなった。** `glm-5.2[reasoning=high]` は現行 CLI でも通る。したがって「bracket 形式を全廃する」のは過剰で、修正対象は grok の 1 分岐に限られる。
2. **`cursor-cursor-` を作っている delegate 側のコードは存在しない。** 正本 `shared/src/` に `cursor-` を再付与する処理は無い（`wrapper-cursor.ts:43-48` と `observe-effort.ts:68-72` が 1 回剥がすだけ、`wrapper-cursor.ts:314` は original model をそのまま usage に記録するだけ）。二重 prefix は、Cursor 側の正しい model 名が **それ自体 `cursor-` で始まる**（`cursor-grok-4.5-medium`）ため、delegate の backend selector prefix `cursor-` を 1 回剥がす仕様と衝突し、利用者が `cursor-cursor-grok-4.5-medium` と入力せざるを得なかったことに起因する。つまり「観測経路の bug」ではなく「入力表現の不在」が根本原因。
3. **slug 指定でも cli-config は base 名 `grok-4.5` へ正規化して記録する。** よって `effortFromCursorConfig` に渡される `run.cursorModel`（= `stripCursorPrefix(baseModel)` = `grok-4.5`）でそのまま参照でき、**effective effort 抽出の実装変更は不要**（§0.2）。
4. **effort 未指定の grok の CLI 既定は `medium`。** seed を無視して `medium` に戻るため、`gpt-5.5` などと同じく「suffix 無しでも catalog 既定が効く」例外として README に記載する必要がある。
5. Cursor CLI の model 解決失敗は **exit 1 / stderr 1 行 / 候補はカンマ区切り同一行**。Devin の `Unknown model:` + 改行区切り候補とはレイアウトが異なる。
6. 他のドキュメント済み Cursor モデル（`composer-2.5(-fast)`, `cursor-gemini-3.1-pro`, `cursor-gemini-3.6-flash-*`, `cursor-kimi-k2.7-code`, `cursor-glm-5.2-{high,max}`, effort なしの `cursor-grok-4.5`）は現行 catalog で解決できる。catalog drift の影響は grok の effort 経路だけ。

## 1. 対応スコープ

| 要件                                                                 | 開始時の状態                                                                            | 完了条件                                                                                                                                       | 最終状態 | 状態   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| [MUST] `cursor-grok-4.5@{low,medium,high}` が 1 往復で成功する       | wrapper が `grok-4.5[effort=...]` を渡し CLI が起動前に拒否（exit 1）                   | wrapper が `--model cursor-grok-4.5-<effort>` を渡し、fake CLI golden の argv assert と実 CLI 手動確認の両方が通る                             | {未記入} | 未着手 |
| [MUST] `cursor-cursor-*` が dispatch 前に fail-closed で止まる       | `@` が無いため effort 検証を素通りし、CLI 側では成功するが observe に二重 prefix が残る | prepare / wrapper が exit 6 で停止し、stderr が修正表記を 1 行で提示する。**follow-up 継承経路でも検証される**（§3.3）。子プロセスは起動しない | {未記入} | 未着手 |
| [MUST] observe の `usage.model` から価格照合が `grok-4.5` に到達する | 二重 prefix 入力時に `cursor-grok-4.5-medium` までしか戻らず未照合                      | 有効な表記が `cursor-grok-4.5[@effort]` の 1 系統に収束し、`cost_usd_estimated` が付く。in-source test で実価格表キー `grok-4.5` を固定        | {未記入} | 未着手 |
| [MUST] grok の effective effort が `measured` で記録される           | bracket 前提のため slug 経由で拾えるか未確認だった                                      | §0.2 のとおり実装変更なしで成立することを in-source test（cli-config fixture）で固定する                                                       | {未記入} | 未着手 |
| [MUST] README / README_ja / spec.md が実装と一致する                 | 変換方式のモデル別差、grok の catalog 既定 `medium`、Cursor の measured usage が未記載  | 公開挙動を変える Step と**同一 commit で**更新される（§4）。`spec.md:303` の「cursor は常に chars_4 推定」の誤りも解消する                     | {未記入} | 未着手 |
| [SHOULD] Cursor の model 解決失敗が observe `error` に分類記録される | signature 未登録のため `error` が現れず、親は stderr を読むしかない                     | `failure-classify.ts` に Cursor signature を追加し、`.error.kind` が `model_not_found` を返す。`error.model` の意味を spec に明記する（§5-g）  | {未記入} | 未着手 |
| [SHOULD] catalog drift の再発を運用手順で検知できる                  | 手順なし。drift は実委譲の失敗ではじめて判明する                                        | development.md に Cursor catalog 確認手順（`agent --list-models` との突合）が書かれている                                                      | {未記入} | 未着手 |

スコープ外:

- **bracket override 方式の全廃**: `glm-5.2[reasoning=*]` は現行 CLI で動作を実測済み（§0.1）。動いている経路を壊す変更は入れない
- **`observe-cost.ts` の `CURSOR_SLUG_PATTERN` 拡張（`-low` / `-medium` の剥離）**: 当初案に含めていたが不要と判明。有効な表記は `cursor-grok-4.5[@effort]` だけになり、`@` 除去 → `cursor-` 1 回除去で `grok-4.5` に到達する。二重 prefix の過去レコードは `-medium` を剥がしても `cursor-grok-4.5` が残るため、この拡張では救えない（§5-d）
- **`effortFromCursorConfig` の拡張**: §0.2 の実測により不要
- **過去 observe / metrics JSONL の遡及修正**: 二重 prefix レコードの再集計は行わない（§5-d）
- **dispatch 前の `agent --list-models` プリフライト**: §5-c で不採用理由を記載
- **`composer-2.5` / `kimi-k2.7-code` / `cursor-gemini-*` への effort 開通**: 現行どおり fail-closed のまま。別 issue 扱い
- **失敗 run で `chars_4` 推定 usage が残ること自体**: 全 backend 共通の既存挙動で grok 固有ではない。`cost_usd_estimated` は元から付かないため実害が小さい

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                                 | 本実装での扱い                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/archive/delegate-effort-suffix.archive.md` §2 の PoC 結果表 | **grok 行のみ無効化**。`grok-4.5[effort=*]` の受理は agent `2026.07.16-899851b` 時点の実測で、`2026.08.04-aaa8809` では再現しない。glm 行は有効なまま |
| 同 §5 の「`@high` を slug `-high` へ書き換え」不採用判断          | **grok に限り撤回**。不採用理由は「slug に effort を載せられるモデルが一部だから」だったが、grok は現在 slug しか経路が無い（§5-a）                   |
| `wrapper-devin.ts` の model variant slug 変換（`kimi-k3-high`）   | 参考にする。delegate の `@effort` を backend 固有 slug へ写像する先例で、grok も同じ形に揃える                                                        |
| `wrapper-cursor.ts:90-107` `cursorCliModelOf`                     | 構造は維持。返り値が最終 CLI model 名なので、grok 分岐の返り値だけ差し替えれば足りる                                                                  |
| `observe-effort.ts:138` `validateModelEffort`                     | **拡張しない**。`@` を含まない model は早期 return するのが契約なので、二重 prefix 検出はここに混ぜず別関数にする（§3.3）                             |
| `observe-effort.ts:361-374` `effortFromCursorConfig`              | 変更なし。§0.2 で grok slug でも成立することを確認済み。非回帰テストだけ足す                                                                          |
| `wrapper-common.ts:241` `responderSessionIdOf`                    | 変更なし。cursor は `run.cursorModel`（= base）を渡しており（`wrapper-cursor.ts:303`）CLI 名を使っていないことを確認済み                              |
| `failure-classify.ts` の Devin signature（改行区切り候補）        | シグネチャ表の構造を、同一行カンマ区切りにも対応できる形へ拡張する（Step 3）                                                                          |

## 3. 設計の中核

### 3.1 Cursor model 名の 3 層を分けて扱う

`cursor-` が「delegate の backend selector」と「Cursor 側 model 名の一部」の二役を持つことが本 issue の構造的な原因。両者を分けて扱う。

| 構成要素                                      | 内容                                                                                                          | 配置 / 寿命                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| delegate model 名（`cursor-grok-4.5@medium`） | 利用者・observe・価格照合が使う正規表記。先頭 `cursor-` は必ず backend selector 1 個ぶんだけ                  | `DELEGATE_<TYPE>_MODEL` / `usage.model` / 永続  |
| base model（`grok-4.5`）                      | selector を 1 回剥がし effort suffix を分離した値。backend 分岐・cli-config 参照・価格照合・session id の起点 | `stripCursorPrefix` の出力 / プロセス内         |
| CLI model 名（`cursor-grok-4.5-medium`）      | Cursor catalog の実名。base model + effort からモデル別ルールで組み立てる。**base と一致しない場合がある**    | `cursorCliModelOf` の出力 / argv + 失敗時の診断 |

要点は「CLI model 名は base model から機械的に導けない」ことを設計に織り込む点。現行実装は `base === CLI 名`（bracket を足すだけ）を暗黙の前提にしており、grok の catalog 改名でその前提が崩れた。`cursorCliModelOf` を「base + effort → CLI 名」の**写像テーブル**として明示的に位置付け直す。

確認済みの不変条件と、その**唯一の例外**:

- cli-config が記録する実効値は base 名（`grok-4.5`）側に正規化される（§0.2）ため、observe の effort 参照キーは base model のままでよい
- `responderSessionIdOf` に渡るのは `run.cursorModel`（base）であり CLI 名ではない（`wrapper-cursor.ts:303`）。変換方式を変えても `RESPONDER_SESSION_ID` は変わらない
- **例外**: Step 3 で Cursor の失敗分類を入れると、`observe-store.ts:621` が `failure.model`（= 子 CLI が拒否した文字列 = CLI 名、bracket を含み得る）を `error.model` へ記録する。この 1 フィールドだけは CLI 名が argv の外に出る。意味づけは §5-g で確定し spec に明記する

### 3.2 モデル別 effort 変換テーブル

`cursorCliModelOf` の分岐を、変換方式まで含めた表として持つ。

| base model | 変換方式                | CLI model 名             | 許容 effort               | effort 未指定時           |
| ---------- | ----------------------- | ------------------------ | ------------------------- | ------------------------- |
| `glm-5.2`  | bracket                 | `glm-5.2[reasoning=<v>]` | `high` / `max`            | `glm-5.2`                 |
| `grok-4.5` | **catalog slug**        | `cursor-grok-4.5-<v>`    | `low` / `medium` / `high` | `grok-4.5`（既定 medium） |
| 上記以外   | 変換なし（fail-closed） | —                        | —                         | base をそのまま           |

### 3.3 model 名の妥当性検証を effort 検証から分離し、follow-up より前に置く

`validateModelEffort` は `model.includes('@')` が false のとき即 `ok` を返す契約（`observe-effort.ts:138-141`）。したがって `cursor-cursor-grok-4.5-medium` は現状 **検証をまったく通らない**。加えて `prepare.ts` の `validateEffortPhase` は `modelSource === 'followup'` のとき検証ごとスキップする（初回で検証済みという前提）。この 2 点を踏まえて配置を決める。

- 新規 `validateModelName(backend, model): EffortValidation`（返り値型は既存の `EffortValidation` を再利用）。cursor 以外の backend は無条件 `ok`
- cursor backend の拒否ルール:
  1. `cursor-cursor-` で始まる → 二重 prefix
  2. base が `grok-4.5-<low|medium|high>` → grok の effort slug 直指定（§5-f で `@effort` 一本に絞るため）
- **呼び出し位置**: `prepare.ts` では `validateEffortPhase` の follow-up 早期 return より **前** に無条件で実行する。effort suffix と違い、model 名の妥当性は「初回で検証済み」が成立しない（本変更以前に作られた session には無効表記が保存されている）。多重防御として `wrapper-common.ts:234` の `effortFailure` と同じ位置でも実行する

follow-up は `backend_session.model` を無条件継承し env 指定を無視する（`prepare.ts:268-276`）ため、無効表記を保存した legacy session は**表記を直す手段が無い**。メッセージはその場合を分けて案内する:

```
ERROR: invalid cursor model 'cursor-cursor-grok-4.5-medium': the 'cursor-' backend prefix must appear exactly once; use 'cursor-grok-4.5@medium'
ERROR: inherited cursor model 'cursor-cursor-grok-4.5-medium' from the previous session is no longer valid; start a new resumable run with 'cursor-grok-4.5@medium'
```

これにより有効な表記が `cursor-grok-4.5` と `cursor-grok-4.5@<effort>` の 1 系統に収束し、`usage.model` の表記揺れが消えて価格照合も既存の正規化のまま通る。

## 4. 実装ステップ

各 Step は「実装 + テスト + 公開仕様の文書 + `npm run build` → `npm run sync-shared`」を同一 commit に含める（テンプレートの「公開仕様は遅延させない」と development.md の正本同期規則）。

### Step 1: (未着手) grok の effort 変換を catalog slug へ

- `shared/src/wrapper-cursor.ts:90-107` の `grok-4.5` 分岐を `` `cursor-grok-4.5-${context.effort}` `` へ変更する
- 直上コメントを「PoC 実測（archive §2）」から §3.2 の表の要約へ更新する。bracket と slug が混在する理由（catalog 側が parameterized model かどうか）は WHY として非自明なので残す
- テスト: §6 の「変換」「effective effort」「価格照合」ケース
- 文書（同一 commit）:
  - `README.md` / `README_ja.md`: 推論強度の表に変換方式が読み取れる記述、`cursor-grok-4.5` の catalog 既定 `medium`（§0.2）を例外リストへ追加
  - `docs/design/spec.md:76,80-82`: 「`cursor-*` は prefix を剥がして CLI へ渡す」を「backend selector prefix を 1 回剥がし、CLI model 名はモデル別変換テーブルで決める」へ改める
  - `docs/design/spec.md:303-304`: `usage を出さない cursor backend は常にこの推定になる` は実装と矛盾している（`wrapper-cursor.ts:310-317` / `observe-usage.ts:192-202` が `cursor_json` の measured を記録する）。measured が既定で、取得不能時のみ `chars_4` fallback へ落ちる旨に直す
- `npm run build` → `npm run sync-shared`

成果物: `cursor-grok-4.5@medium` が 1 往復で成功し、文書と一致した状態

### Step 2: (未着手) `validateModelName` の追加と follow-up を含む 2 経路への配線

- `shared/src/observe-effort.ts` に §3.3 の `validateModelName` を追加する（`validateModelEffort` は変更しない）
- `shared/src/prepare.ts`: `validateEffortPhase` の follow-up 早期 return より前で無条件に呼ぶ。follow-up 継承経路は専用メッセージにする
- `shared/src/wrapper-common.ts:234` 近傍: 多重防御として同じ位置で呼ぶ
- テスト基盤: `scripts/delegate-wrapper-session.test.ts` の cursor fake CLI は `--version` で FAKE_CLI_LOG 書き込み前に `process.exit(0)` する（`:457-463`）。「ログ不在 = 子プロセス未起動」が成立しないため、`--version` 呼び出しも記録する sentinel を先に追加する
- テスト: §6 の「name 検証」「follow-up golden」「prepare 配線」ケース
- 文書（同一 commit）: README / README_ja に `cursor-` prefix は 1 回である旨と、二重 prefix が exit 6 になる移行注記（0.x の minor bump に載せる）
- `npm run build` → `npm run sync-shared`

成果物: 無効表記が run を消費せず停止し、legacy session でも実行可能な修正手順が提示される

### Step 3: (未着手) Cursor の model 解決失敗を `failure-classify` へ登録（SHOULD）

- `shared/src/failure-classify.ts:20-39` の `FailureSignature` を、同一行カンマ区切りの候補列挙にも対応できる形へ拡張する
- Cursor signature（`^Cannot use this model: <model>\. Available models: <csv>$`）を追加する。model 名パターンと候補パーサは §5-h で確定した仕様に従う
- 候補 0 件 = `model_catalog_unavailable`（retryable）/ 非空 = `model_not_found`（非 retryable）の既存分類をそのまま適用する
- テスト: §6 の「failure classification」ケース（Devin の非回帰を含む）
- 文書（同一 commit）:
  - README / README_ja の「既知のモデル解決失敗 signature（現時点では Devin のみ）」を更新する
  - `docs/design/spec.md` の observe `error` 節に、`error.model` は子 CLI が拒否した backend 側の文字列であり delegate model 名とは限らない旨を明記する（§5-g / §3.1 の例外）
- `npm run build` → `npm run sync-shared`

成果物: `read-json.sh .error.kind` が Cursor の catalog drift を親へ返す

### Step 4: (未着手) 運用手順の追加と archive 化

- `docs/design/development.md`: 「モデル追加・価格更新」節に Cursor catalog drift の確認手順（`agent --list-models` と §3.2 の変換テーブルの突合、bracket 受理の再確認）を追加する
- `docs/archive/delegate-effort-suffix.archive.md` §2 PoC 結果表の grok 行に、本計画で無効化された旨と参照先を追記する（archive の既存記述は書き換えず追記に留める）
- 本ドキュメントを `docs/archive/cursor-grok-effort-slug.archive.md` へリネームする

成果物: drift 検知の運用手順 + archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. grok の effort をどう CLI へ渡すか

| 候補                                                | 採用 | 理由                                                                                                                                              |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **catalog slug `cursor-grok-4.5-<effort>` へ写像**  | ✓    | 現行 CLI で唯一通る経路（§0.1）。`devin-kimi-k3` → `kimi-k3-high` の既存写像と作法が揃い、実効値も cli-config で観測できる（§0.2）                |
| bracket のパラメータ名を変える（`reasoning=` 等）   | ✗    | `[reasoning=]` / `[effort=]` とも、prefix の有無に関わらず拒否される（§0.1）。パラメータ名の問題ではなく grok が parameterized model でなくなった |
| 利用者に `cursor-cursor-grok-4.5-medium` を書かせる | ✗    | issue の症状そのもの。`usage.model` が価格表に到達できなくなる                                                                                    |
| grok の `@effort` を fail-closed に戻す             | ✗    | 現行 CLI に effort 指定手段が存在する以上、機能を落とす理由がない                                                                                 |

### b. effort 未指定の `cursor-grok-4.5` をどうするか

| 候補                                   | 採用 | 理由                                                                                                                                                      |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bare `grok-4.5` のまま（現状維持）** | ✓    | 実測で成功する（§0.1）。`--list-models` に無いのは legacy alias の可能性があるが、動作している経路を本 issue の範囲で変えない                             |
| `cursor-grok-4.5-medium` へ既定写像    | ✗    | 実効値は結局 `medium` で同じ（§0.2）なので挙動上の利得がなく、delegate 側が既定値をハードコードする分だけ catalog 追随の負債が増える                      |
| `cursor-grok-4.5-high` へ既定写像      | ✗    | catalog の表示名では `-high` が「Cursor Grok 4.5」だが、未指定に delegate が effort を載せることになり「未指定なら CLI 既定に従う」という既存原則に反する |
| bare 指定も fail-closed                | ✗    | 動く経路を塞ぐだけで利用者の利益がない                                                                                                                    |

> リスク: bare `grok-4.5` が undocumented alias なら将来削除され得る。Step 3 の failure classification と Step 4 の drift 確認手順が検知経路になる。

### c. dispatch 前に catalog をプリフライト検証するか

| 候補                                        | 採用 | 理由                                                                                                                                                                                                        |
| ------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **しない（変換テーブル + 失敗分類で対応）** | ✓    | `--list-models` は allowlist として使えない。bare `grok-4.5` は list に無いが受理される（§0.1）ため、list 突合すると正当な指定を誤って拒否する。加えて run ごとに追加のプロセス起動とネットワーク往復が乗る |
| 毎 run `agent --list-models` で検証         | ✗    | 上記の誤拒否。catalog はアカウント・プランに依存し、キャッシュすると陳腐化する                                                                                                                              |
| 初回のみ検証してキャッシュ                  | ✗    | 誤拒否リスクは同じで、キャッシュ無効化の判断材料も無い                                                                                                                                                      |

> Cursor CLI の model 拒否は API 呼び出し前に起きるため、トークン課金は発生しない。無駄になるのは往復の wall time と observe レコード 1 件で、プリフライトのコストに見合わない。

### d. 価格照合の正規化を触るか

| 候補                                                      | 採用 | 理由                                                                                                                                                         |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **触らない（表記を 1 系統に収束させて既存正規化で通す）** | ✓    | `cursor-grok-4.5@medium` は `@` 除去 → `cursor-` 1 回除去で `grok-4.5` に到達する（実価格表で照合を確認済み）。§3.3 で他表記を拒否すれば追加処理が不要になる |
| `CURSOR_SLUG_PATTERN` に `low\|medium` を追加             | ✗    | 有効表記に `-low` / `-medium` が現れなくなるため使われない。過去の二重 prefix レコードも `cursor-grok-4.5` が残って救えないので、動機が両方とも成立しない    |
| 価格表に `grok-4.5-<effort>` の alias を足す              | ✗    | 同上。effort は単価に影響しないので価格表の関心事ではない                                                                                                    |
| 過去の二重 prefix レコード用に `cursor-` を貪欲に剥がす   | ✗    | Cursor 側 model 名が正当に `cursor-` で始まるため（`cursor-grok-4.5`）、貪欲な剥離は正しい名前を壊す。過去レコードの再集計は本 issue の目的ではない          |

### e. `cursor-cursor-` を許容して正規化するか、拒否するか

| 候補                                       | 採用 | 理由                                                                                                                                                         |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **拒否（exit 6 + 正しい表記を提示）**      | ✓    | 二重 prefix は §3.1 の正規表記に存在しない。許容すると同一モデルに 2 通りの `usage.model` が生まれ、telemetry の分母が割れる。fail-closed の既存方針とも一致 |
| 正規化して受理（`cursor-` を貪欲に剥がす） | ✗    | §5-d と同じ理由で、正しい `cursor-grok-4.5` を壊す                                                                                                           |
| 価格照合側だけで吸収                       | ✗    | issue の提案どおりだが対症療法。`usage.model` の表記揺れは残り、telemetry の分母が汚れたままになる                                                           |

### f. grok の effort slug 直指定（`cursor-grok-4.5-medium`）を許容するか

| 候補                                        | 採用 | 理由                                                                                                                                                                                            |
| ------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **拒否し `@effort` 表記に一本化**           | ✓    | 表記が 1 系統に収まり `usage.model` が一意になる（§5-d の前提）。`cursorSlugEffort` の `-high\|-max` 拡張も価格照合の候補拡張も不要になり、変更点が最小で済む                                   |
| glm と同様に slug 表記も許容                | ✗    | `cursor-glm-5.2-high` との対称性は得られるが、`cursorCliModelOf` の写像・`cursorSlugEffort`・`candidateNames` の 3 箇所を同時に広げる必要があり、同一モデルに 2 表記を許す分 telemetry も割れる |
| glm の slug 表記も廃止して全体を `@` に統一 | ✗    | 公開済み model 名の破壊的変更で、本 issue の解決に必要な範囲を超える。別途 issue で検討する                                                                                                     |

> glm と grok で許容表記が非対称になる点は README に明記する。glm 側の slug 表記は既に公開済みのため現状維持とし、新規に開通する grok は `@effort` のみとする。

### g. 失敗分類の `error.model` に何を入れるか（Step 3）

`observe-store.ts:621` は `failure.model` をそのまま `error.model` へ書く。Cursor では拒否された CLI model 名（bracket を含み得る）になり、§3.1 の「CLI 名は argv に閉じる」に対する例外になる。

| 候補                                                        | 採用 | 理由                                                                                                                                                          |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI が拒否した文字列のまま記録し、spec で意味を定義**     | ✓    | 診断価値の本体は「CLI が実際に何を拒否したか」。delegate model 名は同じ observe の `run.model` / `usage.model` から取れるので情報は失われない。実装変更も最小 |
| delegate の original model へ置き換える                     | ✗    | 「どの文字列が拒否されたか」が失われ、変換テーブルの drift 調査という導入目的そのものを潰す。Devin の既存挙動とも非対称になる                                 |
| `error.model`（delegate 名）と `error.backend_model` を併記 | ✗    | 情報としては最良だが、既存 observe schema と Devin 経路にフィールドを 1 つ増やす。本 issue の範囲を超えるので、必要になった時点で別途検討する                 |

### h. Cursor 失敗 signature の model / 候補パターン（Step 3）

`SLUG_PATTERN`（`/^[A-Za-z0-9._-]{1,64}$/`）が厳格なのは、抽出値が Markdown response へ転記される経路を塞ぐため（`failure-classify.ts:14-16`）。Cursor の拒否 model 名は bracket を含み得る（`grok-4.5[effort=medium]`）ので、そのままでは抽出に失敗する。

| 候補                                                                 | 採用 | 理由                                                                                                                                    |
| -------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **bracket 込みの anchored allowlist を Cursor signature 専用に定義** | ✓    | `/^[A-Za-z0-9._-]{1,64}(\[[A-Za-z0-9._,=-]{1,64}\])?$/` のように anchor + 最大長を保つ。Markdown 制御文字（バッククォート、改行、`<`、` | `）を一切許さない |
| 既存 `SLUG_PATTERN` のまま（bracket 名は `unknown` に落とす）        | ✗    | 本 issue のケース（bracket 付きで拒否される）がまさに分類できず、導入目的を満たさない                                                   |
| model 名パターンを `.*` などへ緩める                                 | ✗    | 未信頼 stderr が response へ転記される境界を弱める。厳格化の理由（`:14-16`）に正面から反する                                            |

候補 CSV は `, ` で分割し、各要素は既存 `SLUG_PATTERN` で濾す（候補側に bracket は現れない）。1 つでも不適合なら以降を打ち切る既存の `collectCandidates` の作法に揃える。

## 6. テスト方針

### 自動テスト

- `shared/src/wrapper-cursor.ts` の in-source test（Step 1）
  - 正常系: `cursor-grok-4.5@{low,medium,high}` → CLI model `cursor-grok-4.5-<effort>`
  - 正常系: `cursor-glm-5.2@high` → `glm-5.2[reasoning=high]`（既存挙動の非回帰）
  - 正常系: effort 無しの `cursor-grok-4.5` → `grok-4.5`
  - 異常系: 変換テーブルに無い base model + effort → exit 6
  - 注: `cursorCliModelOf` は非 export のため、in-source test（同一モジュール内）から直接呼ぶか、export して呼ぶかを実装時に選ぶ。in-source test は同一ファイルなので追加 export なしで到達できる
- `shared/src/observe-effort.ts` の in-source test（Step 1 / Step 2）
  - 正常系: §0.2 の cli-config fixture で `effortFromCursorConfig('grok-4.5', ...)` が `{value: 'low', source: 'measured', fast: false}` を返す（Step 1）
  - 異常系: `validateModelName('cursor', 'cursor-cursor-grok-4.5-medium')` が拒否し、メッセージに `cursor-grok-4.5@medium` を含む（Step 2）
  - 異常系: `validateModelName('cursor', 'cursor-grok-4.5-medium')` が拒否する（Step 2）
  - 境界: `validateModelName('cursor', 'cursor-glm-5.2-high')` は受理（既存 slug の非回帰）
  - 境界: `validateModelName` が claude / codex / devin の model を素通しする
  - 非回帰: `validateModelEffort` の既存ケースが変わらない（`cursor-grok-4.5@max` 拒否など）
- `shared/src/observe-cost.ts` の in-source test（Step 1）
  - 正常系: `cursor-grok-4.5@medium` が実価格表の `grok-4.5` に一致し `cost_usd_estimated` が付く
  - 境界: `cursor-glm-5.2-max` → `glm-5.2`（既存の非回帰）
  - 異常系: 未知 model → `cost_usd_estimated` フィールドが付かない
- `shared/src/failure-classify.ts` の in-source test（Step 3）
  - 正常系: Cursor の 1 行カンマ区切り stderr → `model_not_found` + 候補 8 件 + `candidatesTruncated: true`
  - 正常系: 拒否 model 名が bracket を含む場合（`grok-4.5[effort=medium]`）も §5-h のパターンで分類できる
  - 異常系: model 名に Markdown 制御文字（バッククォート / 改行 / `|`）が混ざる細工 stderr は `unknown` に落ちる
  - 境界: 候補 0 件 → `model_catalog_unavailable`
  - 異常系: tail が途中で切れて model 行を含まない → `unknown`
  - 非回帰: Devin の改行区切り signature が従来どおり分類される
- `scripts/delegate-wrapper-session.test.ts`（Step 1 / Step 2）
  - Step 1: `:2674-2691` の Cursor argv assert に grok ケースを追加（`--model cursor-grok-4.5-medium` を含み、`grok-4.5[effort=` を含まない）
  - Step 2: cursor fake CLI に `--version` 呼び出しも記録する sentinel を追加し、fail-closed ケースで**「`--version` 以外の呼び出しが 1 件も無い」**ことを assert する（現行 fake は `--version` でログ書き込み前に exit するため、ログ不在では未起動を証明できない）
  - Step 2: follow-up golden 2 本 — canonical（`cursor-grok-4.5@medium` を継承して成功）と legacy（`cursor-cursor-grok-4.5-medium` を継承して exit 6、専用メッセージを含む）
- `shared/src/prepare.ts` の in-source test（Step 2）
  - `validateModelName` の配線確認: cursor の無効表記で exit 6 になり、request / observe / dispatch の生成物が作られないこと（wrapper 直接起動のテストでは prepare 側の配線漏れを検出できないため、prepare もしくは one-shot レベルで確認する）

### 手動確認

- [ ] `npm run build` → `npm run sync-shared` → `npm run sync-shared:check`
- [ ] `vp check`
- [ ] `npm test`
- [ ] 実 Cursor CLI で `DELEGATE_EXPLORE_MODEL=cursor-grok-4.5@medium` の委譲が 1 往復で `completed` になる
- [ ] その observe JSON で `usage.model` が `cursor-grok-4.5@medium`、`measurement` が `measured`、`cost_usd_estimated` が非 null、`effort.effective.value` が `medium`
- [ ] `DELEGATE_EXPLORE_MODEL=cursor-cursor-grok-4.5-medium` が exit 6 で停止し、子プロセスが起動しない
- [ ] `DELEGATE_EXPLORE_MODEL=cursor-glm-5.2@high` が引き続き成功する（非回帰）
- [ ] README / README_ja / spec.md の記述と実装が一致している

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- `cursor-glm-5.2*` / `composer-2.5*` / `cursor-gemini-*` / `cursor-kimi-*` の既存挙動が変わっていない
- 新規挙動に対応する in-source test と fake CLI golden がある
- 各 Step の commit 単体で、実装・テスト・公開仕様の文書・生成コピーの同期が揃っている
- `npm run sync-shared:check` / `vp check` / `npm test` が通る
- README / README_ja / spec.md / development.md が実装と一致している
- issue #26 の 2 つの副作用（無駄な 1 往復・二重 prefix による価格照合失敗）が再現しない

## 8. 想定リスクと回避策

| リスク                                                                                        | 回避策                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor catalog が再び改名され、変換テーブルが静かに陳腐化する                                 | Step 3 の failure classification で `.error.kind` に出す + Step 4 で development.md に `agent --list-models` 突合手順を書く。テーブルは `cursorCliModelOf` 1 箇所に集約したまま保つ |
| bare `grok-4.5`（undocumented alias）が将来削除される                                         | §5-b のとおり現状維持だが、削除されれば model 解決失敗として分類され検知できる。その時点で既定 slug 写像を再検討する                                                                |
| 二重 prefix の拒否が、回避策として `cursor-cursor-` を使っている既存設定・既存 session を壊す | 破壊的だが意図的。§3.3 の専用メッセージで follow-up 継承時は「新規 resumable run が必要」と案内し、README に移行注記を書く。0.x の minor bump に載せる                              |
| `validateModelName` の追加で、cursor 以外の backend に予期しない拒否が入る                    | cursor backend 以外は無条件で `ok` を返す構造にし、境界ケースを in-source test で固定する                                                                                           |
| bracket と slug の混在で「どちらの方式か」の判断が実装に埋もれる                              | §3.2 の表を `cursorCliModelOf` の直上コメントに要約し、README の effort 表にも方式が読み取れる記述を持たせる                                                                        |
| Cursor signature 追加が Devin の既存分類に回帰を起こす                                        | `FailureSignature` 拡張は backend ごとの登録を維持したまま行い、Devin の既存 in-source test を非回帰ケースとして残す                                                                |
| bracket 対応で緩めたパターンが、未信頼 stderr の Markdown 転記境界を弱める                    | §5-h の anchored allowlist + 最大長で閉じ、制御文字混入の細工 stderr が `unknown` に落ちることをテストで固定する                                                                    |
| Cursor の候補列挙は 190 件超と長く、stderr tail 切り詰めで先頭の model 行が落ちる可能性がある | `MAX_CANDIDATES` で切るのは分類後。tail が model 行を含まない場合は既存方針どおり `unknown` に落ち、誤分類にはならないことをテストで固定する                                        |

## 9. 参考

- [issue #26](https://github.com/oubakiou/delegate-skills/issues/26)
- [spec.md](../design/spec.md) — model 正規化（`:76`, `:80-82`）/ usage 契約（`:253-304`）
- [development.md](../design/development.md) — モデル追加・価格更新、正本同期規則
- [delegate-effort-suffix.archive.md](../archive/delegate-effort-suffix.archive.md) — §2 PoC 結果表（grok 行は本計画で更新）
- [child-failure-classification.archive.md](../archive/child-failure-classification.archive.md) — `failure-classify` の設計
- Cursor agent CLI `--help` / `--list-models`（`2026.08.04-aaa8809`）
