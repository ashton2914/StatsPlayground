# Issue 265 built-in skills acceptance

## Result

- Skills is enabled with a Build-in section, SP MCP Guide and Distribution Analyze, full Markdown/reference/JSON previews and working contract anchors.
- The bundled source in `built-in-skills/` is shared by the UI and Rust workspace publisher.
- Launch VS Code publishes both skills to `.github/skills/`, records managed-file hashes and verifies read-back. Modified user content and unrelated skills are preserved; stale paths, links and conflicts block launch. Displaced content is restored or retained with an explicit recovery message if concurrent edits prevent restoration.
- MCP server identity and workspace key are `sp-mcp`. Legacy `StatsPlayground` entries migrate after confirmation; duplicate aliases are refused. The existing 22 `statsplayground_*` tool identifiers remain compatible.
- Distribution Analyze uses supplied/existing user data, executes Distribution, checks nested result statuses, interprets returned evidence, creates or updates the intended report and verifies read-back. Missing report revision and save-as limitations are documented.

## Verification

| Check | Result |
|---|---|
| Frontend production build (`npm run build`) | Pass |
| Skill synchronization tests | 9 passed; concurrent write and rollback regressions observed failing before repair |
| VS Code workspace/launch tests | 31 passed on final code |
| MCP tool tests | 19 passed, including all 22 bundled example argument contracts |
| MCP HTTP integration | 9 passed |
| MCP management/VS Code UI | 17 passed, including narrow viewport and contract anchor navigation |
| MCP end-to-end UI | 1 passed after updating the former placeholder expectation |
| Remaining MCP TypeScript checks | Passed individually after the known save-source test stopped the aggregate script |
| Clippy | Exit 0; 199 existing warnings, none in the new skill publisher |
| Skill metadata | YAML names/descriptions validated with Ruby; Python helper unavailable because PyYAML is absent |
| Git diff check | Pass |
| Independent code/skill-consumer review | No remaining Important findings after repairs |

Full Rust library verification during implementation: 1555 passed, 1 failed, 18 ignored. The later concurrency repairs were covered by the final 9 synchronization tests and 31 launch tests.

Known existing failures, also recorded in Issue 262 acceptance:

- `engine::fit_model::ols::tests::warns_in_required_order_when_multiple_conditions_apply`: predictor mean is missing for X1.
- `tests/applicationCommandSaveSnapshot.test.ts`: looks for removed `const handleSave = async () => {` source boundary. `npm run test:mcp` stops there; remaining frontend checks and the affected backend checks were run separately.

## Manual acceptance

The final desktop dev build completed and was launched from worktree `265-launch-vscode` using the worktree Vite server on port 1420. On 2026-10-13, the user confirmed acceptance ("没问题, 提交变更到分支并push") and authorized committing and pushing the feature branch.

1. Open AI → Skills: verify the two cards in Build-in and open their instructions/reference links.
2. Launch VS Code into a selected test folder: verify `sp-mcp` configuration and the two folders under `.github/skills/`.
3. Start a fresh VS Code chat and request Distribution analysis using your own CSV or an existing table. Verify analysis results and the interpreted report.
4. A modified managed Skill must be preserved and reported as a conflict when launching again.

Primary checkout remains on dev at 445046c84a7a12845f108596a5de67aaf81a030f with no working-tree changes. Feature worktree base is 950bb9132f32c3cf1c1285ad1bcee02c9870cf9b, branch codex/265-launch-vscode, target dev.
