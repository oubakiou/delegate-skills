# worker MCP 継承の統一 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdelegate-worker-mcp-config.md)

親エージェントの MCP 設定を 4 backend（Claude / Codex / Devin / Cursor）の worker が既定で利用できるように統一する。現状は backend ごとに MCP 到達性がバラバラ（Claude 通常 run と Devin は暗黙継承、Codex は不達、Cursor は不確実）で、README も「MCP 調査は Claude 系推奨」とする根拠になっている非対称を解消する。

完了後は `docs/design/spec.md` / README / README_ja に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                                        | 開始時の状態                                                                                                                    | 完了条件                                                                                                                                          | 最終状態                                                                                                                                            | 状態 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [MUST] 既定で親の MCP 設定が 4 backend の worker から使える | Claude 通常 run と Devin は実設定共有で暗黙継承。Codex は `--ignore-user-config` で不達。Cursor は config 隔離 + 未承認で不確実 | 4 backend とも既定で親の user スコープ MCP サーバー定義が worker に届く（Claude resumable / followup を含む）。到達性を Step 1 の live PoC で確認 | Claude 通常 run / Devin は共有継承、Claude resumable・followup / Codex / Cursor は wrapper が親設定から抽出・注入。live PoC + 実 CLI E2E で到達確認 | 達成 |
| [SHOULD] 既存の session reuse（resumable / followup）と両立 | Claude resumable の隔離ホームでは user MCP が不達                                                                               | resumable 初回にも継承注入が適用され、followup は初回と同じ MCP 構成を使い続ける                                                                  | resumable 初回に session home へ生成・注入し、followup は初回生成物を再利用（Claude / Codex。Cursor は毎 run 再生成）。live E2E で確認              | 達成 |
| [SHOULD] MCP 構成の適用結果を observe JSON に記録する       | 記録なし                                                                                                                        | `run_context` 相当に MCP 構成の出所（`shared` / `injected` / `none`）を記録                                                                       | observe JSON トップレベル `mcp_config: {source, servers}`（サーバー名のみ、定義本体なし）                                                           | 達成 |

スコープ外:

- **設定ホームの常時隔離の拡大**: Claude 通常 run / Devin の設定ホームは現状どおり共有のまま。Codex（`CODEX_HOME`）と Cursor（`CURSOR_CONFIG_DIR`）の既存隔離も現状維持（§5-a）
- **`delegate_settings.json` による MCP の明示構成**: 継承の統一だけを行い、worker 専用の MCP 構成機構は導入しない。worker から見せる MCP を変えたい場合は親側の MCP 設定を調整する運用とする（§5-e）
- **pre-warm（非同期の事前構築）**: 既存隔離の構築オーバーヘッドは auth 1 ファイルのコピーで実測ミリ秒オーダーと小さく、本計画で加わる MCP 設定生成も小さなファイル書き出しのみ。dispatch 時の同期処理で足りる
- **skill のコピー・構成**: worker は同一 working tree の project スコープ skill（`.claude/skills` / `.agents/skills` 等）を各 CLI の native 発見で利用する。従来どおりで変更しない（§5-g）
- **working tree の隔離（git worktree / 別 workspace）**: 別計画で扱う
- **worker の MCP 書き込み制御の強化**: read-only 系 task の「MCP は読み取り系ツールのみ」は従来どおりプロンプトレベル制約を維持する。技術的強制は本計画の対象外

## 2. ベースライン / リファレンス

| 参照元 / 現行実装                                                          | 本実装での扱い                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `shared/delegate-claude.sh`                                                | 通常 run は変更なし（実ホーム共有で MCP 到達済み）。resumable / followup に `--mcp-config` 注入を追加 |
| `shared/delegate-codex.sh`（`CODEX_HOME` 隔離 + `--ignore-user-config`）   | 隔離 `CODEX_HOME` に `config.toml` を生成して MCP を注入し、`--ignore-user-config` を撤去（§5-c）     |
| `shared/delegate-devin.sh`                                                 | 変更なし（実設定共有で到達済み。Step 1 で実測確認のみ）                                               |
| `shared/delegate-cursor.sh`（`CURSOR_CONFIG_DIR` 隔離）                    | 隔離 config dir への `mcp.json` 生成と `--approve-mcps` 付与を追加（追従・承認効果は PoC 確認済み）   |
| `scripts/delegate-wrapper-session.test.ts`（fake CLI による wrapper test） | MCP 設定生成・フラグ付与のテスト手法として踏襲                                                        |
| `shared/observe-json.sh`（`run_context` helper）                           | MCP 構成の出所（`shared` / `injected` / `none`）の記録 helper を追加                                  |

