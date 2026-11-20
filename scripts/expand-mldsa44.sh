#!/usr/bin/env bash
# Expands an ML-DSA-44 public key for the on-chain verifier, with ZKNox's reference implementation.
#   scripts/expand-mldsa44.sh <public key hex>     prints the expanded key (ABI-encoded) on stdout
set -euo pipefail
cd "$(dirname "$0")/.."
REF=contracts/lib/ETHDILITHIUM/pythonref
VENV=${VENV:-.venv-mldsa}
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV" >/dev/null
  "$VENV/bin/pip" -q install -r "$REF/requirements.txt" >/dev/null
fi
PYTHONPATH="$REF" "$VENV/bin/python" scripts/expand_mldsa44.py "$1"
