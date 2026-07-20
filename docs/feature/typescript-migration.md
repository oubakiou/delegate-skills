# シェルスクリプト TypeScript 移行 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Ftypescript-migration.md)

`shared/` 配下のシェルスクリプト実装（約 4,800 行 + 専用 wrapper 2 本）を TypeScript へ移行し、`vp build`（vite-plus）で単一ファイルにバンドルして配布する。これによりユーザー前提条件から `jq` と `md2idx`（`npx` 実行）を撤廃し、**Node.js（24 以上）と各バックエンド CLI のみ**にする（`.sh` shim の実行に POSIX シェル、follow-up 検証に git は引き続き使う）。あわせてテストを in-source testing へ寄せ、bash snippet を文字列で組み立てる現行 fixture 方式を縮退させる。完了後は spec.md / development.md に永続情報を移し、本ファイルは archive する。

前提となる判断（2026-07-19）: 旧リファクタリング計画のシェル分割系候補（H1a / H1b / H2 / M1 / M2 / L2）は**停止・破棄**した（計画文書自体も削除済みのため、本計画は当該文書を参照しない）。同計画が shell のまま解こうとしていた問題（モジュール解決・source 循環・sync-shared 配布漏れ・jq 密度）は、本移行で言語ごと解消する。引き継ぐ分析は次の 2 点で、該当 Step に内在化している:

- **observe-json.sh（2,239 行）の責務分割軸**: pure 系（usage 抽出 / effort 検証 / cost 推定 / timing 計算）と mutate 系（lock·init / session / lifecycle / response assembly / stream 取り込み）
- **backend wrapper 4 本の共通部の同定**: 引数解析 / finish_without_child / prompt 骨格 / wait·cleanup / response 補完 / usage·effort 記録が左右対称に重複

## 1. 対応スコープ

| 要件                                                                                                                                                                                                                          | 開始時の状態                                                                      | 完了条件                                                                                                                                     | 最終状態 | 状態                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [MUST] `shared/` 全スクリプトの TS 化（resolve-model / check-delegate-chain / build·read-request / build·read-response / prepare / dispatch / run / observe-json / backend wrapper 4 本 / prompt-constraints / delegate-mcp） | 未（全て bash、`shared/*.sh` 17 本）                                              | 各スクリプトの argv / stdout / exit code 契約を変えずに TS 実装へ置換。`.sh` は**直接実行されるエントリポイント**の exec shim のみ残る       |          | 完了（全 shim 化済み: resolve-model / check-delegate-chain / build·read-request / build·read-response / prepare / dispatch / run / wrapper 4 本。observe-json / prompt-constraints / delegate-mcp は TS 正本のみ（凍結 bash は Step 8 で削除）） |
| [MUST] 専用 wrapper / 専用 run の TS 化（`prepare-imagegen` / `run-imagegen` / `delegate-imagegen-codex` / `run-x-research` / `delegate-x-research-grok`）                                                                    | 未（skill 配下の独立正本 bash）                                                   | 共通 TS モジュールを import する形で置換し、コピー由来重複を解消                                                                             |          | 完了（Step 5 で prepare-imagegen / run-imagegen / run-x-research、Step 7 で delegate-imagegen-codex / delegate-x-research-grok を共通モジュール import で shim 化）                                                                              |
| [MUST] `jq` 依存の撤廃                                                                                                                                                                                                        | runtime で jq 必須（`shared/` 内 135 箇所超 + 全 SKILL.md の手順・allowed-tools） | 配布物の実行パスと**全 SKILL.md の手順・allowed-tools** に jq への参照が存在しない（静的検査で確認）。README の Prerequisites から jq を削除 |          | 完了（全実行経路・凍結 bash 削除・全 SKILL.md の手順/allowed-tools・README Prerequisites から撤廃。`scripts/check-no-jq-md2idx.sh` が CI / pre-commit で静的検査。read-json.sh が jq 代替）                                                      |
| [MUST] `md2idx` の runtime `npx` 撤廃                                                                                                                                                                                         | 全 skill が `npx --yes md2idx` に依存                                             | md2idx を npm 依存として import しバンドルに内包。`check-md2idx.sh` 相当の前提チェックが不要になる                                           |          | 完了（Step 3b で実行パスから npx 撤廃、Step 8 で `check-md2idx.sh` 削除。md2idx はバンドル内包で前提チェック不要）                                                                                                                               |
| [MUST] 単一ファイルバンドルの self-contained 配布                                                                                                                                                                             | 未                                                                                | `shared/dist/delegate-cli.mjs` 1 ファイル + shim 群を sync-shared で各 skill へ配布し、`gh skill install` 単体で動作                         |          | 完了（Step 1 で dist 配布を機械化、Step 3〜8 で全 shim を配布。jq/md2idx を隠した環境で run.sh 完走を smoke 確認）                                                                                                                               |
| [MUST] 公開契約の不変                                                                                                                                                                                                         | —                                                                                 | `run.sh` の JSON envelope / observe JSON スキーマ / protocol-v1 の request·response 形式 / 各スクリプトの exit code 表が不変                 |          | 完了（fake CLI golden（wrapper-session / run）と metrics baseline が移行前と同一内容で通り、envelope / observe スキーマ / exit code 表は不変。protocol-v1.md も未変更）                                                                          |
| [SHOULD] テストの in-source 移行                                                                                                                                                                                              | TS テスト 2 本が bash snippet fixture で約 3,900 行                               | pure ロジックは実装隣接の in-source test へ。fake CLI による wrapper 統合テストは golden として維持                                          |          | 完了（pure ロジックは各モジュールの in-source test。bash snippet / parity テストは Step 8 で削除し、削除分のカバレッジは in-source へ移植。fake CLI golden（wrapper-session / run）は維持）                                                      |
| [SHOULD] CI による merge gate                                                                                                                                                                                                 | 未（workflow なし、検証は pre-commit hook と手動）                                | pinned Node / Linux の CI で clean checkout からの build byte 比較・`sync-shared:check`・`vp check` / `vp test` を PR 必須化                 |          | 完了（`.github/workflows/ci.yml`: build:check / sync-shared:check / check-no-jq-md2idx / vp check / vp test。branch protection での必須化は運用側で設定）                                                                                        |
| [SHOULD] ドキュメント追従（README / README_ja / spec.md / development.md / 全 SKILL.md）                                                                                                                                      | 全て bash + jq 前提の記述                                                         | Prerequisites・アーキテクチャ図・開発手順・skill 手順が TS 実装と一致                                                                        |          | 完了（README 両言語の Prerequisites / How it works、spec.md / development.md のアーキ図・inventory・同期パターン・モデル追加手順、全 SKILL.md を TS 構成へ更新。protocol-v1.md は不変契約のため据え置き）                                        |

