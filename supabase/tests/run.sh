#!/bin/bash
# Apply the migrations to a scratch database on a local Postgres and run the security tests.
#   PGHOST / PGPORT / PGUSER choose the server (defaults: 127.0.0.1, 54329, postgres).
set -e
cd "$(dirname "$0")/.."
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-54329} PGUSER=${PGUSER:-postgres}
psql -q -c "drop database if exists climbr_test" -c "create database climbr_test"
psql -q -v ON_ERROR_STOP=1 -d climbr_test -f tests/stub.sql
for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d climbr_test -f "$f" 2>&1 | grep -v "already exists, skipping" || true; done
out=$(psql -q -d climbr_test -f tests/rls.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* NOTICE:  //')
echo "$out" | grep -E "FAIL|ERROR" || true
echo "$(echo "$out" | grep -c '^PASS') passed, $(echo "$out" | grep -c 'FAIL') failed, $(echo "$out" | grep -c 'ERROR') errors"
