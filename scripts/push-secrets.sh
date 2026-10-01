#!/usr/bin/env bash
# Pushes GitHub Actions repository secrets to the Cloudflare Worker via
# `wrangler secret put`, non-interactively. Fails fast with a specific,
# readable error if a required secret is missing, instead of letting
# wrangler fail later with a vague deploy error.
set -euo pipefail

required=(ADMIN_PASSWORD JWT_SECRET API_SECRET_TOKEN TELEGRAM_BOT_TOKEN ADMIN_TELEGRAM_ID SS_MASTER_SECRET BRIDGE_SECRET)
optional=(TELEGRAM_WEBHOOK_SECRET SS_PASSWORD)

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
