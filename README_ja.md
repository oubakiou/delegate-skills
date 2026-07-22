# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME_ja.md)

[![English](https://img.shields.io/badge/Language-English-lightgrey?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-blue?style=for-the-badge)](./README_ja.md)

📖 紹介記事: [高級モデルに全部やらせない — 標準機能(skill)だけでカジュアルに実現するマルチモデルの仕組み『delegate-skills』](https://zenn.dev/oubakiou/articles/c6f632dd0a9e92)

**実装・調査・レビュー・雑務などのタスクを、より安価なモデルや別ベンダーのモデル（Claude → Codex 等）の subagent に委譲してトークン費用を圧縮する LLM エージェント向け skill 集。**

高価なモデルを main agent に据えたまま、「読む・調べる・直す」といった定型作業だけを安価なモデルの子プロセスへ逃がす。たとえば main が Claude Fable 5（input \$10 / output \$50 per 1M tokens）のとき、コード探索を Claude Haiku 4.5（\$1 / \$5）へ委譲すれば、その作業のトークン単価は 1/10 になる。委譲先は Claude 系モデルに限らず、Codex（`gpt-*`）・Devin CLI・Cursor agent CLI 経由のモデルもモデル名だけで指定できる。委譲結果はファイル経由で必要な部分だけ段階的に読み取るため、main の context も膨らまない。

## 特徴

- **トークン費用の圧縮** — 読む量・書く量の多い定型作業を安価なモデルへ委譲し、高価なモデルの消費を意思決定と最終責任に集中させる
- **context の分離** — 大量のファイル読解や試行錯誤のログは子プロセス側に隔離され、main は結果の index → 必要 section だけを読む
- **マルチ CLI 対応** — 呼び出し元（requester）が Claude Code / Codex / Devin CLI / Cursor のいずれでも動作し、委譲先もモデル名だけで同じ 4 系統から選べる
- **capability bridge** — 画像生成（`delegate-imagegen`）や x.com 調査（`delegate-x-research`）など、main 側にない能力を子プロセスで橋渡しする
- **安全側に倒した設計** — 多段委譲の再帰防止、前提不足時の fail-closed、委譲先の push 禁止・read-only などのツール権限制限

## クイックスタート

### 前提条件

- Node.js 24+（delegate スクリプトは `md2idx` を内包した単一バンドル CLI。`jq` も `npx md2idx` も不要で、初回実行にネットワークもいらない）
- `.sh` shim を実行する POSIX シェル。follow-up セッションを使う場合は `git`
- Claude 系モデルを使う場合: `claude` CLI（ログイン済み）
- `gpt-*` を使う場合: `codex` CLI（ログイン済み）
- `swe-*` / `devin-*` を使う場合: `devin` CLI（ログイン済み）
- `composer-*` / `cursor-*` を使う場合: Cursor agent CLI（コマンド名は `agent`。ログイン済み、または `CURSOR_API_KEY` 設定済み）
- 現在の backend で `delegate-x-research` を使う場合: `grok` CLI（ログイン済み、X 調査へアクセス可能）

requester に Codex を使う場合は、delegate skills をインストールした project の `.codex/config.toml` に次を追加して Codex を再起動する。

```toml
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
```

> [!WARNING]
> Codex worker と requester Codex は `danger-full-access` で動くため、Codex sandbox は security boundary にならない。専用 Dev Container、VM、一時的な CI runner、別の hardened container 内での利用を推奨する。agent はその環境に mount または認証したものへ到達できるため、host Docker socket や広い host directory を公開しないこと。詳細は [Codex isolation boundary 契約](./docs/design/spec.md#requester-codex-と外部隔離境界)を参照。

### インストール

#### gh skill（GitHub CLI v2.90.0+）

```bash
# Claude Code 向けに個別 skill をインストール
gh skill install oubakiou/delegate-skills delegate-explore --agent claude-code --scope project

# Codex 向け
gh skill install oubakiou/delegate-skills delegate-explore --agent codex --scope project

# 全 delegate skill をまとめてインストール
for skill in delegate-explore delegate-implement delegate-chore delegate-review delegate-imagegen delegate-x-research delegate-htmldoc; do
  gh skill install oubakiou/delegate-skills "$skill" --agent claude-code --scope project
done
```

#### skills CLI（[vercel-labs/skills](https://github.com/vercel-labs/skills)）

```bash
# 対話的に skill / agent を選んでインストール
npx skills add oubakiou/delegate-skills

# 利用可能な skill を一覧表示
npx skills add oubakiou/delegate-skills --list

# 特定 skill を特定 agent へ非対話でインストール
npx skills add oubakiou/delegate-skills --skill delegate-explore -a claude-code -y
```

### 使ってみる

上記の Codex requester 設定を除き、追加設定は不要。main agent に普段どおり依頼すれば、各 skill の description に基づいて自動で委譲される。

```text
このリポジトリの認証処理がどこで実装されているか調べて
```

→ main agent が `delegate-explore` を発動し、`haiku` の子プロセスが調査する。main は結果ファイルの index → 必要 section だけを読む。

skill 名を指定して明示的に委譲することもできる。

```text
delegate-review でこのブランチの差分をレビューして
```

より積極的に委譲させたい場合は、プロジェクトの CLAUDE.md / AGENTS.md に一文足しておくとよい。

```markdown
- token を節約するため delegate-\* skill を利用して積極的にタスクをサブエージェントに委譲してください
```

## 仕組み

モデル名のプレフィックスで実行系を選ぶ:

| モデル名                              | 実行系           |
| ------------------------------------- | ---------------- |
| `sonnet` / `haiku` / `opus` / `fable` | Claude Code      |
| `gpt-*`                               | Codex            |
| `swe-*` / `devin-*`                   | Devin CLI        |
| `composer-*` / `cursor-*`             | Cursor agent CLI |

各 backend は子プロセスとして動き、main agent と request / response file を受け渡すため、詳細な作業内容は main context に入らない。run は既定で one-shot。詳細は [protocol-v1](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fprotocol-v1.md) と [spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md) を参照。

### 再開可能な worker session

大きめの `delegate-implement` / `delegate-chore` で review/fix の往復が見込まれる場合は、resumable session を選択できる。再開の検証に失敗しても別 session を暗黙に起動せず、通常の run として出し直す。Claude / Codex / Devin / Cursor が対応する。

## skill 一覧

| skill                 | 用途                                               | ツール権限                                | 既定モデル   | env                                                                              |
| --------------------- | -------------------------------------------------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `delegate-explore`    | read-only のコード/ドキュメント/Web/MCP 探索・読解 | read-only（Web・MCP 可）                  | `haiku`      | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| `delegate-implement`  | コード実装・修正（1 コミットに収まる単位）         | Edit/Write/Bash（push なし）              | `sonnet`     | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| `delegate-chore`      | フォールバック雑務                                 | Edit/Write/Bash（push なし）              | `haiku`      | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| `delegate-review`     | コード/ドキュメントレビュー（差分の指摘）          | read-only                                 | `opus`       | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`   | Codex による画像生成/編集                          | Codex 子プロセス                          | `gpt-5`      | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |
| `delegate-x-research` | x.com / X 調査                                     | X 調査子プロセス                          | `grok-build` | `DELEGATE_X_RESEARCH_MODEL` / `DELEGATE_WORK_DIR`                                |
| `delegate-htmldoc`    | HTML ドキュメント生成（固定テンプレート）          | 出力ディレクトリ書き込みのみ（push なし） | `haiku`      | `DELEGATE_HTMLDOC_MODEL` / `DELEGATE_WORK_DIR`                                   |

既定モデルの根拠: explore / chore は read 中心・低リスクで `haiku`、implement は編集の判断を要するため `sonnet`、review は指摘品質が成果物に直結し判断比重が高いため `opus`、htmldoc は同梱固定テンプレートへの content 流し込みだけで判断比重が低いため `haiku`。

`delegate-imagegen` はユーザーにモデル選択を求めないが、運用側は `DELEGATE_IMAGEGEN_MODEL` で切り替えられる。出力先の明示がなければ生成物は `delegate-imagegen-output/` 配下に置く。

`delegate-x-research` は X 調査の capability bridge として扱い、運用側は `DELEGATE_X_RESEARCH_MODEL` で切り替えられるが、ユーザーに backend モデル選択を求めない。

`delegate-htmldoc` は skill 同梱の固定テンプレート（`references/template.html` + `references/styleguide.md`）へ content を流し込んで自己完結型の HTML ドキュメントを生成する。デザインは実行・モデルによらず同一で、worker は CSS を生成・編集しない。グラフ・画像素材は親側で用意して（チャートは dataviz-svg、ラスタ画像は `delegate-imagegen` 等）パスで渡し、SVG は文書へインライン埋め込み、ラスタ画像は出力 HTML の隣へコピーして相対参照する。出力先の明示がなければ生成物は `delegate-htmldoc-output/` 配下に置く。

## 環境変数

通常はモデル関連の変数だけ設定すればよい。

### 基本設定

| 環境変数                       | 既定                                     | 用途                                     |
| ------------------------------ | ---------------------------------------- | ---------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`        | skill 毎                                 | delegate 種別ごとのモデルを上書きする    |
| `DELEGATE_X_RESEARCH_MODEL`    | `grok-build`                             | `delegate-x-research` のモデルを選ぶ     |
| `DELEGATE_WORK_DIR`            | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | request / response / observe file を置く |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR` | `delegate-imagegen-output`               | 画像生成の既定出力 directory を指定する  |

モデル解決順: `DELEGATE_<TYPE>_MODEL` → skill 固有デフォルト。

### 高度な設定

| 環境変数                                 | 既定                          | 用途                                              |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `DELEGATE_RESPONSE_INLINE_MAX`           | `10240` bytes                 | response の inline / 段階読み閾値                 |
| `DELEGATE_RUN_CONTENT_MAX`               | `16384` bytes（`0` は無制限） | one-shot JSON に含める content の上限             |
| `DELEGATE_REQUEST_INLINE_MAX`            | `262144` bytes                | worker prompt に埋め込む request の上限           |
| `DELEGATE_METRICS_FILE`                  | 未設定                        | 任意の JSONL telemetry 出力先                     |
| `DELEGATE_OBSERVE_HEARTBEAT_INTERVAL`    | `10` 秒                       | observe heartbeat の間隔                          |
| `DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS`  | `30` 秒                       | observe lock の timeout                           |
| `DELEGATE_CHILD_BASH_TIMEOUT_MS`         | `300000` ms（`0` は注入なし） | Claude child の Bash timeout                      |
| `DELEGATE_CODEX_HOME_PRUNE`              | `1`（`0` で残す）             | 成功 run の cache を削除する。auth は常に削除する |
| `DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS` | `0`（無効）                   | stream が増えない child を指定秒数後に停止する    |
| `DELEGATE_OBSERVE_STREAM_MAX_BYTES`      | `65536` bytes（`0` は無制限） | observe JSON に保持する stdout / stderr の上限    |
| `DELEGATE_RUN_RETENTION_DAYS`            | `0`（無効）                   | 古い run ごとの scratch directory を削除する      |

### 作業ファイルとテレメトリ

ローカルでの再現調査や外部 watchdog からの監視には `DELEGATE_WORK_DIR=.temp/delegate/work` を設定し、request / response / observe JSON / run ごとの scratch file をリポジトリ内の ignore 済みディレクトリに集約する。
`DELEGATE_RUN_RETENTION_DAYS` を設定すると、その work directory 内の古い run ごとの scratch directory を削除する。監査・デバッグ用の request / response / observe JSON は削除しない。
完走した run は observe JSON に usage と timing を記録する。backend が usage を公開する場合は `measured`、それ以外は request / response だけに基づく推定値となるため、実測値とは比較しないこと。`DELEGATE_METRICS_FILE` を設定すると JSONL telemetry を出力し、`scripts/summarize-metrics.ts` で集計できる。各 field の契約は [spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md) を参照。

## モデルと推論強度

### 対応モデル名

`DELEGATE_<TYPE>_MODEL` には次のドキュメント済みモデル名を指定できる:

| 実行系           | モデル名                                                                                                                                              | 補足                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Claude CLI       | `fable`, `opus`, `sonnet`, `haiku`                                                                                                                    | Claude 系モデルの alias                                  |
| Codex CLI        | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex-spark`       | `delegate-imagegen` は `gpt*` / Codex 分岐のみ受け付ける |
| Devin CLI        | `swe-1.7`, `swe-1.7-lightning`, `swe-1.6`, `swe-1.6-fast`, `devin-glm-5.2`, `devin-deepseek-v4-pro`                                                   | `devin-*` は prefix を剥がして Devin CLI に渡す          |
| Cursor agent CLI | `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5`, `cursor-gemini-3.1-pro`, `cursor-kimi-k2.7-code`, `cursor-glm-5.2-high`, `cursor-glm-5.2-max` | `cursor-*` は prefix を剥がして Cursor agent CLI に渡す  |

上記はドキュメント済みの対応モデルであり、厳密な allowlist ではない。実行先 CLI 側でも指定モデルが利用可能である必要がある。`delegate-x-research` は別途 `DELEGATE_X_RESEARCH_MODEL` を使い、ドキュメント済みモデルは `grok-build`。

### 推論強度（reasoning effort）

モデル名に `@<effort>` を付けて指定する。

```sh
DELEGATE_IMPLEMENT_MODEL=gpt-5.5@high
```

| backend / model             | 指定できる値                                     | 補足                        |
| --------------------------- | ------------------------------------------------ | --------------------------- |
| Claude                      | `low`, `medium`, `high`, `xhigh`, `max`          | `--effort` として渡す       |
| Codex                       | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | reasoning config として渡す |
| `cursor-glm-5.2`            | `high`, `max`                                    | Cursor 固有の変換           |
| `cursor-grok-4.5`           | `low`, `medium`, `high`                          | Cursor 固有の変換           |
| Devin、imagegen、X research | 非対応                                           | effort suffix なし          |

不正な値や非対応の組み合わせは dispatch 前に停止する。Cursor の `-high` / `-max` model slug と `@...` suffix は併用できない。

suffix を付けない場合、delegate-skills は effort を明示せず、実行先 CLI の既定値を使う。例外は、catalog 既定が `medium` の `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` と、model slug 自体に effort を含む Cursor の `-high` / `-max` である。

backend が公開する場合、指定値と実効値を observe JSON へ記録する。詳細は [spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md) を参照。Codex の `max` / `ultra` は Codex CLI v0.144.1 と `gpt-5.6-sol` で確認済みで、古い CLI では拒否される場合がある。

## モデル価格参照データ

[`shared/model-token-prices.json`](shared/model-token-prices.json) に、delegate 対象モデルファミリの token 単価スナップショットを置く。`scripts/sync-shared.ts` が各 skill ディレクトリへコピーを同梱する。これはコスト分析やレポート用の参照データであり、delegate-skills は cost gate としては使わない。

backend がトークン実測を返すが費用を報告しない場合（Codex 等）、observe usage にはこの単価表から換算した `cost_usd_estimated` を実測 `cost_usd` とは別フィールドで併記する（下流の集計が実測と換算を区別できるようにするため）。`cost_estimate_basis` に cached 単価適用の有無が入り、単価表に該当モデルが無い場合はフィールドごと省略する。

![モデル token 単価](docs/assets/model-token-prices.svg)

input が 100 万 token あたり \$1 以下、または output が 100 万 token あたり \$5 以下のモデル:

![低価格モデル token 単価](docs/assets/model-token-prices-low-cost.svg)

## アーキテクチャ

[docs/design/spec.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fspec.md#p:2) を参照。

## 開発

[docs/design/development.md](https://mkdn.review/?url=https%3A%2F%2Fgithub.com%2Foubakiou%2Fdelegate-skills%2Fblob%2Fmain%2Fdocs%2Fdesign%2Fdevelopment.md) を参照。

## ライセンス

MIT