確認済みの CLI 側事実（出典は §9。注入経路の live 実測は §4 Step 1 の PoC 記録）:

| Backend | MCP 設定の格納場所と注入手段                                                                                            | 現状の worker からの到達性                                                                                                          | 注入経路の実測（Step 1 PoC）                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude  | user: `~/.claude.json` の `mcpServers` / project: `.mcp.json` / フラグ: `--mcp-config`                                  | 通常 run は到達（実ホーム共有）。resumable / followup は隔離ホームのため user MCP 不達                                              | `--mcp-config` は `-p` 単独 / 隔離 `CLAUDE_CONFIG_DIR` + `--session-id` / `--resume` のすべてで到達確認               |
| Codex   | `CODEX_HOME/config.toml` の `mcp_servers.*`（project は trusted 時 `.codex/config.toml`）                               | 不達（`--ignore-user-config` が user config を読まない）                                                                            | `--ignore-user-config` なし + 隔離 `CODEX_HOME/config.toml` の `mcp_servers` で到達確認（`--ephemeral` 併用でも有効） |
| Devin   | user: `~/.config/devin/config.json` / project: `.devin/config.json` / local: `.devin/config.local.json` の `mcpServers` | 到達（`devin -p` が user config の `mcpServers` を既定継承することを実測確認）                                                      | 既定継承のため注入不要（変更なしで確定）                                                                              |
| Cursor  | project: `.cursor/mcp.json` / global: `~/.cursor/mcp.json`。headless 承認は `--approve-mcps`                            | 隔離 `CURSOR_CONFIG_DIR` 配下の `mcp.json` に追従することを実測確認。未承認サーバーは spawn すらされず、`--approve-mcps` 付与で到達 | 隔離 config dir への `mcp.json` 生成 + `--approve-mcps` で到達確認。フラグなしの対照実験で不達を確認                  |

## 3. 設計の中核

### 3.1 `shared/delegate-mcp.sh`

| 構成要素                 | 内容                                                                                                                                     | 配置 / 寿命                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `shared/delegate-mcp.sh` | 親設定からの `mcpServers` / `mcp_servers` 抽出と、backend 形式（Codex TOML / Cursor JSON / Claude mcp-config JSON）への変換（jq 関数群） | `shared/` 正本 → 各 skill へ sync |
| 生成 MCP 設定ファイル    | 注入が必要な backend でのみ `$RUN_DIR` 配下に生成（下表）。run 終了後は既存の run dir retention に従う                                   | run dir と同寿命                  |

### 3.2 backend 別の MCP 到達経路

方針: **既に届いている経路は触らず、不達の経路にだけ親設定から抽出した MCP を注入する**（§5-d）。

| Backend | 対応                                                                                                                                                          | observe 記録          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Claude  | 通常 run: 変更なし（実ホーム共有で自然継承）。resumable / followup: 親 `~/.claude.json` から `mcpServers` を抽出した mcp-config JSON を `--mcp-config` で注入 | `shared` / `injected` |
| Codex   | 親 `config.toml` から `mcp_servers.*` を抽出し、隔離 `CODEX_HOME/config.toml` を生成。`--ignore-user-config` は撤去（§5-c）                                   | `injected`            |
| Devin   | 変更なし（実設定共有で自然継承）                                                                                                                              | `shared`              |
| Cursor  | 親の global `mcp.json` から抽出した `mcp.json` を隔離 `CURSOR_CONFIG_DIR` へ生成し、`--approve-mcps` を付与（追従・承認効果は PoC 確認済み）                  | `injected`            |

親側に MCP 設定が無い場合は何も生成せず `none` を記録する（生成物ゼロ・フラグ付与なしで従来挙動と一致）。

## 4. 実装ステップ

### Step 1: (完了) PoC による未確定挙動の確定

実モデルを呼ぶ live 実行で以下を確定させた（2026-07-18 実施。全項目とも到達を確認し、§8 へ移す「効かない経路」は無し）:

