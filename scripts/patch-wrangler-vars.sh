#!/usr/bin/env bash
# Patches wrangler.toml in the CI workspace only (never committed back) using
# GitHub Actions *repository variables* (Settings > Secrets and variables >
# Actions > Variables tab). Anything left unset keeps whatever is already in
# wrangler.toml, so this is safe to run even if you haven't set any variables.
set -euo pipefail

cp wrangler.toml wrangler.toml.bak

if [ -n "${WORKER_NAME:-}" ]; then
  sed -i "0,/^name = .*/s//name = \"${WORKER_NAME}\"/" wrangler.toml
fi
if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  sed -i "s/^CUSTOM_DOMAIN = .*/CUSTOM_DOMAIN = \"${CUSTOM_DOMAIN}\"/" wrangler.toml
fi
if [ -n "${HOSTS:-}" ]; then
  sed -i "s/^HOSTS = .*/HOSTS = \"${HOSTS}\"/" wrangler.toml
fi
if [ -n "${DEFAULT_QUOTA_GB:-}" ]; then
  sed -i "s/^DEFAULT_QUOTA_GB = .*/DEFAULT_QUOTA_GB = \"${DEFAULT_QUOTA_GB}\"/" wrangler.toml
fi

echo "wrangler.toml as it will be deployed with (diff against the committed version):"
diff -u wrangler.toml.bak wrangler.toml || true
rm -f wrangler.toml.bak
