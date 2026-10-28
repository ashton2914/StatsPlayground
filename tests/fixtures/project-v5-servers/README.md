# Native project server import fixtures

These isolated PostgreSQL 16 and MySQL 8.4 instances listen only on local ports
55432 and 53306. Their databases live in temporary memory-backed filesystems.
The passwords in this directory are public test values. They must never be
used for a deployed database.

Use a unique Docker Compose project name. Check the chosen ports and project
before starting; never replace an existing fixture or unrelated container.
Starting Docker, downloading images, creating containers and removing the
owned test containers require the operator's authorization.

The `native_small` table covers exact BIGINT/DECIMAL, Unicode and NULL values.
The 10,000-row `native_large` table covers streaming cancellation and complete
imports. The application connects as `stats_reader` with SELECT permission.
Record resolved image digests with verification output so mutable image tags
are not presented as immutable provenance.