- Claude: `--mcp-config` が `-p` で効くこと。resumable の隔離ホームでも mcp-config 注入で MCP が届くこと → **確認**
- Codex: `--ignore-user-config` 撤去 + 生成 `config.toml` で `mcp_servers` が `codex exec` に効くこと → **確認**
- Devin: `-p` で user config の `mcpServers` が実際に使えること（既定継承の実測） → **確認**
- Cursor: 隔離 `CURSOR_CONFIG_DIR` 配下 `mcp.json` の追従有無と `--approve-mcps` の効果 → **追従する / フラグ必須と確認**

#### PoC 記録（2026-07-18）

手法: 引数のトークン文字列を `get_poc_token` ツールで返す最小 stdio MCP サーバー（node、newline-delimited JSON-RPC）を backend ごとに別トークンで登録し、「ツールを呼びトークンだけを出力せよ」と headless 実行。stdout のトークン一致とサーバー側受信ログ（`initialize` → `tools/list` → `tools/call`）の両方で到達を判定した。

| Backend | CLI バージョン          | 実行形（wrapper の実行形に合わせた）                                                                                                            | 結果                                                                                              |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude  | claude 2.1.195          | ① `-p --mcp-config --no-session-persistence`（実ホーム） ② 隔離 `CLAUDE_CONFIG_DIR`（credentials のみ）+ `--session-id` ③ 同ホームで `--resume` | ①②③ すべて到達。②で session ファイルも生成され、③の followup でも同じ注入構成で到達               |
| Codex   | codex-cli 0.144.1       | 隔離 `CODEX_HOME`（auth.json コピー + 生成 `config.toml`）で `codex exec --ephemeral --json`、`--ignore-user-config` なし                       | 到達（`--ephemeral` 併用でも `mcp_servers` は有効）                                               |
| Devin   | devin 3000.1.27         | `~/.config/devin/config.json` に `mcpServers` を一時追加して `devin -p --permission-mode dangerous`（隔離なし・注入なし）                       | 到達（user config を既定継承）                                                                    |
| Cursor  | cursor-agent 2026.07.09 | 隔離 `CURSOR_CONFIG_DIR`（cli-config.json コピー + 生成 `mcp.json`）で `cursor-agent -p --trust --force --approve-mcps`                         | 到達。対照実験（`--approve-mcps` なし）ではサーバーが spawn されず不達 → 注入時のフラグ付与は必須 |

環境上の注意（本計画のスコープ外の finding）: PoC 環境では `agent` コマンド名が Grok Build TUI（`~/.grok/bin/agent`）に衝突しており、`delegate-cursor.sh` の `command -v agent` が Cursor agent CLI 以外を解決し得る。PoC は `cursor-agent` バイナリ直接呼び出しで実施した。コマンド名衝突への対処が必要なら別 issue として起票する。

成果物: §2 の表の「未確認 / 見込み」を解消した確定仕様（本ドキュメント更新済み）

### Step 2: (完了) `shared/delegate-mcp.sh`

- 親設定からの `mcpServers` / `mcp_servers` 抽出と backend 形式変換を実装
- `scripts/delegate-mcp.test.ts` に抽出（設定なし / 空 / 通常）と変換形（Codex TOML / Cursor JSON / Claude mcp-config JSON）の shell test を追加

成果物: 抽出と変換の単一実装とテスト

### Step 3: (完了) wrapper 統合

- Claude（resumable / followup）・Codex・Cursor の wrapper に MCP 設定の生成・注入を追加（§3.2 の表のとおり。Claude 通常 run と Devin は無変更）
- Codex の `--ignore-user-config` を撤去、Cursor に `--approve-mcps` を付与（PoC 結果次第）
- observe JSON に MCP 構成の出所（`shared` / `injected` / `none`）を記録（`shared/observe-json.sh` helper 追加）
- `scripts/delegate-wrapper-session.test.ts` を更新（backend ごとの生成物とフラグ、親設定なし時に生成・付与が無いこと、followup が初回と同じ構成を使うこと）

成果物: 4 backend の MCP 到達の統一（実装済み。fake CLI テストに加え、staged 親ホーム + 実 CLI での live E2E で Claude resumable の注入と followup の初回構成再利用を確認済み）

### Step 4: (完了) ドキュメント反映と archive 化

- README / README_ja: 「How it works」の「Web / MCP 調査は Claude 系推奨」の記載を新しい到達性に合わせて更新
- `docs/design/spec.md` へ永続仕様を移す。`delegate-explore` SKILL.md の「この skill が MCP 設定を注入することはない」「確実性が要る Web / MCP 調査には使わない」を新仕様に合わせて更新し `npm run sync-shared`
- 本ドキュメントを `docs/archive/delegate-worker-mcp-config.archive.md` へリネーム（ユーザー確認済み）

