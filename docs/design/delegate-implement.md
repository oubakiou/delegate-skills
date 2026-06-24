# delegate-implement 設計

ファイル編集を伴う実装・修正を、編集判断に向いた subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-implement 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=implement` / 既定モデル `sonnet` / Claude パスの `subagent_type=general-purpose`
- ファイル編集を伴う機能追加・バグ修正・リファクタなどを引き受ける。粒度は 1 コミットに収まる単位を想定する
- 調査だけなら explore、push・PR などの git / gh 操作は git に分ける

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| git / gh 操作（push・PR）    | `delegate-git`       |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

implement は「編集によって成果物を変える」作業に使う。機械的な整形だけなら chore で足りる場合があるが、設計判断・テスト調整・周辺影響の確認を伴うなら implement を選ぶ。

## 3. 既定モデルとツール権限

- **既定モデル `sonnet`**: implement は編集の設計判断を要するため、read 中心の作業より判断力のあるモデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_IMPLEMENT_MODEL` で上書き可
- **`subagent_type=general-purpose`**: Edit / Write / Bash による実作業と検証コマンド実行を伴うため、read-only の `Explore` ではなく汎用エージェントを使う
- **制約**: 編集は可、ただし **push はしない**（push・PR は delegate-git の責務）。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 実装と自己検証

implement の中核責務は、編集だけでなく worker 自身が決定論的な検証を実行して結果を返すこと。リクエストの Verification には `vp check` やテストなど、worker が実行すべきコマンドを明記し、レスポンスの Verification section には実行コマンドと exit code を収める。

親エージェントはまず `status` と `index` を読み、必要に応じて Summary と Verification を確認する。lint・型チェック・テストの exit code は決定論的な事実として扱い、受け入れ基準や意味的な妥当性は Summary と差分を中心に確認する。この分担により、spec.md の脅威モデルに沿って、子の説明を鵜呑みにせず、検証可能な結果と判断が必要な結果を分けて扱える。

## 5. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-implement/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`implement` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
