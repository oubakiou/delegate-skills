# child failure の分類（Unknown model の transient / permanent 区別） 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fchild-failure-classification.md)

[issue #29](https://github.com/oubakiou/delegate-skills/issues/29) に対応する。子 CLI が response を書けずに終了したとき、wrapper が生成する failed response は固定文しか持たず、一過性のモデルカタログ取得失敗と恒久的な非対応を親エージェントが区別できない。本プランでは failed response 生成経路に **stderr signature ベースの失敗分類**を追加し、response 本文と observe JSON の双方へ機械可読な形で載せる。

完了後は [spec.md](../design/spec.md) の `observe JSON` / `failed response` 節に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                                                               | 開始時の状態                                                                    | 完了条件                                                                                                                                                                                                | 最終状態                                                                                                                                 | 状態 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [MUST] child stderr から `Unknown model` を検出し、カタログ空 / 候補ありを分類する | 分類なし。stderr は observe の `streams.stderr` に保存されるだけ                | pure 関数 `classifyChildFailure()` が `model_catalog_unavailable` / `model_not_found` / `unknown` を返し、in-source test で境界を網羅する                                                               | `shared/src/failure-classify.ts` を新設。行単位 anchor + marker 完全一致 + 単一エラーブロック限定で判定し、未観測書式は `unknown` に倒す | 完了 |
| [MUST] failed response の `# Summary` / `# Error` に分類結果と再実行可否を載せる   | `Child CLI failed or did not write a response.` + observe path + exit のみ      | 分類がついた場合に Summary が原因を1文で述べ、`# Error` に `Cause:` / `Model:` / `Retryable:` 行が載る。未分類時は現行文面を維持する                                                                    | 3 分類で Summary / `# Error` を分岐。`unknown` は現行文面をバイト単位で維持                                                              | 完了 |
| [MUST] observe JSON に機械可読な分類を残す                                         | トップレベル `error` キーなし。失敗情報は `state` / `events` / `streams` に分散 | 分類がついたときだけ observe に optional な `error` オブジェクト（`kind` / `retryable` / `model` / `backend` / `detected_at`）が入り、`read-json.sh .error.kind` で読める。未分類時はキー自体を作らない | `recordChildFailure()` を追加。optional field で、未分類時はキーを作らない                                                               | 完了 |
| [MUST] `writeFailedResponse()` の全呼び出し元（3 箇所）が新契約に追従する          | 呼び出し元は `wrapper-common.ts:176` / `:371` / `wrapper-dedicated.ts:157`      | 3 箇所すべてが `failure` を明示的に渡し、child stderr を持たない 2 経路は `unknown` を渡す。dedicated（imagegen / xresearch）の回帰テストがある                                                         | `wrapper-common.ts:198` / `:399` / `wrapper-dedicated.ts:157` の 3 箇所を更新。dedicated の回帰テストあり                                | 完了 |
| [MUST] fake devin CLI に stderr 出力を追加し、end-to-end golden で契約を固定する   | fake devin CLI は stderr を出さない                                             | `scripts/delegate-wrapper-session.test.ts` にカタログ空 / 候補あり 2 ケースの golden があり、response 本文と observe `error` を assert する                                                             | `FAKE_DEVIN_UNKNOWN_MODEL`（empty / listed）と `FAKE_CODEX_UNKNOWN_MODEL` を追加し golden 4 本                                           | 完了 |
| [SHOULD] 未確認 backend に対して fail-closed に振る舞う                            | 該当なし                                                                        | signature テーブルは backend 別。実観測のない backend は空エントリで、常に `unknown` に落ちる                                                                                                           | signature テーブルは Devin のみ登録。他 backend は同一 stderr でも `unknown`（golden で固定）                                            | 完了 |
| [SHOULD] spec.md / protocol-v1.md / README（英日）を実装と一致させる               | observe schema に `error` の記載なし                                            | spec.md の observe schema と failed response 節、protocol-v1.md の optional metadata 節が更新済みで、additive optional field の互換性ルールが spec に明記されている                                     | 4 ファイルすべて更新済み。候補列挙書式が未観測である旨も spec に明記                                                                     | 完了 |

スコープ外:

- **自動リトライの実装**: §5.d の判断により本プランでは実装しない。分類の可視化で親が再実行判断できる状態を作ることを優先し、リトライは別 issue に切る
- **`Available:` 以外の失敗 marker への対応**: 本プランが扱うのは `Unknown model:` + `Available:` の組だけ。marker 不在は `unknown` に落とす（§5.f）
- **`Unknown model` 以外の失敗 signature の網羅**（rate limit / auth expired / network 等）: 分類フレームを本プランで用意し、signature の追加は実観測が取れた時点で別 commit に積む
- **Devin CLI 側のカタログ取得失敗そのものの回避**: 上流 CLI の問題であり本リポジトリでは扱わない
- **`finishWithoutChild()`（preflight failure）経路の文面変更**: 同じ `writeFailedResponse()` を通るが、child stderr が存在しないため常に `unknown` に落ちる。現行文面が維持されることをテストで固定するに留める

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                                                                                         | 本実装での扱い                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/src/observe-followup.ts:197-223` `writeFailedResponse()`                                                          | 固定文生成の唯一の実装。分類を受け取れるよう input を拡張し、Summary / Error の本文を分類に応じて差し替える                                                                                                        |
| `shared/src/wrapper-common.ts:363-389` `failedResponseOutcome()`                                                          | 4 backend 共通の「response 欠落 → failed response」変換点。ここで stderr tail を読み、分類して `writeFailedResponse()` と observe へ渡す                                                                           |
| `shared/src/wrapper-common.ts:167-200` `finishWithoutChild()` / `shared/src/wrapper-dedicated.ts:157` `finishDedicated()` | `writeFailedResponse()` の残り 2 呼び出し元。child stderr が存在しないため常に `unknown` を明示的に渡す                                                                                                            |
| `shared/src/wrapper-wait.ts:341-353` `finalizeWaitObserve()`                                                              | child 終了直後に `importStreams()` で stderr capture を observe へ確定する。分類はここには置かない（§5.a）                                                                                                         |
| `shared/src/observe-store.ts:667-718` `streamCapBytes()` / `importStreams()`                                              | stderr capture を全量 `readFileSync()` してから切り詰める既存経路。本プランの bounded tail helper はこれと別に新設し、既存経路は変更しない（§5.g）                                                                 |
| `shared/src/observe-effort.ts` `validateModelEffort()`                                                                    | 「実 CLI で受理を確認したものだけ登録し、未確認は fail-closed」という既存パターン。backend 別 signature テーブルの方針として踏襲する                                                                               |
| `shared/src/wrapper-cursor.ts:164-220` の `create-chat` 3 回試行                                                          | 既存の唯一のリトライ。backend 固有の起動初期化に閉じており、child 実行本体のリトライ前例ではない。§5.d の判断根拠として参照する                                                                                    |
| `docs/design/spec.md:378-385` failed response 節                                                                          | 「stderr 全文は埋め込まず observe path と短い要約だけを載せる」を既に規定。本実装はこの「短い要約」を具体化するものと位置づけ、方針変更はしない                                                                    |
| `docs/design/protocol-v1.md:123-130`                                                                                      | 「report 回収失敗時は failed response、方式の実行後切替や自動リトライはしない」を規定。この段落が扱うのは**回収方式**であり child 再実行一般ではない。本プランは回収経路に手を入れないため規定に抵触しない（§5.d） |
| `docs/design/protocol-v1.md:44-49` observe optional metadata 節                                                           | `lineage` / `backend_session` / `run_context` を列挙する既存の optional metadata 節。`error` の追記先はここ                                                                                                        |

## 3. 設計の中核

### 3.1 分類は backend 共通の pure module に置く

| 構成要素                                 | 内容                                                                                                  | 配置 / 寿命                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `shared/src/failure-classify.ts`（新規） | `classifyChildFailure()` と backend 別 signature テーブル。I/O を持たない pure 関数のみ               | 正本。in-source test 同居。バンドルに含まれる                   |
| `ChildFailure` 型                        | 下記の discriminated union。`unknown` は追加フィールドを持たない                                      | `failure-classify.ts` から export                               |
| `readTailBytes()`（新規）                | ファイル末尾 N bytes だけを `open` / `fstat` / `read` で読む bounded helper                           | `failure-classify.ts` の外（I/O のため `wrapper-common.ts` 側） |
| `failedResponseOutcome()` の呼び出し追加 | stderr capture の tail を読み、`classifyChildFailure()` に渡し、結果を response 生成と observe へ配線 | `wrapper-common.ts` 内。既存 4 backend が自動的に恩恵           |
| observe `error` キー                     | 分類がついたときだけ書き込む optional field。初期化はしない                                           | observe JSON トップレベル。`schema_version` は 1 のまま         |

```ts
export type ChildFailure =
  | { kind: 'unknown' }
  | { kind: 'model_catalog_unavailable'; retryable: true; model: string }
  | {
      kind: 'model_not_found'
      retryable: false
      model: string
      candidates: readonly string[]
      candidatesTruncated: boolean
    }
```

`candidatesTruncated` を型に持たせるのは、8 件ちょうどと 9 件以上を出力側が区別して `…` を付けるため。件数だけでは決定論的に決まらない。

`classifyChildFailure(input: { backend, stderrTail })` の判定手順:

1. backend の signature テーブルを引く。エントリが無ければ `unknown`（Devin 以外は当面ここに落ちる）
2. stderr tail から `Unknown model: '<slug>'` を抽出する。マッチしなければ `unknown`
3. **その後ろに `Available:` 行が無ければ `unknown`**。tail の途中切断や別レイアウトの出力を「カタログ空」と誤断定しないため（§5.f）
4. `Available:` 以降、空行または次の非候補行までを候補行として読む。各候補は `[A-Za-z0-9._-]{1,64}` に完全一致する 1 行 1 slug のみを採用し、それ以外の行が現れた時点で収集を打ち切る
   - 採用候補が **0 件** → `model_catalog_unavailable`（`retryable: true`）
   - 採用候補が **1 件以上** → `model_not_found`（`retryable: false`）。先頭 8 件を保持し、9 件目以降があれば `candidatesTruncated: true`
5. `slug` も同じ文字種・長さ制約で検証する。逸脱した場合は `unknown` に落とす

文字種・長さ制約は、stderr の任意テキストが Markdown へ転記される経路を塞ぐためのもの（§5.e）。

stderr tail は capture ファイル全体ではなく末尾の固定 bytes（既定 8 KiB）のみを `readTailBytes()` で読む。既存の `readFileOrEmpty()` は全量読みなので流用しない。100% ディスク使用時や巨大ログでも失敗経路の追加読み込み量を一定に保つため。既存の `importStreams()` が全量読みである点は本プランでは変更しない（§5.e）。

### 3.2 分類は「表示」と「機械可読」の 2 経路に同時に載せる

failed response（親が最初に読む）と observe JSON（機械監視・後追い診断）で同じ分類を出す。issue #29 の実害は「親が stderr を読まないと原因に到達できない」なので、**Summary の 1 文**が主な解決手段になる。

分類ありの failed response（`model_catalog_unavailable` の例）:

```markdown
# Summary

Child CLI failed: backend could not resolve model 'kimi-k3-max'. The backend returned no model catalog, so this is likely transient and may succeed on retry.

# Error

Cause: model_catalog_unavailable
Model: kimi-k3-max
Retryable: yes
See observe JSON: /path/to/...\_observe.json
Exit code: 1
```

`model_not_found` では Summary が「the backend does not expose this model」に変わり、`# Error` に `Available: a, b, c` の 1 行（上限 8 件、超過時は `…`）が加わる。`Retryable: no`。

未分類（`unknown`）では現行の 3 行構成をそのまま維持する。既存 golden を壊さないことと、憶測の原因表示を避けることの両立。

observe JSON:

```json
"error": {
  "kind": "model_catalog_unavailable",
  "retryable": true,
  "backend": "devin",
  "model": "kimi-k3-max",
  "detected_at": "2026-08-08T02:02:38Z"
}
```

`candidates` は observe には載せない（response の `Available:` 行で足り、observe の肥大を避ける）。分類が `unknown` のときは `error` キー自体を作らない。`read-json.sh` は欠落キーと明示 `null` をどちらも文字列 `null` として返す（`shared/src/read-json.ts:25-31,46-58`）ため、初期化しても読み手からは区別できず、初期化する利点がない。

分類済みの `error` は **response 生成より先に** observe へ書く。`spec.md:385` が「response 生成が失敗する段階では failed response 生成に固執せず、observe event と stderr 保存を優先する」と規定しているため、response 生成失敗時にも分類が残る順序にする。observe 書き込み自体の失敗は fail-soft（例外を握って失敗経路を継続）とする。

### 3.3 signature テーブルは実観測ベースでのみ拡張する

```ts
const signatures: Record<string, FailureSignature[]> = {
  devin: [unknownModelSignature],
  // claude / codex / cursor: 実観測が取れるまで空（常に unknown へ落ちる）
}
```

`Unknown model:` という文言は現時点で Devin CLI についてのみ観測されている。他 backend に同文言があると仮定して共通適用すると、別 backend の別種の失敗を誤分類し、issue #29 と同種の「誤った断定」を再生産する。`validateModelEffort()` と同じく、実 CLI で確認できたものだけ登録する。

## 4. 実装ステップ

### Step 1: (完了済み) 設計判断の確定

- §5 の設計判断（分類の配置 / observe の optional field / signature 範囲 / リトライ非採用）をレビューする
- 確定済みとして扱う項目: `Available:` marker 不在は `unknown`（§5.f）、`error` は optional で初期化しない（§5.b）、`schema_version` は 1 のまま、stderr tail 上限は 8 KiB
- 各 Step は公開仕様（response 本文契約 / observe schema）を変える回で spec / protocol / README を同一 commit で更新する

成果物: §5 の確定

### Step 2: (完了済み) 分類 pure module

- `shared/src/failure-classify.ts` に `ChildFailure` union、`classifyChildFailure()`、backend 別 signature テーブルを実装する
- 同ファイルの `if (import.meta.vitest)` に §6 の in-source test を追加する
- 公開仕様の変更なし（この Step 単独では外部から観測できない）

成果物: `shared/src/failure-classify.ts` + テスト

### Step 3: (完了済み) failed response への統合（公開仕様変更あり）

- `writeFailedResponse()` の `FailedResponseInput` に `failure: ChildFailure` を追加し、Summary / Error 本文を分類で分岐させる
- **呼び出し元 3 箇所すべて**を更新する: `wrapper-common.ts:371`（`failedResponseOutcome()`、分類を渡す）、`wrapper-common.ts:176`（`finishWithoutChild()`、`{ kind: 'unknown' }`）、`wrapper-dedicated.ts:157`（`finishDedicated()`、`{ kind: 'unknown' }`）
- `wrapper-common.ts` に `readTailBytes()` を追加し、`failedResponseOutcome()` で stderr capture の末尾 8 KiB だけを読んで `classifyChildFailure()` に渡す
- `wrapper-common.ts` / `observe-followup.ts` の in-source test を追加する（dedicated 経路の回帰を含む）
- **同一 commit で** `docs/design/spec.md` の failed response 節に分類つき文面の契約を追記する

成果物: 分類つき failed response + 更新された spec.md

### Step 4: (完了済み) observe JSON への記録（公開仕様変更あり）

- `observe-store.ts` に `recordChildFailure()` を追加する。`initObserve()` は変更しない（`error` は optional）
- `failedResponseOutcome()` から、**`writeFailedResponse()` より先に** fail-soft で呼ぶ
- `observe-store.ts` の in-source test に、分類前は `error` キーが無いこと / 書き込み後の形を追加する
- **同一 commit で** `docs/design/spec.md` の observe JSON schema と `docs/design/protocol-v1.md:44-49` の optional metadata 節に `error` を追記し、「additive optional field は `schema_version` を bump しない」互換性ルールを spec に明記する
- README / README_ja の「Work files and telemetry」節に、失敗分類が observe の `error` に載る旨を 1 行追加する

成果物: observe の `error` フィールド + 更新された spec / protocol / README

### Step 5: (完了済み) end-to-end golden

- `scripts/delegate-wrapper-session.test.ts` の `devinFakeScript()` に `FAKE_DEVIN_UNKNOWN_MODEL`（カタログ空 / 候補あり）を追加し、stderr へ signature を出力して非 0 終了させる
- カタログ空 / 候補あり / 既存の `FAKE_DEVIN_EXIT_WITHOUT_RESPONSE`（＝ `unknown` 維持）の 3 golden を追加・確認する
- 他 backend（例: codex）が同じ stderr を出しても `unknown` に落ちることを 1 ケースで固定する
- imagegen（dedicated wrapper）の既存 failed response golden が無改変で通ることを確認する

成果物: fake CLI golden

### Step 6: (完了済み) バンドル同期と全ゲート通過

- `npm run build` → `npm run sync-shared`（Step 3 / 4 の各 commit でも都度実行する。pre-commit の `sync-shared:check` が fail-closed のため）
- `vp check` / `npm test` / `npm run build:check` / `npm run sync-shared:check` / `bash scripts/check-no-jq-md2idx.sh` / `npm run metrics:baseline:check`

成果物: 全ゲート green

### Step 7: (一部未完) 残課題の整理と archive 化

- 永続情報が spec.md / protocol-v1.md へ移っていることを確認する（完了）
- 本ドキュメントを `docs/archive/child-failure-classification.archive.md` にリネームする（完了）
- 自動リトライを後続 issue として起票する（**未実施**。§5.d の判断根拠と、下記の未解決 3 点を本文に含める）
- issue #29 に結果（採用した分類、リトライを分離した理由、後続 issue 番号）をコメントする（**未実施**）

成果物: archive + issue クローズ

## 4.1 実施記録

実装は Step 2 → 6 の順に進め、全ゲート（`npm test` 465 tests / `vp check` / `build:check` / `sync-shared:check` / `check-no-jq-md2idx` / `metrics:baseline:check`）が green。

コミット前のセルフレビューで medium 2 件・low 2 件を検出し、うち 3 件を修正した。最も重要だったのは **§3.1 の判定手順が部分一致ベースで、3 種の false positive を生んでいた**こと:

| crafted stderr                       | 修正前                                   | 修正後    |
| ------------------------------------ | ---------------------------------------- | --------- |
| `Available:not-the-marker`           | `model_catalog_unavailable`（retryable） | `unknown` |
| `Available: swe-1.7, devin-glm-5.2`  | `model_catalog_unavailable`（retryable） | `unknown` |
| `Unknown model:` ブロック 2 個が混線 | 前段の model + 後段の候補を結合          | `unknown` |

2 行目が最も危険で、実 Devin CLI が候補を marker と同一行にカンマ区切りで出す場合、恒久的に使えないモデルへ `Retryable: yes` を返していた。候補列挙の実書式は issue #29 時点で未観測（観測できたのは空カタログのみ）なので、実在しうる誤断定だった。§5.f の「marker 不在は `unknown`」という方針は正しかったが、実装が marker 判定を `startsWith` で行っていたため方針を満たせていなかった。

修正として、`Unknown model:` 行を行全体に anchor し、marker を完全一致で判定し、探索範囲を次の `Unknown model:` 行までの 1 ブロックに限定した。未観測の書式はすべて `unknown` に倒れる。

対応しなかった 1 件は「文字種 whitelist では secret 漏洩・Markdown injection を防げない」（medium）。`[A-Za-z0-9._-]{1,64}` は `sk-live-ABCDEF0123456789` 形式の token を通す。レビューの推奨は「候補名を転記せず件数だけ載せる」だったが、issue #29 の提案 1 が候補の提示を明示的に求めているため採らなかった。上記の anchor 修正により、転記されるには「完全一致の `Available:` 行の直後・同一ブロック内・単独行」という条件が要る。文字種にブラケット / 括弧 / バッククォート / 山括弧を含まないためリンクやコード注入は成立せず、`__text__` による強調のみ可能。stderr 全文は元々 observe JSON に保存されている。**残存リスクとして認識したうえで候補表示を維持する**判断。

## 5. 設計判断

### a. 分類ロジックをどこに置くか

| 候補                                                      | 採用 | 理由                                                                                                                                                                |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **共通 pure module + `failedResponseOutcome()` から呼ぶ** | ✓    | response 欠落を failed response に変換する 4 backend 唯一の合流点。stderr capture path を既に持ち（`wrapper-common.ts:386`）、pure 関数なので in-source test が軽い |
| `finalizeWaitObserve()`（child 終了直後）で分類           | ✗    | response を書けた成功 run でも毎回分類が走る。分類が必要なのは response 欠落時だけなので責務が広すぎる                                                              |
| 各 backend wrapper（`wrapper-devin.ts` 等）に個別実装     | ✗    | 同じ分類ロジックが 4 箇所に複製される。issue も「backend 個別か共通か」を設計時判断としており、合流点が存在する以上共通が素直                                       |
| `read-response.sh`（親が読む時点）で分類                  | ✗    | observe / response に痕跡が残らず、後追い診断と機械監視に使えない                                                                                                   |

### b. observe への記録形式

| 候補                                                              | 採用 | 理由                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **トップレベル `error` オブジェクト（optional、分類時のみ追加）** | ✓    | issue の提案どおり `read-json.sh .error.kind` で 1 回の dotpath 読みに落ちる。既存の optional metadata（`lineage` / `backend_session` / `run_context`）と同じ「あるときだけ載る」形に揃う |
| トップレベル `error` を `initObserve()` で `null` 初期化          | ✗    | `read-json.ts:25-31,46-58` は欠落キーと明示 `null` をどちらも文字列 `null` として返すため、読み手から区別できず初期化の利点がない。JSON 破損 / ファイル欠落は既に非 0 exit で区別される   |
| `events[]` に `child_failure_classified` を push                  | ✗    | 既存の失敗系（`usage_parse_failed` 等）と同じ場所ではあるが、配列走査が必要で `read-json.sh` の dotpath だけでは取り出せない                                                              |
| `state.error_kind` として state に平坦に置く                      | ✗    | `state` は phase / exit / duration というライフサイクル情報の集合で、分類の詳細（model / candidates）を足すと責務が混ざる                                                                 |

`schema_version` は 1 のまま据え置く。optional field の**追加**は既存 consumer に対して非破壊で、bump すると schema 判定を持つ外部 watchdog を無駄に壊す。ただしこの互換性ルール自体が現状どこにも明文化されていないため、Step 4 で spec に「observe JSON への additive optional field は `schema_version` を bump しない」と明記する。既存 consumer は `read-json.sh` の dotpath 読みのほか、`scripts/delegate-wrapper-session.test.ts` の選択的 `JSON.parse` があるが、いずれも未知キーの追加で壊れない（`scripts/summarize-metrics.ts` は `DELEGATE_METRICS_FILE` の JSONL を読むもので observe JSON の直接 consumer ではない）。

### c. 未確認 backend への signature 適用範囲

| 候補                                                       | 採用 | 理由                                                                                                                                    |
| ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Devin のみ登録し、他 backend は常に `unknown`**          | ✓    | `Unknown model:` の文言は Devin CLI でのみ実観測。未確認 backend に適用すると別種の失敗を誤分類し、issue #29 と同種の誤断定を再生産する |
| 全 backend に同じ正規表現を適用                            | ✗    | 文言一致は偶然でも起こる。誤った `Retryable: yes` は無駄な再実行を誘発し、誤った `Retryable: no` はモデルの誤った除外判断を誘発する     |
| backend 非依存の緩いキーワード検索（`model` を含む行など） | ✗    | false positive が高く、分類の信頼性が固定文より悪化する                                                                                 |

### d. 自動リトライを本プランで実装するか

| 候補                                            | 採用 | 理由                                                                                                                                                   |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **実装しない（分類の可視化に留める）**          | ✓    | issue の実害は「区別できず誤認する」ことで、Summary への 1 文で解消する。リトライ導入には後述の 3 つの未解決点があり、分類の可視化とは独立に判断できる |
| `model_catalog_unavailable` に限り 1 回リトライ | ✗    | 再現手順が未確立で、リトライ間隔・成功率の根拠データがない。副作用として failed run の所要時間が倍化し、observe の timing / usage 集計の意味も変わる   |
| 全 failed run を 1 回リトライ                   | ✗    | 非冪等な implement / chore タスクを二重実行し得る。read-only の explore 以外では受け入れられない                                                       |

不採用の根拠は製品判断であって protocol 上の禁止ではない。`protocol-v1.md:123-130` の「方式の実行後切替や自動リトライはしない」が対象にしているのは **report 回収方式**（構造化出力 / report.md）の失敗であり、child プロセスの再実行一般を禁じてはいない。この点を誤って「protocol が禁止している」と読むと、後続の設計判断まで縛られる。

未解決点は 3 つ:

1. 分類は stderr の事後観察であり、child が**副作用を起こす前**に失敗したことを保証しない。`model_catalog_unavailable` は起動直後の失敗に見えるが、それを invariant として保証する仕組みが現状ない
2. implement / chore は非冪等で、再実行がワークツリーへの二重適用になり得る
3. 再現率と backoff の根拠データがない（issue 時点で再現手順が未確立）

リトライを本当に禁止したいなら、それは別途 protocol / spec の invariant として書くべきものであり、本プランでは扱わない。後続 issue には上記 3 点を判断材料として記載する。

### e. `# Logs` section を追加するか

| 候補                                         | 採用 | 理由                                                                                                                                              |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **追加しない（`# Error` の行を増やすだけ）** | ✓    | spec.md:382 は「stderr 全文は埋め込まない」と規定。section を新設すると stderr 断片を貼りたくなる圧力が生まれる。分類の構造化行だけで目的を満たす |
| `# Logs` に stderr tail を数行載せる         | ✗    | secret 混入リスクと response 肥大。observe path を辿れば全文（capped）が読める                                                                    |

response へ転記するのは、抽出した slug と候補名を厳格な文字種（`[A-Za-z0-9._-]{1,64}`）で検証したものだけとする。stderr の生テキストは 1 文字も転記しない。

### f. `Available:` marker 不在時の扱い

| 候補                             | 採用 | 理由                                                                                                                                                                           |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`unknown` に落とす**           | ✓    | 8 KiB tail の途中切断、別レイアウトの出力、CLI 更新による文面変更のいずれでも marker は消え得る。それらを「カタログ空 = retryable」と断定すると issue #29 と同種の誤断定になる |
| `model_catalog_unavailable` 扱い | ✗    | 「候補列挙が空」と「候補列挙が観測できなかった」は別の事象。後者を transient と断定する根拠がない                                                                              |

`model_catalog_unavailable` を名乗るのは「`Unknown model:` と `Available:` の両方が観測でき、かつ `Available:` の候補が 0 件」のときだけとする。

### g. bounded tail read を新設するか既存経路を直すか

| 候補                                                                  | 採用 | 理由                                                                                                                                     |
| --------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **分類用に `readTailBytes()` を新設し、`importStreams()` は触らない** | ✓    | 本プランの責任範囲は「分類のために追加で読む量」を一定に保つこと。既存の全量読みは本プラン以前からの挙動で、修正はスコープと検証範囲が別 |
| `readFileOrEmpty()` を流用                                            | ✗    | 全量読みのため 8 KiB 上限が成立せず、§8 のリスク対策が名目だけになる                                                                     |
| `importStreams()` も同時に bounded 化                                 | ✗    | observe の `streams.*.bytes`（全 bytes 数）の意味が変わり、既存 golden と外部監視の契約に影響する。別 issue として切る                   |

## 6. テスト方針

### 自動テスト

- `shared/src/failure-classify.ts` の in-source test
  - 正常系: `Unknown model: 'kimi-k3-max'` + `Available:` 空 → `model_catalog_unavailable` / `retryable: true` / `model` 抽出
  - 正常系: `Available:` に 3 件 → `model_not_found` / `retryable: false` / `candidates` 3 件
  - 境界: 候補ちょうど 8 件 → `candidatesTruncated: false`
  - 境界: 候補 9 件 → 先頭 8 件 + `candidatesTruncated: true`
  - 境界: `Available:` 行そのものが無い → `unknown`（§5.f）
  - 境界: tail の途中で `Unknown model:` 行が切断されている → `unknown`
  - 境界: stderr tail が空文字 → `unknown`
  - 異常系: 未登録 backend（`codex` / `claude` / `cursor`）に同じ stderr → `unknown`
  - 異常系: slug が文字種・長さ制約を外れる（quote / 空白 / 65 文字以上）→ `unknown`
  - 異常系: 候補行に Markdown メタ文字や診断文が混ざる → その行以降を採用せず、throw しない
- `shared/src/observe-followup.ts` の in-source test
  - 分類あり 2 種 → Summary / `# Error` の行構成が期待どおり、`Retryable` の値が分類と一致する
  - `unknown` → 現行の 3 行構成が変わらない
- `shared/src/observe-store.ts` の in-source test
  - `initObserve()` の初期 schema に `error` キーが**無い**
  - `recordChildFailure()` 後に `error.kind` / `error.retryable` / `error.model` / `error.backend` / `error.detected_at` が入る
  - `read-json.sh .error.kind` が、未分類 observe で `null`、分類済み observe で `kind` を返す
- `shared/src/wrapper-common.ts` の in-source test
  - `finishWithoutChild()`（child stderr なし）が `unknown` 経路のまま failed response を書く
  - `readTailBytes()`: 上限未満 / ちょうど / 超過（末尾が返る）/ ファイル欠落（空文字）
  - response 生成が失敗しても observe の `error` が残る（記録順序の固定）
- `shared/src/wrapper-dedicated.ts` の in-source test
  - `finishDedicated()` が `unknown` を渡し、imagegen / xresearch の failed response 文面が現行と一致する
- `scripts/delegate-wrapper-session.test.ts` の fake CLI golden
  - fake devin: カタログ空 → response の Summary / `# Error`、observe `error.kind === 'model_catalog_unavailable'`、exit code 透過
  - fake devin: 候補あり → `model_not_found` / `Available:` 行 / `Retryable: no`
  - fake devin: 既存 `FAKE_DEVIN_EXIT_WITHOUT_RESPONSE` → 現行文面のまま（回帰防止）
  - fake codex: 同一 stderr を出しても `unknown`（signature テーブルが backend 別であることの end-to-end 固定）

### 手動確認

- [ ] `vp check`
- [ ] `npm test`
- [ ] `npm run build` → `npm run sync-shared`
- [ ] `npm run sync-shared:check`（dist 再ビルド byte 比較）
- [ ] `npm run build:check`
- [ ] `bash scripts/check-no-jq-md2idx.sh`
- [ ] `npm run metrics:baseline:check`
- [ ] spec.md の observe schema / failed response 節と実装が一致している
- [ ] protocol-v1.md の optional metadata 節に `error` が載っている
- [ ] README / README_ja の記述が対応している
- [ ] 実 Devin backend で `model_not_found` 側を再現（存在しない slug を `DELEGATE_EXPLORE_MODEL=devin-<invalid>` で指定）し、response と observe を確認する。`model_catalog_unavailable` 側は再現手順が未確立のため fake CLI golden で代替する

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 分類がつかない失敗の response 文面と exit code が現行と一致する（既存 golden が無改変で通る）
- observe の `error` 追加が既存の `read-json.sh` 読み取り経路を壊さない
- 新規挙動に対応する in-source test と fake CLI golden がある
- `npm run sync-shared:check` / `vp check` / `npm test` が通る
- spec.md / protocol-v1.md / README / README_ja が実装と一致している

## 8. 想定リスクと回避策

| リスク                                                            | 回避策                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 誤分類により `Retryable: no` を出し、使えるモデルを誤って除外する | signature は実観測のある backend にのみ登録（§5.c）。候補が空か非空かという明確な二分だけで判定し、推測を挟まない   |
| 誤分類により `Retryable: yes` を出し、無駄な再実行を誘発する      | 自動リトライは実装しない（§5.d）。判断は親に残り、コストは 1 回分に留まる。marker 不在は `unknown` に倒す（§5.f）   |
| observe schema 変更が外部 watchdog を壊す                         | additive optional field のみ・`schema_version` 据え置き（§5.b）。互換性ルールを Step 4 で spec に明記する           |
| 分類のための stderr 読み取りが巨大ログでメモリを圧迫する          | 分類は `readTailBytes()` で末尾 8 KiB のみ読む（§5.g）。既存 `importStreams()` の全量読みは本プランの範囲外         |
| 呼び出し元の更新漏れで dedicated wrapper だけ契約が不一致になる   | `writeFailedResponse()` の呼び出し元 3 箇所を Step 3 に明記し、`wrapper-dedicated.ts` の回帰テストを追加する        |
| response 生成が失敗して分類も失われる                             | 分類は response 生成より先に fail-soft で observe へ書く（§3.2）。順序を in-source test で固定する                  |
| stderr に secret が含まれ response 経由で漏れる                   | response には抽出した slug と候補名のみを載せ、stderr の生テキストは 1 文字も転記しない（§5.e）                     |
| 生成コピー（`skills/*/scripts/*`）を直接編集してしまう            | 編集は `shared/src/` のみ。`npm run build` → `npm run sync-shared` を通し、pre-commit の `sync-shared:check` で検出 |
| 分類が Devin 専用の特殊対応に見え、他 backend への拡張が滞る      | signature テーブルを backend 別 map として最初から用意し、追加手順を development.md の「モデル追加」節に倣って書く  |

## 9. 参考

- [issue #29](https://github.com/oubakiou/delegate-skills/issues/29)
- [spec.md](../design/spec.md) — `### observe JSON（機械監視）` / `### failed response（wrapper 生成）`
- [protocol-v1.md](../design/protocol-v1.md) — `## observe JSON の optional metadata` / `### 誰が response を組み立てるか（worker / wrapper の責務）`
- [development.md](../design/development.md) — テスト方針、shared/ 同期パターン、モデル追加手順