成果物: 公開仕様と実装の一致

## 5. 設計判断

### a. 設定ホームの常時隔離の扱い

| 候補                                                 | 採用 | 理由                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **現状維持（隔離は Codex / Cursor の既存実装のみ）** | ✓    | 隔離拡大の主目的だった skill の絞り込みが、Codex / Devin の `~/.agents/skills`（HOME 依存）を制御できず実現不能。残る効果に対して Claude 通常 run の暗黙継承（MCP / user skill）を壊すコストが上回る |
| 4 backend とも常時隔離                               | ✗    | skill 制御が成立しない以上、MCP 到達の統一だけなら注入のみで達成でき、隔離ホーム構築や pre-warm の複雑さが割に合わない                                                                               |
| Devin にのみ隔離を追加                               | ✗    | 同上。`--config` 単体では auth / セッション状態の分離も不完全（部分隔離）                                                                                                                            |

### b. MCP の注入方式（注入が必要な backend）

| 候補                                               | 採用 | 理由                                                                                                                                    |
| -------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **backend 形式の設定ファイル生成 + フラグ / 配置** | ✓    | 注入が必要な 3 経路（Claude resumable / Codex / Cursor）すべてに設定ファイル経由の注入経路がある。生成物は run dir 内で親設定を汚さない |
| 親設定ファイルの直接編集                           | ✗    | 親の設定を worker 都合で書き換えるのは論外（並行 run・ユーザー作業と衝突）                                                              |
| フラグのみで注入                                   | ✗    | Claude には `--mcp-config` があるが、Codex / Cursor は設定ファイル経由のみで統一不能                                                    |

### c. Codex `--ignore-user-config` の扱い

| 候補                                                        | 採用 | 理由                                                                                                |
| ----------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| **撤去し、隔離 `CODEX_HOME/config.toml` を wrapper が生成** | ✓    | 読む config が wrapper 生成物になるため、フラグの目的（ユーザー設定の混入防止）は隔離側で担保される |
| 維持し、MCP を `-c mcp_servers.*` で個別注入                | ✗    | サーバー定義の TOML 値をシェル引数で組み立てることになり、エスケープ事故と可読性の問題が大きい      |

### d. 既定継承の実現方法

| 候補                                              | 採用 | 理由                                                                                                    |
| ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| **既に届く backend は触らず、不達の経路だけ注入** | ✓    | Claude 通常 run / Devin は実設定共有で今日も動いている。動いている経路を作り直すのはリスクだけ増える    |
| 全 backend で抽出 → 注入に統一                    | ✗    | 実装は対称になるが、Claude 通常 run の project `.mcp.json` / managed 設定との相互作用を壊すリスクを負う |

### e. MCP の明示構成（`delegate_settings.json`）の扱い

| 候補                                                       | 採用 | 理由                                                                                                                           |
| ---------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| **導入しない（継承の統一のみ）**                           | ✓    | worker から見せる MCP を変えたいニーズは親側の MCP 設定の調整で足りる。設定ファイル・env・fail-closed 検証の導入コストを省く   |
| `DELEGATE_SETTINGS_FILE` + `delegate_settings.json` を導入 | ✗    | スキーマ設計・検証・テスト・ドキュメントの維持費に対して、現時点で明確な利用場面がない。必要になった時点で別計画として起票する |

### f. MCP 継承の抽出方法（注入が必要な backend）

| 候補                                                             | 採用 | 理由                                                                         |
| ---------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| **親設定から `mcpServers` / `mcp_servers` のみ jq / 変換で抽出** | ✓    | セッション状態・プロジェクト履歴・無関係設定を生成物へ持ち込まない           |
| 親設定ファイルの丸ごとコピー                                     | ✗    | Claude `~/.claude.json` 等は履歴・状態を含み、生成物が肥大し漏えい面も広がる |

### g. skill の扱い

| 候補                                               | 採用 | 理由                                                                                                                                     |
| -------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **project スコープのみに依拠（コピー・構成なし）** | ✓    | 子は同一 working tree で project skill を native 発見できており、現状で機能している。worker に使わせたい skill は project スコープへ配置 |
| user スコープ skill のコピー継承・絞り込み構成     | ✗    | Codex / Devin の `~/.agents/skills`（HOME 依存）を制御できず、4 backend で挙動が揃わない                                                 |

