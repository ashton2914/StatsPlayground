# Issue 285 execution record

Issue: https://github.com/ashton2914/StatsPlayground/issues/285

Base: `2ea3e334c32159e868aa39e25feaf3e7da5d35b8`; isolated branch `codex/285-table-centered-project`.

## Implemented behavior

Ordinary Cargo/Tauri/portable builds enable v5. Explicit `--no-default-features` retains the compatibility build. Native object names are literal logical names; external interchange formats and `.spprj` containers keep their real suffixes.

Directory membership comes from a complete revision-bound metadata topology. Tables are topological peers inside a linked bracket; Graph, Graph Builder-new, all Analysis kinds and Tabulate are children of their source table. Transform controls open the existing editor. Rendering is paged independently from complete action scope. Reports and workflows stay project-wide.

Moving any table or owned child, copying, and project-object exporting cover the entire undirected Transform-connected component. Folder rename/move/promotion is one complete guarded native transaction including connectors. Deletion follows directed descendants, preserves other Join inputs, and independently permits child-document deletion. Public native boundaries reject partial folder writes, reparenting of children, connector unlinking and replacement of existing Transform inputs.

Copy and native subset export/import remap stable identities, formulas, display/filter settings, owned documents, bindings and lineage. Only selected rows enter transfer staging; exact SQL comparisons reject lossy conversions. Publication is atomic and no-clobber. Copy/import are one public undo action. Native receipts recover lost replies, and owned request tokens support cancellation before publication.

Deletion undo restores children under the surviving parent's current folder. If surviving Join inputs now occupy different folders, restore rolls back until their folders are aligned.

## Verification

- Default-feature harness builds with `--features perf-harness` only. Resolved root features: `default,project-v5`.
- Real native capability → draft → automatic durable edit → reopen passed. Explicit no-default-feature library check passed.
- Native project regressions: **333 passed, 1 ignored**. Linked-group cases include metadata-only discovery, multi-input chains, folder integrity, rollback, directed deletion/replay, moved-parent restoration, independent copied formulas/Transform reruns, exact typed export/import, invalid/future/dangling sources, cancellation and lost receipts.
- MCP tests: **21 passed**, including 28-tool typed catalog and all shipped guide examples. External group transfer tools use application file pickers; arbitrary paths are excluded from MCP schemas.
- `npm run test:project-persistence`: **91 contract scripts and 149 UI tests passed**. Separate directory/Graph-new/Distribution UI run: **25 passed**. Broader native-app/lazy-hydration UI run: **33 passed**.
- Frontend production build and TypeScript check passed. Budget framework tests: **29 passed**. App-version/portable/release-workflow tests: **27 passed**. Dependency lock files unchanged.
- Native macOS acceptance app has a separate identifier (`com.statsplayground.issue285.acceptance`). The normal running application and user projects were preserved.

Old regression fixtures were corrected to use actual owned source tables and typed Transform creation/removal. Restored definitions/settings are reloaded at their authoritative revisions. An old reopened-queue test transport that routed every command to an empty record patch was corrected to route native mutations as well. The public write guards were retained.

## Native desktop observations

The final corrected default-feature desktop app rebuilt successfully. Its native context-menu rename displayed the input, saved `Unrelated Table.literal`, preserved the suffix and completed the durability barrier. The actual default-feature desktop window showed the bracket, extensionless logical names, five real owned documents under B, and prompt-less new-folder creation followed by immediate rename. The B-deletion confirmation listed B, C and owned children, excluding A, X and Join. Deletion removed the selected graph editor; undo restored the chain. Five-table group copy changed the project count from 6 to 11, and one undo returned it to 6. Native group export and import produced a second independent five-table group. An individual analysis was deleted while all 11 tables remained; after application restart the original analysis stayed deleted while the imported group's copy survived. File save durability barrier completed.

Native drag attempts through CUA did not yield a verifiable move, including a splitter calibration attempt. Chromium component drag/drop tests pass and native group/folder transactions pass, but macOS drag gesture acceptance remains a manual check. A separate Playwright WebKit attempt could not launch because that browser runtime is not installed; no browser installation was performed.

The seeded Graph-new document opened its existing editor but displayed a renderer error. Chart rendering itself is not claimed as visually accepted by this directory change; copy/import configuration integrity and activation are covered by native and UI tests.

Native screenshots and self-owned project/export fixtures are retained in the local temporary Issue 285 acceptance directory. No user project was used as a destructive test fixture.

