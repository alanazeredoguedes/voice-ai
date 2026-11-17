#!/usr/bin/env bash
# Mostra como está a última release na GitHub e, se algum build falhou, o final do log do erro.
#   tools/release-logs.sh           última execução do workflow Release
#   tools/release-logs.sh --watch   acompanha a execução em andamento até terminar
#   tools/release-logs.sh <id>      uma execução específica
# Precisa do GitHub CLI (gh) com login: gh auth login
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null; then
  echo "Instale o GitHub CLI (https://cli.github.com) e rode: gh auth login" >&2
  exit 1
fi

if [ "${1:-}" = "--watch" ]; then
  id=$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
  gh run watch "$id" --exit-status --interval 30 || true
  shift
  set -- "$id"
fi

id="${1:-$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')}"
gh run view "$id"

failed=$(gh run view "$id" --json jobs -q '.jobs[] | select(.conclusion == "failure") | .databaseId')
for job in $failed; do
  echo
  echo "================ log do job que falhou ($job) ================"
  gh run view --job "$job" --log-failed | sed -E 's/^[^\t]*\t[^\t]*\t//' | tail -n 120
done
