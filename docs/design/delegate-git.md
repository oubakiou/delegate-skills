# delegate-git 設計

git / gh 操作を、main の明確な指示に従って subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-git 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=git` / 既定モデル `haiku`（最安）/ Claude パスの `subagent_type=general-purpose`
- commit / branch / push / PR 作成などの git / gh 操作を引き受ける。push・PR を許可する唯一の delegate skill
- コード実装は implement、調査は explore、差分の品質指摘は review に分ける

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| git / gh 操作（push・PR）    | `delegate-git`       |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

git はバージョン管理と GitHub 操作だけを扱う。変更内容の作成や修正判断は implement、レビュー判断は review の責務であり、git はその後の明確な操作手順を実行する。

## 3. 既定モデルとツール権限

- **既定モデル `haiku`**: git は外向き操作を含むが、判断は main が持ち、subagent には単純で明確な操作だけを委譲するため最安モデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_GIT_MODEL` で上書き可
- **`subagent_type=general-purpose`**: git / gh コマンドを実行するため汎用エージェントを使う。操作範囲の限定はツール権限ではなく prompt 制約で担保する
- **制約**: git / gh 操作のみを行い、他ファイルの編集はしない。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 判断は main、操作のみ委譲

delegate-git は push や PR 作成のような取り消し困難な外向き操作を含むため、何を行うかの判断を subagent に渡さない。main が対象ブランチ・commit 対象・PR の宛先・本文などを明確に決め、worker はその手順を実行する。

force push、branch 削除、PR merge など破壊的または取り消し困難な操作は、リクエストに明示されていない限り行わない。検証フェーズでは `git log` / `git diff` / `git status` を使い、意図しないファイル変更や想定外の履歴変更がないことを確認する。ツールレベルで完全には縛らないため、prompt 制約と検証報告を組み合わせて運用する。

## 5. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-git/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`git` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
