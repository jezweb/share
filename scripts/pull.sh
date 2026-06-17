#!/usr/bin/env bash
# share/pull — download a published share's files to a LOCAL directory, so you can
# edit it with your normal tools and push it back. This is the round-trip: R2 is
# the shelf, your disk is the workshop.
#
#   SHARE_BASE=https://share.jezweb.com SHARE_TOKEN=xxx \
#     ./pull.sh quote-draft-7Kp9mXe2 ./site
#   # edit ./site locally, then: SHARE_SLUG=quote-draft-7Kp9mXe2 ./push.sh ./site
set -euo pipefail
SLUG="${1:?usage: pull.sh <slug> <dir>}"
DIR="${2:?usage: pull.sh <slug> <dir>}"
: "${SHARE_BASE:?set SHARE_BASE}"; : "${SHARE_TOKEN:?set SHARE_TOKEN}"

FILES=$(curl -sf -H "Authorization: Bearer $SHARE_TOKEN" "$SHARE_BASE/api/shares/$SLUG/files" \
  | python3 -c 'import json,sys; [print(f) for f in json.load(sys.stdin).get("files",[])]')
[ -n "$FILES" ] || { echo "no files (or no such share): $SLUG" >&2; exit 1; }

mkdir -p "$DIR"
printf '%s\n' "$FILES" | while read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$DIR/$(dirname "$rel")"
  curl -sf "$SHARE_BASE/$SLUG/$rel" -o "$DIR/$rel" && echo "  - $rel" >&2
done
echo "pulled to $DIR" >&2