スコープ外:

- **旧リファクタリング計画の残候補**: 停止・破棄済み。テスト分割・summarize-metrics 分割は移行の副産物として概ね解消見込みで、残るものは移行完了後に再起票する
- **挙動変更・プロトコル変更・新機能**: 本移行は挙動不変のポート。protocol-v1 / observe スキーマの変更が必要になったら別プランに切り出す
- **開発側スクリプト**（`scripts/*.sh`、`.githooks/`、`local_setup.sh`）: ユーザー配布物ではなく開発環境（devcontainer）には jq がある。`check-metrics-baseline.sh` 等は golden 検証として無改変で使う。TS 化は移行完了後の任意タスク
- **md2idx 自体の機能追加**: 本移行が前提とする md2idx 側の変更は「副作用のない library entry の分離」のみ（Step 1）。それ以外の改修は当該リポジトリで独立に行う
- **guarded-webfetch / guarded-websearch 等の非 delegate skill**: 別系統の正本であり本移行の対象外

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                                                          | 本実装での扱い                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 旧リファクタリング計画の分析（2026-07-19 停止、文書は削除済み）                            | observe の pure / mutate 分割軸と wrapper 共通部の同定結果を冒頭「前提となる判断」に内在化して採用。実装方式（shell 分割）は不採用                                                                                                                                                         |
| `md2idx` npm package（zero-dependency ESM、library exports）                               | `import` してバンドルに内包。v0.2.0 は library と CLI が同一 entry で top-level の CLI 自己判定を持ちバンドル時に誤発火したが、**v0.3.0（[md2idx#3](https://github.com/oubakiou/md2idx/issues/3)）で bin が `dist/cli.mjs` に分離され解消済み**。engines `>=24.0.0` は維持（受理確認済み） |
| `scripts/delegate-wrapper-session.test.ts`（fake CLI fixture）                             | 移行前後の等価性を検証する golden test。shim 経由で呼び出し形が変わらないため無改変で通ることを各 Step の完了条件にする                                                                                                                                                                    |
| `scripts/delegate-run.test.ts` / `scripts/delegate-mcp.test.ts`                            | run one-shot 契約と MCP config 隔離の golden。run / 専用 run（Step 5）と wrapper クラスタ（Step 6）の等価性確認に使う                                                                                                                                                                      |
| `scripts/observe-json.test.ts`（bash snippet fixture）                                     | 移行期の互換検証に維持。対応モジュールが TS 化された時点で in-source test に置き換え、bash snippet 部を削除                                                                                                                                                                                |
| `fixtures/metrics/` + `scripts/check-metrics-baseline.sh`                                  | metrics レコード形状の決定論的ドリフト検知（**duration 系は意図的に除外されている**）。レイテンシ回帰は §6 の反復ベンチで別途比較する                                                                                                                                                      |
| `scripts/observe-parity.test.ts` / `scripts/observe-store-parity.test.ts`（Step 4 で新設） | 凍結 bash 版 observe-json.sh と TS モジュールを同一入力・同一操作列で突き合わせる等価性 golden（31 件。lock 相互運用・スキーマ deep 比較含む）。bash 版削除（Step 8）と同時に削除する                                                                                                      |
| `scripts/sync-shared.ts`                                                                   | 配布経路として拡張（dist バンドル + shim の配布、`shared/src/` 自動列挙）。手書きリスト起因の配布漏れハザードは本移行で吸収                                                                                                                                                                |

## 3. 設計の中核

### 3.1 配布物とビルドパイプライン

```
shared/src/**/*.ts            正本（TS モジュール + in-source test）
   │  vp build --config vite.cli.config.ts（build.ssr / rollup 単一 ESM チャンク / target=node24）
   ▼
shared/dist/delegate-cli.mjs  単一ファイルバンドル（md2idx 内包・外部依存ゼロ・コミット対象）
   │  scripts/sync-shared.ts
   ▼
skills/<skill>/scripts/       delegate-cli.mjs + 直接実行エントリポイントの .sh shim 群
   │  gh skill install
   ▼
.claude/skills/ / .agents/skills/
```

最小サポート Node は md2idx の engines 宣言（`>=24.0.0`、2026 年時点の LTS）に揃えて **24** とする。md2idx 側で engines を緩和できれば引き下げを再評価する（バンドル済み JS 自体は下位 Node でも構文上は動くが、内包依存の宣言済みサポート範囲を配布物の要件として尊重する）。

| 構成要素                        | 内容                                                                                                                                                                                                                                                                                                                                                                                           | 配置 / 寿命                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/**/*.ts`            | 実装の正本。pure ロジックは in-source test を隣接させる                                                                                                                                                                                                                                                                                                                                        | 正本。`vite.config.ts` の `includeSource: 'shared/**/*.ts'` で既にテスト対象                                                     |
| `shared/dist/delegate-cli.mjs`  | `vp build` 生成の単一ファイル CLI。**git にコミットする**                                                                                                                                                                                                                                                                                                                                      | 生成物だがコミット対象（`gh skill install` はリポジトリ内容をそのまま配布するため）。lint 対象外（既存 `ignorePatterns: dist/`） |
| `vite.cli.config.ts`            | CLI バンドル専用の vite-plus config。mdxg-redline の `vite.review-request.config.ts` を基に（`build.ssr` で Node 解決と top-level 副作用保持を両立 / `external: [/^node:/]` / 単一 ESM 出力 / `define` で `import.meta.vitest` を除去）、**`ssr.noExternal: true` を追加**する。SSR ビルドは npm 依存を既定で externalize するため、これがないと md2idx が内包されず self-contained が破綻する | 開発ツール                                                                                                                       |
| `skills/*/scripts/*.sh`（shim） | `exec node "$(dirname "$0")/delegate-cli.mjs" <subcommand> "$@"` の 2〜3 行。**直接実行されるエントリポイントのみ**が対象で、source されるライブラリ（`observe-json.sh` / `prompt-constraints.sh` / `delegate-mcp.sh` / `run.sh` の関数群）は shim 化しない（§3.2）                                                                                                                            | 移行期〜当面維持（§5-d）。node 欠如時は既存の exit 3 系メッセージを返す                                                          |
| `scripts/sync-shared.ts`        | dist + shim + アセットを各 skill へ配布。`shared/src/` は readdir で自動列挙                                                                                                                                                                                                                                                                                                                   | 拡張。ドリフト検知（`--check`）は dist の再ビルド byte 比較まで含める                                                            |

### 3.2 エントリポイントと source クラスタ

現行スクリプトのうち**直接実行されるもの**をサブコマンド 1 個に対応させる（`delegate-cli.mjs run` / `prepare` / `dispatch` / `build-request` / `read-response` / `wrapper claude` …）。argv・stdout・exit code は現行スクリプトの契約をそのまま引き継ぐ（`run` の JSON envelope、`read-response` の selector、exit 2/3/4/5/6 の意味を含む）。

一方、**source されて関数を提供するスクリプト**は exec shim に置き換えられない（source 先が `exec node` すると親 shell ごと置換される）。現行の source 依存は次の 3 クラスタで、**クラスタ単位で consumer と同時に移行**する:

- `run.sh` の関数群 ← `run-imagegen.sh` / `run-x-research.sh` が source して prepare / dispatch を override（Step 5 で 3 本同時に TS 化）
- `prompt-constraints.sh` / `delegate-mcp.sh` / `observe-json.sh` ← backend wrapper 4 本が source（Step 6 で wrapper と同時に TS 化）
- `observe-json.sh` ← `prepare.sh` / `dispatch.sh` / 専用 wrapper も source（Step 4 で TS モジュール化した後も、bash のまま残る consumer 向けに bash 版を**凍結して並存**させ、全 consumer の移行完了（Step 7）後に削除）

凍結並存期間中は、bash 版と TS 版が同一 observe JSON を触るため、統一 lock プロトコル（§3.3）とスキーマ golden で等価性を担保する。関数単位の bash↔node ブリッジ（サブコマンド経由の observe 操作）は採らない（§5-e）。

### 3.3 移行期の相互運用: lock 統一とクラスタ単位ポート

- **lock**: 現行 `observe-json.sh` は flock 優先 + mkdir フォールバック。Node に flock が無いため、**移行に先立ち bash 側を symlink lock に統一**した（Step 2 完了。owner を target に埋め込む `ln -s` の atomic 作成、pid 生存判定 takeover、bounded wait、trap cleanup を仕様化。TS 側は `fs.symlinkSync` で同一実装にする）
- **移行粒度**: 移行単位は単独スクリプトではなく **source 依存クラスタ**（§3.2）。public 契約が argv/stdout レベルで切られているため、fake CLI テスト・run/MCP golden・metrics baseline が移行前後の golden になる。leaf（変換・検証系）→ observe → orchestration（prepare/dispatch/run + 専用 run）→ wrapper クラスタ → 専用 wrapper の依存順に進め、どの中間状態でも全 skill が動作する

## 4. 実装ステップ

> 各 Step は 1 PR。完了前に `npm run sync-shared:check` / `vp check` / `vp test` を通し、`scripts/delegate-wrapper-session.test.ts` / `scripts/delegate-run.test.ts` / `scripts/delegate-mcp.test.ts` と metrics baseline の全パスを等価性確認として扱う。実装後は delegate-review で独立レビューする。

### Step 1: (完了) md2idx 前提リリースとビルド・配布基盤

- **md2idx 側の先行リリース**（本移行の前提）: **md2idx@0.3.0 で解消済み**。bin が `dist/cli.mjs` に分離され library entry は export のみになったことを確認済み（[md2idx#3](https://github.com/oubakiou/md2idx/issues/3)）。engines `>=24.0.0` 維持のため最小サポート Node は 24 で確定。delegate-skills の devDependency は `^0.3.0` に更新済み
- `vite.cli.config.ts`（CLI バンドル専用の vite-plus config）と `npm run build`（`vp build --config vite.cli.config.ts`）/ `npm run build:check`（再ビルド byte 比較）を作成。構成は mdxg-redline の `vite.review-request.config.ts` を基にする: `build.ssr` + `rollupOptions.external: [/^node:/]` + 単一 ESM 出力（`entryFileNames`）+ `define: {'import.meta.vitest': 'undefined'}` による in-source test の dead-code 除去。ただし **`ssr.noExternal: true` を必ず追加**する — SSR ビルドは npm 依存を既定で externalize するため、参考元の生成物には `import { marked } from "marked"` が bare import のまま残っており、同型のままでは md2idx が内包されない。新規 devDependency は不要
- `shared/src/` に CLI 骨格（サブコマンド dispatch と `--version` のみ）を実装し、`shared/dist/delegate-cli.mjs` をコミット
- **バンドル起動 PoC**: 実バンドルを最小サポート Node で起動し、(a) delegate サブコマンド実行で md2idx の CLI 側コードが発火しない (b) usage・stdout・exit code の汚染がない、を回帰テスト化する
- `scripts/sync-shared.ts` を拡張: dist バンドル + shim の配布、`shared/src/` の自動列挙、`--check` に dist ドリフト検知を追加
- pre-commit hook（`.githooks/pre-commit`）に build + dist ドリフト検証を追加
- **CI workflow を新設**（現状 workflow なし）: pinned Node / Linux で clean checkout から build を 2 回実行して byte 比較し、`sync-shared:check` / `vp check` / `vp test` と合わせて PR の必須 gate にする

成果物: 全 skill に `delegate-cli.mjs` が配布され、ビルド〜配布〜ドリフト検知がローカル hook と CI の両方で機械化された状態（既存 .sh は無改変で共存）

### Step 2: (完了) observe lock の symlink 統一と stale lock 仕様化

- `shared/observe-json.sh` の flock 優先分岐を削除し **symlink lock** に統一した（計画時は mkdir lock を想定していたが、実装レビューで「mkdir と owner 記録が非原子で、その間の停止により相互排他が破れる」P1 指摘を受け、`ln -s` の atomic 作成に owner を埋め込む symlink lock へ変更。TS 側は `fs.symlinkSync` で同一プロトコルを実装する）
- stale lock 対策を新規に仕様化した: symlink target への owner（pid + token）埋め込み、bounded wait（`DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS`、既定 30 秒、超過時エラー）、pid 生存判定による takeover（reap 専用 mutex 配下で再検証→除去。mv で claim する方式は live lock を一時退避させ多重保持を生むため二次レビューで不採用）、旧 flock ファイル等 symlink でない残骸の回収、EXIT trap の退避・合成・復元による異常終了時 cleanup
- テストを `scripts/observe-json.test.ts` に追加: 並列 4 writer 競合 / lock 保持者の kill 後回復 / 死亡 pid の残存 lock takeover / legacy 残骸の回収 / bounded wait timeout / 呼び出し元 EXIT trap の保存・復元（特殊文字含む）/ `set +e` 呼び出し元の errexit 状態維持 / 複数 contender の reap 競合 / callback 失敗時の return code 透過と lock 解放 / timeout env 不正値の既定 fallback

成果物: bash / TS が相互排他可能で、保持者異常終了から回復できる単一 lock プロトコル

### Step 3: (完了) 変換・検証系 leaf の TS 化（md2idx バンドルの中核）

- **(3a 完了)** `resolve-model` / `check-delegate-chain` を TS 化した（`shared/src/` にモジュール + in-source test、`.sh` は node 前提チェック付き exec shim。不正チェーン JSON の exit 5 を含む exit code 表と stdout 契約は bash 版と実測一致）
- **(3b 完了)** `build-request` / `read-request` / `build-response` / `read-response` を TS 化し、md2idx を import に置換した。移行前に bash 実装との突き合わせを実測で行い、request/response envelope・companion md・全 selector 出力（auto / decision のサイズゲート・clip 含む）・metrics レコード（ts / duration / パス除く）が byte 一致することを確認してから shim へ置換
- `prompt-constraints.sh` は wrapper から source されるためここでは移行しない（Step 6 のクラスタ）
- 呼び出し元（prepare.sh 等の bash）は shim 経由で無改変。`check-md2idx.sh` はこの時点では残し、Step 8 で削除
- 各モジュールに in-source test（正常系 / 境界 / 異常系 + exit code 表の互換）

成果物: request / response の md2idx + envelope 生成が TS 実装になり、当該経路から jq / npx が消える

### Step 4: (完了) observe モジュールの TS 化（bash 版は凍結並存）

- 4a: pure 系（usage 抽出 / effort 検証 / cost 推定 / timing 計算）を TS モジュール化し、`observe-json.test.ts` の対応 describe を in-source test へ移行
  - **(4a-1 完了)** effort 検証（split / validate / codex sessions / cursor config）と cost 推定（prices 解決 / augment）を `shared/src/observe-effort.ts` / `observe-cost.ts` に移植。`scripts/observe-parity.test.ts` で凍結 bash 版と同一入力の突き合わせを常時実行（jq `//` の false 落とし等の細部も一致確認済み）。`observe-json.test.ts` の bash 側 describe は mutate 系（record_effort / record_usage）と絡むため、mutate 系 TS 化（4b）時に整理する
  - **(4a-2 完了)** usage 抽出（backend 別 stream parser / codex session 走査 / Devin ATIF / chars÷4 fallback）と timing 計算（stream counts / first useful event / monotonic ms）を `shared/src/observe-usage.ts` / `observe-timing.ts` に移植。jq 評価規則の共有プリミティブは `shared/src/jq-compat.ts` に集約。parity テストは効果・コスト分と合わせ計 17 件
- **(4b 完了)** mutate 系（lock·init / session / lifecycle / response assembly / stream 取り込み）を TS モジュール化した:
  - `shared/src/observe-lock.ts`: symlink lock の TS 実装（fs.symlinkSync、reap mutex、bounded wait）。bash 形式の残存 lock を回収できることを parity で確認
  - `shared/src/observe-store.ts`: init / event / usage / mcp_config / lineage / backend_session / resume_unavailable / run_context / record_effort / record_usage / supersede / dispatch lifecycle / record_timing / import_streams / dispatch metrics
  - `shared/src/observe-followup.ts`: backend_supports_resume / validate_followup（bash と同一メッセージ）/ write_failed_response（TS build-response を in-process 利用）
  - `scripts/observe-store-parity.test.ts`: bash と TS に同一操作列を適用し、observe JSON をタイムスタンプ・パス正規化のうえ deep 比較するスキーマ golden（8 シナリオ）
  - wait ループ（wait_with_heartbeat / wait_probe_progress）・process_tree・report/prompt 系 helper・codex_home_prune は子プロセス管理と不可分のため Step 6（wrapper クラスタ）で移植する
  - bash 版 `observe-json.sh` は**凍結**（機能追加禁止）して並存し、consumer（prepare / dispatch / wrapper）は引き続き bash 版を使う
- TS 版・bash 版双方に対する observe JSON スキーマの golden テストを用意する

成果物: observe ロジックの TS 正本が完成し、以後の consumer 移行（Step 5-7）が in-process import で進められる状態

### Step 5: (完了) prepare / dispatch / run / 専用 run / metrics の TS 化

- 着手前に §6 反復ベンチの「移行前」ベースラインを `scripts/run-latency-bench.sh`（新設）で採取し §6 に記録した
- `prepare`（session_mode 解析・follow-up 検証含む）/ `dispatch` / `run`（one-shot envelope）を TS 化した（`shared/src/prepare.ts` / `dispatch.ts` / `run-oneshot.ts` / `backend.ts`）。observe は Step 4 の TS モジュール（init / lineage / run_context / dispatch lifecycle / dispatch metrics / followup validation）を in-process 利用し、resolve-model / check-delegate-chain / build-request / read-response も in-process 化した
- `run-imagegen.sh` / `run-x-research.sh` / `prepare-imagegen.sh` を同一 Step で TS 化した（`shared/src/prepare-imagegen.ts` + `run-oneshot.ts` の専用エンジン。source override 構造は型付き config（prepare / dispatch hook）に置換）。専用 wrapper（`delegate-imagegen-codex.sh` / `delegate-x-research-grok.sh`）は bash のまま TS run から起動される（Step 7 で TS 化）
- TS 化した prepare は bash 版が呼んでいた `check-md2idx.sh` を呼ばない（md2idx バンドル内包により前提条件ごと消滅。ファイル削除は Step 8）
- backend wrapper の起動は shim を介さず `bash <scripts_dir>/delegate-<backend>.sh` を直接 spawn する。scripts_dir はバンドル位置から導出（配布形態は同 dir、リポジトリ正本は `dist/` の親）
- `DELEGATE_METRICS_FILE` 追記は TS 共通モジュール（`protocol.ts` の `appendMetrics` + `prepare.ts` の `appendPrepareMetrics` / observe-store の `appendDispatchMetrics`）に集約し、`fixtures/metrics/` baseline の一致を確認した
- shim 置換前に bash 実装との突き合わせを実測で行い、prepare stdout / metrics レコード（ts・duration 除く）/ observe JSON（ts・pid 除く）/ dispatch stdout・exit code / run envelope・stderr 先出しの一致を確認した
- 完了時の反復ベンチ結果は §6 に記録（`prepare` p50 200ms → 0ms、`dispatch` 100ms → 80ms、許容回帰 +20% を満たす）

成果物: 親側 happy path（run 一発）と専用 run が wrapper 起動まで TS で完結

### Step 6: (完了) backend wrapper クラスタの TS 化

- `delegate-claude` / `delegate-codex` / `delegate-cursor` / `delegate-devin` を TS 化した（`shared/src/wrapper-{claude,codex,cursor,devin}.ts`。`.sh` は `delegate-cli wrapper <backend>` への exec shim）。CLI サブコマンドは async handler になり、`runCli` は Promise を返す
- wrapper が source していた `prompt-constraints.sh` / `delegate-mcp.sh` も同一クラスタとして TS 化した（`shared/src/prompt-constraints.ts` / `delegate-mcp.ts`。bash 版ファイルは Step 8 で削除するまで凍結）。`scripts/delegate-mcp.test.ts` は無改変で golden として通過
- 共通部は `shared/src/wrapper-common.ts`（引数解析 / finish_without_child / prompt 骨格 / response 補完 / usage・effort 記録 / session 記録）に集約し、backend 固有部（Claude の schema / allowedTools / config 隔離、Codex の HOME 隔離・argv gate、Cursor の bracket 変換・create-chat retry、Devin の prefix・ATIF）のみ各実装に残した
- Step 4b から繰り越した observe 関数を移植した: wait ループは `shared/src/wrapper-wait.ts`（spawn / 1 秒 poll / heartbeat / stall 検知・kill / stream 取り込み / シグナル cleanup）、report/prompt 系と `process_tree_json` / `codex_home_prune` は `shared/src/wrapper-report.ts`
- 子プロセス管理の等価性は fake CLI テスト（`delegate-wrapper-session.test.ts` 80 件無改変）で検証した
- poll の sleep は子の終了と race + タイマー unref にした（bash の非中断 sleep 1 と実効挙動同一のまま、速い子で丸 1 秒待つ TS 固有の劣化を排除。テストスイートの wrapper 部も 95s → 12s に短縮）
- 完了時ベンチは §6 に記録（`dispatch` p50 100ms → 30ms。許容回帰 +20% を満たす）

成果物: 4 backend の dispatch 実行系と wrapper 用ライブラリが TS 化され、横断変更が 1 モジュールで完結

### Step 7: (完了) 専用 wrapper（imagegen / x-research）の TS 化

- `delegate-imagegen-codex` / `delegate-x-research-grok` を TS 化した（`shared/src/wrapper-imagegen.ts` / `wrapper-xresearch.ts`。`delegate-cli wrapper imagegen|xresearch` サブコマンド + skill 配下の exec shim）。Step 6 の共通モジュール（wrapper-common / wrapper-wait / wrapper-report）と Codex 起動部品（`copyCodexAuth` / `codexHomePrune`）を import で再利用し、コピー由来重複を解消
- 専用 wrapper 固有の自前 dispatch lifecycle（start / end / metrics。共通 dispatch.sh を経由しないため）は `shared/src/wrapper-dedicated.ts` に集約。二重記録が無いことは observe JSON の実測比較で確認
- shim 置換前に HEAD の bash 実装との突き合わせを実測で行い、observe JSON・response（ts / pid / 経過 ms 正規化のうえ）と非 gpt モデルの fail-closed（exit 2 + failed response）の一致を確認した
- ここで bash consumer が全滅し、凍結していた bash 版 `observe-json.sh` / `prompt-constraints.sh` / `delegate-mcp.sh` を削除できる状態になった（削除自体は Step 8）

成果物: 独立正本だった専用 wrapper のコピー由来重複が解消し、全実行経路が TS 実装になる

### Step 8: (完了) 後始末と公開仕様更新

- 凍結 bash 本体（`observe-json.sh` / `prompt-constraints.sh` / `delegate-mcp.sh`）と `check-md2idx.sh` を削除。bash snippet / parity テスト（`scripts/observe-json.test.ts` / `observe-parity.test.ts` / `observe-store-parity.test.ts` / `delegate-mcp.test.ts`）も削除し、sync-shared で配布コピー 28 本の残骸を除去した
- 削除で失われるカバレッジを補償: `delegate-mcp.test.ts` の固有ケース（fake codex CLI での抽出・Claude/Cursor renderer・TOML エスケープ）を `shared/src/delegate-mcp.ts` の in-source test へ移植。`delegate-wrapper-session.test.ts` が直接 source していた `validate_followup` を `delegate-cli validate-followup` internal subcommand（TS 実装）経由へ付け替え
- jq 撤廃基盤として `read-json.ts`（`jq -r <dotpath>` 相当）+ `read-json.sh` shim を新設。**全 7 skill の SKILL.md** の run 出力 / observe JSON 読み取りを read-json.sh へ置換し、allowed-tools から `Bash(jq:*)` を撤去（read-json.sh の allow を追加）。observe 監視の prose も jq 非依存へ
- **配布 tree の静的検査** `scripts/check-no-jq-md2idx.sh` を新設し CI / pre-commit に組み込み。commit 対象 `skills/` は fail-closed、ローカル install（`.claude/skills` / `.agents/skills`、gitignore 済み・CI 不在）は warning
- README / README_ja: Prerequisites を「Node.js 24+ / 各 backend CLI / POSIX シェル / follow-up 時 git」へ更新し jq / md2idx / npx を削除。How it works に「shim → 単一 TS バンドル（md2idx 内包）」を明記
- spec.md / development.md: アーキテクチャ図・ディレクトリ構成・スクリプト inventory・exit code 表・shared 同期パターン・モデル追加手順・observe lock（symlink lock）を TS 構成へ書き換え。protocol-v1.md は不変契約のため変更しない
- `jq` / `md2idx` / `npx` を PATH から完全に隠した環境で `skills/delegate-chore/scripts/run.sh` の prepare→dispatch→read-response が完走することを smoke 確認
- SKILL.md の呼び出しは bash shim 維持で確定（§5-d。混在解消済みのため node 直呼びへの変更は不要）

成果物: 配布物・ドキュメント・前提条件が TS 実装で一貫した状態。リリース（`gh skill publish`）

### Step 9: (未着手) 永続ドキュメント反映と archive 化

- 残す設計判断（バンドル配布・lock プロトコル・CLI サブコマンド構成・source クラスタの考え方）を spec.md / development.md へ移す
- 本ドキュメントを `docs/archive/typescript-migration.archive.md` にリネームする（ユーザー確認後）

成果物: spec.md / development.md 更新 + archive

## 5. 設計判断

### a. 実行形態

| 候補                                         | 採用 | 理由                                                                                                                                |
| -------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **単一ファイル JS にバンドル（`vp build`）** | ✓    | ユーザー要件が「Node.js のみ」になる。md2idx / 将来の依存を内包できる。最小 Node は内包する md2idx の engines に合わせて 24（§3.1） |
| `.ts` を Node の type stripping で直接実行   | ✗    | erasable syntax 縛りが増える上、md2idx を内包できず `npx` 依存が残るため目的を満たさない                                            |
| skill 配下で `npm install`（runtime 依存）   | ✗    | self-contained 配布が崩れ、初回実行にネットワークが必要になる（現行 `npx --yes` の欠点が残る）                                      |

### b. バンドラ

| 候補                                 | 採用 | 理由                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`vp build`（vite の SSR ビルド）** | ✓    | 導入済み toolchain（vite-plus）で完結し新規依存ゼロ。mdxg-redline の `vite.review-request.config.ts` に Node CLI 単一 `.mjs` の実績構成があり流用できる（ただし npm 依存の内包には `ssr.noExternal: true` の追加が必須。§3.1）。`define` による in-source test 除去も同一機構 |
| esbuild                              | ✗    | ビルドは最速だが devDependency が増え、build toolchain が vp と二本立てになる。決定的出力・単一ファイル化の要件は rollup でも満たせる                                                                                                                                         |
| `vp pack`                            | ✗    | ライブラリ配布（exports / d.ts）向けで、単一ファイル CLI の出力制御が間接的                                                                                                                                                                                                   |
| vite-plugin-singlefile               | ✗    | ブラウザ向けビルドの JS/CSS を単一 **HTML** へインライン化するプラグインで、Node CLI の `.mjs` バンドルには適用外（mdxg-redline でも HTML 成果物側のみで使用）                                                                                                                |

### c. CLI 形態

| 候補                             | 採用 | 理由                                                                                               |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| **単一 CLI + サブコマンド**      | ✓    | 配布物が文字通り 1 ファイル。共有コードの重複がなく、sync-shared / ドリフト検知の対象も 1 つで済む |
| 現行スクリプトごとの個別バンドル | ✗    | 共通モジュールが各バンドルに重複し、配布物と検証対象が 17 個に増える                               |

### d. エントリポイントの互換

| 候補                                                                  | 採用 | 理由                                                                                                                                                        |
| --------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **直接実行エントリポイントのみ .sh shim + source クラスタ単位の移行** | ✓    | SKILL.md・スクリプト間相互呼び出し・fake CLI テストの呼び出し形が不変になり、段階移行と golden 検証が成立する                                               |
| 全 .sh の一律 exec shim 化                                            | ✗    | `run-imagegen.sh` 等が `run.sh` を source して関数 override するため、source 先を exec shim にすると親 shell ごと置換され、混在期の全 Step が壊れる（§3.2） |
| SKILL.md を node 直呼びに書き換え                                     | ✗    | 移行中の混在状態で SKILL.md が二重管理になる。全移行完了後の Step 8 で改めて評価する（shim 維持のままでも実害はない）                                       |

### e. 移行粒度

| 候補                                          | 採用 | 理由                                                                                                                                                  |
| --------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **source 依存クラスタ単位・契約不変のポート** | ✓    | argv/stdout 契約ごとに golden test で挟めるため回帰を局所化できる。source 関係を跨いで分割しないため、どの中間状態でも全 skill が動く                 |
| big-bang 一括書き換え                         | ✗    | 子プロセス管理・lock・シグナルなど挙動敏感部が多く、一括では回帰の切り分けができない                                                                  |
| 関数単位の bash↔node ブリッジ                 | ✗    | heartbeat（10s）/ wait ループ（1s poll）の node 起動コストに加え、二重の契約面が生まれる。移行期は凍結した bash 版 `observe-json.sh` の並存で代替する |

### f. observe lock

| 候補                                           | 採用 | 理由                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **symlink lock に統一 + stale 仕様の新規設計** | ✓    | Node / bash 双方で同一実装が可能で、混在期に相互排他が成立する。`ln -s` は作成と owner 公開が単一の atomic 操作のため、mkdir 案にあった「lock 作成後・owner 記録前」の無所有の窓が存在しない。owner 埋め込み / bounded wait / takeover / trap cleanup を Step 2 で仕様化した |
| mkdir lock                                     | ✗    | mkdir と owner 記録が別操作になり、その間に停止した保持者を lease 回収すると相互排他が破れる（実装レビュー P1 指摘で不採用）                                                                                                                                                 |
| flock 優先を維持                               | ✗    | Node 標準に flock がなく、bash=flock / TS=symlink の混在は相互排他にならない（observe JSON 破壊リスク）                                                                                                                                                                      |

### g. md2idx の取り込み方

| 候補                             | 採用 | 理由                                                                                                                                                          |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm 依存として import + 内包** | ✓    | zero-dependency ESM で library exports と型定義を持つ。v0.2.0 の CLI 自己判定はバンドル内で誤発火したが、v0.3.0 で bin 専用 entry（`dist/cli.mjs`）に分離済み |
| TS 内で再実装                    | ✗    | 正本が二重化し、md2idx 側の仕様変更に追従できない                                                                                                             |
| runtime `npx` を維持             | ✗    | ユーザー要求撤廃という本移行の目的に反する                                                                                                                    |

### h. dist バンドルの管理

| 候補                   | 採用 | 理由                                                                                                                                                            |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **git にコミットする** | ✓    | `gh skill install` はリポジトリ内容をそのまま配布するため、コミットしない限り配布できない。ドリフトは再ビルド byte 比較（pre-commit + CI）で fail-closed に検知 |
| CI / install 時に生成  | ✗    | インストール経路がビルド環境に依存し、self-contained 配布が崩れる。CI は生成ではなく**コミット済み成果物の検証**に使う（Step 1）                                |

## 6. テスト方針

### 自動テスト

- `shared/src/**/*.ts` の in-source test（モジュールごと）
  - 変換・検証系: exit code 表の互換 / md2idx 出力の envelope 付与 / 空 index·sections の fail-closed / selector 分岐
  - observe pure 系: backend 別 usage 抽出 / chars÷4 推定 fallback / effort 検証（fail-closed exit 6）/ cost 推定 / timing 集計 — `observe-json.test.ts` の対応 describe を移設
  - observe mutate 系: lock 下の原子更新 / 並行書き込み競合 / **lock 保持者 kill 後の回復 / 残存 lock dir の takeover / bounded wait の timeout** / follow-up validation の fail-closed
  - バンドル起動: 最小サポート Node での起動 / md2idx CLI 側コードが発火しない（stdout・exit code 汚染なし）/ dist に `import.meta.vitest` 分岐が残っていない（`define` による in-source test 除去の確認）/ **dist に `node:` 以外の bare import が残っていない**（`ssr.noExternal` の内包確認）/ **`node_modules` が存在しない隔離ディレクトリへ dist 単体をコピーして起動できる**
- golden（移行前後の等価性、無改変で維持）
  - `scripts/delegate-wrapper-session.test.ts`: fake CLI による backend 別 session mode / argv / report 収集の検証。shim 経由のため呼び出し形が変わらない
  - `scripts/delegate-run.test.ts` / `scripts/delegate-mcp.test.ts`: run one-shot 契約と MCP config 隔離
  - `scripts/check-metrics-baseline.sh`: metrics レコード形状の決定論的ドリフト検知（duration 系は含まれない点に注意）
  - `npm run sync-shared:check` + dist ドリフト検知
- 静的検査: 配布 tree（`skills/` / `.claude/skills/` / `.agents/skills/`、SKILL.md 含む）に `jq` / `npx --yes md2idx` への参照が存在しない（Step 8 以降、CI で常時検証）
- 移行の各 Step で分割前後のテスト件数（passed count）が減っていないことを確認する

### レイテンシ反復ベンチ

metrics baseline は duration を含まないため、レイテンシ回帰は別途測る。`scripts/run-latency-bench.sh`（`run-metrics-fixtures.sh` ベース、warm-up 1 回 + 本計測 10 回 × 3 fixture）で `prepare` / `read_response` / `dispatch` の `duration_ms` p50（nearest-rank）を取り、移行前の記録値との比較で**許容回帰 +20% 以内**を Step 5 / Step 6 / 最終受け入れの完了条件にする。

移行前ベースライン（2026-07-20 採取、devcontainer / Linux、HEAD a376867 = bash 版 prepare / dispatch / run が runtime。`bash scripts/run-latency-bench.sh 10`、各 kind 30 サンプル、計測分解能は `/proc/uptime` 由来の 10ms）:

| kind            | p50    | 備考                                                                    |
| --------------- | ------ | ----------------------------------------------------------------------- |
| `prepare`       | 200 ms | bash 版（jq / node 子プロセス多数）                                     |
| `dispatch`      | 100 ms | fake claude 経由の orchestration オーバーヘッドのみ（モデル実行を除く） |
| `read_response` | 0 ms   | Step 3b で TS shim 化済み。10ms 分解能未満                              |

Step 5 完了時の再計測（2026-07-20、同環境・同条件）: `prepare` 0 ms / `dispatch` 80 ms / `read_response` 0 ms。全 kind で許容回帰 +20% を満たす（prepare は in-process 化により jq / node 子プロセスが消え 10ms 分解能未満へ短縮）。

Step 6 完了時の再計測（2026-07-20、同環境・同条件）: `prepare` 0 ms / `dispatch` 30 ms / `read_response` 0 ms。wrapper の TS 化（bash 内 jq 多数 → in-process）と poll sleep の中断可能化で dispatch も移行前比で短縮した。

### 手動確認

- [ ] `vp check` / `vp test` / `npm run sync-shared:check` / `npm run build:check`
- [ ] `gh skill install . <skill> --from-local` 後、実モデルで delegate-explore を 1 本実行し response / observe JSON を確認
- [ ] `jq` / グローバル `md2idx` を PATH から隠した環境で、install 直後の状態から全 skill が動作する（Step 8）
- [ ] 並列 dispatch（同時 2 run）で observe JSON が破壊されない。lock 保持プロセスを kill しても後続 run が回復する
- [ ] 反復ベンチの p50 が許容回帰内に収まっている
- [ ] README / README_ja の Prerequisites・How it works・全 SKILL.md の手順が実装と一致している

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- ユーザー前提条件が「Node.js 24+ と利用するバックエンド CLI（shim 実行に POSIX シェル、follow-up 利用時に git）」になっている（jq / md2idx / `npx` 不要、初回実行にネットワーク不要）
- 公開契約（各スクリプト shim の argv・stdout・exit code / `run` の JSON envelope / observe JSON スキーマ / protocol-v1）が意図せず変わっていない
- golden test（wrapper-session / delegate-run / metrics baseline）が移行前と同一内容で通る（`delegate-mcp.test.ts` は Step 8 で削除し、MCP 抽出/描画のカバレッジは `delegate-mcp.ts` の in-source test へ移設）
- 配布 tree（SKILL.md 含む）に jq / `npx md2idx` への参照が静的検査で存在しない
- レイテンシ反復ベンチの p50 が許容回帰（+20%）以内
- `gh skill install` 単体（リポジトリ clone なし）でインストールした skill が動作する
- spec.md / development.md / README / README_ja / 全 SKILL.md が実装と一致している

## 8. 想定リスクと回避策

| リスク                                                                      | 回避策                                                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| md2idx の CLI 自己判定がバンドル内で誤発火し、stdout / exit code を汚染する | md2idx 側で副作用のない library entry を分離してから取り込む（Step 1 前提）。実バンドルの起動回帰テストで常時検証                                                          |
| lock / 原子性の移植バグ、保持者異常終了による observe 更新の恒久停止        | Step 2 で mkdir 統一と同時に owner 記録 / bounded wait / stale takeover / trap cleanup を仕様化し、競合・kill・timeout のテストを追加してから mutate 系を移行する          |
| exit code / stdin 取り回し / シグナル・cleanup の暗黙挙動の移植漏れ         | クラスタ単位ポート + shim で契約を固定し、fake CLI golden test と exit code の in-source test で検証                                                                       |
| node プロセス起動増によるレイテンシ悪化                                     | クラスタ粒度移行で境界呼び出しを増やさない。jq / npx 子プロセスの消滅で相殺見込み。baseline は duration を含まないため、§6 の反復ベンチ（p50、許容 +20%）で移行前後を比較  |
| コミット済み dist と src のドリフト                                         | 決定的ビルド（vite / rollup バージョンは package-lock 厳守）+ pre-commit / `--check` に加え、pinned 環境の CI で clean checkout から build byte 比較を PR 必須化（Step 1） |
| 混在期に bash 実装と TS 実装の JSON 形状が乖離                              | bash 版 observe-json.sh を凍結し、observe スキーマ・metrics レコードを golden で固定。移行順を leaf → observe → orchestration → wrapper の依存順に保つ                     |
| SKILL.md の手順・allowed-tools と実装の乖離（jq 撤去漏れ）                  | Step 8 で全 SKILL.md を実装と同時更新し、配布 tree への静的 jq / npx 検査を CI 化。jq を PATH から隠した install 後 smoke を受け入れ条件にする                             |
| md2idx のバージョン更新への追従漏れ                                         | devDependency + lock で固定し、更新時は build:check とテストで検知。バンドル内包により「ユーザー環境の md2idx が古い」問題は消滅                                           |
| バンドル 1 ファイル化によるデバッグ性低下                                   | sourcemap を dist に併置するか検討（配布サイズと相談）。正本 `shared/src/` の in-source test で再現・切り分けする運用を development.md に明記                              |

## 9. 参考

- [spec.md](../design/spec.md) — 完了時にアーキテクチャ章を TS 構成へ更新
- [development.md](../design/development.md) — shared 同期パターン・モデル追加手順・テスト章を更新
- [protocol-v1.md](../design/protocol-v1.md) — 本移行では変更しない（不変契約）
- [md2idx](https://github.com/oubakiou/md2idx) — v0.3.0（zero-dependency ESM / library exports。engines `>=24.0.0`。[#3](https://github.com/oubakiou/md2idx/issues/3) で library / CLI entry 分離済み）
- [vite-plus](https://www.npmjs.com/package/vite-plus) — `vp build` によるバンドル（toolchain は導入済み）
- [mdxg-redline の vite.review-request.config.ts](https://github.com/oubakiou/mdxg-redline/blob/main/vite.review-request.config.ts) — Node CLI 単一ファイルバンドルの参考構成（`build.ssr` / `external: [/^node:/]` / 単一 ESM 出力 / `define` による in-source test 除去）
