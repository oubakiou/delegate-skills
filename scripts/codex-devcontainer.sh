#!/bin/sh
set -eu

echo "WARNING: codex-devcontainer does not provide isolation; full-access Codex can reach available files, credentials, services, and network resources. Run it only inside an external isolation boundary such as the included Dev Container, a dedicated VM, an ephemeral CI runner, or another hardened container." >&2

if [ "${1:-}" = "--unattended" ]; then
  shift
  exec codex exec --dangerously-bypass-approvals-and-sandbox "$@"
fi

for arg in "$@"; do
  case "$arg" in
    --dangerously-bypass-approvals-and-sandbox | --dangerously-bypass-approvals-and-sandbox=* | \
      --yolo | --yolo=* | --full-auto | --full-auto=* | \
      --ask-for-approval | --ask-for-approval=* | -a | -a=* | -a?* | \
      --sandbox | --sandbox=* | -s | -s=* | -s?* | \
      --config | --config=* | -c | -c=* | -c?* | \
      --profile | --profile=* | -p | -p=* | -p?* | \
      --remote | --remote=* | --remote-auth-token-env | --remote-auth-token-env=*)
      echo "codex-devcontainer: normal mode does not allow policy override argument: $arg" >&2
      exit 1
      ;;
  esac
done

exec codex --sandbox danger-full-access --ask-for-approval on-request "$@"
