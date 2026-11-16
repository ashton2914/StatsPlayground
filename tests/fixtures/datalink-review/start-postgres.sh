#!/usr/bin/env bash
set -euo pipefail

fixture_port=${STATSPG_REVIEW_PORT:-55432}
if [[ ! "$fixture_port" =~ ^[1-9][0-9]{0,4}$ ]] || (( fixture_port > 65535 )); then
  echo "STATSPG_REVIEW_PORT must be a TCP port from 1 to 65535." >&2
  exit 1
fi

fixture_bin=${STATSPG_POSTGRES_BIN:-}
if [[ -z "$fixture_bin" ]] && command -v pg_config >/dev/null; then
  fixture_bin=$(pg_config --bindir)
fi
if [[ -n "$fixture_bin" ]]; then
  export PATH="$fixture_bin:$PATH"
fi
for command_name in initdb pg_ctl createdb psql; do
  if ! command -v "$command_name" >/dev/null; then
    echo "Install PostgreSQL or set STATSPG_POSTGRES_BIN to its bin directory (missing $command_name)." >&2
    exit 1
  fi
done

fixture_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/statspg-datalink-review.XXXXXXXX")
fixture_data="$fixture_dir/data"

cleanup() {
  if [[ -s "$fixture_data/postmaster.pid" ]]; then
    if ! pg_ctl -D "$fixture_data" -m fast -w stop >/dev/null; then
      echo "Could not stop the test server. Its files remain at $fixture_dir." >&2
      return 1
    fi
  fi
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

admin_password=statspg-fixture-admin
printf '%s\n' "$admin_password" > "$fixture_dir/password"
initdb -D "$fixture_data" -U fixture_admin --auth=scram-sha-256 --pwfile="$fixture_dir/password" >/dev/null
if ! pg_ctl -D "$fixture_data" -l "$fixture_dir/postgres.log" \
  -o "-h 127.0.0.1 -p $fixture_port -k '' -c ssl=off" -w start >/dev/null; then
  tail -n 15 "$fixture_dir/postgres.log" >&2
  exit 1
fi

fixture_connection=(-h 127.0.0.1 -p "$fixture_port" -U fixture_admin)
PGPASSWORD="$admin_password" createdb "${fixture_connection[@]}" statspg_review
PGPASSWORD="$admin_password" psql -X "${fixture_connection[@]}" -d statspg_review \
  -v ON_ERROR_STOP=1 -f "$fixture_source/postgres.sql" >/dev/null

printf 'DataLink fixture ready: PostgreSQL at 127.0.0.1:%s, database statspg_review\n' "$fixture_port"
printf 'User: stats_reader   Test password: statspg-fixture-reader   TLS: Disabled\n'
printf 'Press Ctrl+C to stop the server and remove its temporary database.\n'
while pg_ctl -D "$fixture_data" status >/dev/null; do
  sleep 1
done
