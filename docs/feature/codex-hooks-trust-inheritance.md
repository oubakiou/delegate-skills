# Codex worker での project hooks 有効化 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fcodex-hooks-trust-inheritance.md)

[issue #28](https://github.com/oubakiou/delegate-skills/issues/28) に対応する。Codex backend へ委譲した worker で、対象リポジトリの `.codex/hooks.json`（project hooks）が親セッションと同様に発火するようにする。完了後は [spec.md](../design/spec.md) の「Codex パスの起動」「セッション再利用（opt-in）」「observe JSON」「環境変数」章へ永続情報を移し、本ファイルは archive する。

有効化の手段は **A: 親の trust 状態を隔離 HOME へ透過** と **B: Codex CLI の hook trust bypass flag** の 2 案を併記し、Step 1 の実測で確定する（§5a）。両案は副作用の性質が異なるため、比較材料が揃うまで一方に寄せない。

## 1. 対応スコープ

| 要件                                                                      | 開始時の状態 | 完了条件                                                                                                                                                         | 最終状態 | 状態   |
| ------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| [MUST] Codex worker で対象リポジトリの project hooks が発火する           | 未           | 実 Codex への委譲で `.codex/hooks.json` の PostToolUse hook が実行されることを end-to-end で確認                                                                 | {}       | 未着手 |
| [MUST] 有効化手段 A / B を実測比較して確定する                            | 未           | Step 1 の実測表が §5a に反映され、採用案と不採用理由が確定している                                                                                               | {}       | 未着手 |
| [MUST] 採用案の副作用が把握され、文書化されている                         | 未           | A なら project config layer 全体（`.codex/config.toml` / rules / inline hooks）が worker に効くこと、B なら enabled hook が無条件実行されることを spec.md に明記 | {}       | 未着手 |
| [MUST] 有効化の範囲が対象リポジトリに限定される                           | 未           | A なら他リポジトリの `[projects]` / `[hooks.state]` エントリが持ち込まれないことを in-source test で固定。B なら `-C` 対象リポジトリ以外に効かないことを確認     | {}       | 未着手 |
| [MUST] follow-up / resumable lineage での挙動が定義され、テストされている | 未           | opt-out と親の再 trust が lineage にどう反映されるかが §5f で確定し、両方向の切り替えを契約テストで確認                                                          | {}       | 未着手 |
| [MUST] 前提が欠けても run が壊れない                                      | 未           | ユーザー設定不在・パース不能・該当エントリ不在で run が失敗せず、hooks 無効のまま継続することを確認                                                              | {}       | 未着手 |
| [MUST] MCP 注入と共存する（A 採用時）                                     | 未           | MCP あり / なし × 有効化あり / なし の 4 組み合わせ + stale config で期待どおりの `config.toml` になる                                                           | {}       | 未着手 |
| [SHOULD] 無効化する opt-out env を提供する                                | 未           | `DELEGATE_CODEX_INHERIT_TRUST=0` で hooks が有効化されないことを契約テストで確認                                                                                 | {}       | 未着手 |
| [SHOULD] 有効化の有無を observe JSON に記録する                           | 未           | `project_hooks` フィールド（§3.3、A / B 両案共通の形）が §3.3 の決定規則どおりに記録され、`read-json.sh` で読める                                                | {}       | 未着手 |
| [SHOULD] 公開仕様（spec.md / README 英日）が実装と一致する                | 未           | 「Codex パスの起動」節と環境変数表が更新され、英日の記載が対応している                                                                                           | {}       | 未着手 |

スコープ外:

- **`delegate-imagegen`（`wrapper-imagegen.ts`）**: [`wrapper-imagegen.ts:81`](../../shared/src/wrapper-imagegen.ts) が `--ignore-user-config` を明示しており、MCP setup 経路も共有していない。画像生成 worker はリポジトリのソース編集を行わないため project hooks を必要とせず、共通経路の変更が波及しないことも確認済み
- **ユーザー設定のグローバル hooks 定義（`[hooks]` 直下の hook 定義そのもの）**: issue の対象はリポジトリに置かれた project hooks。親のグローバル hooks を worker に持ち込むのは権限スコープの拡大であり、別途要否を判断する
- **project 側 inline hooks（`.codex/config.toml` の `[hooks]`）を A 案の allowlist 対象にすること**: 対象は `<repoRoot>/.codex/hooks.json` 由来の hook に限る（§3.2）。ただし A 案では project config layer 自体が有効化される副作用として inline hooks も読まれ得るため、Step 1 でその有無を実測し §5b に記録する
- **`trusted_hash` の wrapper 側再計算**: Codex 側のハッシュ入力仕様が公開仕様として確認できないため採らない（§5c）
- **Codex 以外の backend（Claude / Devin / Cursor）**: Claude 子プロセスは親の設定探索経路をそのまま使うため本 issue の症状がない。Devin / Cursor は hooks 相当の機構が異なるため別 issue で扱う

## 2. ベースライン / リファレンス

### 現行の隔離経路（調査で確定済み）

| 実装                                                                            | 挙動                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `setupCodexHome`（[wrapper-codex.ts:147](../../shared/src/wrapper-codex.ts)）   | 通常 run / resumable initial は `<workDir>/codex-home`、follow-up は検証済み `session_home` を返す                     |
| `copyCodexAuth`（同 234）                                                       | root の `auth.json` だけを atomic copy する                                                                            |
| `injectCodexMcp`（同 418）                                                      | MCP サーバーが 1 件以上あるときだけ `config.toml` を **上書き** 生成する。MCP 不在なら `config.toml` は作られない      |
| `recordFollowupMcp`（同 402、`setupCodexMcp` 同 435）                           | follow-up は既存 `config.toml` を **再生成せず再利用** し、サーバー名を observe に記録するだけ                         |
| 子プロセス起動（同 644-652）                                                    | cwd = `repoRoot`、env に `CODEX_HOME=<隔離 HOME>` / `TMPDIR=<workDir>/tmp` を上書き。`--ignore-user-config` は付けない |
| `codexHomePrune`（[wrapper-report.ts:391](../../shared/src/wrapper-report.ts)） | `DELEGATE_CODEX_HOME_PRUNE` の判定を直書きし、`config.toml` と `sessions` は常に残す                                   |

`CODEX_HOME` が差し替わっているため、ユーザー設定（`~/.codex/config.toml`）は worker から実質読まれない。

### 対象リポジトリの Codex 設定（実測）

`.codex/` には hooks 以外の project layer も存在する。**A 案はこれらをまとめて有効化する**（§5b）。

| ファイル                     | 内容                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.codex/config.toml`         | `approval_policy` / `approvals_reviewer` / `sandbox_mode` / `[features] hooks = true` / `[tui]` / `[shell_environment_policy]`（`set` に `DELEGATE_*_MODEL` を含む） |
| `.codex/hooks.json`          | PostToolUse hook（`.codex/hooks/run-vp-check-fix.ts`）                                                                                                               |
| `.codex/rules/default.rules` | project rules                                                                                                                                                        |

`[features] hooks = true` が **project 側** に存在するため、user 設定に `[features]` が無くても project trust だけで hooks feature が有効になり得る。Step 1 の実測はこの交絡を排除する必要がある（§4 Step 1）。

### 参照する既存実装

| 参照元                                                                                                                                                 | 本実装での扱い                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/delegate-mcp.ts`                                                                                                                           | **三段構成（抽出 → canonical → TOML 描画）と in-source test の書き方を踏襲**。ただし `mcpTomlServerNames` の行処理は独立した header scan に過ぎず、table state を持つ本実装より単純なので、パース方針はそのまま流用しない（§5e） |
| `mcpExtractCodexUser`（`codex mcp list --json` 経由）                                                                                                  | **同じ手段は使えない**。trust / hooks 状態を機械可読に出力する公開サブコマンドが確認できない（Step 1 で最終確認）                                                                                                                |
| `mcpRenderCodexToml`                                                                                                                                   | **描画方針を踏襲**。`JSON.stringify` によるキー / 値の quoting をそのまま使う                                                                                                                                                    |
| `codexHomePrune` の env 判定                                                                                                                           | 再利用可能な helper が無く直書きなので、共通 helper を新設して両者から使う（§3.3）                                                                                                                                               |
| Codex CLI v0.145.0 / [公式 config 仕様](https://developers.openai.com/codex/config-advanced) / [hooks 仕様](https://developers.openai.com/codex/hooks) | trusted project が project config / hooks / rules をまとめて有効化することの根拠。hook trust の bypass 手段は候補として存在情報があるだけで、正式なフラグ名・利用可否は Step 1 で確認する                                        |

## 3. 設計の中核

### 3.1 hooks 有効化手段の 2 案（Step 1 で確定）

|                       | A: trust 状態の透過                                                                                                         | B: hook trust bypass flag                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 手段                  | ユーザー `config.toml` から対象リポジトリ分の `[projects]` / `[hooks.state]` を allowlist 抽出し、隔離 `config.toml` へ書く | `codex exec` の argv に `--dangerously-bypass-hook-trust` 相当を追加する |
| 実装量                | TOML リーダ + 描画 + 合成（新規モジュール）                                                                                 | argv 1 行 + env gate                                                     |
| 有効化される範囲      | project config layer 全体（`.codex/config.toml` / rules / inline hooks / hooks.json）                                       | 対象リポジトリで enabled な hook すべて（trust 済みか否かを問わない）    |
| 信頼の出所            | 親が明示的に trust した内容だけ                                                                                             | wrapper が無条件に信頼する                                               |
| 親の trust 撤回の反映 | 反映される（透過元が消えるため）                                                                                            | 反映されない                                                             |
| hooks.json 更新時     | 親で再 trust するまで発火しない                                                                                             | 即座に発火する                                                           |

どちらも「hooks だけを有効化する」ことはできない。A は project layer 全体、B は hook trust 判定全体を対象にする。Step 1 で実測比較したうえで §5a に採用理由を確定させる。

以降の §3.2 / §3.3 は **A 案を採用した場合の設計**を記述する。B 案を採用する場合の差分は次のとおりで、§1 の要件・§6 のテスト・§8 のリスクも同じ条件分岐で読み替える。

| 項目                | A 案                                                      | B 案                                                                                         |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| §3.2 抽出モジュール | 必要                                                      | 不要（Step 2 が消える）                                                                      |
| Step 3 の変更範囲   | config 合成 + env gate + observe                          | argv 追加 + env gate + observe のみ                                                          |
| `config.toml`       | MCP 断片 + trust 断片を合成                               | 現行のまま（MCP 断片のみ）                                                                   |
| opt-out の効き方    | initial run のみ（lineage snapshot。§5f）                 | **run ごと**。argv は起動のたびに構成されるため follow-up でも当該 run の env がそのまま効く |
| 親の trust 撤回     | 次の initial run から反映                                 | 反映されない（trust を参照しないため）                                                       |
| observe             | `mode: 'inherited_trust'`、trust_level / entries を埋める | `mode: 'bypass'`、trust_level は `null`、entries は `0`                                      |

opt-out の効き方が案ごとに違う（A は lineage 固定、B は run ごと）点は、採用案の確定後に spec.md と README へそのまま書く。

### 3.2 抽出モジュール `shared/src/codex-user-config.ts`（A 案）

| 構成要素                                            | 内容                                                                                                                             | 配置 / 寿命                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `extractCodexProjectTrust(realCodexHome, repoRoot)` | ユーザー `config.toml` を読み、対象 repoRoot に紐づく allowlist エントリだけを canonical へ抽出する                              | 新規モジュール（正本 `shared/src/`） |
| `renderCodexProjectTrustToml(canonical)`            | canonical を `[projects."<path>"]` / `[hooks.state."<key>"]` / `[features]` の TOML 断片へ描画する                               | 同上                                 |
| `inspectCodexConfigTrust(configTomlPath)`           | **生成済み** `config.toml` に trust 断片が含まれるかを検査し、`CodexProjectTrust` を返す。follow-up の observe 算出に使う（§5f） | 同上                                 |
| `CodexProjectTrust` 型                              | `{ trustLevel: string \| null; hooksState: Record<string, string>; featuresHooks: boolean \| null }`                             | 同上（module 内 export）             |
| 行ベースの最小 TOML リーダ                          | テーブルヘッダ行と `key = "value"` 行だけを解釈する（下記の fail-soft 規約に従う）。抽出と検査で共用する                         | module private                       |

**allowlist**（これ以外は一切出力しない）:

| ユーザー設定側のキー                 | 抽出条件                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[projects."<path>"] trust_level`    | `<path>` が対象 repoRoot と正規化後に一致する。値は受理 enum に限る（暫定 `trusted` のみ。Step 1 の実測で確定し §3.2 と §6 に反映する）                                                          |
| `[hooks.state."<key>"] trusted_hash` | `<key>` が正規化済み `<repoRoot>/.codex/hooks.json:` で始まる（前方一致は source 部分の完全一致に限定し、nested source / inline hooks / `..` を含む key は拒否）。値は `sha256:<hex>` 形式に限る |
| `[features] hooks`                   | 値が boolean として読める                                                                                                                                                                        |

**fail-soft 規約**（誤読より「有効化しない」に倒す）。無効化の粒度を 3 段に分け、正常な設定が過剰に拒否されないようにする:

| 検出内容                                                                                                         | 倒し方                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **allowlist 外**のキー・テーブル（配列、複数行文字列、inline table、Codex 更新で増えた未知キーを含む）           | **無視**する。正当性は判定しない                                                                                                                                   |
| **抽出対象キー**の値が解釈できない（enum 外、hash 形式不一致、複数行 / inline table 表現、行が途中で切れている） | **そのキーだけ**を落とす。`trust_level` が落ちれば hooks は有効化されず、`hooks.state` の 1 エントリが落ちればその hook だけ発火しないので、いずれも安全側に倒れる |
| **抽出対象キーの重複**、または **allowlist 対象テーブルのヘッダ自体が不正**（閉じていない、quote が壊れている）  | **文書全体を空 canonical に倒す**。どの値が正なのか決められないため                                                                                                |

加えて:

- 未知・不正なテーブルヘッダに遭遇したら **current table を解除する**。直前のテーブルへ誤帰属させない
- ファイル不在・読み取り失敗・空ファイルは空 canonical を返し、throw しない
- CRLF、コメント行、末尾コメント、インデントを受け付ける

### 3.3 `wrapper-codex.ts` の `config.toml` 生成（A 案）

現行の「MCP があれば MCP だけを書く」を、「断片を集めて連結し、非空なら atomic replace、空なら既存を削除する」へ変える。

```
writeIsolatedCodexConfig(context, codexHome):        # follow-up 以外で呼ぶ
  fragments = []
  mcp = mcpExtractCodexUser(realCodexHome)                      # 既存
  if mcpHasServers(mcp): fragments.push(mcpRenderCodexToml(mcp))
  if envFlagEnabled(env, 'DELEGATE_CODEX_INHERIT_TRUST'):
    trust = extractCodexProjectTrust(realCodexHome, repoRoot)   # 新規
    if hasTrustEntries(trust): fragments.push(renderCodexProjectTrustToml(trust))
  if fragments is empty:
    rmSync(codexHome/config.toml, { force: true })   # stale trust を残さない
    return
  atomicWrite(codexHome/config.toml, fragments.join('\n'))
```

- **stale 対策**: 空断片時に既存ファイルを削除する。これがないと、事前に存在する home や同一 run dir への再 dispatch で、opt-out や親の trust 撤回が古いファイルによって無効化される
- **atomic replace**: 一時ファイルへ書いて rename する。partial write の `config.toml` を Codex に読ませない
- **follow-up**: §5f の判断に従う。`recordFollowupMcp` の役割は変えない。observe は親設定を再抽出せず、`inspectCodexConfigTrust(<session_home>/config.toml)` で **生成済み config を検査**して算出する（snapshot 契約を破らないため）
- **共通 env helper**: `envFlagEnabled(env, name)`（`'0'` / `'false'` / `'no'` を false、未設定を true）を `wrapper-common.ts` に新設し、`codexHomePrune` の直書き判定も同 helper へ寄せる（挙動不変のリファクタ）
- **observe フィールド**（既存 `mcp_config` と並置。A / B 両案で同じ名前・同じ形を使う）:

  ```
  project_hooks: {
    mode: 'inherited_trust' | 'bypass' | null,
    source: 'inherited' | 'inherited_from_lineage' | 'none' | 'disabled',
    trust_level: string | null,
    hooks_state_entries: number,
  }
  ```

  `read-json.sh .project_hooks.source` で読める。`mode` は採用案（A なら `inherited_trust`、B なら `bypass`）、無効時は `null`。

  `source` の決定規則:

  | 状況                                                                | `source`                 | `trust_level` / `hooks_state_entries` |
  | ------------------------------------------------------------------- | ------------------------ | ------------------------------------- |
  | opt-out（`DELEGATE_CODEX_INHERIT_TRUST=0`）                         | `disabled`               | `null` / `0`                          |
  | A 案 initial run で trust 断片を書いた                              | `inherited`              | 抽出値 / 抽出件数                     |
  | A 案 initial run で対象エントリ無し・ユーザー設定不在・読み取り失敗 | `none`                   | `null` / `0`                          |
  | A 案 follow-up で既存 config に trust 断片が **ある**               | `inherited_from_lineage` | 検査値 / 検査件数                     |
  | A 案 follow-up で既存 config が MCP のみ、または config 不在        | `none`                   | `null` / `0`                          |
  | B 案（initial / follow-up とも、当該 run の env が有効）            | `inherited`              | `null` / `0`                          |

  「config を再利用した」だけで `inherited_from_lineage` にはしない。MCP-only の lineage を誤って trust ありと記録しないため、必ず `inspectCodexConfigTrust` の結果で決める

## 4. 実装ステップ

### Step 1: (未着手) 有効化手段の実測比較と gating 仕様の確定

**交絡の排除**: 本リポジトリの `.codex/config.toml` は `[features] hooks = true` を持つため、これを使うと user 設定側 `[features]` の要否を判定できない。**project 側 `.codex/config.toml` を持たない最小検証リポジトリ**（`.temp/` 配下）で (a)-(d) を実測し、そのうえで project config ありの場合を別ケースとして確認する。

- A 案の実測: 隔離 HOME を手動で用意し `CODEX_HOME=<隔離> codex exec --sandbox danger-full-access -C <repo>` を起動して、project hooks の発火を確認する
  - (a) `config.toml` 空 / (b) `trust_level` のみ / (c) (b) + `trusted_hash` / (d) (c) + `[features] hooks = true`
  - trusted 時に project config layer の何が実効値になるか（`approval_policy`、`shell_environment_policy`、rules、inline hooks）を、CLI override（`--sandbox` / `-m`）との優先順位込みで確認する
- B 案の実測: `--dangerously-bypass-hook-trust` 相当のフラグ名・存在・挙動を `codex exec --help` と実行で確認し、trust 無しで hooks が発火するか、他に何が緩むかを確認する
- 共通確認:
  - repoRoot のパス表記（`-C` に渡す文字列 / realpath / 末尾スラッシュ）とユーザー設定側キーの表記が一致するか
  - `hooks.state` のキー形式が hooks.json 内容変更でどう変わるか、`trusted_hash` の値形式
  - trust / bypass 状態を出力する公開サブコマンドの有無（あれば §5d の判断が変わる）
  - 全 task type（explore / implement / chore / review）が同じ Codex wrapper を通るため、有効化が read-only 種別の挙動にも及ぶことの影響
- 実測結果を §2 / §3.1 / §5a / §5b に反映する。あわせて **§3.2 の受理 enum・hash 形式・allowlist を実測値で確定**し、対応するケースを §6 のテスト一覧へ追記する

成果物: 採用案の確定、hooks 発火に必要な最小キー集合、project layer 副作用の一覧

### Step 2: (未着手、A 案採用時のみ) 抽出・描画モジュールの実装

- `shared/src/codex-user-config.ts` に §3.2 の pure 関数を実装する（I/O は `readFileSync` 1 箇所に閉じ、パース・抽出・描画は文字列 → 文字列の pure 関数に分ける）
- 同ファイルの `if (import.meta.vitest)` ブロックに §6 の in-source test を追加する
- この Step は wrapper から未参照のまま単独でマージできる（`vp check` / `npm test` が緑になる粒度）

成果物: `shared/src/codex-user-config.ts` + in-source test

### Step 3: (未着手) 統合・テスト・同期・公開仕様（単一 PR）

Step 3 は分割しない。`shared/src` の変更は `npm run build` → `npm run sync-shared` を伴わないと契約テストが旧 dist を検証し（[`shared/delegate-codex.sh:16`](../../shared/delegate-codex.sh) は committed dist を実行する）、CI の `build:check` / `sync-shared:check` も落ちるため、以下は同一 commit にまとめる。

- `wrapper-codex.ts`: §3.3 の合成手順（A 案）または argv 追加（B 案）
- `wrapper-common.ts`: `envFlagEnabled` 新設と `codexHomePrune` の置き換え
- `observe-store.ts`: `project_hooks` 更新ヘルパ（§3.3 の決定規則を 1 箇所に閉じる）
- `scripts/delegate-wrapper-session.test.ts`: §6 の契約テスト
- `npm run build` → `npm run sync-shared`
- `docs/design/spec.md`:「Codex パスの起動」に有効化契約と副作用、「セッション再利用（opt-in）」に follow-up の扱いと opt-out の効く範囲、「observe JSON」に `project_hooks`、「環境変数」に `DELEGATE_CODEX_INHERIT_TRUST` を追記
- `README.md` / `README_ja.md`: Advanced settings の環境変数表に追加（英日で対応させる）

成果物: 緑の単一 PR（実装 + テスト + dist 同期 + 公開仕様）

### Step 4: (未着手) 実 Codex での end-to-end 検証

- project 側 `.codex/config.toml` を持たない検証用リポジトリと、PostToolUse で sentinel ファイルを書くだけの `.codex/hooks.json` を `.temp/` に用意する
- 親セッションで一度 trust させたうえで、`DELEGATE_IMPLEMENT_MODEL=gpt-5.6-luna` 等で微小な編集タスクを委譲し、sentinel が生成されることを確認する
- `DELEGATE_CODEX_INHERIT_TRUST=0` で発火しないことを確認する
- follow-up lineage で §5f の判断どおりに振る舞うことを確認する（opt-out の反映有無、親の再 trust の反映有無）
- 本リポジトリ（project config あり）でも 1 回委譲し、Step 1 で洗い出した副作用が実際の worker 挙動に与える影響を確認する
- 検証用ファイルは commit しない

成果物: §1 の MUST 要件（hooks 発火、lineage 挙動、副作用把握）の実測エビデンス

### Step 5: (未着手) spec.md 反映と archive 化

- 永続情報を spec.md へ移す（Step 3 で先行して書いた分の最終確認）
- 本ドキュメントを `docs/archive/codex-hooks-trust-inheritance.archive.md` にリネームする

成果物: spec.md 更新 + archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. hooks 有効化の手段（Step 1 の実測で確定）

| 候補                                              | 採用 | 理由                                                                                                                                        |
| ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A: 親の trust 状態を allowlist 透過               | 保留 | 信頼の出所が「親が明示的に trust した内容」に限られ、親の trust 撤回も伝播する。代償として project config layer 全体が worker に効く（§5b） |
| B: `--dangerously-bypass-hook-trust` 相当のフラグ | 保留 | 実装が argv 1 行で済み、hooks.json 更新後も再 trust 不要。代償として wrapper が hook を無条件に信頼し、親の trust 撤回が効かなくなる        |
| A + B の併用                                      | ✗    | 両方の副作用を同時に負う。どちらか一方で目的を満たせる                                                                                      |
| 隔離 `CODEX_HOME` をやめる                        | ✗    | auth 保護と session 分離という隔離の目的を失う。issue 側も隔離廃止は求めていない                                                            |

Step 1 の実測後、この表の採用列を確定させ、不採用理由を実測結果で裏づける。

### b. A 案を採る場合の副作用の扱い

trusted project では Codex が `.codex/config.toml`、project rules、project hooks をまとめて有効化する（[公式仕様](https://developers.openai.com/codex/config-advanced)）。本リポジトリの `.codex/config.toml` は `approval_policy` / `approvals_reviewer` / `shell_environment_policy`（`DELEGATE_*_MODEL` を含む）を設定しているため、**「hooks だけが有効になる」わけではない**。

| 候補                                                       | 採用 | 理由                                                                                                                                          |
| ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **必須の副作用として受け入れ、spec.md に明記する**         | ✓    | project layer は「そのリポジトリで作業するエージェント全員に効かせたい」設定であり、worker にも効くのが本来の意図。ただし暗黙にせず文書化する |
| project config layer を無効化しつつ hooks だけ有効にする   | ✗    | Codex にそのような分離手段が確認できない。可能なら Step 1 で判明するので、その場合は採用へ切り替える                                          |
| wrapper 側で approval / sandbox を明示的に固定して打ち消す | 保留 | Step 1 で CLI override が project config に勝つことを確認できれば不要。勝たない項目があれば、その項目だけ argv で固定する                     |

§1 の「新たな権限は生まれない」という当初の想定は誤りだったため撤回する。実際には worker の approval 挙動・shell 環境・rules が変化し得る。

### c. `trusted_hash` の扱い（A 案）

| 候補                                       | 採用 | 理由                                                                                                                                                                                     |
| ------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ユーザー設定から値をそのままコピーする** | ✓    | Codex 側のハッシュ入力仕様に依存しない。かつ「親が一度も trust していない hooks は worker でも動かない」という fail-safe な性質が自然に得られる                                          |
| wrapper が hooks.json から再計算する       | ✗    | 対象バイト列・正規化・キー構成が公開仕様として確認できず、Codex の実装変更で静かに壊れる。さらに「親が承認していない hooks を wrapper が勝手に信頼させる」ことになり、信頼の出所が変わる |

**互換性リスク**: `[hooks.state].trusted_hash` は公式 config reference に載らない内部表現であり、Codex 0.x の更新で形式が変わり得る。§8 のリスク表と Step 1 の互換性確認（`--strict-config` smoke）で扱う。

### d. trust 状態の取得手段（A 案）

| 候補                                                      | 採用 | 理由                                                                                                                                  |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **ユーザー `config.toml` を直接読み、allowlist 抽出する** | ✓    | MCP と違い状態を出力する CLI サブコマンドが確認できない。読む範囲を allowlist に限れば行ベースの最小リーダで足りる                    |
| `codex` サブコマンド経由で取得                            | ✗    | 該当する公開サブコマンドが確認できない。存在すれば MCP と同様にそちらが望ましい（Step 1 で最終確認する）                              |
| ユーザー `config.toml` を丸ごとコピーし MCP 部だけ上書き  | ✗    | `model` / `model_reasoning_effort` など委譲の指定と競合し得る設定まで持ち込む。何が worker に効くかが暗黙になる                       |
| `-c` CLI override で渡す                                  | ✗    | `[hooks.state."<path>:post_tool_use:0:0"]` のようにキーへ `/` と `:` を含むテーブルを dotted-path override で安全に表現できるか不明確 |

### e. TOML パースの倒し方（A 案）

| 候補                                                            | 採用 | 理由                                                                                                                                                   |
| --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **未知ヘッダで table state を解除し、§3.2 の 3 段階粒度で倒す** | ✓    | 誤帰属（未知テーブル配下のキーを直前テーブルの値として拾う）を構造的に防ぎつつ、allowlist 外キーの正当性は判定しないので、正常な設定を過剰に拒否しない |
| 曖昧さを検出したら常に文書全体を空に倒す                        | ✗    | `[features]` などに未知の配列 / inline table があるだけで hooks が静かに無効化される。既定 ON の機能が環境依存で働かなくなる                           |
| `delegate-mcp.ts` と同じく解釈できない行を単に無視する          | ✗    | `mcpTomlServerNames` はヘッダ行だけを見る独立 scan で、table state を持たない。同じ粒度を値の抽出に流用すると誤帰属が起きる                            |
| フル TOML パーサを依存として追加する                            | ✗    | バンドルは外部依存ゼロが前提（`shared/dist/delegate-cli.mjs`）。allowlist が数キーに限られるため釣り合わない                                           |

### f. follow-up / resumable lineage での有効化の更新（採用案で分岐）

現行の follow-up は既存 `config.toml` を再利用するため、そのままでは opt-out env も親の再 trust も lineage に反映されない。

| 候補                                                                       | 採用 | 理由                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **初回 run の snapshot として固定し、env と文書を initial-run 限定にする** | ✓    | 「follow-up は初回 run の隔離 config を再利用し、初回と同じ MCP サーバー集合を保つ」という既存契約（spec.md §7）と一貫する。trust も同じ lineage 不変量として扱い、変更したい場合は新規 lineage を張る |
| run ごとに trust 断片を再合成する                                          | ✗    | MCP 断片を別ファイルに保存して follow-up ごとに再合成する仕組みが要る。既存の「初回 config を再利用」契約とも矛盾し、変更範囲が follow-up 検証全体に及ぶ                                               |
| follow-up でも `config.toml` を丸ごと再生成する                            | ✗    | MCP サーバー集合が run 間で変わり得るようになり、既存契約を壊す                                                                                                                                        |

採用に伴う明記事項:

- `DELEGATE_CODEX_INHERIT_TRUST` は **initial run にのみ効く**。既存 lineage の trust を変えたい場合は新規 lineage を張る
- 親で hooks.json を更新し再 trust しても、既存 lineage の worker は古い hash のまま hooks が発火しなくなる。これを検知できるよう follow-up の observe には `project_hooks.source: 'inherited_from_lineage'` を記録する（判定は `inspectCodexConfigTrust` の結果で行う。§3.3）
- 上記 2 点を spec.md §7 と README の env 説明に書く

**B 案を採用する場合はこの判断が逆になる**。bypass flag は argv であり起動のたびに構成されるため、opt-out も有効化も **run ごとに当該 run の env が効く**（lineage snapshot ではない）。initial / follow-up で挙動が分かれないぶん説明は単純になるが、「lineage 内で挙動が変わり得る」点を spec.md §7 に明記する。§1 の完了条件・§6 の follow-up テスト期待値も、採用案に応じてどちらか一方を選ぶ。

### g. 環境変数名

| 候補                                       | 採用 | 理由                                                                                                                                   |
| ------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`DELEGATE_CODEX_INHERIT_TRUST`**         | ✓    | 既存の `DELEGATE_CODEX_HOME_PRUNE` と同じ `DELEGATE_<BACKEND>_<対象>` 系。B 案採用時も「hooks trust を有効にするか」の意味で流用できる |
| `CODEX_DELEGATE_INHERIT_HOOKS`（issue 案） | ✗    | 既存 env は `DELEGATE_` 前置が主流（`CODEX_DELEGATE_SANDBOX` は例外）。新規追加は多数派へ揃える                                        |

### h. 既定で有効にする / opt-in にする

| 候補                                    | 採用 | 理由                                                                                                                                                                        |
| --------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **既定 ON + opt-out env**               | ✓    | project hooks は「そのリポジトリで作業するエージェント全員に効かせたい」防御であり、委譲経路だけ素通りするのは防御の破れ。opt-out は §5b の副作用が問題になったときの退避路 |
| opt-in env（issue の `..._HOOKS=1` 案） | ✗    | 既定で壊れたままになり、issue の実害（未整形コードの commit）が「設定を知っている人だけ回避できる」状態で残る                                                               |
| 無効化手段を持たない                    | ✗    | §5b の副作用が問題になったときの退避路が無くなる                                                                                                                            |

### i. 抽出時のパス一致判定（A 案）

| 候補                                                        | 採用 | 理由                                                                                                                                   |
| ----------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`path.resolve` + 末尾スラッシュ除去で正規化して比較する** | ✓    | `-C` に渡す repoRoot とユーザー設定側キーの表記ゆれ（末尾スラッシュ、相対表記、`..` を含む表記）を吸収でき、実装コストも小さい         |
| `realpathSync` まで解決して比較する                         | ✗    | symlink 経由で開いたワークツリーでは Codex 自身がどちらの表記でキーを作るかに依存する。Step 1 の実測で必要と判明したら採用へ切り替える |
| 文字列完全一致                                              | ✗    | 末尾スラッシュ差だけで有効化が静かに失われ、原因が分かりにくい                                                                         |

### j. 生成 `config.toml` の書き込み方（A 案）

| 候補                                              | 採用 | 理由                                                                                                                              |
| ------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| **非空なら atomic replace、空なら既存を削除する** | ✓    | 事前に存在する home や同一 run dir への再 dispatch で stale trust が残り、opt-out や trust 撤回が無効化されるのを防ぐ。冪等になる |
| 非空なら上書き、空なら何もしない（当初案）        | ✗    | 空断片時に既存ファイルが残るため冪等でない。opt-out が stale file に負ける                                                        |
| 既存 `config.toml` へ追記する                     | ✗    | resumable / follow-up と絡むと重複追記の可能性がある                                                                              |

## 6. テスト方針

### 自動テスト（A 案採用時）

- `shared/src/codex-user-config.ts` の in-source test
  - 正常系: 対象 repoRoot の `trust_level` と `hooks.state` エントリを抽出し、期待どおりの TOML 断片へ描画する
  - 正常系: 複数の `hooks.state` エントリ（複数 event / 複数 index）をすべて拾う
  - 正常系: `[features] hooks = true` があれば拾う / 無ければ出力に含めない
  - 境界: 他リポジトリの `[projects]` / `[hooks.state]` を除外する
  - 境界: `model` / `[tui.*]` など allowlist 外のキーを一切出力しない
  - 境界: repoRoot の末尾スラッシュ差、相対表記の正規化
  - 境界: `hooks.state` の key が nested source / inline hooks（`.codex/config.toml:...`）/ `..` を含む場合に **拒否**する
  - 境界: `trust_level` が未知 enum、`trusted_hash` が `sha256:<hex>` 形式でない場合に拒否する
  - 異常系: ファイル不在 / 空 / 読めない → 空 canonical、throw しない
  - 異常系: 未知テーブルヘッダの直後に `trust_level` 相当の行がある → 誤帰属しない
  - 異常系: CRLF、コメント行、途中で切れたファイルで throw しない
  - fail-soft 粒度（§3.2 の 3 段を 1 ケースずつ固定する）
    - allowlist 外の配列 / 複数行文字列 / inline table / 未知キーがある → **無視**され、対象キーは通常どおり抽出される（過剰拒否しない）
    - 抽出対象キーの値が enum 外 / hash 形式不一致 / inline table 表現 → **そのキーだけ**落ち、他のキーは残る
    - 抽出対象キーの重複、または allowlist 対象テーブルのヘッダが壊れている → **文書全体が空 canonical**
  - 検査: `inspectCodexConfigTrust` が trust 断片あり / MCP のみ / ファイル不在をそれぞれ正しく判定する
  - 描画: パスに `"` / `\` を含むキーが正しく escape される
  - 描画: 出力断片が単体で TOML として妥当（テスト内の最小パーサまたは exact golden で確認）
- `scripts/delegate-wrapper-session.test.ts` の契約テスト
  - MCP あり × trust あり → 両断片を含む `config.toml`（**exact golden** で assert し、substring では済ませない）
  - MCP なし × trust あり → trust 断片のみ（従来は非生成だった組み合わせ）
  - MCP あり × trust なし → 既存テストと同一出力（回帰チェック）
  - MCP なし × trust なし → `config.toml` を生成しない（既存テスト維持）
  - **stale**: 事前に trust 入り `config.toml` を置いた home で opt-out / 親設定消失 → ファイルが削除される
  - **再 dispatch**: 同一 run dir へ 2 回 dispatch しても結果が同一（冪等）
  - `DELEGATE_CODEX_INHERIT_TRUST=0` → trust 断片を書かない
  - 親 `CODEX_HOME` に `config.toml` が無い → run が成功し trust 断片なし
  - **follow-up（trust あり lineage）**: config が再利用され、observe が `inherited_from_lineage` になる
  - **follow-up（MCP のみの lineage）**: config は再利用されるが observe は `none` になる（「再利用した」だけで inherited と記録しない）
  - **follow-up × opt-out**: 既存 lineage に `DELEGATE_CODEX_INHERIT_TRUST=0` を指定しても config が変わらない（§5f の採用結果を仕様として固定する）
  - observe JSON の `project_hooks.mode` / `.source` / `.trust_level` / `.hooks_state_entries` が §3.3 の決定規則どおりになる
- `envFlagEnabled` の in-source test（`'0'` / `'false'` / `'no'` / 未設定 / 空文字 / その他）と、`codexHomePrune` の既存テストが緑のままであること

### 自動テスト（B 案採用時）

- `scripts/delegate-wrapper-session.test.ts` の argv assert に bypass flag の有無を追加
  - 既定 ON → flag あり / `DELEGATE_CODEX_INHERIT_TRUST=0` → flag なし
  - **follow-up でも当該 run の env が効く**（初回 ON → follow-up で opt-out すると flag が消える）。§5f の B 案分岐を仕様として固定する
- observe JSON の `project_hooks.mode` が `bypass`、`source` が `inherited` / `disabled`、`trust_level` が `null`、`hooks_state_entries` が `0` になる
- `config.toml` 生成まわりの既存テストは変更しない（回帰チェックとして緑のまま）
- `envFlagEnabled` の in-source test は A 案と同じものを追加する

### 手動確認

- [ ] `vp check`
- [ ] `npm test`
- [ ] `npm run build` → `npm run sync-shared` → `npm run sync-shared:check`
- [ ] Step 1 の実測（最小検証リポジトリでの A/B 比較、project config layer の実効値、`--strict-config` smoke）
- [ ] Step 4 の end-to-end（sentinel hook 発火 / opt-out で非発火 / follow-up lineage の挙動 / 本リポジトリでの副作用確認）
- [ ] `README.md` / `README_ja.md` / `spec.md` の記載と実装が一致している

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 採用案の副作用（A: project config layer 全体の有効化 / B: enabled hook の無条件実行）が spec.md に明記されている
- 既存の MCP 注入・auth lifecycle・prune・session reuse の挙動が変わっていない（`scripts/delegate-wrapper-session.test.ts` が緑）
- 新規挙動に対応する in-source test と契約テストがある
- `npm run sync-shared:check` / `vp check` / `npm test` が通る
- `spec.md` / `README.md` / `README_ja.md` が実装と一致している

## 8. 想定リスクと回避策

| リスク                                                                                         | 回避策                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 案で project config layer 全体が有効化され、worker の approval / shell 環境 / rules が変わる | Step 1 で CLI override との優先順位と実効値を実測し、spec.md に副作用として明記する。打ち消しが必要な項目は argv で固定する（§5b）                          |
| A 案の副作用が read-only 種別（explore / review）にも及ぶ                                      | 全 task type が同じ Codex wrapper を通ることを Step 1 の確認項目に含め、Step 4 で少なくとも 1 種別を実測する                                                |
| B 案で trust していない hook まで無条件実行される                                              | §5a の実測比較で明示的に比較し、採用時は spec.md に「wrapper が hook を無条件に信頼する」と明記する                                                         |
| 行ベース TOML リーダが利用者の複雑な `config.toml` を誤読する                                  | 未知ヘッダで table state を解除し、§3.2 の 3 段階粒度で倒す（§5e）。malformed / CRLF / comment / truncated をテストする                                     |
| fail-soft が過剰に働き、正常な設定でも hooks が静かに無効化される                              | allowlist 外キーの正当性は判定せず無視する。文書全体を空にするのは対象キーの重複と対象テーブルヘッダ破損のみに限定し、3 段階を個別にテストする（§3.2 / §6） |
| `trusted_hash` が内部表現のため Codex 更新で静かに非互換化する                                 | 形式（`sha256:<hex>`）を検証して不一致なら有効化しない。Step 1 に `--strict-config` smoke を含め、observe に `project_hooks` を残して診断可能にする         |
| follow-up lineage で opt-out / 再 trust が反映されない（A 案）                                 | §5f の採用結果（initial-run 限定）を spec.md §7 と README に明記し、契約テストで固定する。follow-up observe に `inherited_from_lineage` を記録する          |
| B 案では逆に lineage 内で挙動が変わる（run ごとに env が効く）                                 | §5f の B 案分岐を spec.md §7 に明記し、follow-up での flag 付け外しを argv assert で固定する                                                                |
| stale `config.toml` が opt-out や trust 撤回を無効化する                                       | 空断片時は既存ファイルを削除する（§5j）。stale 事前配置と再 dispatch をテストする                                                                           |
| 親設定の意図しない情報（他リポジトリのパス等）が隔離 HOME に漏れる                             | allowlist を `<repoRoot>/.codex/hooks.json:` の source 完全一致に限定し、除外を in-source test で固定する（§3.2）                                           |
| Step 1 の実測が project 側 `[features] hooks = true` に交絡する                                | project `.codex/config.toml` を持たない最小検証リポジトリで実測し、project config ありは別ケースとして確認する（§4 Step 1）                                 |
| バンドル同期漏れ（`shared/src` だけ更新して dist が古い）                                      | Step 3 で実装・テスト・build・sync・公開仕様を単一 PR に束ね、pre-commit / CI の `build:check` / `sync-shared:check` で fail-closed                         |

## 9. 参考

- [issue #28](https://github.com/oubakiou/delegate-skills/issues/28)
- [spec.md](../design/spec.md) — 「Codex パスの起動」「セッション再利用（opt-in）」「observe JSON」「環境変数」
- [protocol-v1.md](../design/protocol-v1.md)
- [development.md](../design/development.md)
- [delegate-worker-mcp-config.archive.md](../archive/delegate-worker-mcp-config.archive.md) — MCP 注入の設計経緯（本計画が構成を踏襲する）
- [Codex config: project config files](https://developers.openai.com/codex/config-advanced) — trusted project が有効化する範囲
- [Codex hooks: where Codex looks for hooks](https://developers.openai.com/codex/hooks) — hook source の種類と trust
