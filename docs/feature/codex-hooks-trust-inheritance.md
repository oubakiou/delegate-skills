# Codex worker での project hooks 有効化 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fcodex-hooks-trust-inheritance.md)

[issue #28](https://github.com/oubakiou/delegate-skills/issues/28) に対応する。Codex backend へ委譲した worker で、対象リポジトリの `.codex/hooks.json`（project hooks）が親セッションと同様に発火するようにする。完了後は [spec.md](../design/spec.md) の「Codex パスの起動」「セッション再利用（opt-in）」「observe JSON」「環境変数」章へ永続情報を移し、本ファイルは archive する。

**採用案: `implement` / `chore` の `codex exec` に `--dangerously-bypass-hook-trust` を付与する（§5a / §5d）。** 当初は「親の trust 状態を隔離 `CODEX_HOME` へ透過する」案（以下 A 案）を主軸に置いていたが、§2.3 の実測で不成立と判明したため差し替えた。実行時安定性を最優先の判断軸とする。

## 1. 対応スコープ

| 要件                                                                      | 開始時の状態 | 完了条件                                                                                                                                         | 最終状態 | 状態   |
| ------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| [MUST] Codex worker で対象リポジトリの project hooks が発火する           | 部分         | 実 Codex への委譲（通常 run / follow-up の双方）で `.codex/hooks.json` の PostToolUse hook が実行されることを確認                                | {}       | 未着手 |
| [MUST] 有効化が「hook を無条件に信頼する」ことの明示                      | 未           | spec.md の「Codex パスの起動」に、wrapper が persisted hook trust を要求せず enabled hook を実行することを明記                                   | {}       | 未着手 |
| [MUST] 各 task_type の書き込み契約が hook 経由で破れない                  | 未           | §5d の allowlist が確定し、Codex wrapper を通る allowlist 外の種別（explore / review / htmldoc）の argv に flag が付かないことを契約テストで固定 | {}       | 未着手 |
| [MUST] flag 非対応 CLI での挙動が定義され、契約テストで固定されている     | 未           | §5c の方針（fail-closed）が実装され、flag を拒否する fake CLI で期待どおりの終了状態になることを確認                                             | {}       | 未着手 |
| [MUST] 有効化の範囲が対象リポジトリに限定される                           | 未           | `-C <repoRoot>`（通常 run）または cwd = repoRoot（follow-up）配下の hook のみが対象で、親の user 設定側 hooks が持ち込まれないことを確認         | {}       | 未着手 |
| [MUST] follow-up / resumable lineage での挙動が定義され、テストされている | 未           | argv は run ごとに構成されるため opt-out も run ごとに効く（§5f）。initial / follow-up 双方の argv assert に加え、follow-up の実発火を確認       | {}       | 未着手 |
| [SHOULD] hook 実行が委譲の所要時間に与える影響を把握する                  | 部分         | §2.3 の実測（差し戻し時に 11s → 37s）を spec.md か README の注記に反映し、退避路として opt-out を案内する                                        | {}       | 未着手 |
| [SHOULD] 無効化する opt-out env を提供する                                | 未           | `DELEGATE_CODEX_HOOKS=0` で flag が付かないことを契約テストで確認                                                                                | {}       | 未着手 |
| [SHOULD] 有効化の有無を observe JSON に記録する                           | 未           | `project_hooks` フィールド（§3.2）が記録され、`read-json.sh` で読める                                                                            | {}       | 未着手 |
| [SHOULD] 公開仕様（spec.md / README 英日）が実装と一致する                | 未           | 「Codex パスの起動」節と環境変数表が更新され、英日の記載が対応している                                                                           | {}       | 未着手 |

スコープ外:

- **親の trust 状態の透過（A 案）**: §2.3 の実測で `trust_level` 単独では発火せず、`trusted_hash` の再計算も不可能と確定したため不採用（§5a / §5b）。TOML 抽出モジュールも不要になった
- **`delegate-imagegen`（`wrapper-imagegen.ts`）**: 画像生成 worker はリポジトリのソース編集を行わず、hook を効かせる要件が issue にない。argv を変更しないことは §6 の回帰テストで固定する（`--ignore-user-config` は user config の読み込みだけを抑止するもので、project hooks の gating とは無関係。除外の根拠にはならない）
- **ユーザー設定のグローバル hooks 定義（`~/.codex` 側の hook）**: 隔離 `CODEX_HOME` には持ち込まれないため対象外
- **project `.codex/config.toml` の設定値が worker に適用されること**: §2.3 の実測で **trust の有無に関わらず適用される**（= 現行 delegate でも既に適用されている）ことを確認した。本計画の変更対象ではない
- **Codex 以外の backend（Claude / Devin / Cursor）**: Claude 子プロセスは親の設定探索経路をそのまま使うため本 issue の症状がない。Devin / Cursor は hooks 相当の機構が異なるため別 issue で扱う

## 2. ベースライン / リファレンス

### 2.1 現行の隔離経路（調査で確定済み）

| 実装                                                                            | 挙動                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `setupCodexHome`（[wrapper-codex.ts:147](../../shared/src/wrapper-codex.ts)）   | 通常 run / resumable initial は `<workDir>/codex-home`、follow-up は検証済み `session_home` を返す                     |
| `copyCodexAuth`（同 234）                                                       | root の `auth.json` だけを atomic copy する                                                                            |
| `injectCodexMcp`（同 418）                                                      | MCP サーバーが 1 件以上あるときだけ `config.toml` を上書き生成する                                                     |
| `normalCodexArgs`（同 482）                                                     | 通常 run と resumable initial の argv を構築する（差は `--ephemeral` の有無のみ）                                      |
| `followupCodexArgs`（同 460）                                                   | `codex exec resume` の argv を構築する。`-C` を持たず、sandbox は `-c sandbox_mode=` で渡す                            |
| `codexLaunchOf`（同 614）                                                       | 上記 2 関数の分岐点                                                                                                    |
| 子プロセス起動（同 644-652）                                                    | cwd = `repoRoot`、env に `CODEX_HOME=<隔離 HOME>` / `TMPDIR=<workDir>/tmp` を上書き。`--ignore-user-config` は付けない |
| `sandboxOf`（同 449）                                                           | `CODEX_DELEGATE_SANDBOX` で上書き可能。既定は `danger-full-access`                                                     |
| `codexHomePrune`（[wrapper-report.ts:391](../../shared/src/wrapper-report.ts)） | `DELEGATE_CODEX_HOME_PRUNE` の判定を直書きし、`config.toml` と `sessions` は常に残す                                   |

`CODEX_HOME` が差し替わっているため、ユーザー設定（`~/.codex/config.toml`）は worker から実質読まれない。これが issue の直接原因。

### 2.2 Codex CLI が提供する制御手段（v0.145.0 の `codex exec --help` で確認）

| flag                              | 説明（help 原文の要旨）                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dangerously-bypass-hook-trust` | Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS. **Intended only for automation that already vets hook sources**. `codex exec resume` にも存在する |
| `--enable <FEATURE>`              | Enable a feature (repeatable). Equivalent to `-c features.<name>=true`                                                                                                                     |
| `--strict-config`                 | Error out when config.toml contains fields that are not recognized by this version of Codex                                                                                                |
| `--ignore-user-config`            | `$CODEX_HOME/config.toml` を読まない（auth は `CODEX_HOME` を使う）。**project 側の hooks / config は抑止しない**                                                                          |
| `--ignore-rules`                  | user / project execpolicy `.rules` を読まない（delegate は意図的に付けない）                                                                                                               |

help の "Intended only for automation that already vets hook sources" は、リポジトリの hook source を親が使っている delegate-skills の状況にそのまま当てはまる。

### 2.3 実測（2026-08-09、codex-cli 0.145.0、`gpt-5.6-luna`）

project 側 `.codex/config.toml` を持たない最小リポジトリに sentinel を書くだけの `.codex/hooks.json`（PostToolUse / `Edit|Write`）を置き、隔離 `CODEX_HOME`（`auth.json` のみコピー）で `codex exec --skip-git-repo-check --ephemeral --sandbox danger-full-access -C <repo>` を起動した。

**hooks の発火条件**

| #   | 隔離 HOME の `config.toml`                    | 追加 argv                         | project config | 結果                          |
| --- | --------------------------------------------- | --------------------------------- | -------------- | ----------------------------- |
| 1   | 空                                            | なし                              | なし           | **発火せず**（issue を再現）  |
| 2   | 空                                            | `--dangerously-bypass-hook-trust` | なし           | **発火**                      |
| 3   | 空                                            | `--enable hooks` + bypass         | なし           | 発火（`--enable` は不要）     |
| 4   | `[projects."<repo>"] trust_level = "trusted"` | なし                              | なし           | **発火せず**                  |
| 5   | 空                                            | `--dangerously-bypass-hook-trust` | 壊れた TOML    | run 失敗（TOML パースエラー） |
| 6   | `trust_level = "trusted"`                     | なし                              | 壊れた TOML    | run 失敗（同上）              |

**project config layer の適用範囲・安定性**

| #   | 検証内容                                                                                           | 結果                                                                                |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 7   | project `.codex/config.toml` の `[shell_environment_policy.set]` が worker の shell に適用されるか | **trust の有無に関わらず適用**（trust あり / なしとも `mark=applied`）              |
| 8   | project `approval_policy = "untrusted"` が非対話 run をハングさせるか                              | **ハングしない**（trust あり / なしとも 11 秒で完了、編集も成功）                   |
| 9   | hook が exit 2 で差し戻したときに worker がループするか                                            | **ループしない**（発火 1 回で正常終了）。ただし wall time が 11s → 37s              |
| 10  | 未知 flag を渡したときの失敗の出方                                                                 | `exit=2` + stderr `error: unexpected argument '<flag>' found`。**API 到達前**に失敗 |

**`trusted_hash` の入力調査**

親 `~/.codex/config.toml` のキー形式は `[hooks.state."<repoRoot>/.codex/hooks.json:post_tool_use:0:0"] trusted_hash = "sha256:…"`。この記録値と、対象 `.codex/hooks.json` の raw file / 末尾改行除去 / command 文字列の sha256 はいずれも一致しない。

確定した事実:

- **bypass flag だけで hooks は発火する**（#2）。`--enable hooks` も trust 設定も不要
- **`trust_level` の透過だけでは発火しない**（#4）
- **`trusted_hash` は wrapper 側で再計算できない**（内部表現。§5b）
- **project `.codex/config.toml` は trust と無関係にパースされ、値も適用される**（#5 = #6、#7）。壊れていれば run が失敗する。いずれも本計画の変更対象外の現行挙動
- **実測条件では approval 由来のハングが起きなかった**（#8）。sandbox を明示していることが理由と推定されるが、sandbox 未指定との比較や他タスク条件では未検証
- **未知 flag は API 到達前に exit 2 で落ちる**（#10）。副作用ゼロで観測可能

未確定（Step 3 に残す）:

- 非既定 sandbox（`CODEX_DELEGATE_SANDBOX` を絞った運用）で hook command が sandbox 制約を受けるか
- `codex exec resume`（follow-up 経路）で project hooks が cwd ベースに解決されるか。flag の存在自体は help で確認済み

## 3. 設計の中核

### 3.1 argv への flag 付与

argv 構築関数は `normalCodexArgs`（通常 run / resumable initial を兼ねる）と `followupCodexArgs`（`codex exec resume`）の **2 つ**で、分岐点は `codexLaunchOf` の 1 箇所。他に `codex exec` を起動する経路は `wrapper-imagegen.ts:72`（意図的に対象外）のみで、`delegate-mcp.ts:80` は `codex mcp list` なので無関係。**追加漏れになる経路は他にない。**

両関数に、次を満たすときだけ `--dangerously-bypass-hook-trust` を追加する。`config.toml` の生成経路（`injectCodexMcp` / `recordFollowupMcp`）は**一切変更しない**。

```
codexHooksEnabled(context) =
  envFlagEnabled(env, 'DELEGATE_CODEX_HOOKS')          # 既定 true
  && HOOK_ENABLED_TASK_TYPES.has(context.args.taskType)  # implement / chore のみ（§5d）
```

- **task_type の allowlist**: `taskType` は `WrapperContext` から参照できる。`HOOK_ENABLED_TASK_TYPES = {implement, chore}` を単一の定数として定義し、新種別の追加時に「明示的に足さない限り hook は効かない」既定にする（§5d）
- **共通 env helper**: `envFlagEnabled(env, name)`（`'0'` / `'false'` / `'no'` を false、未設定を true）を **新規の小モジュール `shared/src/env-flag.ts`** に置く。`wrapper-common.ts` は既に `wrapper-report.ts` を import している（`wrapper-common.ts:27`）ため、`codexHomePrune`（実体は `wrapper-report.ts:392`）から `wrapper-common.ts` を import すると循環になる。依存方向が中立な独立モジュールにすることで、両者から安全に使える
- **follow-up も同じ扱い**: argv は起動のたびに構成されるため、opt-out は run ごとに効く（§5f）

### 3.2 observe への記録

既存の `mcp_config`（`source` + `servers` の 2 フィールド）に倣い、状態フラグを重複させない。

```
project_hooks: {
  enabled: boolean,
  source: 'flag' | 'disabled' | 'task_type_excluded',
}
```

`enabled=false` になる条件が重なった場合（`DELEGATE_CODEX_HOOKS=0` かつ allowlist 外の種別）は、運用者の明示設定を優先して `disabled` とする。

`read-json.sh .project_hooks.source` で読める。将来 trust 方式が増えたら `mode` を足す。

## 4. 実装ステップ

### Step 1: (完了済み) 有効化手段の実測

§2.3 に結果を記録した。採用案の確定（§5a）、fail-closed 方針の確定（§5c）、approval ハングが実測条件では起きないことの確認、wall time 影響の把握まで完了している。残る 2 項目（非既定 sandbox、follow-up の実発火）は実装後の検証と同時に行うため Step 3 に移した。

### Step 2: (未着手) 実装・テスト・同期・公開仕様（単一 PR）

`shared/src` の変更は `npm run build` → `npm run sync-shared` を伴わないと契約テストが旧 dist を検証し（[`shared/delegate-codex.sh:16`](../../shared/delegate-codex.sh) は committed dist を実行する）、CI の `build:check` / `sync-shared:check` も落ちるため、以下は同一 commit にまとめる。

- `wrapper-codex.ts`: `normalCodexArgs` / `followupCodexArgs` に flag を追加（§3.1）
- `shared/src/env-flag.ts`（新規）: `envFlagEnabled`
- `wrapper-common.ts`: `HOOK_ENABLED_TASK_TYPES` 定数の定義
- `wrapper-report.ts`: `codexHomePrune` の直書き判定を `envFlagEnabled` へ置き換え（挙動不変）
- `observe-store.ts`: `project_hooks` 更新ヘルパ
- `scripts/delegate-wrapper-session.test.ts`: §6 の契約テスト
- `npm run build` → `npm run sync-shared`
- `docs/design/spec.md`:「Codex パスの起動」に flag・種別別の出し分け・「hook を無条件に信頼する」旨、「セッション再利用（opt-in）」に opt-out が run ごとに効くこと、「observe JSON」に `project_hooks`、「環境変数」に `DELEGATE_CODEX_HOOKS` を追記
- `README.md` / `README_ja.md`: Advanced settings の環境変数表に追加（英日で対応させる）

成果物: 緑の単一 PR（実装 + テスト + dist 同期 + 公開仕様）

### Step 3: (未着手) 実 Codex での end-to-end 検証

§2.3 と同じ最小検証リポジトリ（sentinel hook）を再構成して行う。検証用ファイルは commit せず、`.temp/` 配下に置いて auth コピーを残さず削除する。

- `delegate-implement` 経由で sentinel hook が発火する
- **follow-up run でも sentinel hook が発火する**（`codex exec resume` は `-C` を持たず cwd 依存のため、通常 run とは別に確認する）
- `DELEGATE_CODEX_HOOKS=0` で発火しない。follow-up で opt-out を切り替えると run ごとに反映される
- `delegate-explore` / `delegate-review` では flag が付かず発火しない（read-only 契約の確認）
- **user hook の隔離**（§1 の「対象リポジトリに限定される」に対応する負の検証）。非発火だけでは fixture の設定ミスでも成功してしまうため、正の対照を先に取る:
  1. fixture 用の親 HOME を作り、`auth.json` と、user hook を定義した `config.toml` + 参照先 hook（project sentinel とは別の sentinel を書く）を置く
  2. **正の対照**: その fixture を `CODEX_HOME` にして直接 `codex exec` を実行し、user sentinel が発火することを確認する（fixture が有効であることの担保）
  3. 同じ fixture を親 `CODEX_HOME` として wrapper の通常 run / follow-up を実行し、project sentinel は発火し **user sentinel は発火しない**ことを確認する
- **非既定 sandbox**（`CODEX_DELEGATE_SANDBOX` を絞る）で hook command が sandbox 制約を受けるか（§8 のセキュリティ論拠の裏づけ）
- 本リポジトリ（`.codex/hooks.json` が `vp check --fix` を起動する）で 1 回委譲し、複数編集を伴うタスクでの wall time 増を観測する

成果物: §1 の MUST 要件の実測エビデンス

### Step 4: (未着手) spec.md 反映と archive 化

- 永続情報を spec.md へ移す（Step 2 で先行して書いた分の最終確認）
- 本ドキュメントを `docs/archive/codex-hooks-trust-inheritance.archive.md` にリネームする

成果物: spec.md 更新 + archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. hooks 有効化の手段

| 候補                                             | 採用 | 理由                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`--dangerously-bypass-hook-trust` を付与する** | ✓    | 実測 #2 で flag 単独で発火。実装は argv 1 行で、`config.toml` 生成・TOML パース・stale 管理といった失敗点を一切増やさない。help が "Intended only for automation that already vets hook sources" と用途を明示している                                                                           |
| A: 親の trust 状態を隔離 HOME へ透過             | ✗    | 実測 #4 で `trust_level` 単独では発火しない。成立させるには `trusted_hash` の透過が追加で必要になるが、その値は内部表現で再計算できず（§5b）、**透過すれば発火するかどうか自体が未検証**（値を入手できず測れなかった）。TOML パーサを実装したうえで成否が環境依存になり、失敗しても観測されない |
| A + B の併用                                     | ✗    | B だけで目的を満たす。A の失敗点（パース誤読、stale config）を足す理由がない                                                                                                                                                                                                                    |
| 隔離 `CODEX_HOME` をやめる                       | ✗    | auth 保護と session 分離という隔離の目的を失う。issue 側も隔離廃止は求めていない                                                                                                                                                                                                                |

**安定性の観点での決め手**: A 案の失敗様式は「静かに無効化」（環境依存で hooks が効かず、issue が再発しても気づけない）。B 案の失敗様式は「flag 非対応なら API 到達前に exit 2」（実測 #10）で、観測可能かつ副作用ゼロ。実行時安定性を最優先の判断軸に置くなら、観測できない失敗より観測できる失敗を選ぶ。

なお当初 A 案の副作用として挙げていた「project config layer 全体が有効化される」は、実測 #7 で **trust と無関係に適用される**ことが判明したため、A 案固有の欠点ではない（現行 delegate でも既に適用されている）。

### b. `trusted_hash` を wrapper が再計算する案（不採用）

| 候補                                 | 採用 | 理由                                                                                                                                                     |
| ------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ユーザー設定から値をコピーする       | ✗    | A 案ごと不採用（§5a）                                                                                                                                    |
| wrapper が hooks.json から再計算する | ✗    | 実測で raw file / 末尾改行除去 / command 文字列の sha256 いずれも親の記録値と不一致。入力仕様が公開されておらず、当てても Codex の実装変更で静かに壊れる |

### c. flag を受理しない Codex CLI への備え

| 候補                                                  | 採用 | 理由                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **fail-closed（そのままエラーにする）**               | ✓    | 実測 #10 のとおり未知 flag は **API 到達前に exit 2** で落ちる。トークン消費もリポジトリへの副作用もなく、失敗が即座に観測できる。CLI 側の非互換は delegate 側の更新で対応すべき事象であり、隠すべきではない                                                                                                                                                                               |
| flag 非対応を検出したら flag なしで再試行（fallback） | ✗    | **子プロセスを 2 回起動する**ことになり、1 回目が flag 拒否以外の理由で途中まで進んで落ちた場合に編集・commit の副作用を二重適用する（worker は `--sandbox danger-full-access` で編集し、`delegate-implement` は commit まで行う）。さらに判定が stderr の文字列一致に依存し、CLI のメッセージ変更で静かに壊れる。§5a が A 案を退けた「静かに壊れる」失敗様式を B 案側へ持ち込むことになる |
| 起動前に `codex exec --help` で flag の存在を確認する | ✗    | 委譲のたびに子プロセスが 1 回増える（同種の子プロセス起動は実測 94ms）。得られる判定は fail-closed と同じで、コストだけが恒常的に乗る                                                                                                                                                                                                                                                      |

契約テストでは、flag を拒否する fake CLI に対して wrapper が failed response を書き、exit code を透過することを固定する。

### d. hook を有効化する task_type（allowlist）

| 候補                                                                | 採用 | 理由                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`implement` / `chore` のみの明示 allowlist**                      | ✓    | issue の実害（未整形コードの commit）はこの 2 種別で起きる。allowlist にすることで、新種別を追加しても「明示的に足さない限り hook は効かない」既定になり、書き込み契約を後から壊さない                                                                                                                          |
| 「編集を伴う種別は ON」という denylist（explore / review のみ除外） | ✗    | 無制限編集と**限定書き込み**を同一視してしまう。`htmldoc` は「指定出力ディレクトリ配下だけ書き込み可」、`x-research` は調査専用という契約を持ち、hook（例: `vp check --fix`）が出力先外のリポジトリファイルを書き換えると契約が静かに破れる。hook は PostToolUse で動くため prompt constraints では止められない |
| 全 task type 一律 ON                                                | ✗    | 上記に加えて explore / review の read-only 契約も破れる                                                                                                                                                                                                                                                         |
| `implement` だけ ON                                                 | ✗    | `chore` も編集を行うため、issue と同じ実害が chore 経由で残る                                                                                                                                                                                                                                                   |

`htmldoc` を将来 ON にする場合は、限定書き込み契約との優先順位を §1 / spec.md に明記し、出力先外が変更されないことを e2e で確認してから足す。

### e. 環境変数名

| 候補                                       | 採用 | 理由                                                                                                                                                |
| ------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`DELEGATE_CODEX_HOOKS`**                 | ✓    | 既存の `DELEGATE_CODEX_HOME_PRUNE` と同じ `DELEGATE_<BACKEND>_<対象>` 系。制御対象が hooks の有効化そのものなので、trust 実装に依存しない名前にする |
| `DELEGATE_CODEX_INHERIT_TRUST`（旧案）     | ✗    | trust 透過を採らなくなったため、実装と名前が合わない                                                                                                |
| `CODEX_DELEGATE_INHERIT_HOOKS`（issue 案） | ✗    | 既存 env は `DELEGATE_` 前置が主流（`CODEX_DELEGATE_SANDBOX` は例外）。新規追加は多数派へ揃える                                                     |

### f. follow-up / resumable lineage での有効化の更新

argv は起動のたびに構成されるため、**opt-out も有効化も run ごとに当該 run の env が効く**。初回 run の設定を lineage に固定する MCP config とは異なる挙動になるため、spec.md §7 に明記する。

| 候補                                 | 採用 | 理由                                                                                                                       |
| ------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| **run ごとに当該 run の env が効く** | ✓    | argv の自然な帰結で、追加実装が不要。opt-out を効かせたいときに新しい lineage を張らなくてよい                             |
| initial run の設定を lineage に固定  | ✗    | argv を observe に永続化して follow-up で読み戻す仕組みが要る。MCP config との一貫性のためだけに、退避路の使い勝手を下げる |

### g. 既定で有効にする / opt-in にする

| 候補                                    | 採用 | 理由                                                                                                                                                             |
| --------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **既定 ON + opt-out env**               | ✓    | project hooks は「そのリポジトリで作業するエージェント全員に効かせたい」防御であり、委譲経路だけ素通りするのは防御の破れ。opt-out は §8 のリスク顕在化時の退避路 |
| opt-in env（issue の `..._HOOKS=1` 案） | ✗    | 既定で壊れたままになり、issue の実害（未整形コードの commit）が「設定を知っている人だけ回避できる」状態で残る                                                    |
| 無効化手段を持たない                    | ✗    | hook が委譲を壊す環境（hook 自体の失敗、収束しない差し戻しループ）で逃げ道がなくなる                                                                             |

## 6. テスト方針

### 自動テスト

- `scripts/delegate-wrapper-session.test.ts` の argv assert
  - 通常 run（`implement` / `chore`）: 既定で `--dangerously-bypass-hook-trust` が付く
  - resumable initial: 同上
  - follow-up（`codex exec resume`）: 同上
  - **allowlist 外の種別**（`explore` / `review` / `htmldoc`）: 既定でも flag が付かない（§5d）。`x-research` は `run-x-research` から専用の Grok wrapper へ dispatch され Codex wrapper を通らないため、ここでは扱わず既存の dispatch 契約テストに任せる
  - `DELEGATE_CODEX_HOOKS=0` / `false` / `no`: いずれでも flag が付かない
  - **follow-up で run ごとに切り替わる**: 初回 ON → follow-up で opt-out すると flag が消える（§5f）
  - imagegen の argv は変わらない（`wrapper-imagegen.ts` 非対象の回帰チェック）
  - `config.toml` 生成まわりの既存テストが緑のまま（MCP あり / なし / follow-up 再利用）
- **flag 拒否 fake CLI**: unknown argument で exit 2 を返す fake codex に対し、wrapper が failed response を書き exit code を透過する（§5c の fail-closed を固定）
- observe JSON の `project_hooks.enabled` / `.source` が期待値になる（`flag` / `disabled` / `task_type_excluded`）。**複合条件**（opt-out かつ allowlist 外）で `disabled` が優先されることも 1 ケース固定する
- `envFlagEnabled` の in-source test（`'0'` / `'false'` / `'no'` / 未設定 / 空文字 / その他）と、`codexHomePrune` の既存テストが緑のままであること
- `HOOK_ENABLED_TASK_TYPES` の in-source test（allowlist 内 / 外の判定に加え、**未知の task_type が allowlist 外になる**ことを固定する）

### 手動確認

- [ ] `vp check`
- [ ] `npm test`
- [ ] `npm run build` → `npm run sync-shared` → `npm run sync-shared:check`
- [ ] Step 3 の end-to-end（通常 run / follow-up の実発火、opt-out、allowlist 外の種別で非発火、user hook の非発火、非既定 sandbox、本リポジトリでの wall time）
- [ ] `README.md` / `README_ja.md` / `spec.md` の記載と実装が一致している

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 「wrapper が persisted hook trust を要求せず enabled hook を実行する」ことと、対象 task_type の allowlist が spec.md に明記されている
- 既存の MCP 注入・auth lifecycle・prune・session reuse の挙動が変わっていない（`scripts/delegate-wrapper-session.test.ts` が緑）
- 新規挙動に対応する契約テストがある
- `npm run sync-shared:check` / `vp check` / `npm test` が通る
- `spec.md` / `README.md` / `README_ja.md` が実装と一致している

## 8. 想定リスクと回避策

実行時安定性を最優先の判断軸とするため、失敗様式ごとに整理する。

| リスク                                                                                          | 失敗の見え方         | 回避策                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI が flag を受理せず、全 Codex 委譲が起動できなくなる                                   | 即エラー（観測可能） | §5c で fail-closed に確定。実測 #10 のとおり API 到達前に exit 2 で落ちるため副作用がない。flag 拒否 fake CLI の契約テストで終了状態を固定する                                                                                                                                                                            |
| hook 実行で wall time が伸び、親の timeout や `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` に当たる | run が途中で切られる | 実測 #9 では差し戻しありで 11s → 37s。委譲を呼ぶ側は所要時間より長い timeout を設定する（skill の既存ガイダンス）。退避路として `DELEGATE_CODEX_HOOKS=0`                                                                                                                                                                  |
| hook が exit 2 で差し戻し、worker が収束しない修正ループに入る                                  | wall time 増 / 失敗  | 実測 #9 では単一編集タスクでループしなかった。複数編集を伴うタスクでの挙動を Step 3 で観測する。退避路は opt-out                                                                                                                                                                                                          |
| hook 自体が壊れている環境（`vp` 不在、node 不在）で worker が失敗する                           | run 失敗（観測可能） | opt-out env で切れることを README に明記する。hook は利用側リポジトリの責任範囲                                                                                                                                                                                                                                           |
| trust を要求しないため、リポジトリに悪意ある hook があると worker で実行される                  | 静かに実行される     | **既定の `danger-full-access` 運用では** worker の権限上限と一致するため昇格にはならない。ただし `CODEX_DELEGATE_SANDBOX` で sandbox を絞った運用では、hook command が sandbox 制約を受けるかが未確認（Step 3）。実効的な緩和は `DELEGATE_CODEX_HOOKS=0` のみ。spec.md に「wrapper が hook を無条件に信頼する」と明記する |
| allowlist 外の種別で hook がリポジトリを書き換え、read-only / 限定書き込み契約が破れる          | 静かに書き換わる     | §5d の allowlist（`implement` / `chore`）を単一定数で持ち、契約テストで固定する。新種別は明示的に足さない限り OFF                                                                                                                                                                                                         |
| project `.codex/config.toml` が壊れていると run が失敗する                                      | 即エラー（観測可能） | 実測 #5/#6 で確認した現行挙動であり本計画の変更対象外                                                                                                                                                                                                                                                                     |
| バンドル同期漏れ（`shared/src` だけ更新して dist が古い）                                       | CI で検出            | Step 2 で実装・テスト・build・sync・公開仕様を単一 PR に束ね、pre-commit / CI の `build:check` / `sync-shared:check` で fail-closed                                                                                                                                                                                       |

実測条件では観測されなかったリスク: **project config の `approval_policy` による非対話 run のハング**（#8。`approval_policy = "untrusted"` でも 11 秒で完了）。sandbox を明示していることが理由と推定されるが、sandbox 未指定との比較や他タスク条件では未検証のため、リスク自体は残す。

**実行時オーバーヘッド**: wrapper 側は argv 1 要素の追加のみでゼロ。参考として、不採用にした A 案の抽出処理は実測 0.005ms/回で、隣で既に払っている `codex mcp list --json` の子プロセス起動（実測 94ms）の 1/19,000 だった。どちらの案でも wrapper 側のコストは判断材料にならず、実効コストは worker 側の hook 実行時間が支配する。

## 9. 参考

- [issue #28](https://github.com/oubakiou/delegate-skills/issues/28)
- [spec.md](../design/spec.md) — 「Codex パスの起動」「セッション再利用（opt-in）」「observe JSON」「環境変数」
- [protocol-v1.md](../design/protocol-v1.md)
- [development.md](../design/development.md)
- [delegate-worker-mcp-config.archive.md](../archive/delegate-worker-mcp-config.archive.md) — MCP 注入の設計経緯
- [Codex config: project config files](https://developers.openai.com/codex/config-advanced)
- [Codex hooks: where Codex looks for hooks](https://developers.openai.com/codex/hooks)
