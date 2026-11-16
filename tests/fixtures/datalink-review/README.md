# PostgreSQL DataLink review fixture

This disposable PostgreSQL database exercises column selection, server-side
filters, saved DataLinks, and reimport. It contains synthetic battery readings
with repeated record numbers across four channels.

From a checkout with the project dependencies installed, run:

```sh
npm run fixture:datalink-postgres
```

The command needs installed PostgreSQL server and client binaries. If they
are outside PATH, set `STATSPG_POSTGRES_BIN` to their bin directory. If port
55432 is already in use, set `STATSPG_REVIEW_PORT` to a free port. Ctrl+C stops
the fixture and removes its temporary database. The fixture listens only on
IPv4 loopback and uses public test credentials.

In another terminal run `npm run tauri -- dev`. In PostgreSQL DataLink, connect
to host `127.0.0.1`, port `55432` (or the chosen override), database
`statspg_review`, user `stats_reader`, and password
`statspg-fixture-reader`. Use TLS Disabled for this loopback fixture.

Select `public.cell_a_raw` and project `Rec#`, `Current (A)`, and
`Voltage (V)`. Filter `Rec#` to 1000 through 1999 inclusive. Preview shows a
sample. Import writes 4,000 rows. Save and reopen the project to check that the
DataLink is still available. Edit a destination cell, then reimport to check
the confirmation for replacing edited data.

Run the native integration test against the running fixture with:

```sh
STATSPG_REVIEW_PASSWORD=statspg-fixture-reader \
  cargo test --manifest-path src-tauri/Cargo.toml --locked --lib \
  project_v5_imports_only_previewed_postgres_selection -- --ignored
```

Pass the same `STATSPG_REVIEW_PORT` to the test if you changed the fixture port.
