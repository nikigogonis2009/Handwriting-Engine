#!/usr/bin/env bash
# Build the password-protected site and publish it on the gh-pages branch.
#
#   SITE_PASSWORD='...' npm run deploy:pages
#   SITE_PASSWORD='...' HANDWRITING_FILE=my-handwriting.json npm run deploy:pages   (also publishes the samples, sealed)
#
# Adds a normal commit on top of gh-pages (no force push). The branch only ever contains the
# login page, the encrypted app, the MCP server files (the program only) with their instructions in mcp.txt,
# and, if the user chose to publish it, their handwriting sealed with the password (handwriting.enc.json). In the repo settings, set Pages to deploy from gh-pages.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SITE_PASSWORD:?Set SITE_PASSWORD}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node scripts/build-protected.js "$WORK/site"
REMOTE="$(git remote get-url origin)"
NAME="$(git config user.name || true)"
EMAIL="$(git config user.email || true)"
if git ls-remote --exit-code --heads "$REMOTE" gh-pages >/dev/null 2>&1; then
  git clone -q --branch gh-pages --depth 1 "$REMOTE" "$WORK/repo"
else
  git init -q -b gh-pages "$WORK/repo"
  git -C "$WORK/repo" remote add origin "$REMOTE"
fi
# commit as whoever this repo is configured as
[ -n "$NAME" ] && git -C "$WORK/repo" config user.name "$NAME"
[ -n "$EMAIL" ] && git -C "$WORK/repo" config user.email "$EMAIL"

# keep the samples already published, unless a new file is being published now
if [ -z "${HANDWRITING_FILE:-}" ] && [ -f "$WORK/repo/handwriting.enc.json" ]; then
  cp "$WORK/repo/handwriting.enc.json" "$WORK/site/"
fi
# the address Pages serves this repo at, for the links in mcp.txt
SLUG="$(git remote get-url origin | sed -E 's#^.*[:/]([^/]+)/([^/]+)$#\1 \2#; s#\.git$##')"
OWNER="${SLUG% *}"; REPO="${SLUG#* }"
node scripts/build-site-extras.js "$WORK/site" "https://$(echo "$OWNER" | tr 'A-Z' 'a-z').github.io/$REPO/"
find "$WORK/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$WORK/site/." "$WORK/repo/"
cd "$WORK/repo"
git add -A
if git diff --cached --quiet; then
  echo "Nothing changed."
  exit 0
fi
git commit -q -m "Update site"
git push -q origin gh-pages
echo "Published to gh-pages."
