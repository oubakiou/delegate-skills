# 開発ガイド

delegate-skills の開発ワークフロー。仕様は [spec.md](spec.md)、プロトコルは [protocol-v1.md](protocol-v1.md) を参照。

## セットアップ

devcontainer 前提。初回はリポジトリ root で `local_setup.sh` を実行する。

```sh
./local_setup.sh
```

主な処理:

- `npm ci`（`package-lock.json` があればロック厳守、無ければ `npm install`）
- `claude` / `codex` / `vp` / `typescript-language-server` を `/usr/local/bin` にシンボリックリンク
- `.claude/settings.local.json` / `CLAUDE.local.md` を example から生成（無ければ）
- 既定 skill の `gh skill install`
- `git config core.hooksPath .githooks`（pre-commit hook を有効化）

## ツールチェーン

format / lint / test / 型チェックは [vite-plus](https://www.npmjs.com/package/vite-plus)（`vp`）に集約する。設定は [`vite.config.ts`](../../vite.config.ts)。

| コマンド         | 役割                                                      |
| ---------------- | --------------------------------------------------------- |
| `vp check`       | format + lint + 型チェックの横断確認（CI / 最終確認向け） |
| `vp check --fix` | 上記を自動修正付きで実行                                  |
| `vp test`        | Vitest 実行                                               |

- **format**（oxfmt）: セミコロンなし / シングルクォート / 末尾カンマ `es5`
- **lint**（oxlint, type-aware）: `correctness` / `perf` / `restriction` / `style` / `suspicious` を `error`。個別 off ルールは `vite.config.ts` の `rules` を参照
- import の並びは fmt（oxfmt の sortImports）が所有する。lint の `sort-imports` は別アルゴリズムで衝突するため off

TypeScript のコード調査・変更検証には Claude Code の `LSP` deferred tool を併用する（`goToDefinition` / `findReferences` / `getDiagnostics`）。`getDiagnostics` は指定ファイル中心のため、横断的な最終確認は `vp check` を使う。

## テスト

Vitest の **in-source testing** で種別非依存の汎用部品を単体検証する。対象は `vite.config.ts` の `test.includeSource`（`shared/**`、各 skill の `scripts/*-sanitize*.ts` 等）。

正本（canonical）は `shared/` 側に置き、各 skill 配下の生成コピーはテストを重複実行しない。インストール先である `.claude/skills/`（Claude Code）や `.agents/skills/`（Codex）側ではなく、正本である `skills/` 側を直接テスト対象にして回帰検出漏れを防ぐ。

## shared/ 同期パターン

self-contained 配布のため、共有スクリプトは `shared/` を正本とし各 skill 配下へコピー同梱する（`gh skill install` 単体でも動くようにする）。同期は `scripts/sync-shared.ts` が担う。

| コマンド                    | 役割                                        |
| --------------------------- | ------------------------------------------- |
| `npm run sync-shared`       | `shared/` の正本を各 skill のコピーへ同期   |
| `npm run sync-shared:check` | drift 検出（ズレがあれば失敗、fail-closed） |

生成コピー（`skills/*/scripts/{sanitize,codex-jsonl}.ts` 等）を直接編集してはならない。編集は `shared/` 側で行い、同期を走らせる。

## git hooks（pre-commit）

`.githooks/pre-commit` が以下を順に実行する:

1. `sync-shared:check` で生成コピーの直接編集を早期検出
2. `vp check --fix` で format / lint を自動修正し、変更を再ステージ
3. `vp check --fix` が正本を書き換えた場合に `sync-shared` でコピーへ再同期し再ステージ
4. 最終ドリフト検証（fail-closed）
5. `vp test`

## コーディング規約

[../../AGENTS.md](../../AGENTS.md) に従う。要点:

- 一時ファイル・ディレクトリは必ず `.temp/` 配下に作成する
- linter を無効化する場合、まず無効化しない対応を検討し、難しい場合はコメントで理由を記述する
- 明確な理由がなければ `let` ではなく `const` を使う
- コメントは WHY が非自明な場合のみ書く。識別子で表現できる WHAT は書かない
- 現在のタスク・修正経緯・呼び出し元への言及はコメントに書かない（PR description / commit message に属する）
- コミット前にサブエージェントでセルフレビューを行うか、`AskUserQuestion` でユーザーに確認する
