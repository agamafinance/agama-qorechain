#!/bin/zsh
# The on-chain campaign: ROUNDS (3) rounds of every battery against the live keeper and app, fresh lenders each
# round, then the post-quantum audit. Stops when the operator drops under 150 QOR, so the keeper keeps its runway.
# One line per suite in $CAMPAIGN_LOGS/summary.txt, a full log per suite next to it.
#
#   ROUNDS=3 BASE=300 APP_URL=https://app.agama.finance/qorechain scripts/campaign.sh
R=${0:A:h:h}; L=${CAMPAIGN_LOGS:-/tmp/agama-campaign}; mkdir -p $L; S=$L/summary.txt; : > $S
APP=${APP_URL:-https://app.agama.finance/qorechain}; B=${BASE:-300}
OP=qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly; RL=qor1pxv6l32qguyrv3xp0hpxehqd9mmlcdwp8c3qmg; TR=qor15hx7a24fw3rtam04j7elx6kx3x4zp6nhpp5jlm
bal() { curl -s -A curl/8.7.1 "https://api-testnet.qore.host/cosmos/bank/v1beta1/balances/$1/by_denom?denom=uqor" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["balance"]["amount"])//1000000)'; }
run() { local name=$1; shift; local log=$L/r${ROUND}-$name.log; local t0=$SECONDS
  ( "$@" ) > $log 2>&1; local c=$?
  local p=$(grep -c '^ *PASS' $log); local f=$(grep -c '^ *FAIL' $log); local tally=$(grep -oE '^[0-9]+/[0-9]+ ' $log | tail -1)
  echo "round $ROUND  $name  ${${c:#0}:+EXIT $c  }pass=$p fail=$f ${tally:+ ($tally)} $((SECONDS-t0))s" >> $S; }
# One hash per kind of hybrid transaction the round's batteries printed: the lenders' messages and the keeper's acts.
kinds() { cat $L/r${ROUND}-battery.log $L/r${ROUND}-pq-battery.log 2>/dev/null | python3 -c '
import re, sys
seen = {}
for line in sys.stdin:
    m = re.search(r" pq (.+?) for 0x.*?: ([0-9A-F]{64})", line) or re.search(r"^\s+qore (.+?)\s{2,}([0-9A-F]{64}).*\(native, hybrid\)", line)
    if m: seen.setdefault(re.sub(r"[^A-Za-z0-9]+", "-", m.group(1)).strip("-"), m.group(2))
print("\n".join(f"{k}={v}" for k, v in list(seen.items())[:12]))'; }
for ROUND in $(seq 1 ${ROUNDS:-3}); do
  ob=$(bal $OP); echo "round $ROUND start: operator $ob QOR, relayer $(bal $RL), treasury $(bal $TR)" >> $S
  [ "$ob" -lt 150 ] && { echo "stop: operator under 150 QOR" >> $S; break; }
  cd $R/keeper
  run battery env BATTERY_BASE=$((B+ROUND*20)) npx tsx src/battery.ts
  run pq-battery env PQ_BASE=$((B+10+ROUND*20)) npx tsx src/pq-battery.ts
  run e2e npx tsx src/e2e.ts
  run pq-check npx tsx src/pq-check.ts
  run bridge-check npx tsx src/bridge-check.ts
  run new-lender npx tsx src/new-lender.ts $((B+300+ROUND))
  cd $R/web
  run browser env APP_URL=$APP node e2e/browser.mjs
  run onboarding env APP_URL=$APP LENDER_INDEX=$((B+300+ROUND)) node e2e/onboarding.mjs
  run locked env APP_URL=$APP node e2e/locked.mjs
  run explorer node e2e/explorer.mjs ${(f)"$(kinds)"}
done
cd $R/keeper; ROUND=final; run pq-audit npx tsx src/pq-audit.ts
echo "end: operator $(bal $OP), relayer $(bal $RL), treasury $(bal $TR)" >> $S
echo DONE >> $S
