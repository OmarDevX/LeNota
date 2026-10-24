#!/usr/bin/env bash
# No tokens, API keys, or ChatGPT sessions are read by this diagnostic.
set -uo pipefail
printf 'LeNota AI network check (DNS + HTTPS; no credentials used)\n\n'
if ! command -v getent >/dev/null 2>&1; then
  echo 'Missing getent; DNS checks skipped.'
fi
for host in api.openai.com generativelanguage.googleapis.com openrouter.ai auth.openai.com; do
  printf '%-40s DNS: ' "$host"
  if command -v getent >/dev/null 2>&1 && getent ahosts "$host" >/dev/null 2>&1; then
    echo 'OK'
  else
    echo 'FAILED'
  fi
  printf '%-40s HTTPS: ' "$host"
  if command -v curl >/dev/null 2>&1; then
    status=$(curl --head --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 10 "https://$host/" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "Connected (HTTP $status; 401/403/404 is normal without credentials)"
    else
      echo "FAILED ($status)"
    fi
  else
    echo 'curl not installed'
  fi
  echo
 done
printf 'DNS configuration (names and DNS servers only):\n'
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl dns 2>&1 || true
elif command -v nmcli >/dev/null 2>&1; then
  nmcli -g IP4.DNS,IP6.DNS device show 2>&1 || true
fi
printf '\nDo not share tokens or API keys when reporting results.\n'