## 6. テスト方針

### 自動テスト

- `scripts/delegate-mcp.test.ts`（新規）
  - 親設定からの抽出: 設定ファイルなし / `mcpServers` なし / 通常ケース
  - 正準 `mcpServers` → Codex TOML / Cursor JSON / Claude mcp-config JSON 変換の形
- `scripts/delegate-wrapper-session.test.ts`（更新、fake CLI）
  - Codex / Cursor / Claude(resumable) で生成される MCP 設定ファイルの内容と CLI フラグ（`--mcp-config` / `--approve-mcps`、Codex の `--ignore-user-config` 不在）を検証
  - Claude 通常 run / Devin で余計な生成・フラグ付与をしないこと
  - 親設定に MCP が無い場合に生成物ゼロ・フラグ付与なしで従来挙動と一致すること
  - resumable 初回に注入が適用され、followup が初回と同じ構成を使うこと
  - observe JSON に MCP 構成の出所が記録されること

### 手動確認

- [x] Step 1 PoC 項目（実 CLI での MCP 到達、backend 4 種。§4 Step 1 の PoC 記録を参照）
- [x] `npm run sync-shared:check` / `vp check` / `vp test`（セルフレビュー指摘対応後の最終確認で全パス、132 テスト）
- [x] README / README_ja の公開仕様と実装が一致している

## 7. 受け入れ基準

- §1 の MUST 要件を満たす
- 既存の delegate 実行（全 skill × 4 backend）が親側に MCP 設定が無い環境でも従来どおり完走する
- session reuse（resumable / followup）の既存テストが通る
- 新規挙動（継承注入）に対応するテストがある
- `npm run sync-shared:check` が通る（生成コピーの直接編集なし）
- README / README_ja / spec.md / 各 SKILL.md が実装と一致している

## 8. 想定リスクと回避策

| リスク                                                                                            | 回避策                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Cursor の `mcp.json` が `CURSOR_CONFIG_DIR` に追従しない~~（解消）                              | Step 1 PoC で追従を実測確認済み（cursor-agent 2026.07.09）。古い CLI で追従しない場合は従来どおり global 不達に留まるだけで、skill 側は従来どおり動く                  |
| `--ignore-user-config` 撤去により Codex worker の挙動が user 設定に影響される                     | 読ませる config は wrapper 生成物のみ（隔離 `CODEX_HOME`）なので、実際に混入する経路はない。生成 config に `mcp_servers` 以外を書かないことをテストで固定              |
| MCP 継承の統一で Codex / Cursor worker にも攻撃面（prompt injection 経由の MCP 呼び出し）が広がる | Claude backend の現状と同等の面に揃うだけであり、read-only 系 task のプロンプト制約は維持。worker に見せたくないサーバーは親設定側で管理する運用を README に明記       |
| MCP サーバー定義に含まれる認証情報（env の token 等）が run dir の生成物に複製される              | 生成物は run dir 内に限定し、`DELEGATE_RUN_RETENTION_DAYS` による掃除対象であることを明記。observe JSON にはサーバー名のみ記録し定義本体は書かない                     |
| `--approve-mcps` の一括承認が意図しないサーバーまで有効化する（Cursor）                           | 注入する `mcp.json` は wrapper 生成物（親から抽出したサーバーのみ）で、承認対象はその範囲に限られる。PoC の対照実験で未承認サーバーは spawn 自体されないことも確認済み |

## 9. 参考

- [docs/design/spec.md](../design/spec.md) / [docs/design/development.md](../design/development.md)
- 既存実装: `shared/delegate-claude.sh` / `shared/delegate-codex.sh` / `shared/delegate-devin.sh` / `shared/delegate-cursor.sh` / `shared/observe-json.sh`
- Claude Code: [settings（MCP 格納場所）](https://code.claude.com/docs/en/settings)
- Codex CLI: [config reference（`mcp_servers`）](https://learn.chatgpt.com/docs/config-file/config-reference)
- Devin CLI: [configuration（`mcpServers` と優先順位）](https://docs.devin.ai/cli/extensibility/configuration) / [MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)
- Cursor: [CLI MCP](https://cursor.com/docs/cli/mcp) / [CLI configuration](https://cursor.com/docs/cli/reference/configuration) / [headless](https://cursor.com/docs/cli/headless)
