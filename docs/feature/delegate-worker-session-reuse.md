# 子ワーカーセッション再利用 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdelegate-worker-session-reuse.md)

`delegate-implement` などで子ワーカーが実装した後、親エージェントの差分確認で不具合が見つかった場合に、前回の子ワーカー文脈へ follow-up 依頼できるようにするための設計判断と実装手順をまとめる。

現行実装は、各 delegate 実行を 1 回限りの非永続セッションとして扱う。これにより隔離性と再現性は高いが、同じ修正の二巡目でも worker が同じ repository / request / diff を読み直すため、token cache と会話文脈を活用できない。本計画では、通常実行の非永続性は維持しつつ、親が初回から明示的に `resumable` として起動した run に限り、既存の request/response/observe file protocol を維持したまま backend の resume 機能で follow-up できるようにする。

完了後は `docs/design/spec.md` / `docs/design/protocol-v1.md` / `docs/design/development.md` / README / README_ja に永続情報を移し、本ファイルは archive する。

## 1. 対応スコープ

| 要件                                                              | 開始時の状態                                                                                                    | 完了条件                                                                                                           | 最終状態 | 状態     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| [MUST] follow-up 可能な初回 delegate を明示的に起動できる         | 通常 delegate は非永続で、完了後に resume handle を復元できない                                                 | 親が初回 run を `resumable` として起動でき、observe JSON に resume handle と `run_context` を記録できる            | 未実装   | 未着手   |
| [MUST] resumable 利用可否は親が初回起動時に判断する               | delegate 種別ごとの固定挙動にすると、不要な session 永続化か、必要な follow-up 機会の取り逃しが起きる           | 種別は利用可否と推奨条件だけを定義し、親が request ごとに通常 run / resumable initial run を明示的に選べる         | 未実装   | 未着手   |
| [MUST] follow-up delegate を明示的に起動できる                    | 各 delegate 実行は必ず新規セッション。親が不具合を見つけた場合も、新しい request と新しい子プロセスで再依頼する | 親が前回の `resumable` run を指定し、同じ backend セッションへ追加指示を送れる                                     | 未実装   | 未着手   |
| [MUST] 既存の通常 delegate は非永続・隔離のまま維持する           | Claude は `--no-session-persistence`、Codex は isolated `CODEX_HOME` + `--ephemeral` を使う                     | 初回から `resumable` と指定した run だけ persistence / resume を有効化し、通常実行の挙動は変えない                 | 未実装   | 未着手   |
| [MUST] resume handle を observe JSON に記録する                   | `responder_session_id` は wrapper 由来の追跡 ID で、CLI の resume handle ではない                               | backend / model / resume id / persistence mode / source を機械的に読める                                           | 未実装   | 未着手   |
| [MUST] follow-up 実行も新しい response_file / observe_file を持つ | request/response は 1 実行 1 ペア。前回 response を更新する設計ではない                                         | follow-up でも新しい run_dir を作り、`followup_of` で前回 run と関連付ける                                         | 未実装   | 未着手   |
| [MUST] backend ごとの resume 可否を fail-closed にする            | CLI help 上は resume / continue がある backend でも、現行 wrapper はそれを使わない                              | resume handle が無い、または PoC 未完了の backend では通常新規実行に落とすのではなく、明確なエラーにする           | 未実装   | 未着手   |
| [SHOULD] Claude / Codex を初期対象にする                          | Claude / Codex は現行 delegate の主要経路。CLI help で非対話 resume の入口が確認できる                          | live PoC 後、Claude / Codex の resumable initial run と follow-up を実装する                                       | 未実装   | 未着手   |
| [SHOULD] Devin / Cursor は PoC 結果に基づき support 対象にする    | print mode + resume + response_file 生成の live PoC は完了済み                                                  | wrapper 統合時に引数契約、usage 抽出、failed response 経路を fixture 化し、unsupported 条件を明確化する            | 未実装   | 一部完了 |
| [SHOULD] stale context のリスクを親が検出できる情報を残す         | worker の会話文脈が常に新規なので、前回文脈の古さを考慮する必要が薄い                                           | follow-up request に親の最新確認結果、対象 diff、前回 response_file を明示し、observe JSON に `run_context` を残す | 未実装   | 未着手   |

