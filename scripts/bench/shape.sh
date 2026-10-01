#!/bin/sh
# Shapes everything this container sends: a rate in Mbit/s, a one-way delay and jitter in ms, and a
# loss in percent. RATE=0 removes the shaping.
set -e
if [ "${RATE:-0}" = "0" ]; then
  tc qdisc del dev eth0 root 2>/dev/null || true
  exit 0
fi
tc qdisc replace dev eth0 root netem rate "${RATE}mbit" delay "${DELAY:-0}ms" "${JITTER:-0}ms" loss "${LOSS:-0}%" limit "${LIMIT:-1000}"
