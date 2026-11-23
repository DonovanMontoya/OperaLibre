#!/usr/bin/env bash
# Model-checks every TLA+ config under verification/ and asserts its expected
# outcome. Exits non-zero when a config that must break a rule passes, when a
# config that must pass breaks one, or when TLC fails for any other reason.
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"

root=$(cd "$(dirname "$0")" && pwd)
cache=${OPERALIBRE_TLA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/operalibre/tla}
jar="$cache/tla2tools-${TLA_VERSION}.jar"
java=${JAVA:-${JAVA_HOME:+$JAVA_HOME/bin/java}}
java=${java:-java}

# spec|config|expectation. "pass" must hold every invariant; "violate X" must
# break X.
checks=(
  "progress-replay/ProgressReplay.tla|current.cfg|pass"
  "progress-replay/ProgressReplay.tla|reliable-network.cfg|pass"
  "progress-replay/ProgressReplay.tla|prefix-0af3ac8c.cfg|violate NoOrphanedEdit"
  "progress-replay/ProgressReplay.tla|prefix-0af3ac8c-lost-reply.cfg|violate NoOrphanAfterLostReply"
  "progress-replay/ProgressReplay.tla|prefix-4c7bd6f6.cfg|violate PlayerShowsNewest"
  "progress-replay/ProgressReplay.tla|prefix-85fadfd4.cfg|violate PlayerShowsNewest"
  "progress-replay/ProgressReplay.tla|unrestored-save.cfg|violate NoResetToStart"
)

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ ! -f "$jar" ] || [ "$(sha256 "$jar")" != "$TLA_SHA256" ]; then
  mkdir -p "$cache"
  download=$(mktemp "$cache/download.XXXXXX")
  curl -fsSL --retry 3 -o "$download" "$TLA_URL"
  actual=$(sha256 "$download")
  if [ "$actual" != "$TLA_SHA256" ]; then
    rm -f "$download"
    echo "tla2tools.jar ${TLA_VERSION} has sha256 $actual, expected $TLA_SHA256" >&2
    exit 1
  fi
  mv "$download" "$jar"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
runs=0

# check NAME SPEC_DIR SPEC CONFIG_PATH pass|violate [INVARIANT]
check() {
  local name=$1 dir=$2 spec=$3 config=$4 kind=$5 invariant=${6:-}
  local log="$work/run-$runs.log" code violated other states ok=false started=$SECONDS
  runs=$((runs + 1))
  set +e
  (cd "$dir" && "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto \
    -metadir "$work/meta-$runs" -config "$config" "$spec") >"$log" 2>&1
  code=$?
  set -e
  violated=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' "$log" | sort -u | tr '\n' ' ')
  violated=${violated% }
  other=$(grep '^Error:' "$log" | grep -v '^Error: Invariant [A-Za-z0-9_]* is violated\.$' \
    | grep -v '^Error: The behavior up to this point is:$' || true)
  states=$(sed -n 's/.* \([0-9]*\) distinct states found.*/\1/p' "$log" | tail -1)
  if [ "$kind" = pass ]; then
    [ "$code" = 0 ] && [ -z "$violated" ] && [ -z "$other" ] \
      && grep -q '^Model checking completed. No error has been found.$' "$log" && ok=true
  else
    [ "$code" = 12 ] && [ "$violated" = "$invariant" ] && [ -z "$other" ] && ok=true
  fi
  local outcome="expected $kind${invariant:+ $invariant}; broke ${violated:-nothing}, ${states:-?} states, $((SECONDS - started))s"
  if $ok; then
    echo "ok    $name: $outcome"
  else
    failures=$((failures + 1))
    echo "FAIL  $name: $outcome, TLC exit $code"
    if grep -q '^Error:' "$log"; then sed -n '/^Error:/,$p' "$log" | head -200 || true
    else tail -20 "$log"; fi
  fi
}

for entry in "${checks[@]}"; do
  IFS='|' read -r spec config expectation <<<"$entry"
  read -r kind invariant <<<"$expectation"
  dir="$root/$(dirname "$spec")"
  name="$spec $config"
  case $kind in
    pass) check "$name" "$dir" "$(basename "$spec")" "$config" pass ;;
    violate) check "$name" "$dir" "$(basename "$spec")" "$config" violate "$invariant" ;;
    *) echo "unknown expectation: $expectation" >&2; exit 2 ;;
  esac
done

if [ "$failures" -gt 0 ]; then
  echo "$failures of $runs model checks did not match their expected outcome." >&2
  exit 1
fi
