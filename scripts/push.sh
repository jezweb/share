#!/usr/bin/env bash
# share/push — publish a LOCAL directory as a share.
#
# The model: build the site on your own disk with your normal tools (write, edit,
# grep, preview), then push the finished tree. R2 is the shelf, not the workshop.
#
#   SHARE_BASE=https://share.jezweb.com SHARE_TOKEN=xxx \
#     ./push.sh ./site "Quote draft for review"
#
# Re-push to the SAME share (after editing) by passing its slug:
#   SHARE_SLUG=quote-draft-7Kp9mXe2 ./push.sh ./site
#
# Prints the share URL on success.
set -euo pipefail
DIR="${1:?usage: push.sh <dir> [title]}"
TITLE="${2:-${DIR##*/}}"
: "${SHARE_BASE:?set SHARE_BASE}"; : "${SHARE_TOKEN:?set SHARE_TOKEN}"
[ -d "$DIR" ] || { echo "no such dir: $DIR" >&2; exit 1; }

mime() { case "${1,,}" in
  *.html|*.htm) echo text/html;;        *.css) echo text/css;;
  *.js|*.mjs) echo application/javascript;; *.json) echo application/json;;
  *.png) echo image/png;;               *.jpg|*.jpeg) echo image/jpeg;;
  *.gif) echo image/gif;;               *.svg) echo image/svg+xml;;
  *.webp) echo image/webp;;             *.ico) echo image/x-icon;;
  *.mp4) echo video/mp4;;               *.webm) echo video/webm;;
  *.pdf) echo application/pdf;;          *.woff2) echo font/woff2;;
  *.txt|*.md) echo "text/plain; charset=utf-8";; *) echo application/octet-stream;;
esac; }

# Reuse a share if SHARE_SLUG is set, else create a fresh one.
if [ -n "${SHARE_SLUG:-}" ]; then
  SLUG="$SHARE_SLUG"
else
  SLUG=$(curl -s -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
    -d "{\"title\":$(printf '%s' "$TITLE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"ttlHours\":${SHARE_TTL:-168}}" \
    "$SHARE_BASE/api/shares" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
fi
[ -n "$SLUG" ] || { echo "failed to create/resolve share" >&2; exit 1; }

# Walk the dir, PUT each file at its relative path. Bytes go disk -> HTTP -> R2.
( cd "$DIR" && find . -type f ! -path '*/.*' | sed 's|^\./||' | while read -r rel; do
    curl -sf -X PUT -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: $(mime "$rel")" \
      --data-binary @"$rel" "$SHARE_BASE/api/shares/$SLUG/files/$rel" >/dev/null \
      && echo "  + $rel" >&2 || echo "  ! failed $rel" >&2
  done )

echo "$SHARE_BASE/$SLUG"
