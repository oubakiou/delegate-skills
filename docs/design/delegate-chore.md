# delegate-chore 設計

雑務のフォールバック先として、explore / implement / git のどれにも明確に当てはまらない作業を最安モデルの subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-chore 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=chore` / 既定モデル `haiku`（最安）/ Claude パスの `subagent_type=general-purpose`
- 専用 skill（explore / implement / git / review）でカバーされない雑務を引き受ける**フォールバック**。軽微な整形・リネーム・一括置換・定型コマンド実行など
- 専用 skill が当てはまる作業は必ずそちらを優先する。chore はあくまで受け皿

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| git / gh 操作（push・PR）    | `delegate-git`       |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

implement との差は「実装判断の有無」。機能追加・バグ修正・リファクタなど編集の設計判断を要するものは implement、判断をほぼ要さない機械的・定型的な雑用が chore。境界が曖昧なときは、繰り返し現れるなら専用 skill 化を提案する（§4）。

## 3. 既定モデルとツール権限

- **既定モデル `haiku`**: chore は read 中心・低リスクで判断比重が小さいため最安モデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_CHORE_MODEL` で上書き可
- **`subagent_type=general-purpose`**: 軽微な編集（Edit/Write）や定型コマンド実行（Bash）を伴いうるため、read-only の `Explore` ではなく汎用エージェントを使う
- **制約**: 編集は可、ただし **push はしない**（push・PR は delegate-git の責務）。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. フィードバックループ（chore 固有の中核責務）

chore に流れたタスクは「専用 skill が無い作業」のシグナルである、という点が delegate-chore 固有の設計上の役割。親エージェントはレスポンス消費後に次の 2 つの昇格を評価する。

- **skill 昇格提案**: その雑務が繰り返し現れる / 明確にスコープされた再利用可能なカテゴリなら、専用 `delegate-<name>` skill の新規作成を `AskUserQuestion` で提案する
- **決定論的プロセスの自動化提案**: LLM の判断を要さず決定論的に自動化できる手順（固定パイプライン・機械的な一括置換など）に気づいたら、スクリプト化 / git hook / npm script / CI 等の自動化を提案する

いずれも一度きりの些末な作業では提案しない。判定基準・提案内容・生成手順（skill-creator 雛形化、本プロトコルへの追従）の詳細は spec.md [§8](spec.md#8-delegate-chore-からの-skill-昇格提案) に集約する。この feedback により chore の受け皿は時間とともに専用 skill / 自動化へ昇格し、フォールバックに残るのは真にアドホックな作業のみになる。

## 5. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-chore/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`chore` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
