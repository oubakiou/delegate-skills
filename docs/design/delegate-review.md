# delegate-review 設計

変更差分のコードレビューを、指摘品質に向いた subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-review 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=review` / 既定モデル `opus` / Claude パスの `subagent_type=general-purpose`
- 変更差分に対するバグ・設計上のリスク・規約逸脱などの指摘出しを引き受ける
- read-only で運用し、編集・git 書き込み・push はしない。修正作業は implement に分ける

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| git / gh 操作（push・PR）    | `delegate-git`       |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

review は「既にある差分に対して問題を見つける」作業に使う。調査だけなら explore、指摘を受けた修正の実装は implement、commit や PR 作成は git に分ける。

## 3. 既定モデルとツール権限

- **既定モデル `opus`**: review は指摘品質が成果物に直結し、判断比重が高いため最も高性能なモデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_REVIEW_MODEL` で上書き可
- **`subagent_type=general-purpose`**: Claude パスでは `git diff` / `git log` / `git show` / `git status` を使うため汎用エージェントを使う。ただし運用は read-only に限定する
- **制約**: ファイル編集・git の書き込み操作・push はしない。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 指摘出しの方針

review のリクエストでは、Scope にレビュー対象の差分範囲を明記する。base / head、対象パス、見るべき観点が曖昧だと不要な調査が増えるため、worker は指定範囲の差分に集中する。

指摘はレスポンスの Findings section に収め、親エージェントは `index` を読んだ後、必要な場合に Findings を取得する。review は問題の有無と根拠を返すだけで、修正・commit・push は行わない。修正が必要な場合は main が判断し、別途 implement や git に委譲する。

TODO: delegate-chore で先行適用した発火条件の絞り込み、worker 起動の固定テンプレ化（J1）、main の echo / 再要約禁止（J3）を review に横展開する。review では、大きめの diff、複数ファイルにまたがる変更、main が差分全体を読むと重い一次レビューを発火条件にする。一方、数行の diff、main が既に読んだ差分、style / typo 程度の軽微レビューは委譲しない。固定テンプレには Findings section 必須、各 finding の severity / file:line / 根拠 / 影響 / 推奨対応、read-only、編集・git 書き込み・push 禁止、main が重要 findings の該当 diff だけ裏取りする条件を含める。

## 5. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-review/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`review` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
