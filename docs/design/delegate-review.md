# delegate-review 設計

変更差分のコード/ドキュメントレビューを、指摘品質に向いた subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-review 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=review` / 既定モデル `opus` / Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）
- 変更差分に対するバグ・設計上のリスク・規約逸脱・文書の不整合などの指摘出しを引き受ける
- read-only で運用し、編集・git 書き込み・push はしない。修正作業は implement に分ける

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

review は「既にある差分に対して問題を見つける」作業に使う。調査だけなら explore、指摘を受けた修正の実装は implement、commit や PR 作成は親エージェントが直接扱う。

## 3. 既定モデルとツール権限

- **既定モデル `opus`**: review は指摘品質が成果物に直結し、判断比重が高いため最も高性能なモデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_REVIEW_MODEL` で上書き可
- **Claude パス**: `delegate-claude.sh`（`claude -p` 子プロセス）で worker を起動する。`git diff` / `git log` / `git show` / `git status` を使うが運用は read-only に限定する
- **制約**: ファイル編集・git の書き込み操作・push はしない。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 発火条件

review は、main が差分全体を読むと context を膨らませる一次レビューを発火条件にする。大きめの diff、複数ファイルにまたがる変更、広い影響範囲の確認が必要な差分が対象。
対象はコード差分だけでなく、README / spec / design docs / changelog などのドキュメント差分も含む。

一方、数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューは委譲しない。小さすぎる差分は委譲オーバーヘッドが勝ちやすく、軽微レビューは main が直接確認した方が速い。

## 5. 指摘出しの方針

review のリクエストでは、Scope にレビュー対象の差分範囲を明記する。base / head、対象パス、見るべき観点が曖昧だと不要な調査が増えるため、worker は指定範囲の差分に集中する。

指摘はレスポンスの Findings section に収め、各 finding は severity / file:line / 根拠 / 影響 / 推奨対応を持つ。親エージェントは `index` を読んだ後、必要な場合に Findings を取得し、重要 findings の該当 diff だけを裏取りする。review は問題の有無と根拠を返すだけで、修正・commit・push は行わない。修正が必要な場合は main が判断し、別途 implement や git に委譲する。

## 6. 起動テンプレートと出力規律

delegate-chore で先行適用した worker 起動の固定テンプレ化（J1）と main の echo / 再要約禁止（J3）を review にも適用する。worker への起動プロンプトは `<REQUEST_FILE>` / `<RESPONSE_FILE>` だけを差し替える固定ボイラープレートにし、タスク本体は request_file に置く。固定テンプレには Findings section 必須、各 finding の severity / file:line / 根拠 / 影響 / 推奨対応、read-only、編集・git 書き込み・push 禁止、main が重要 findings の該当 diff だけ裏取りする条件を含める。

worker の報告 Markdown は canonical 英語 section 名に固定する。`Summary` / `Findings` は必須で、必要に応じて `Blockers`、`Error` を使う。main は response 読了後に worker 本文を echo / 再要約せず、ユーザー向けには Summary を指す 1 行に留める。これにより main の orchestration 出力を増やさず、詳細は response_file の段階読み取りと該当 diff の裏取りに残す。

## 7. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-review/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`review` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
