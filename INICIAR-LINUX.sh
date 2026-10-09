#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo 'Este iniciador é para Linux x86_64.' >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo 'Abra como seu usuário normal, sem sudo.' >&2
  exit 1
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Instale Node.js 24.19 ou superior, com npm. Veja LEIA-ME-LINUX.md.' >&2
  exit 1
fi
exec node scripts/linux-start.mjs "$@"
