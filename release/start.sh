#!/usr/bin/env sh
set -eu

cd -- "$(dirname -- "$0")"
mkdir -p audiobooks data

echo "Starting OperaLibre..."
echo "Press Ctrl+C to stop the server."
echo

exec ./operalibre-server
