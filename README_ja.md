# delegate-skills

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2FREADME_ja.md)

[![English](https://img.shields.io/badge/Language-English-lightgrey?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/言語-日本語-blue?style=for-the-badge)](./README_ja.md)

**実装・調査・レビュー・雑務などのタスクを、安価なモデルの subagent に委譲してトークン費用を圧縮する LLM エージェント向け skill 集。**

## 概要

main agent（高価なモデル）の context を汚さず、定型的・機械的な作業を安価なモデルへ委譲する。委譲先は**モデル名で二分岐**する:

- Claude 系（`sonnet`/`haiku`/`opus`/`fable`）→ **Claude 子プロセス**（`claude -p`、`delegate-claude.sh`）
- `gpt-*` → **Codex 子プロセス**（`codex exec`、`delegate-codex.sh`）

どちらのパスもシェルラッパ経由で子プロセスを起動するため、requester が Claude Code でも Codex でも同じように動作する。main↔sub の受け渡しはファイルベース（リクエスト/レスポンス）で、両方とも [md2idx](https://github.com/oubakiou/md2idx) 形式（`index` + `sections`）を採用し段階読み取りでトークンを節約する。

## skill 一覧

| skill                | 用途                                       | ツール権限                   | 既定モデル | env                                              |
| -------------------- | ------------------------------------------ | ---------------------------- | ---------- | ------------------------------------------------ |
| `delegate-explore`   | read-only のコード/ドキュメント探索・読解  | read-only                    | `haiku`    | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`   |
| `delegate-implement` | コード実装・修正（1 コミットに収まる単位） | Edit/Write/Bash（push なし） | `sonnet`   | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR` |
| `delegate-chore`     | フォールバック雑務                         | Edit/Write/Bash（push なし） | `haiku`    | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`     |
| `delegate-review`    | コードレビュー（差分の指摘）               | read-only                    | `opus`     | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`    |

既定モデルの根拠: explore / chore は read 中心・低リスクで `haiku`、implement は編集の判断を要するため `sonnet`、review は指摘品質が成果物に直結し判断比重が高いため `opus`。

## 環境変数

| 環境変数                | 既定                                     | 説明                                  |
| ----------------------- | ---------------------------------------- | ------------------------------------- |
| `DELEGATE_<TYPE>_MODEL` | skill 毎                                 | 種別別のモデル上書き                  |
| `DELEGATE_WORK_DIR`     | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | リクエスト/レスポンスファイルの置き場 |

モデル解決順: `DELEGATE_<TYPE>_MODEL` → skill 固有デフォルト。

## アーキテクチャ

各 skill は共有スクリプトのコピーを同梱（self-contained）し、skill ディレクトリ相対の `.claude/skills/<skill>/scripts/...` で呼ぶ:

```
main agent
  ├─ <skill>/scripts/check-md2idx.sh         前提条件チェック（npx md2idx, fail-closed）
  ├─ <skill>/scripts/resolve-model.sh        モデル解決（種別env → デフォルト）
  ├─ <skill>/scripts/check-delegate-chain.sh 多段委譲の再帰防止（同一種別2度禁止 → exit 4）
  ├─ request_file / response_file を mktemp で事前確保（ts + 乱数を共有）
  ├─ model が gpt* → <skill>/scripts/delegate-codex.sh で Codex 子プロセス
  │                 それ以外 → <skill>/scripts/delegate-claude.sh で Claude 子プロセス（claude -p）
  └─ jq で response の status → index → 必要 section を段階読み取り → 検証
```

共有スクリプトの正本は `shared/` にあり、`scripts/sync-shared.ts` が各 skill の `scripts/` へコピーする。プロトコルの詳細は [docs/design/protocol-v1.md](docs/design/protocol-v1.md) を参照。

## 前提条件

- Node.js と `md2idx`（`npx md2idx` が実行可能なこと。各 skill が多用するため `npm install -g md2idx` でのグローバルインストールを推奨）
- `jq`
- Claude 系モデルを使う場合: `claude` CLI（ログイン済み）
- `gpt-*` を使う場合: `codex` CLI（ログイン済み）

## 開発

開発フロー（セットアップ、`vp` による format/lint/test、`shared/` の同期パターン、git hooks）は [docs/design/development.md](docs/design/development.md) を参照。

## ライセンス

MIT
