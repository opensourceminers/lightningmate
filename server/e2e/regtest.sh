#!/bin/bash
# A local regtest network for server/e2e: bitcoind and three LND nodes (seller, hub, buyer).
# Nothing here touches a real network. See docs/E2E-TESTING.md.
#   LND_DIR=… BITCOIN_DIR=… REGTEST_DIR=… regtest.sh up | down
# "up" starts afresh and prints the two variables the checks need.
set -u
: "${LND_DIR:?folder with lnd and lncli}"
: "${BITCOIN_DIR:?folder with bitcoind and bitcoin-cli}"
: "${REGTEST_DIR:?an empty folder for the nodes}"
RUN=$REGTEST_DIR
stop() { for n in buyer hub seller btc; do [ -f "$RUN/$n.pid" ] && kill "$(cat "$RUN/$n.pid")" 2>/dev/null; rm -f "$RUN/$n.pid"; done; }
if [ "${1:-}" = down ]; then stop; echo stopped; exit 0; fi

stop; sleep 3; rm -rf "$RUN"; mkdir -p "$RUN/btc"
BC="$BITCOIN_DIR/bitcoin-cli -regtest -datadir=$RUN/btc -rpcuser=u -rpcpassword=p -rpcport=18543"
nohup "$BITCOIN_DIR/bitcoind" -regtest -datadir="$RUN/btc" -rpcuser=u -rpcpassword=p -rpcport=18543 -port=18544 -listen=0 -txindex=1 -fallbackfee=0.00002 \
  -zmqpubrawblock=tcp://127.0.0.1:28532 -zmqpubrawtx=tcp://127.0.0.1:28533 > "$RUN/btc.log" 2>&1 &
echo $! > "$RUN/btc.pid"
for _ in $(seq 1 60); do $BC getblockchaininfo >/dev/null 2>&1 && break; sleep 0.5; done
$BC createwallet miner >/dev/null 2>&1
$BC generatetoaddress 110 "$($BC -rpcwallet=miner getnewaddress)" >/dev/null

start() { # name rpc-port p2p-port extra-flags
  mkdir -p "$RUN/$1"
  # shellcheck disable=SC2086
  nohup "$LND_DIR/lnd" --lnddir="$RUN/$1" --bitcoin.regtest --bitcoin.node=bitcoind --bitcoind.rpchost=127.0.0.1:18543 --bitcoind.rpcuser=u --bitcoind.rpcpass=p \
    --bitcoind.zmqpubrawblock=tcp://127.0.0.1:28532 --bitcoind.zmqpubrawtx=tcp://127.0.0.1:28533 --noseedbackup --alias="$1" --rpclisten=127.0.0.1:"$2" --listen=127.0.0.1:"$3" \
    --restlisten=127.0.0.1:$(($2 + 50)) --protocol.wumbo-channels --bitcoin.defaultchanconfs=1 --unsafe-disconnect $4 --debuglevel=info --trickledelay=100 --gossip.channel-update-interval=1s \
    > "$RUN/$1.log" 2>&1 &
  echo $! > "$RUN/$1.pid"
}
# The seller dials like a node with Tor: through the SOCKS proxy the checks run (regtest.ts, SOCKS_PORT).
start seller 20109 29735 "--tor.active --tor.socks=127.0.0.1:19150"
start hub 20209 29736 ""
start buyer 20309 29737 ""
for n in "seller 20109" "hub 20209" "buyer 20309"; do
  # shellcheck disable=SC2086
  set -- $n
  for _ in $(seq 1 120); do
    "$LND_DIR/lncli" --network=regtest --lnddir="$RUN/$1" --rpcserver=127.0.0.1:"$2" getinfo 2>/dev/null | grep -q '"synced_to_chain": *true' && break
    sleep 0.5
  done
done
echo "up. For the checks:"
echo "export REGTEST_DIR=$RUN"
echo "export REGTEST_BITCOIN_CLI=\"$BC\""
