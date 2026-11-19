#!/usr/bin/env bash
# Cryptographic inventory of the deployment with QoreScan (CycloneDX 1.6 CBOM), plus the DORA mapping and the
# crypto-agility template. Reads only: the role accounts' key status, the TLS endpoints, the Solidity sources.
set -euo pipefail
cd "$(dirname "$0")/.."
ROLES="qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly qor1gp6jjx2u7h6vrcv2h4rtsxp0al8h4mv37sn064 qor17q0jps4cvvg2x6xm3d2d44pev4shh4lx3x50re qor122d73j03vxdzvwlpvzdze30s0gejn2q8g252h7 qor1z0y4zrt2pkxmrgzzvh2cws5azlvf66zckvkx9w"
ARGS=(); for a in $ROLES; do ARGS+=(-address "$a"); done
QS="npx -y @qorechain/qorescan@0.1.0"
$QS scan -name agama-qorechain -network testnet "${ARGS[@]}" \
  -tls evm-testnet.qore.host:443 -tls api-testnet.qore.host:443 \
  -solidity contracts/src -out docs/cbom/agama-qorechain.cdx.json
$QS report -framework dora -cbom docs/cbom/agama-qorechain.cdx.json -out docs/cbom/dora.md
$QS template agility -cbom docs/cbom/agama-qorechain.cdx.json -out docs/cbom/agility.md
echo "docs/cbom written"
