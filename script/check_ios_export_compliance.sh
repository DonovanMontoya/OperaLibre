#!/bin/sh
set -eu

# Check the processed app plist in Xcode, and the source plist in CI.
# Fail rather than silently repair a declaration that needs a fresh crypto review.
PLIST="${1:?usage: check_ios_export_compliance.sh path/to/Info.plist}"
KEY=ITSAppUsesNonExemptEncryption
if ! VALUE=$(/usr/bin/plutil -extract "$KEY" raw -expect bool -o - "$PLIST" 2>/dev/null); then
  echo "error: $PLIST must declare $KEY as Boolean false (exempt encryption)." >&2
  exit 1
fi
if [ "$VALUE" != false ]; then
  echo "error: $PLIST declares non-exempt encryption; review export compliance before changing this check." >&2
  exit 1
fi
echo "Export compliance verified: $KEY is Boolean false in $PLIST"