## Implementation decisions and costs

1. Canonical sibling worktree via Git fallback: platform worktree tool cannot target that layout; the worktree has no managed platform attachment.
2. Cross-table lifecycle manifest: existing same-dataset change sets cannot represent cascade replay; lifecycle history spans more tables and must remain transactionally tested.
3. Projected authoritative metadata instead of a second topology index: no duplicate durable truth or document hydration; relationship reads scale with metadata size.
4. Existing Transform inputs cannot be replaced; unchanged-input reruns remain supported. Cross-folder inputs must first be organized together. This costs an extra organization/new-Transform action when changing parents.
5. Creation undo with live descendants rejects dependency order; scoped callers must undo descendants first.
6. Native uncommitted SQL tables stage copies; cancellation can wait for a long SQL statement to return. A synchronized publication guard covers the actual COMMIT/file-link boundary.
7. Copy/import are a single component creation undo root; undo scope is intentionally the entire user action.
8. Typed transfer staging rejects unsupported lossless conversions; unusual engine types may fail export rather than change their values.
9. Explicit folder actions load a complete metadata inventory and submit one guarded patch; no parallel folder transaction API was introduced.
10. Desktop visual acceptance was deferred to final default promotion; native drag acceptance remains limited as described above.
11. MCP transfer paths are chosen through application dialogs; unattended raw-path transfer is not exposed.
12. Acknowledged atomic publication wins a racing late cancellation; cancellation is not an implicit undo.
13. Restored descendants inherit the live parent's folder; conflicting surviving Join folders block restore rather than silently moving surviving tables.
14. Debug performance smoke is separate from the full release qualification matrix. Windows/Linux native acceptance and a full release performance qualification are not claimed.

## Performance and independent review

Source-frozen debug smoke collected **31 logically verified native UI samples**: regular 300,000 × 20 and a 500-extra-table/10,000-report fixture, three warm samples per scenario, plus one verified owned-file cold catalog open. Source tree fingerprint: `e42cadd5e2d7e0a5fc1fa6832ff44a929eca2de4`. All forbidden-work counters were zero; directory samples retained zero viewport rows and performed no archive restore/full copy/full anchor rebuild/full count. Metadata-only relationship tests separately verify zero table-row work.

| Catalog path | Native observed latency | UI observed latency | Budget |
| --- | ---: | ---: | ---: |
| Regular, one cold sample | 108 ms | 198 ms | 1,000 ms |
| Regular, three warm samples, P95 | 113 ms | 213 ms | 500 ms |
| Many documents, three warm samples, P95 | 717 ms | 828 ms | 500 ms |

The smoke is **not qualified**: debug provenance, insufficient warm/cold sample counts, and observed timing misses. Many-document catalog open exceeded its 500 ms target. Scroll UI P95 was 125/133 ms versus 100 ms, and edit UI P95 was 226/322 ms versus 200 ms for regular/many fixtures. No before/after timing regression claim is made without a matching baseline. Raw reports and the failed qualification assessment are retained with the acceptance evidence. A full release performance qualification remains outstanding.

The independent whole-branch review identified five important findings. The consolidated fix pass covers each with a failing regression reproduced before implementation:

1. Cascade confirmation now carries its immutable topology revision across asynchronous generation lookup to the native transaction. Changed scope rejects deletion; lost acknowledgements still replay the original receipt.
2. Cancellation and publication share a mutex held over the actual database COMMIT or no-clobber file link. Cancellation accepted before that boundary rolls back; publication already holding the boundary wins late cancellation.
3. Generic Transform definition/binding writes validate the resulting relationship inside their transaction and roll back inconsistent revisions, identities or roles.
4. Owned Graph, Graph-new, Analysis and Tabulate bodies must agree with their single real table dependency.
5. Context-menu rename requests now reach the native directory input, including unloaded tables, Graph-new and analyses without body hydration.

Deferred minor: topology diagnostic/blocker notices do not yet expose the affected object identities. Invalid operations remain blocked, but diagnosis requires further inspection.

Review scope rulings: the seeded chart renderer error remains unattributed and unaccepted visually; native drag, other native platforms and release performance remain unverified; inspected semantic hashes/provenance did not establish a remapping defect; existing explicit group moves provide normalization without a separate normalization button. These retain the limitations above rather than imply broader acceptance. The debug smoke fingerprint above belongs to the pre-review snapshot, not the final corrected tree.

This record is not a release or merge authorization.