スコープ外:

- 自動 follow-up 判定: 親が不具合を見つけたか、同じ worker に戻すべきかは main agent が判断する
- 通常 delegate run を完了後に resumable 化すること: 初回から `resumable` として起動していない run は follow-up 対象外にする
- 長期記憶としての worker session pool: 本機能は直前の修正への follow-up に絞る
- 複数 branch / worktree をまたぐ resume: 同じ repository root と同じ working tree の lineage に限定する
- token cost の絶対値保証: cache hit は backend / provider の挙動に依存するため、usage 観測に留める

## 2. ベースライン / リファレンス

### 2.1 現行実装

| 参照元 / 現行実装                   | 本実装での扱い                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/delegate-claude.sh`         | 通常実行では `--no-session-persistence` を維持する。resumable initial run では persistence と `--session-id` を検証し、follow-up 実行では `--resume` を検証する |
| `shared/delegate-codex.sh`          | 通常実行では per-run isolated `CODEX_HOME` と `--ephemeral` を維持する。resumable lineage では lineage 単位の home と `exec resume` を検討する                  |
| `shared/delegate-devin.sh`          | `-p` / `--export` と `--resume` / `--continue` の併用 PoC は完了済み。wrapper 統合時の引数契約と failed response 経路を fixture 化する                          |
| `shared/delegate-cursor.sh`         | `agent create-chat`、`--resume`、`--output-format json` の併用 PoC は完了済み。JSON usage 抽出と failed response 経路を fixture 化する                          |
| `shared/observe-json.sh`            | resume handle、lineage、repo/worktree の stale-context 判定情報を保存する helper を追加する                                                                     |
| `docs/design/protocol-v1.md`        | `responder_session_id` は追跡 ID のまま維持し、resume handle は別 field として扱う                                                                              |
| `docs/design/delegate-implement.md` | implement の親チェックで不具合が見つかった場合の follow-up 運用を追記する                                                                                       |

### 2.2 事前検証メモ

2026-07-05 時点のローカル CLI で、実 API を呼ばない `--help` / version 確認を行った。

| backend | version                       | 確認コマンド                                                         | 確認できたこと                                                                                                                                                                                         | 未検証事項                                                                               |
| ------- | ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Claude  | `2.1.195 (Claude Code)`       | `claude --help` / `claude --version`                                 | `-r, --resume [value]`、`-c, --continue`、`--session-id <uuid>` がある。`--no-session-persistence` は resume 不能にする                                                                                | `-p --resume <id> --output-format stream-json` で response_file 生成まで安定するか       |
| Codex   | `codex-cli 0.142.3`           | `codex exec --help` / `codex exec resume --help` / `codex --version` | `codex exec resume [SESSION_ID] [PROMPT]`、`--last`、`--json` がある。`--ephemeral` は session file を永続化しない                                                                                     | `codex exec --json` から session id を安定抽出できるか。isolated home で resume できるか |
| Devin   | `devin 3000.1.23 (13fc088b9)` | `devin --help` / `devin version` / live PoC                          | `-p --export` の初回実行で protocol v1 response_file を生成でき、export JSON の `session_id` を `devin --resume <session_id> -p --export` に渡した follow-up でも response_file を生成できた           | wrapper 統合時の引数契約、export ATIF の schema drift、failed response 経路の fixture 化 |
| Cursor  | `2026.07.01-41b2de7`          | `agent --help` / `agent --version` / live PoC                        | `agent create-chat` で chat id を作り、`agent -p --trust --force --resume <chatId> --output-format json` の初回 / follow-up 両方で protocol v1 response_file を生成できた。JSON stdout に usage も出る | wrapper 統合時の引数契約、JSON usage schema、failed response 経路の fixture 化           |

2026-07-05 の live PoC では、Devin / Cursor の print mode resume と response_file 生成の併用は確認済み。Claude / Codex は CLI surface の存在確認までで、実際の resume 品質、session id の取り出し方、token cache の効き方は live PoC が必要。

### 2.3 公式ドキュメント確認

2026-07-05 に各 backend の公式ドキュメントも確認した。ローカル CLI help / live PoC と公式 docs の間で、resume 可否そのものに矛盾はなかった。

| backend | 公式 docs で確認できたこと                                                                                                                                                                                                                       | 公式 docs だけでは確定しないこと                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Claude  | Claude Code CLI reference で `claude -p`、`claude -c -p`、`claude -r "<session>" "query"`、`--resume`、`--session-id`、`--output-format json/stream-json`、`--no-session-persistence` は保存せず resume 不能にすることを確認した                 | 現行 wrapper の tool / permission / stream capture / response_file protocol と組み合わせた live PoC |
| Codex   | Codex non-interactive mode / CLI reference で `codex exec`、`codex exec resume <SESSION_ID>`、`--json`、`--output-last-message`、`--ephemeral`、`codex resume` を確認した                                                                        | lineage scoped `CODEX_HOME` での session id 抽出 source と token cache 効果                         |
| Devin   | Devin CLI Commands & Flags で `--continue`、`--resume <SESSION_ID>`、`--print`、`--export [PATH]`、`devin list --format json` を確認した。Devin API docs でも session への message 送信時に suspended session が自動 resume されることを確認した | `--export` ATIF の `session_id` を wrapper の resume handle として使う契約の fixture 化             |
| Cursor  | Cursor CLI docs で `agent -p` の non-interactive mode、`--output-format json`、`agent resume`、`agent --continue`、`agent --resume="chat-id-here"`、`agent create-chat` を確認した                                                               | JSON stdout の usage schema と response_file protocol との併用は live PoC / fixture で担保する      |

参照リンクは §9 に集約する。

## 3. 設計の中核

### 3.1 follow-up run は新しい protocol run として扱う

backend の会話は resume しても、delegate protocol 上は毎回新しい request/response/observe/run_dir を作る。前回 response_file を上書きせず、新しい response_file に follow-up の結果を保存する。

| 構成要素               | 内容                                      | 配置 / 寿命                                                                                                       |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `followup_of`          | 前回 observe_file または run_dir への参照 | 新しい observe JSON の metadata。request JSON schema は拡張せず、前回参照は request 本文の Context section に書く |
| `backend_session`      | backend の resume handle と取得元         | observe JSON。必要なら response meta にも mirror する                                                             |
| `run_context`          | repo / worktree / git head の一致確認情報 | observe JSON。follow-up の stale-context 判定に使う                                                               |
| `responder_session_id` | 既存の追跡 ID                             | protocol v1 response。resume handle にはしない                                                                    |
| `run_dir`              | follow-up 実行ごとの scratch / capture    | 従来どおり 1 実行 1 directory                                                                                     |
| `lineage_id`           | 初回実行から follow-up 群を束ねる ID      | observe JSON。retention と debug 用                                                                               |

想定 schema:

```json
{
  "lineage": {
    "lineage_id": "delegate_implement_20260705_120000_abcd",
    "followup_of": ".temp/delegate/work/delegate_implement_20260705_120000_abcd_observe.json"
  },
  "backend_session": {
    "backend": "codex",
    "model": "gpt-5",
    "resume_id": "00000000-0000-0000-0000-000000000000",
    "resume_source": "codex_json",
    "persistence": "resumable",
    "home_dir": ".temp/delegate/work/delegate_implement_20260705_120000_abcd/codex-home"
  },
  "run_context": {
    "repo_root": "/workspaces/delegate-skills",
    "worktree_root": "/workspaces/delegate-skills",
    "git_head": "0123456789abcdef0123456789abcdef01234567",
    "git_branch": "main",
    "dirty": true
  }
}
```

`run_context.repo_root` と `run_context.worktree_root` は `realpath` 済みの値を記録する。`git_head` は `git rev-parse HEAD` の値を prepare 時に記録し、wrapper が run 終了後に worker のコミットを反映した HEAD で更新する。`delegate-implement` は worker 自身が 1 コミットを作る規約のため、run 開始時の HEAD との厳密一致で検証すると主要ユースケース（implement → 親の diff 確認 → follow-up）が常に fail-closed になる。follow-up 時の検証は lineage 最新 run の run 終了後 `git_head` と現在の HEAD を比較し、一致するか、記録 HEAD が現在 HEAD の ancestor（`git merge-base --is-ancestor`。親が追いコミットした場合）であれば続行する。reset / rebase / branch 切替などで ancestor 関係が壊れた場合は fail-closed にする。dirty な worktree での follow-up は許容するが、親は follow-up request に最新の `git diff` 範囲を含め、worker の会話内に残った古い diff だけに依存させない。

### 3.2 起動フロー

通常 delegate:

1. `prepare.sh` が新しい request/response/observe/run_dir を作る
2. wrapper は現行どおり non-persistent / isolated で起動する
3. resume handle が得られても、通常実行では保存しないか `persistence: "ephemeral"` として記録する

resumable initial delegate:

1. 親が初回 request の時点で resumable mode を明示する。delegate 種別は固定の永続化挙動を持たず、種別ごとの利用可否・推奨条件を参考に親が request 単位で判断する
2. `prepare.sh` が新しい request/response/observe/run_dir を作り、`lineage_id` と `run_context` を記録する
3. wrapper は通常実行と同じ protocol prompt を使うが、backend session を永続化できる起動引数に切り替える
4. wrapper は初回 response_file 生成後に backend の resume handle を抽出し、`backend_session.persistence: "resumable"` と run 終了後の `run_context`（worker のコミットを反映した `git_head`）を observe JSON に記録する
5. resume handle を抽出できなかった場合は初回実行の成果物は残すが、`backend_session.persistence: "unavailable"` として記録し、後続 follow-up は fail-closed にする
6. 親は response 読了時に observe JSON の `backend_session.persistence` を確認する。`resumable` でなければその時点で follow-up 不可と判断し、再依頼が必要なら通常 delegate として出し直す（follow-up 実行時に初めて fail-closed で気づく silent downgrade を避ける）

follow-up delegate:

1. 親が前回 observe_file を指定して follow-up request を作る
2. `prepare-followup.sh` または `prepare.sh` の follow-up mode が lineage、前回 backend_session、前回 run_context を読む
3. dispatch が backend wrapper に resume metadata を渡す
4. wrapper は現在の repo/worktree context と前回 run_context を比較し、一致する場合だけ backend 固有の resume コマンドで起動して新しい response_file を生成する
5. observe JSON に新旧 run の lineage、新しい backend_session、run 終了後の `run_context` を記録する（次の follow-up の検証基準になる）

follow-up request には、親が見つけた不具合、最新の `git diff` の見るべき範囲、前回 response_file / Verification の参照を含める。worker の古い会話文脈だけに依存させない。

### 3.3 backend ごとの初期方針

| backend | 初期方針                                                                                                                                                                                                                                                                                                                                                                | live PoC の合格条件                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | resumable initial run では `--no-session-persistence` を外すか、明示 `--session-id` を使う。follow-up は `-p --resume <id>` を試す。session file は既定で `~/.claude` 配下（work dir 外）に残るため、lineage scoped `CLAUDE_CONFIG_DIR`（auth 持ち込み含む）で work dir 配下へ隔離できるかを PoC で確認する。公式 docs で session persistence / resume の入口は確認済み | stream-json / dangerous permissions / allowedTools / response_file 生成が現行 wrapper と同じ契約を満たす。session file を lineage scoped に隔離できるか確認し、できない場合は retention 対象外である旨と cleanup 手段を docs に明記する                                                                                                                                                                                                  |
| Codex   | resumable lineage では初回から `--ephemeral` を外し、lineage scoped `CODEX_HOME` に session JSONL を残す。follow-up は `exec resume`。公式 docs で non-interactive resume の入口は確認済み                                                                                                                                                                              | `--json` 付きで resume でき、session id を stdout JSONL または session JSONL から安定抽出できる。加えて resume 時の実効 cwd / sandbox / AGENTS(rules) 読み込み / lineage scoped `CODEX_HOME` の継続利用が初回実行と同等であることを機械的に確認できる（`codex exec resume` は `-C` / `--sandbox` を直接受けないため、`--config` 等での等価指定キーを確定し fixture 化する。等価性を確認できない場合は unsupported / fail-closed に残す） |
| Devin   | resumable initial run は `-p --export <path>` で実行し、export JSON の `session_id` を `backend_session.resume_id` に記録する。follow-up は `devin --resume <id> -p ... --export <path>`                                                                                                                                                                                | response_file 生成、export usage、permission mode が同時に成立することを live PoC 済み                                                                                                                                                                                                                                                                                                                                                   |
| Cursor  | resumable initial run 前に `agent create-chat` で chat id を確保し、初回 / follow-up とも `agent -p --trust --force --resume <chatId> --output-format json` で実行する。公式 docs で `create-chat` / `--resume` / `--output-format` は確認済み                                                                                                                          | response_file 生成、workspace trust、tool permission、JSON usage が同時に成立することを live PoC 済み                                                                                                                                                                                                                                                                                                                                    |

### 3.4 fail-closed の条件

follow-up mode は、次の条件では新規実行に暗黙 fallback しない。親が「再利用できた」と誤認すると、token cost と文脈の前提が崩れるため。

- 前回 observe_file が存在しない
- 前回 observe_file に `backend_session.persistence: "resumable"` が無い
- 前回 observe_file に `run_context.repo_root` / `worktree_root` / `git_head` が無い
- backend / model / repo root / worktree root が現在の request と一致しない
- lineage 最新 run の run 終了後 `git_head` が現在の HEAD と一致せず、かつ現在 HEAD の ancestor でもない
- resume handle の PoC が未完了、または wrapper が unsupported と判定している
- 前回 run_dir が retention で削除され、必要な isolated home / session file が残っていない

## 4. 実装ステップ

### Step 1: (一部完了) backend resume live PoC

- 公式ドキュメント確認は Claude / Codex / Devin / Cursor すべて完了済み
- `.temp/delegate/session-reuse-poc/` 配下で、Claude / Codex の resumable initial run と follow-up の最小 request/response 生成を実行する
- Claude は `--session-id` 付き初回実行または session persistence 有効な初回実行、`-p --resume <id>` follow-up、`--output-format stream-json` の組み合わせを確認する。lineage scoped `CLAUDE_CONFIG_DIR` で session file を work dir 配下に隔離したまま resume が成立するかも確認する
- Codex は lineage scoped `CODEX_HOME` で `--ephemeral` なしの `codex exec --json` 初回実行、session id 抽出、`codex exec resume --json <id>` を確認する。resume 時の実効 cwd / sandbox / rules 読み込みを初回実行と同等にする `--config` 等の指定方法を確定する（確定できなければ Codex は unsupported / fail-closed のまま）
- Devin は `devin -p --export` の初回実行と `devin --resume <session_id> -p --export` の follow-up で protocol v1 response_file 生成を確認済み
- Cursor は `agent create-chat` 後、同じ chat id への `agent -p --trust --force --resume <chatId> --output-format json` 初回 / follow-up で protocol v1 response_file 生成を確認済み

成果物: backend ごとの supported / unsupported 判定と、session id 抽出 source の確定。Devin / Cursor は PoC 済み、Claude / Codex は未完

### Step 2: (未着手) observe JSON schema と helper

- `shared/observe-json.sh` に `lineage` / `backend_session` / `run_context` 更新 helper を追加する
- `run_context` には `repo_root` / `worktree_root` / `git_head` を必須として記録し、`git_branch` / `dirty` を補助情報として記録する。`git_head` は wrapper が run 終了後に更新する
- resume handle 欠落や unsupported backend を observe event と failed response に記録する helper を追加する
- `scripts/observe-json.test.ts` に schema merge / missing handle / missing run_context / stale backend / repo-worktree mismatch / git head ancestor 判定の fixture test を追加する
- `npm run sync-shared` で各 skill copy に同期する

成果物: resume metadata を安全に保存・検証する共通 helper

### Step 3: (未着手) prepare / dispatch の follow-up mode

- resumable initial request と follow-up request を作る helper を追加するか、`prepare.sh` に optional mode 引数を追加する
- resumable initial mode では `lineage_id` と現在の `run_context` を observe JSON に記録する（`git_head` は wrapper が run 終了後に更新する）
- follow-up mode では前回 observe_file から backend / model / backend_session / run_context を読み、現在 request と整合するか検証する
- `dispatch.sh` から wrapper へ resume metadata を渡す引数契約を追加する
- 既存の通常実行 path は引数なしで完全後方互換にする

成果物: backend wrapper に resume metadata を渡せる delegate orchestration

### Step 4: (未着手) Claude / Codex wrapper 対応

- `shared/delegate-claude.sh` に通常実行、resumable initial run、follow-up 実行の分岐を追加する
- `shared/delegate-codex.sh` に通常 per-run `CODEX_HOME`、resumable lineage scoped `CODEX_HOME`、`codex exec resume` 分岐を追加する
- response_file 未生成時の failed response 生成、usage 記録、stream capture の既存挙動を維持する
- response_file 生成後に resume handle と run 終了後の `run_context`（worker のコミットを反映した `git_head`）を observe JSON に記録する
- session id 抽出に失敗した場合は `backend_session.persistence: "unavailable"` として記録し、follow-up では fail-closed する

成果物: Claude / Codex backend の follow-up delegate

### Step 5: (未着手) skill docs と親エージェント運用の更新

- `skills/delegate-implement/SKILL.md` に、初回から follow-up 可能性がある実装を resumable initial run として起動する判断基準と、親チェックで不具合が見つかった場合の follow-up 起動手順を追加する
- resumable initial run の読了手順に、observe JSON の `backend_session.persistence` 確認を必須として明記する（`resumable` 以外なら follow-up 不可としてその場で判断する）
- `delegate-chore` など編集可能 skill にも適用するかを判断する
- `delegate-explore` / `delegate-review` は read-only の性質上、初期対応から外すか明示的に制限する
- README / README_ja に環境変数、制約、fail-closed の説明を追加する

成果物: main agent が安全に follow-up を使うための公開手順

### Step 6: (一部完了) Devin / Cursor 対応判断

- Devin / Cursor は live PoC 済みのため support 対象にする
- Devin は `--export` の `session_id` を `backend_session.resume_id` として記録する
- Cursor は `agent create-chat` の戻り値を `backend_session.resume_id` として記録し、初回から `--resume <chatId>` を使う
- wrapper 統合時は unsupported / handle 抽出失敗 / response_file 未生成時に明確な failed response を返す

成果物: 全 backend の対応範囲が明示された状態。Devin / Cursor は supported、Claude / Codex は Step 1 の PoC 後に確定

### Step 7: (未着手) 永続 docs 反映と archive 化

- `docs/design/spec.md` に follow-up delegate の概要、metadata、fail-closed 条件を追記する
- `docs/design/protocol-v1.md` に optional metadata の扱いを追記する
- `docs/design/development.md` に live PoC / fixture / sync-shared の注意点を追記する
- 実装完了後、本ファイルを `docs/archive/delegate-worker-session-reuse.archive.md` に移す

成果物: 永続設計文書への反映と feature plan の archive

## 5. 設計判断

### a. follow-up を自動化するか

| 候補                                     | 採用 | 理由                                                                             |
| ---------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| **親が明示した場合だけ follow-up**       | ✓    | stale context のリスクを親が判断でき、通常 delegate の隔離性を維持できる         |
| 不具合検出時に自動で前回 worker へ戻す   | ✗    | 不具合の種類によっては親が直接直す方が安い。誤った自動再利用は古い前提を増幅する |
| 常に同一 task_type の最新 session を使う | ✗    | 別タスクの文脈混入と repository state の不一致が起きやすい                       |

### b. resumable initial run の選択主体

| 候補                            | 採用 | 理由                                                                                                                |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| **親が request ごとに判断する** | ✓    | 同じ `implement` でも follow-up 価値は作業サイズ、読んだ文脈量、レビューで差し戻す可能性によって変わる              |
| delegate 種別ごとに固定する     | ✗    | `implement` を常に永続化すると過剰で、`chore` でも大きい修正では follow-up 価値があるため、種別だけでは判断できない |
| operator 設定だけで一律制御する | ✗    | `always` / `never` override は将来あり得るが、初期設計の既定判断としては粗すぎる                                    |

初期方針では、`implement` / `chore` は resumable initial run を利用可能な種別、`explore` / `review` は初期対応では対象外または原則 non-resumable とする。最終判断は、親が初回 request を作る時点で明示する。

### c. backend resume handle をどこに持つか

| 候補                                                  | 採用 | 理由                                                                             |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| **別 field の `backend_session` を追加**              | ✓    | 既存 protocol の追跡 ID と backend resume handle の責務を分けられる              |
| `responder_session_id` に実 session id を入れる       | ✗    | 現在は wrapper が生成する安定追跡 IDであり、backend によって取得可否も形式も違う |
| request_file に response_file と resume id を埋め込む | ✗    | response_file は起動時 prompt が source of truth という既存 protocol を崩す      |

`responder_session_id` は response を書いた主体を追跡する protocol field として維持する。`backend_session` は backend CLI に resume するための optional metadata であり、通常 run や抽出失敗時には resumable ではない状態を表せる。

### d. 通常実行の persistence

| 候補                                                   | 採用 | 理由                                                                                                             |
| ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------- |
| **通常実行は非永続、resumable initial run だけ永続化** | ✓    | 既存の隔離性、retention、debug しやすさを保ちながら、初回から follow-up 可能性があるケースだけ cost を下げられる |
| 全 delegate 実行を永続 session にする                  | ✗    | session file の蓄積、誤 resume、機密情報保持期間の増加が起きる                                                   |
| 通常 run を完了後に resumable 化する                   | ✗    | 現行の非永続起動では backend session が残らないため、後から resume handle を復元できない                         |
| 常に `--last` / `--continue` を使う                    | ✗    | 並行 delegate や別 repository の session を拾う危険がある                                                        |

### e. 初期 backend 範囲

| 候補                          | 採用 | 理由                                                                                                                                |
| ----------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Claude / Codex から始める** | ✓    | 現行の主要 backend で、既存 wrapper 差分を小さく始められる。Devin / Cursor は PoC 済みだが wrapper 契約が異なるため別 step に分ける |
| 全 backend を同時実装する     | ✗    | response protocol、failed response、usage 抽出、session id 抽出の差が大きく、単一変更にまとめると検証範囲が広がりすぎる             |
| Claude のみ実装する           | ✗    | Codex は `exec resume` が明示的に存在し、token cache 利用の期待が大きい                                                             |

## 6. テスト方針

### 自動テスト

- `scripts/observe-json.test.ts`
  - `lineage` / `backend_session` を observe JSON に merge できる
  - `run_context.repo_root` / `worktree_root` / `git_head` を observe JSON に merge できる
  - resume handle が無い observe JSON は follow-up 不可として判定される
  - `backend_session.persistence` が `resumable` ではない通常 run は follow-up 不可として判定される
  - backend / model / repo root / worktree root mismatch は fail-closed になる
  - 記録 `git_head` が現在 HEAD と一致または現在 HEAD の ancestor なら follow-up 可、ancestor 関係が無ければ fail-closed になる
  - unsupported backend は新規実行へ暗黙 fallback しない
- shell wrapper fixture
  - Claude / Codex の通常実行、resumable initial run、follow-up command 組み立てが分岐する
  - response_file 未生成時の failed response 生成が維持される
  - `npm run sync-shared:check` で generated copy drift が出ない

### 手動確認

- [ ] `DELEGATE_WORK_DIR=.temp/delegate/session-reuse-poc` で Claude resumable initial run が response_file、resumable handle、run_context を生成する
- [ ] 同じ Claude session へ follow-up し、新しい response_file が生成される
- [ ] 通常 Claude run を follow-up 対象にした場合、failed response で止まる
- [ ] `DELEGATE_WORK_DIR=.temp/delegate/session-reuse-poc` で Codex resumable initial run が response_file、resumable handle、run_context を生成する
- [ ] 同じ Codex session へ follow-up し、新しい response_file が生成される
- [x] `DELEGATE_WORK_DIR=.temp/delegate/session-reuse-poc` で Devin initial run が response_file と export `session_id` を生成する
- [x] 同じ Devin session へ follow-up し、新しい response_file が生成される
- [x] `agent create-chat` で Cursor chat id を生成する
- [x] 同じ Cursor chat id で initial run と follow-up を実行し、それぞれ新しい response_file が生成される
- [ ] worker がコミットを作った resumable initial run の後、follow-up が git_head 検証（run 終了後 HEAD との比較）を通過する
- [ ] resume handle 欠落時に follow-up が failed response で止まる
- [ ] repo root / worktree root mismatch、または ancestor 関係の無い git head で follow-up が failed response で止まる
- [ ] `vp check`
- [ ] `vp test`
- [ ] `npm run sync-shared:check`

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 通常 delegate 実行の CLI 引数、run_dir、response protocol が後方互換である
- resumable initial run は delegate 種別だけで自動固定されず、親が初回 request で明示した場合だけ使われる
- resumable initial run は通常 delegate とは明示的に区別され、resume handle と run_context を observe JSON に記録する
- follow-up delegate は前回の resumable run を明示指定した場合だけ backend resume を使う
- follow-up delegate は新しい response_file / observe_file を生成し、前回 run との lineage と run 終了後の run_context を記録する
- resumable initial run の persistence 結果（`resumable` / `unavailable`）を親が response 読了時に observe JSON で確認できる
- 通常 run、resume handle が無い run、unsupported backend、repo/worktree mismatch、ancestor 関係の無い git head では fail-closed する
- support 対象 backend の live PoC と自動テストが通る。Devin / Cursor は PoC 済み、Claude / Codex は wrapper 実装前に PoC を完了する
- README / README_ja / design docs が実装と一致している

## 8. 想定リスクと回避策

| リスク                                              | 回避策                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stale context による誤修正                          | follow-up request に親の最新確認結果と対象 diff を必ず含め、親の最終 diff 確認を維持する                                                                                                                                                                                              |
| session file の保持期間が伸びる                     | resumable initial run だけ session を残す。Codex は lineage home が run_dir 配下にあり retention 対象。Claude は lineage scoped `CLAUDE_CONFIG_DIR` で work dir 配下へ隔離して retention 対象に含め、隔離が成立しない場合は retention 対象外である旨と cleanup 手段を docs に明記する |
| resume handle 抽出失敗を親が見落とす                | 初回読了時に observe JSON の `backend_session.persistence` 確認を必須化し、follow-up 実行時も fail-closed で検出する                                                                                                                                                                  |
| resumable initial run が過剰に使われる              | skill docs に発火条件を明記し、通常 delegate の既定挙動は非永続のまま維持する                                                                                                                                                                                                         |
| 並行 delegate が `--last` / `--continue` を誤用する | 明示 resume id だけを使い、`--last` / bare `--continue` は wrapper で使わない                                                                                                                                                                                                         |
| backend CLI の resume 仕様変更                      | live PoC と wrapper fixture を分け、unsupported 時は fail-closed にする                                                                                                                                                                                                               |
| response protocol と resume 会話がずれる            | response_file は毎 run 新規生成し、worker prompt に新しい request/response path を渡す                                                                                                                                                                                                |
| token cache 効果が観測できない                      | `observe.usage` と backend usage source を記録し、効果測定は実測値ベースで行う                                                                                                                                                                                                        |

## 9. 参考

内部 docs:

- [spec.md](../design/spec.md)
- [protocol-v1.md](../design/protocol-v1.md)
- [development.md](../design/development.md)
- [delegate-implement.md](../design/delegate-implement.md)
- [delegate-worker-backend-usage-streams.md](delegate-worker-backend-usage-streams.md)

backend 公式 docs:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex CLI command line options](https://developers.openai.com/codex/cli/reference)
- [Devin CLI Commands & Flags](https://docs.devin.ai/cli/reference/commands.md)
- [Devin API sessions index](https://docs.devin.ai/llms.txt)
- [Devin API Send a message to an enterprise session](https://docs.devin.ai/api-reference/v3/sessions/post-enterprise-sessions-messages.md)
- [Devin API Send a message to an organization session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages.md)
- [Cursor CLI overview](https://cursor.com/docs/cli/overview)
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters.md)
- [Cursor CLI usage](https://cursor.com/docs/cli/using.md)
