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

# Sniff binary images by magic bytes so a mislabelled extension (e.g. JPEG
# bytes saved as .png by an image model) still gets the correct content-type.
sniff() { case "$(head -c 12 "$1" | od -An -tx1 | tr -d ' \n')" in
  89504e47*) echo image/png;;           ffd8ff*) echo image/jpeg;;
  47494638*) echo image/gif;;           *57454250) echo image/webp;;  # RIFF....WEBP
  *) echo "";;
esac; }

mime() { local m
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *.html|*.htm) m=text/html;;            *.css) m=text/css;;
    *.js|*.mjs) m=application/javascript;; *.json) m=application/json;;
    *.png) m=image/png;;                   *.jpg|*.jpeg) m=image/jpeg;;
    *.gif) m=image/gif;;                    *.svg) m=image/svg+xml;;
    *.webp) m=image/webp;;                  *.ico) m=image/x-icon;;
    *.mp4) m=video/mp4;;                    *.webm) m=video/webm;;
    *.pdf) m=application/pdf;;              *.woff2) m=font/woff2;;
    *.txt|*.md) m="text/plain; charset=utf-8";; *) m=application/octet-stream;;
  esac
  # For raster image extensions, trust the bytes over the name.
  case "$m" in image/png|image/jpeg|image/gif|image/webp)
    local r; r="$(sniff "$1")"; [ -n "$r" ] && m="$r";; esac
  printf '%s' "$m"; }

# Reuse a share if SHARE_SLUG is set, else create a fresh one.
if [ -n "${SHARE_SLUG:-}" ]; then
  SLUG="$SHARE_SLUG"
else
  # Optional per-share notify webhook (a Chat space, a generic URL) via SHARE_NOTIFY.
  NOTIFY_JSON=""
  [ -n "${SHARE_NOTIFY:-}" ] && NOTIFY_JSON=",\"notify\":$(printf '%s' "$SHARE_NOTIFY" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))')"
  SLUG=$(curl -s -X POST -H "Authorization: Bearer $SHARE_TOKEN" -H "content-type: application/json" \
    -d "{\"title\":$(printf '%s' "$TITLE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"ttlHours\":${SHARE_TTL:-168}${NOTIFY_JSON}}" \
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
echo "  responses: $SHARE_BASE/api/shares/$SLUG/responses" >&2
echo "  read them: SHARE_BASE=$SHARE_BASE SHARE_TOKEN=… ./responses.sh $SLUG" >&2
