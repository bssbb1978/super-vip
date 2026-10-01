#!/usr/bin/env bash
# Pushes GitHub Actions repository secrets to the Cloudflare Worker via
# `wrangler secret put`, non-interactively. Fails fast with a specific,
# readable error if a required secret is missing, instead of letting
# wrangler fail later with a vague deploy error.
set -euo pipefail

# ADMIN_TELEGRAM_ID is NOT required any more: since the owner-binding module
# (work/core/31-owner.js) the bot is *claimed* from an authenticated panel
# session — POST /api/owner {action:"invite"} → /claim CODE in Telegram — and
# the chat id is then stored in D1 (qv_admins) instead of in a secret.
# Set it only if you prefer the old, explicit behaviour; it always wins.
required=(ADMIN_PASSWORD JWT_SECRET API_SECRET_TOKEN TELEGRAM_BOT_TOKEN SS_MASTER_SECRET BRIDGE_SECRET)
optional=(ADMIN_TELEGRAM_ID TELEGRAM_WEBHOOK_SECRET SS_PASSWORD OWNER_PEPPER)

missing=()
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::Missing required repository secrets: ${missing[*]}"
  echo "Add them under Settings > Secrets and variables > Actions > New repository secret."
  exit 1
fi

FLAG=()
[ "${DEPLOY_ENV:-production}" = "staging" ] && FLAG=(--env staging)

for name in "${required[@]}" "${optional[@]}"; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    echo "Setting secret: $name"
    printf '%s' "$value" | npx wrangler secret put "$name" "${FLAG[@]}"
  fi
done
