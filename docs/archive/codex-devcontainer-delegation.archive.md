# 外部隔離境界を前提とする Codex requester delegation 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Farchive%2Fcodex-devcontainer-delegation.archive.md)

[spec.md の委譲アーキテクチャ](../design/spec.md#2-アーキテクチャ概要)と
[development.md の test execution capability](../design/development.md#テスト)に対応し、requester と delegate worker を外部隔離境界の内側で動かす運用における Codex の実行境界を定義する。

本計画の結論は、requester / child Codex では inner OS sandbox を重ねず、その外側に operator が管理する security boundary を置く構成を採用することである。同梱の non-privileged Dev Container を既定実装とするが、専用 VM、一時的な CI runner、別の hardened container も同じ役割を担える。requester は `--sandbox danger-full-access` で起動し、child は現行の `codex exec --sandbox danger-full-access` を維持する。Codex app-server、`externalSandbox`、managed permission profile はこの構成には不要である。

この文書は、すべての coding agent を信頼できる外部隔離境界の内側で動かす運用を対象とする。通常 laptop や共有 host で launcher を使うと警告して続行するが、その host 自体を境界として推奨するものではない。利用者は同梱 Dev Container または同等に hardening した専用環境を選ぶ。

## 1. 対応スコープ

| 要件                                                               | 開始時の状態                                                                             | 完了条件                                                                                                        | 最終状態                       | 状態 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---- |
| [MUST] requester Codex から契約テストと delegate を起動できる      | requester の inner sandbox で Node anonymous pipe、network、nested `bwrap` が失敗する    | 同梱 Dev Container 内の requester から canonical test と最小 Codex delegate が成功する                          | test / real delegate 実測済み  | 完了 |
| [MUST] sandbox owner を外部隔離境界に一意化する                    | requester、child、host sandbox の責任が混在している                                      | requester / child の Codex sandbox を境界と数えず、mount・namespace・credential・egress の owner を明記する     | 契約を §3 に定義               | 完了 |
| [MUST] full-access 起動ごとに外部境界の必要性を警告する            | child Codex は環境を問わず `danger-full-access` が既定                                   | launcher が環境を安全と推測せず、到達範囲と外部隔離の必要性を毎回1回警告して起動する                            | 毎回警告する launcher          | 完了 |
| [MUST] Dev Container 自体を境界として成立させる                    | `docker-in-docker` feature が outer container を privileged にする                       | 通常 profile が non-privileged で、host Docker socket、host PID/network namespace、不要な host mount を持たない | 通常 profile を実測済み        | 完了 |
| [MUST] Codex 固有の full-access 条件を利用者へ公開する             | README には child Codex の sandbox 無効化と必要な outer boundary が明記されていない      | README / README_ja が起動条件、保護されない資産、Dev Container の注意点を説明する                               | 本計画と同時に注意を追加       | 完了 |
| [SHOULD] delegate の資格情報 lifecycle と MCP authority を定義する | `auth.json` と MCP config を isolated `CODEX_HOME` へコピーし、失敗 run では auth も残す | auth copy は成否にかかわらず削除し、MCP 継承の設計判断・実装・テスト・公開説明が一致する                        | auth cleanup と MCP 契約を実装 | 完了 |
| [SHOULD] inner sandbox 無しの運用を一度だけ qualification する     | test preflight は失敗を検出するが、container 境界自体は検証しない                        | image build / container start で境界と process capability を検証し、delegate ごとの probe は増やさない          | 2026-07-21 に実測              | 完了 |

スコープ外:

- 通常 laptop や共有 Linux host 自体を `danger-full-access` の安全な境界にすること: launcher の warning は isolation を追加しない
- task kind ごとの完全な read-only 強制: inner sandbox を外すため、`explore` / `review` の非書き込みは prompt と main の diff 検証に依存する
- 隔離環境内の mounted workspace、filesystem、credentials を悪意ある agent から保護すること: これらは同じ trust domain に属する
- Codex app-server client の実装: CLI の既存 surface で必要条件を満たすため採用しない

## 2. ベースライン / リファレンス

### 2.1 同梱 Dev Container の根拠となる公式運用

Codex の公式 security guide は、Dev Container を outer isolation boundary とする運用を明示している。container を意図した境界にする場合は、container 内で `--sandbox danger-full-access` を使い、Codex が二つ目の sandbox を作らない構成を選べる。一方、full access の agent は container 内の Codex credentials を含むすべてを読み出せるため、trusted repository と限定された credential scope が前提になる。

| 公式仕様                                                                                                               | 本計画での扱い                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)                                  | 外部隔離境界内で `danger-full-access` を採用し、境界内 asset は保護対象外とする            |
| [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)                                            | child は外部隔離境界内で `codex exec --sandbox danger-full-access` と `--ephemeral` を使う |
| [Codex secure Dev Container example](https://github.com/openai/codex/blob/main/.devcontainer/devcontainer.secure.json) | mount と egress の参考にする。inner `bwrap` 用 capability は本計画では不要                 |
| [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)                     | `externalSandbox` は app-server client 用であり、CLI delegation のためには導入しない       |
| [Docker privileged mode](https://docs.docker.com/reference/cli/docker/container/run/#privileged)                       | privileged container は安全な host sandbox ではないため、通常の agent profile から除外する |

### 2.2 Step 2 適用前の Dev Container 実測

2026-07-21 時点の `.devcontainer/devcontainer.json` と実行中 container を確認した。

| 項目                      | 実測                                                                                                           | 判定                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| workspace                 | host の対象 repository だけを `/workspaces/delegate-skills` へ bind mount                                      | agent が repository と `.git` を変更・削除できることを受け入れる                                                  |
| Docker daemon             | `/var/run/docker.sock` は Dev Container 内の専用 daemon で、host Docker socket ではない                        | host daemon の直接公開は無い。ただし outer privileged mode は別の問題                                             |
| `docker-in-docker:2`      | feature manifest 自体が `"privileged": true` を要求                                                            | container を強い Linux host boundary とみなせない                                                                 |
| root capability           | `sudo` 後の root が全 capability、`Seccomp: 0`、read-write `/sys` を持つ                                       | [Docker の privileged mode の警告](https://docs.docker.com/reference/cli/docker/container/run/#privileged) と一致 |
| Docker Desktop            | container の外側に Docker Desktop Linux VM があり、host workspace だけが明示共有されている                     | macOS / Windows host には VM 境界が残るが、VM と共有 mount は full-access agent の到達範囲                        |
| repository の Docker 利用 | source、test、build から Docker CLI / daemon への依存は確認できず、主な参照は Dev Container のディスク運用のみ | 通常 profile から DinD を外す余地がある                                                                           |
| Codex child               | wrapper は既に `--sandbox danger-full-access` と `--ephemeral` を指定                                          | child 起動方式の変更は不要                                                                                        |
| canonical test            | requester の inner sandbox 外で `npm test` を実行し、36 files / 283 tests が成功                               | inner sandbox を外すだけで Node process / pipe preflight と全 test が成立                                         |
| real Codex delegate       | `gpt-5.6-luna` child が Node grandchild の sentinel を完全取得し、response / observe を生成                    | CLI 直接実行で worker command と model round trip が成立。成功 run の auth copy も削除済み                        |

Docker Desktop は Linux VM による追加境界を提供するが、privileged container は VM 内部と Docker Engine に強い権限を持つ。native Linux では VM 境界が無いため、Step 2 適用前の profile を security boundary として採用しない。Docker が必要な場合も、host Docker socket を mount する `docker-outside-of-docker` へ単純に置換しない。

### 2.3 Step 2 適用後の default profile

source、test、build script に Docker CLI / daemon 依存が無いことを再確認し、`docker-in-docker:2` とその lock entry を削除した。Docker 用の別 profile は、現時点で利用者がいないため追加しない。

| 項目                   | default profile の設定               | effective state                                                                                  |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| user                   | `remoteUser: "vscode"`               | base image に含まれる non-root `vscode` user で VS Code lifecycle command と terminal を実行する |
| init                   | `init: true`                         | container runtime の init が PID 1 となり、signal forwarding と zombie reaping を担う            |
| privilege / capability | `privileged: false`、`capAdd` なし   | privileged mode と追加 Linux capability を使わない                                               |
| namespace              | host namespace を選ぶ `runArgs` なし | host PID / network / IPC namespace を共有しない                                                  |
| mount                  | `mounts` なし                        | Dev Container が管理する workspace mount 以外の host path と host Docker socket を追加しない     |
| seccomp                | `securityOpt` なし                   | runtime の default seccomp / AppArmor または Docker Desktop の同等 isolation を無効化しない      |

この表は configuration contract を記録するもので、image rebuild 後の runtime 状態は Step 5 の container qualification で検証する。

## 3. 設計の中核

### 3.1 requester の外側に強制境界を置く

```mermaid
flowchart LR
  H["Operator environment"] --> B["External isolation boundary<br/>Dev Container / dedicated VM / ephemeral CI"]
  B --> R["Requester Codex<br/>danger-full-access"]
  R --> D[delegate wrapper]
  D --> C["Child Codex<br/>danger-full-access / ephemeral"]
  C --> W[worker commands]

  B -. recursive enforcement .-> R
  B -. recursive enforcement .-> C
  B -. recursive enforcement .-> W
```

同梱 Dev Container はこの外部境界の既定実装である。代替環境も、agent が変更できない mount、namespace、credential、egress、process lifecycle の制約を同等に所有する必要がある。launcher 自体はこれらの制約を提供しない。

Codex の sandbox と approval は次のように扱う。

| surface                  | 設定                                                               | 役割                                                                                         |
| ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| interactive requester    | `codex --sandbox danger-full-access --ask-for-approval on-request` | inner OS sandbox を省く。approval は operator UX として残すが security boundary には数えない |
| unattended requester     | `codex exec --dangerously-bypass-approvals-and-sandbox`            | 外層が十分に制御され、MCP / remote credential も限定した専用 run にだけ使う                  |
| normal Codex delegate    | 現行 `codex exec --sandbox danger-full-access --ephemeral`         | wrapper の one-shot protocol を維持する                                                      |
| resumable Codex delegate | `danger-full-access` + isolated `CODEX_HOME` の session            | 明示的な follow-up だけを保持し、隔離環境の寿命を越えるかは persistence 方針で決める         |

`danger-full-access` は inner filesystem / network sandbox を外すが、approval policy の選択を別に残せる。`--dangerously-bypass-approvals-and-sandbox` は sandbox と approval の両方を外すため、通常の interactive requester では既定にしない。

child wrapper の `CODEX_DELEGATE_SANDBOX` は互換性・診断用の override として維持する。qualification 対象は override 未設定時の `danger-full-access` とし、override を指定した経路は Dev Container の標準構成として保証しない。通常 run と resumable initial run は `--sandbox <value>`、follow-up は `-c sandbox_mode=<value>` で同じ値を適用する。

### 3.2 通常 Dev Container profile の必須契約

| 境界               | MUST                                                                                                 | SHOULD                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| privilege          | `privileged: false`、host PID / network / IPC namespace を共有しない                                 | default seccomp / AppArmor、non-root `remoteUser`、`init: true`                          |
| mount              | workspace 以外の host path を必要最小限にし、host Docker socket を mount しない                      | host `.gitconfig` が必要なら read-only、cache / `CODEX_HOME` は named volume             |
| Docker             | repository が Docker を必要としない通常 profile から `docker-in-docker` を外す                       | Docker が必要なら別 profile / remote builder に分離し、その profile を強い境界と称さない |
| credential         | container に入れた credential は requester / child / repository code から読めるものとして scope する | workflow 専用・短命 token、remote service ごとの最小権限、定期 rotation                  |
| network            | full access 時の Codex network policyを強制境界とみなさない                                          | 必要なら agent が変更できない外層 egress proxy / firewall で domain を制限               |
| process / resource | descendant process を同じ container / cgroup 内に留め、container stop でまとめて終了させる           | PID / memory / CPU limit と init による zombie reaping                                   |
| persistence        | workspace と明示 volume 以外は再作成可能にする                                                       | command history、auth、sessions、cache を別 volume に分け、寿命と削除手順を明記          |

Step 2 適用前の `docker-in-docker` feature は [feature manifest](https://github.com/devcontainers/features/blob/main/src/docker-in-docker/devcontainer-feature.json) で privileged を要求していた。Rootless DinD も outer `--privileged` を必要とするため、通常 agent profile の境界強化にはならない。Docker を使わない本 repository の通常作業では feature 自体を外す。

### 3.3 credential と MCP は外部隔離境界の内側にある

full-access agent からは次が読み取り・利用可能になる。

- root requester の `$CODEX_HOME/auth.json` または access token
- child isolated `CODEX_HOME` へコピーされた `auth.json`
- GitHub CLI、各 backend CLI、package registry の login state
- MCP server の command、URL、bearer token、environment value
- mounted workspace の source、`.git`、未 commit 差分

このため、isolated `CODEX_HOME` は security boundary ではなく、session/config の衝突を避ける operational isolation と位置付ける。現行の auth copy は実用上維持できるが、成功・失敗を問わず wrapper 終了時に削除する。cache prune の無効化は auth copy の削除を無効化しない。失敗診断には redacted event、exit status、session metadata を残し、credential 自体は残さない。

resumable initial run と follow-up は session JSONL と `config.toml` を含む isolated `CODEX_HOME` を再利用するが、auth copy 自体には依存しない。各 follow-up は起動時に root requester の auth を同じ session home へ再コピーし、終了時に再び削除するため、auth の短命化と session resume は両立する。

MCP 継承は full-access shell と別の remote authority を worker に与える。本計画では backend 間の互換性を優先し、親の user-scope MCP server 集合を isolated config へ注入する現行動作を維持する。config へ不要な secret value を複製せず、server/token 側で credential と tool scope を絞り、observe には server name だけを記録する。MCP 無しや server identity allowlist を必要とする環境は、別の hardening profile として扱う。

repository の信頼度によって、隔離環境へ渡す authority を分ける。

| 運用モード                    | credential / MCP                                                | persistence              | network                                                |
| ----------------------------- | --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| trusted repository の通常開発 | workflow に必要な login だけ。MCP は明示 server に限定          | root auth / cache を許可 | outbound を許可し、remote write は token scope で制限  |
| untrusted repository の確認   | GitHub write token と MCP を渡さず、必要なら一時 API credential | 隔離環境ごと破棄         | 採用 provider だけを外層で許可。任意 live web は無効化 |

untrusted repository に personal Codex / GitHub / MCP credential を同時に渡す構成は、外部隔離境界内であっても採用しない。

### 3.4 egress は用途別に二段階で扱う

最小構成では隔離環境の outbound network を許可する。これは dependency install、各 backend API、Web / MCP 調査を最も単純に動かせる一方、境界内 credential と source の exfiltration を技術的には防がない。

より厳しい運用では次の二段階に分ける。

1. setup phase: package install と tool update に必要な広い network を許可する
2. agent phase: agent が変更できない外層の egress proxy / firewall を使い、採用 backend、source control、明示 MCP endpoint だけを許可する

`danger-full-access` では Codex inner network proxy を外層の代替にしない。full access では live web search も利用可能になるため、不要なら `web_search = "disabled"` を隔離環境の Codex config に設定する。

### 3.5 launcher は起動ごとに外部隔離の必要性を警告する

repository の `.codex/config.toml` に無条件の `sandbox_mode = "danger-full-access"` を追加すると、repository を通常 host で開いた利用者にも適用され得る。このため、次の順で実装する。

1. launcher は実行環境が安全だと推測しない
2. normal / unattended のどちらも、launcher 自体が isolation を提供しないこと、full-access の到達範囲、外部隔離境界の必要性を stderr へ毎回1回警告して起動する
3. normal mode は execution boundary、sandbox、approval policy を上書きし得る利用者引数を拒否する

## 4. 実装ステップ

### Step 1: (完了済み) 適用前提と公開上の警告を定義する

- 同梱 Dev Container を既定とし、同等の外部隔離境界も利用できる条件と launcher が毎回出す warning を明記する
- README / README_ja に Codex child の full-access と outer boundary の必要条件を追加する

成果物: 本文書 + README 注意事項

### Step 2: (完了済み) 通常 Dev Container を non-privileged にする

- repository の Docker CLI / daemon 依存が無いことを最終確認する
- `.devcontainer/devcontainer.json` から `docker-in-docker:2` を外す
- Docker 依存が無いため privileged な別 profile は作成しない。将来必要になった場合は別名 profile へ分離し、通常 agent 起動では選択しない
- `remoteUser`、`init`、host namespace、mount、capability、seccomp の effective state を記録する

成果物: non-privileged default Dev Container + 必要なら明示的な別 Docker profile

### Step 3: (完了済み) requester の外部隔離 warning 付き起動経路を追加する

- 環境を安全と推測せず、外部隔離の必要性を毎回警告して Codex を起動する薄い launcher を追加する
- interactive 既定を `--sandbox danger-full-access --ask-for-approval on-request` にする
- unattended bypass は別 flag とし、README で追加条件を示す

`scripts/codex-devcontainer.sh` は実行環境を判定せず、launcher 自体が isolation を提供しないこと、full-access の到達範囲、同梱 Dev Container / 専用 VM / 一時的な CI runner / 別の hardened container など外部隔離境界の必要性を stderr へ毎回1回警告して Codex を `exec` する。通常 mode は `danger-full-access` と `on-request` を組み合わせ、argv 全体から execution boundary または policy を上書きし得る remote app-server flag、sandbox / approval flag、config、profile 選択を拒否する。`--unattended` を指定した場合だけ `codex exec` と approval bypass を launcher が構成する。launcher test は normal / unattended の warning が各1回であること、fake Codex の argv / PID、adversarial argv、fixture cleanup を検証する。README 英日と development guide に CLI launcher の利用手順を記載した。

成果物: 環境を安全と推測せず、外部隔離の必要性を毎回警告する requester launcher + 利用手順

### Step 4: (完了済み) Codex credential / MCP lifecycle を hardening する

- `auth.json` copy を wrapper の成否にかかわらず削除する
- cache prune の override から auth cleanup を分離し、session JSONL と `config.toml` は保持する
- config / observe / stderr の credential redaction test を追加する
- Codex MCP 継承が §5 の互換性維持判断と一致し、注入した server name だけを observe に記録することを確認する
- GitHub / backend / MCP credential の推奨 scope を README に追加する

通常 run / resumable initial / follow-up は起動直前に root requester の auth を isolated home と同じ directory の一意な owned staging file へ排他的に copy し、hard-link で stale destination を置換せず publish する。実 `copyFileSync` が destination 作成後に失敗しても staging file だけを削除して起動前に fail-closed する。auth lease は staging 開始前に登録し、owned staging / published artifact だけを追跡して cleanup 完了後に signal handler を解除する。wrapper lifecycle は stage → spawn/wait → auth cleanup → response/session/dispatch finalize の順で各1回とし、stage / cleanup 中、spawn 前後、child exit 後の SIGINT / SIGTERM race を含む wrapper 終了時に cleanup する。cleanup failure または同期 operation exception は resumable success metadata を残さない exactly-once の sanitized failed terminal state と非 0 exit に変える。cache prune の設定はこの cleanup に影響せず、session JSONL と `config.toml` は保持する。follow-up home は所有 user、非 symlink、`delegate_*` run と previous observe の session metadata 一致を確認し、root requester の real `CODEX_HOME` と無関係な external home を copy / config mutation / spawn 前に拒否する。既存の Codex MCP 継承判断は維持し、E2E test が注入 server name だけを observe に記録して command、URL、credential value を含めないことを確認する。README 英日、spec、development guide を同じ契約へ同期した。

成果物: secret cleanup + MCP authority contract

### Step 5: (完了済み) Dev Container qualification と real delegate を固定する

qualification 対象は repository が同梱する non-privileged Dev Container だけとする。専用 VM、一時的な CI runner、別の hardened container の安全性は operator が確認し、repository と launcher は検出、attest、自動 qualification を行わない。

- host から `Privileged=false`、host namespace 非共有、host Docker socket 非 mount を検証する
- container 内で Node sync / async pipe、multi-level process、canonical test を検証する
- requester Codex から最小の `gpt-*` delegate を一度実行する
- failure run 後に auth copy が無いことを検証する
- 2026-07-21 に non-privileged default profile を再 build し、process capability、`npm test`（37 files / 352 tests）、`gpt-5.6-luna` delegate、実 child failure 後の auth cleanup、container stop 後の process lifecycle を確認した。実測値と再現コマンドは [qualification report](../feature/codex-devcontainer-qualification.md) に記録した

成果物: container boundary report + test / delegate の成功記録

### Step 6: (完了済み) 永続文書へ反映する

- `docs/design/spec.md` に外部隔離境界、requester / child Codex の full-access、launcher の非保証契約を反映済み
- `docs/design/development.md` の requester launcher 説明と Step 5 qualification report への導線は反映済み
- 本文書の完了項目を更新し、`docs/archive/codex-devcontainer-delegation.archive.md` へ archive 済み

成果物: design / development 更新 + archive 判断

## 5. 設計判断

### a. Codex integration surface

| 候補                                     | 採用 | 理由                                                                               |
| ---------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| **CLI `danger-full-access`**             | ✓    | 現行 wrapper と公式 Dev Container guidance に一致し、追加 daemon / protocol が不要 |
| app-server `externalSandbox`             | ✗    | rich client protocol が不要で、transport と privileged control plane だけが増える  |
| inner `workspace-write` + nested `bwrap` | ✗    | 外部隔離境界と責任が重複し、今回の pipe / namespace 制約を再導入する               |
| managed permission profile               | ✗    | CLI launcher と operator-managed external boundary には fleet rollout が過剰       |

### b. requester の approval policy

| 候補                                         | 採用     | 理由                                                                        |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| **`danger-full-access` + `on-request`**      | ✓        | inner sandbox を外しつつ、interactive な operator UX と MCP prompt を残せる |
| `--dangerously-bypass-approvals-and-sandbox` | 条件付き | unattended 専用。remote credential と MCP を限定した run では最も単純       |
| project config に無条件の full access        | ✗        | host で repository を開いた利用者へ誤適用される                             |

### c. Docker capability

| 候補                                     | 採用     | 理由                                                                                   |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| **通常 profile から DinD を外す**        | ✓        | repository runtime に Docker 依存がなく、privileged mode を除去できる                  |
| privileged DinD を通常 profile に残す    | ✗        | native Linux で host boundary とみなせず、Docker Desktop VM 内の attack surface も広い |
| host Docker socket を mount する         | ✗        | agent に host daemon 相当の権限を与え、container boundary を崩す                       |
| Docker 専用の別 profile / remote builder | 条件付き | Docker が必要な作業だけ明示的に選び、通常 coding agent と分離できる                    |

### d. network enforcement

| 候補                                                | 採用     | 理由                                                         |
| --------------------------------------------------- | -------- | ------------------------------------------------------------ |
| **同梱 Dev Container の通常開発は outbound を許可** | ✓        | backend、dependency、Web / MCP の互換性を保ち、最も単純      |
| 外層 egress allowlist                               | 条件付き | secret exfiltration を threat model に含める環境で採用       |
| Codex inner network proxy だけに依存                | ✗        | `danger-full-access` では outer enforcement の代替にならない |

### e. MCP authority

| 候補                                                 | 採用     | 理由                                                                                      |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| **親の user-scope MCP server 集合を継承する**        | ✓        | backend 間の互換性を維持し、既存 skill の MCP 利用契約を変えない                          |
| skill ごとの server opt-in / identity allowlist      | 将来候補 | remote authority を縮小できるが、skill metadata と設定移行を含む別の hardening 設計が必要 |
| MCP config と credential value を observe に記録する | ✗        | 診断 artifact から secret が漏れるため、server name だけを記録する                        |

## 6. テスト方針

### 自動確認

- `scripts/test-execution-capability.ts`
  - Node 24 の sync pipe に spawn error が無く sentinel stdout が完全一致する
  - async Node child の stdout が close 前に drain される
- wrapper test
  - override 未設定の通常 run が `--sandbox danger-full-access --ephemeral` を使う
  - resumable initial run は `--sandbox danger-full-access` を使い、`--ephemeral` を使わない
  - follow-up は `-c sandbox_mode=danger-full-access` を使い、`--sandbox` と `--ephemeral` を使わない
  - `CODEX_DELEGATE_SANDBOX` override が通常・resumable・follow-up の各経路へ反映される
  - 成功 / child error / response missing / signal termination のすべてで auth copy を削除する
  - `DELEGATE_CODEX_HOME_PRUNE=0` でも auth copy を削除し、session JSONL と `config.toml` は保持する
  - resumable initial と follow-up の各起動で auth を再コピーし、終了時に削除する
  - 親から注入した MCP server name と observe の記録が fixture と一致し、credential value を記録しない
- launcher test
  - 通常 / unattended の各起動で warning を1回出し、期待 argv を exec する
  - 利用者引数から execution boundary、sandbox、approval policy を上書きする経路を拒否する

### 同梱 Dev Container qualification

この checklist は同梱 default profile の reference qualification であり、代替の外部隔離境界を検証するものではない。

- [x] host の `docker inspect` で `Privileged=false` である
- [x] host PID / network / IPC namespace を共有していない
- [x] host Docker socket と host `$HOME` が mount されていない
- [x] host から公開された writable mount が workspace と明示した named volume だけである
- [x] default seccomp / AppArmor または同等の Docker Desktop isolation が有効である
- [x] requester から `npm test` が canonical baseline 以上の件数で成功する
- [x] requester から最小 Codex delegate が response / observe を生成する
- [x] container stop 後に requester / child / worker process が残らない

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- 通常 Dev Container が non-privileged で host Docker socket と host namespace を公開しない
- requester Codex を `danger-full-access` で起動でき、launcher が環境によらず外部隔離の warning を毎回1回出す
- 同梱 Dev Container で Node sync / async pipe、canonical test、実 Codex delegate が成功する
- 代替の外部隔離境界は operator が mount、namespace、credential、egress、process lifecycle を確認し、repository や launcher が安全性を保証しない
- child Codex に app-server、`externalSandbox`、managed permission profile、追加 capability probe を導入していない
- mounted repository、隔離環境内 credentials、MCP、remote service authority が保護対象外であることを README が説明する
- auth copy が成功・失敗を問わず isolated `CODEX_HOME` / `session_home` に残らず、resumable session artifact は follow-up に再利用できる
- MCP 継承動作、observe に記録する server name、README の remote authority 説明が §5 の設計判断と一致する
- design / development / README / README_ja が実装と一致する

## 8. 想定リスクと回避策

| リスク                                                           | 回避策                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| full-access agent が mounted repository や `.git` を破壊する     | clean branch、頻繁な commit、host backup、main による diff review を rollback boundary とする                                              |
| 隔離環境内の OpenAI / GitHub / MCP credential を持ち出す         | trusted repository、短命・最小 scope credential、失敗時を含む cleanup、必要なら外層 egress allowlist                                       |
| prompt injection が live web / MCP / shell を利用する            | 不要な web / MCP を無効化し、remote write authority を server/token 側で制限する                                                           |
| privileged DinD により container escape の影響が広がる           | 通常 profile から除去する。Docker Desktop では必要に応じ Enhanced Container Isolation、native Linux では別 runner を使う                   |
| operator が通常 host で full-access launcher を実行する          | launcher が isolation を提供しないことと外部隔離の必要性を毎回1回警告する。project config へ full access を固定しない                      |
| `on-request` を security boundary と誤認する                     | approval は UX / audit と明記し、強制境界は operator-owned VM / hypervisor / container / CI controls と remote credential scope に限定する |
| persistent volume が container recreate 後も auth/history を残す | `CODEX_HOME`、history、cache を別 volume にし、削除・rotation 手順と retention を定義する                                                  |

## 9. 参考

- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex secure Dev Container example](https://github.com/openai/codex/blob/main/.devcontainer/devcontainer.secure.json)
- [Dev Container docker-in-docker feature manifest](https://github.com/devcontainers/features/blob/main/src/docker-in-docker/devcontainer-feature.json)
- [Docker privileged mode](https://docs.docker.com/reference/cli/docker/container/run/#privileged)
- [Docker Desktop container security FAQ](https://docs.docker.com/security/faqs/containers/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [spec.md](../design/spec.md)
- [development.md](../design/development.md)
