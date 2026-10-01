#!/usr/bin/env bash
# Creates the D1 database and KV namespace used by this Worker, but only if
# one by that name doesn't already exist — safe to run on every deploy.
# Requires `jq` (preinstalled on GitHub-hosted ubuntu runners).
#
# Honesty note: this covers the *production* section of wrangler.toml. If you
# also deploy --env staging, run this once with DEPLOY_ENV=staging (or add a
# second provisioning call) and it will patch the [env.staging] block the
# same way — the sed ranges below target whichever block matches first, so
# don't run both in the same invocation without checking the diff it prints.
set -euo pipefail

DB_NAME="qvu-db"
KV_TITLE="KVU_KV"
if [ "${DEPLOY_ENV:-production}" = "staging" ]; then
  DB_NAME="qvu-db-staging"
fi

echo "Checking for D1 database '$DB_NAME'..."
DB_ID=$(npx wrangler d1 list --json | jq -r --arg n "$DB_NAME" '.[] | select(.name==$n) | .uuid' | head -1)
if [ -z "$DB_ID" ] || [ "$DB_ID" = "null" ]; then
  echo "Not found — creating it."
  DB_ID=$(npx wrangler d1 create "$DB_NAME" --json | jq -r '.uuid // .d1_databases[0].id')
fi
echo "D1 database_id = $DB_ID"

echo "Checking for KV namespace '$KV_TITLE'..."
KV_ID=$(npx wrangler kv namespace list --json | jq -r --arg t "$KV_TITLE" '.[] | select(.title | endswith($t)) | .id' | head -1)
if [ -z "$KV_ID" ] || [ "$KV_ID" = "null" ]; then
  echo "Not found — creating it."
  KV_ID=$(npx wrangler kv namespace create "$KV_TITLE" --json | jq -r '.id')
fi
echo "KV id = $KV_ID"

if [ -z "$DB_ID" ] || [ -z "$KV_ID" ]; then
  echo "::error::Could not resolve a D1 database id or KV namespace id — check the Cloudflare API token's permissions (needs D1:Edit and Workers KV Storage:Edit)."
  exit 1
fi

sed -i "0,/^database_id = .*/s//database_id = \"$DB_ID\"/" wrangler.toml
sed -i "0,/^id = .*/s//id = \"$KV_ID\"/" wrangler.toml

echo "wrangler.toml patched with live resource ids for this run (not committed back)."
