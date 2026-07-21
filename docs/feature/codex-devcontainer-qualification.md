# 同梱 Dev Container qualification report

実施日: 2026-07-21

対象 revision: `9bfaba4`。`.devcontainer/devcontainer.json` と test / delegate source に未コミット差分が無い状態で、Dev Containers CLI 0.87.0 から build した default profile

## 結果

| 確認項目           | 結果 | 実測                                                                                 |
| ------------------ | ---- | ------------------------------------------------------------------------------------ |
| privilege          | pass | `Privileged=false`、追加 capability なし                                             |
| namespace          | pass | host PID 非共有、`NetworkMode=bridge`、`IpcMode=private`                             |
| host mount         | pass | writable bind mount は workspace だけ。host Docker socket と host home の mount なし |
| runtime security   | pass | Docker Engine の built-in seccomp と cgroup namespace が有効                         |
| process capability | pass | sync / async child-process preflight と3階層 Node process が成功                     |
| canonical test     | pass | 37 files / 352 tests                                                                 |
| real delegate      | pass | `gpt-5.6-luna` が completed response / ended observe と `STEP5_DELEGATE_OK` を生成   |
| failure cleanup    | pass | 無効 model の実 child failure 後も isolated auth copy / staging file なし            |
| process lifecycle  | pass | stop 後は `Running=false`、`Pid=0`。一時 credential を削除して container も削除      |

Dev Containers CLI は image build と container start を完了した後、worktree の `postCreateCommand` が Devin CLI の対話 login で exit 1 になった。boundary と runtime の qualification は起動済み container に対して継続した。この結果は non-interactive setup 全体の成功を意味しない。

## 再現コマンド

repository root で実行する。`--remove-existing-container` は同名の既存 container を停止・削除するため、対象名を確認し、この qualification 専用 container にだけ実行する。

```sh
QUAL_REPO_ROOT="$(pwd -P)"
QUAL_CONTAINER_NAME="${USER}-delegate-skills"
docker ps -a --filter "name=^/${QUAL_CONTAINER_NAME}$"
npx -y @devcontainers/cli@0.87.0 up \
  --workspace-folder "${QUAL_REPO_ROOT}" \
  --remove-existing-container
docker inspect "${QUAL_CONTAINER_NAME}"
docker info
```

container 内の capability と canonical test:

```sh
node scripts/test-execution-capability.ts
node -e 'const {spawnSync}=require("node:child_process"); const child=spawnSync(process.execPath,["-e","const {spawnSync}=require(\\"node:child_process\\");const grandchild=spawnSync(process.execPath,[\\"-e\\",\\"process.stdout.write(\\\\\\"LEVEL3_OK\\\\\\")\\"],{encoding:\\"utf8\\"});if(grandchild.status!==0||grandchild.stdout!==\\"LEVEL3_OK\\")process.exit(1);process.stdout.write(\\"LEVEL2_OK\\")"],{encoding:"utf8"}); if(child.status!==0||child.stdout!=="LEVEL2_OK")process.exit(1); process.stdout.write("MULTILEVEL_OK\\n")'
npm test
```

real delegate は `DELEGATE_WORK_DIR` を `/tmp` 配下に固定し、`delegate-explore` の one-shot `run.sh` へ read-only の sentinel request を渡した。成功 run と無効 model の failure run の後、両 run directory に `auth.json` と `.auth.json.stage-*` が無いことを確認した。この report には sentinel と terminal state だけを記録し、credential value、response 全文、child stderr、MCP config は保存していない。

停止確認:

```sh
docker stop "${QUAL_CONTAINER_NAME}"
docker inspect --format 'running={{.State.Running}} status={{.State.Status}} pid={{.State.Pid}}' "${QUAL_CONTAINER_NAME}"
docker rm "${QUAL_CONTAINER_NAME}"
```

最後の `docker rm` は停止済み qualification container を削除する。別用途の container 名を指定しない。
