# delegate-imagegen 設計

画像生成・画像編集を Codex 子プロセスへ委譲する skill の設計。

delegate skill 共通の仕組み（ファイルプロトコル、段階読み取り、多段委譲、脅威モデル）は [spec.md](spec.md) を参照する。本書は `delegate-imagegen` 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=imagegen`
- 既定の「軽いモデルへ逃がす」delegate ではなく、**画像生成 capability を持つ実行系への bridge** として扱う
- 主目的は token cost 削減ではなく、画像生成・画像編集の capability isolation と context isolation
- ユーザー向けに画像生成モデルの選択肢は出さない。運用側は `DELEGATE_IMAGEGEN_MODEL` で起動モデルを切り替えられる
- imagegen の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない

## 2. 他 skill との境界

| 作業の性質                                 | 振り先               |
| ------------------------------------------ | -------------------- |
| 画像生成・画像編集                         | `delegate-imagegen`  |
| SVG / HTML / CSS / canvas で表現すべき図版 | 通常の実装・編集     |
| コードやドキュメントの読解                 | `delegate-explore`   |
| ファイル編集を伴う実装・修正               | `delegate-implement` |
| 差分の指摘                                 | `delegate-review`    |
| 上記いずれにも該当しない雑務               | `delegate-chore`     |

imagegen は「画像として出すのが本質」なケースに使う。既存のデザインシステム内で再現可能な UI、あるいは構造化されたコードで作る方が適切な成果物なら、通常の実装として扱う。
imagegen の作業を委譲する場合は、この skill の固定フローを使う。generic な subagent へ流す運用は想定しない。

## 3. 既定値と出力先

- **モデル解決**: `DELEGATE_IMAGEGEN_MODEL` → 既定 `gpt-5`
- **実行系分岐**: `gpt*` は Codex、非 `gpt*` は Claude へフォールバックせず中止
- **出力先の既定**: ユーザーが出力先を明示しない場合は `delegate-imagegen-output/`
- **worker への指示**: 既存画像を編集する場合は、入力ファイル、保持要素、変更点、許容するスタイル変化を request に明記する

出力先の既定を skill 固有ディレクトリに寄せるのは、生成物を workspace 内に閉じて、試行錯誤の副産物を散らさないためである。リポジトリ固有の一時ディレクトリ規約がある場合は、運用側で `DELEGATE_IMAGEGEN_OUTPUT_DIR` を設定して上書きする。

## 4. 実行フロー

`delegate-imagegen` は画像生成専用の準備・Codex ラッパを使う。モデル解決は他 delegate と同じ形にするが、画像生成 capability bridge なので実行系は Codex に限定する。

1. **準備**
   - Objective / Scope / Context / Acceptance criteria / Verification / Constraints を Markdown で与える
   - 出力先の指定がない場合、Constraints に `DELEGATE_IMAGEGEN_OUTPUT_DIR` の既定出力先を使う旨を含める
   - `prepare-imagegen.sh` で model / request / response を事前確保し、前提不足なら exit 3、再帰検出なら exit 4 で止める
2. **実行系分岐**
   - `model` が `gpt*` なら `delegate-imagegen-codex.sh "$model" "$request_file" "$response_file"` を使い、request_file を読ませて response_file を書かせる
   - それ以外なら中止する
3. **レスポンス読み取り**
   - `read-response.sh auto` を既定にし、小さい報告は一括で読む
   - 大きい報告は `index` → `Generated files` / `Verification` / `Blockers` の順で段階読み取りする
4. **検証**
   - `Generated files` に列挙されたパスが実在することを main 側で確認する
   - 必要に応じて画像を開き、Acceptance criteria と明らかに矛盾しないかを確認する

## 5. Request の要点

imagegen の request では、worker が生成物を安定して作れるように、成果物の条件をできるだけ構造化して渡す。

- 何を作るか
- 何を保持するか
- 何を変えてよいか
- 参照画像があるならそれはどれか
- サイズ、枚数、縦横比、ファイル形式などの制約
- 生成物の保存先

「雰囲気をよしなに」だけではなく、機械的に検証できる条件を増やすほど、main 側の確認コストが下がる。

## 6. Worker report

worker の report Markdown は次の見出しを基本にする。

- `Summary`: 生成・編集結果の短い説明
- `Generated files`: 作成・更新した画像ファイルのパス
- `Parameters`: 使用したプロンプト、サイズ、枚数、参照画像、重要な生成条件
- `Verification`: ファイル存在確認、目視確認、試行し直した内容
- `Blockers`: 生成不能、入力不足、安全上の制約、ツール不在

`delegate-imagegen` では、worker の試行錯誤ログを main が再要約しない。main の役割は、生成ファイル一覧と短い結果を返し、必要な場合だけ `Verification` を確認することにある。

## 7. 安全と制約

- `DELEGATE_IMAGEGEN_MODEL` → `gpt-5` の順でモデル解決する
- Codex 限定で起動し、非 `gpt*` モデルでは Claude パスへフォールバックしない
- ユーザーにモデル選択を求めない
- `task_type_chain` に同種別を再登場させない
- 出力先が未指定なら `DELEGATE_IMAGEGEN_OUTPUT_DIR` の既定出力先に閉じる
- 画像生成そのものが必要ないケースは、通常のコード編集や他 delegate に振り分ける

画像生成は、コード変更と違って「差分の意味」をテキストだけで厳密に追いにくい。そのため main 側は、ファイルの存在確認と目視確認を前提に検証する。

## 8. 共通事項への参照

- 実行フローの共通規約: [SKILL.md](../../skills/delegate-imagegen/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー: spec.md [§8](spec.md#8-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§10](spec.md#10-スクリプトと-exit-code) / [§12](spec.md#12-環境変数) / [§13](spec.md#13-脅威モデル割り切り)

## 9. 外部参照

- [OpenAI Developers: Codex CLI](https://developers.openai.com/codex/cli)
- [OpenAI API Docs: Image generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation)
- [OpenAI API Docs: Image generation](https://developers.openai.com/api/docs/guides/image-generation)
