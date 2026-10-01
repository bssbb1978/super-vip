#!/usr/bin/env bash
# Best-effort post-deploy check. A fresh Worker deploy can take a few seconds
# to propagate, so this retries instead of failing on the first miss — but it
# only ever emits a warning, never fails the job, since a transient network
# hiccup here doesn't mean the deploy itself failed.
set -euo pipefail

if [ -z "${CUSTOM_DOMAIN:-}" ]; then
  echo "No CUSTOM_DOMAIN repository variable set — skipping health check."
  exit 0
fi

for i in 1 2 3 4 5; do
  if curl -fsS "https://${CUSTOM_DOMAIN}/health" >/dev/null 2>&1; then
    echo "Health check passed on attempt $i."
    exit 0
  fi
  sleep 5
done

echo "::warning::https://${CUSTOM_DOMAIN}/health did not respond after 5 attempts. The deploy step itself succeeded — check the Cloudflare dashboard and DNS/custom domain setup."
