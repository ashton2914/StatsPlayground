# Final Fix Report

## Verdict

The review finding was valid.

`DataTableView.load` deduplicated work with a `Set` keyed by dataset, generation,
and query signature. During A → B → A, B advanced the request epoch while the
first A retained its key. The restored A therefore returned before claiming a
new epoch, leaving B current. The key also omitted `start`, and unconditional
cleanup could remove a later claim after key reuse.

## RED

Added a deterministic component regression that:

1. holds the first unfiltered A window request;
2. transitions to filtered B;
3. restores unfiltered A while the first A remains pending; and
4. requires a third window request and the restored A result to become current.

Command:

```sh
npx playwright test -c playwright-ct.config.ts tests/dataTableCounts.spec.tsx \
  --grep "reissues a query restored" --reporter=line
```

Observed failure:

```text
Expected three signatures: A, B, A
Received two signatures: A, B
1 failed
```

## GREEN

Replaced the key `Set` with epoch-owned claims:

- the claim key now includes requested `start`;
- a duplicate is suppressed only when its existing claim owns the current epoch;
- an A claim made stale by intervening B can be replaced by a new A claim; and
- `finally` deletes a claim only when it still owns that key.

This retains exact-once duplicate initial-load behavior because a same-request
claim in the current epoch is still deduplicated. Existing generation/session
tests continue to verify prepared-session release behavior.

Commands and results:

```text
npx playwright test -c playwright-ct.config.ts tests/dataTableCounts.spec.tsx \
  --grep "reissues a query restored" --reporter=line
1 passed

npx playwright test -c playwright-ct.config.ts tests/dataTableCounts.spec.tsx \
  --reporter=line
6 passed

npx playwright test -c playwright-ct.config.ts \
  tests/dataTableCounts.spec.tsx tests/dataTableScroll.spec.tsx \
  tests/dataTableSplitters.spec.tsx --reporter=line
11 passed

npx tsc -b
passed

npx vite build
passed (existing chunk-size advisory only)

git diff --check
passed
```

## Files

- `src/components/DataTableView.tsx`
- `tests/DataTableCountsHarness.tsx`
- `tests/dataTableCounts.spec.tsx`
- `.superpowers/sdd/2026-09-20-issue-237-baseline-test-reliability/final-fix-report.md`

## Concerns

No functional concerns remain. The worktree's pre-existing untracked
`node_modules/` and `.cache/` directories were not added.
