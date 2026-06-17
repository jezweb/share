#!/usr/bin/env bash
# share/responses — read the structured answers back for a share, by SLUG.
#
# This is the whole point of the boundary: a consuming agent only ever needs
# SHARE_BASE + SHARE_TOKEN + HTTP. It reads answers from THIS authed endpoint,
# keyed by the slug it already holds from publishing. It never touches D1, never
# runs wrangler, never needs Cloudflare access. Querying the database directly is
# the anti-pattern this script exists to remove.
#
#   SHARE_BASE=https://share.jezweb.com SHARE_TOKEN=xxx \
#     ./responses.sh hack-day-what-should-we-build-zBb0mujwcQ
#
# Accepts a bare slug OR a full share URL (it takes the last path segment).
set -euo pipefail
REF="${1:?usage: responses.sh <slug-or-share-url>}"
: "${SHARE_BASE:?set SHARE_BASE}"; : "${SHARE_TOKEN:?set SHARE_TOKEN}"
SLUG="${REF##*/}"; SLUG="${SLUG%%\?*}"   # strip any ?k=… too

out=$(curl -sf -H "Authorization: Bearer $SHARE_TOKEN" "$SHARE_BASE/api/shares/$SLUG/responses") \
  || { echo "failed to read responses for: $SLUG" >&2; exit 1; }
if command -v jq >/dev/null 2>&1; then printf '%s\n' "$out" | jq .; else printf '%s\n' "$out"; fi
