# Issue 254 MCP Persistent Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, secure persistence for a user-selected MCP loopback port and bearer token under `~/.statsplayground/settings.json`.

**Architecture:** A focused Rust settings service owns validation and atomic disk I/O. Thin Tauri commands resolve the home directory and connect that service to the existing MCP runtime; typed TypeScript service/store layers expose editable state to the current MCP panel without moving persistence or security logic into React.

**Tech Stack:** Rust 2021, Tauri v2, Tokio/Axum, Serde/serde_json, tempfile, React 19, TypeScript, Zustand, Playwright Component Testing.

**Spec:** `docs/issue-254-mcp-persistent-settings-design.md`

## Global Constraints

- MCP remains default-off and binds only to `127.0.0.1`.
- Missing settings preserve the current random-port/random-token behavior.
- Saved settings apply only on the next server start; a running server is never reconfigured.
- The settings file is `~/.statsplayground/settings.json`, version `1`.
- Valid ports are `1..=65535`.
- Valid tokens are 32 through 256 visible ASCII bytes with no whitespace or control characters.
- Unix directory/file permissions are `0700` and `0600`.
- Persistence errors and invalid files are explicit `AppError` failures; there is no silent fallback.
- Absolute filesystem paths never cross the IPC boundary.
- Existing debug environment overrides remain available only in debug builds.

---

### Task 1: Versioned MCP settings persistence

**Files:**
- Create: `src-tauri/src/services/mcp_settings_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/mcp.rs`

**Interfaces:**
- Consumes: `AppError`, `BearerToken::generate()`, `serde_json`, and `tempfile::NamedTempFile`.
- Produces:
  - `pub struct McpSettings { pub port: u16, pub token: String }`
  - `pub struct McpSettingsState { pub settings: Option<McpSettings> }`
  - `pub struct McpSettingsService { settings_directory: PathBuf, settings_path: PathBuf }`
  - `pub fn new(home_directory: PathBuf) -> Self`
  - `pub fn load(&self) -> Result<Option<McpSettings>, AppError>`
  - `pub fn save(&self, settings: &McpSettings) -> Result<(), AppError>`
  - `pub fn validate(settings: &McpSettings) -> Result<(), AppError>`

- [ ] **Step 1: Add failing service tests for the persistence contract**

Add unit tests in `mcp_settings_service.rs` that use `tempfile::TempDir` and
assert:

```rust
assert_eq!(service.load().expect("missing settings"), None);

service.save(&McpSettings {
    port: 48123,
    token: "a".repeat(32),
}).expect("save");
assert_eq!(
    service.load().expect("reload"),
    Some(McpSettings { port: 48123, token: "a".repeat(32) })
);
```

Add separate tests for malformed JSON, `version: 2`, port `0`, tokens shorter
than 32 bytes, tokens longer than 256 bytes, whitespace/control/non-ASCII
tokens, and replacement of an existing valid file. On Unix, assert directory
mode `0700` and file mode `0600`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mcp_settings_service -- --nocapture
```

Expected: compilation fails because the service and models do not exist.

- [ ] **Step 3: Add models and the settings service**

In `models/mcp.rs`, add camelCase Serde models:

```rust
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSettingsState {
    pub settings: Option<McpSettings>,
}
```

In the service, use a private persisted envelope:

```rust
#[derive(Deserialize, Serialize)]
struct UserSettingsV1 {
    version: u32,
    mcp: McpSettings,
}
```

Implement `.statsplayground/settings.json` derivation, strict validation,
missing-file handling, JSON parsing, same-directory temporary-file writing,
`sync_all`, Unix permissions behind `#[cfg(unix)]`, and
`NamedTempFile::persist`. Map validation failures to `AppError::InvalidParam`
and disk/JSON failures to `AppError::FileIO`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mcp_settings_service -- --nocapture
```

Expected: all persistence and validation tests pass.

- [ ] **Step 5: Format and commit the persistence slice**

Run:

```bash
rustfmt --edition 2021 src-tauri/src/services/mcp_settings_service.rs src-tauri/src/models/mcp.rs src-tauri/src/services/mod.rs
git add src-tauri/src/services/mcp_settings_service.rs src-tauri/src/services/mod.rs src-tauri/src/models/mcp.rs
git commit -m "feat(mcp): persist server settings"
```

### Task 2: Runtime and typed IPC integration

**Files:**
- Modify: `src-tauri/src/mcp/security.rs`
- Modify: `src-tauri/src/mcp/server.rs`
- Modify: `src-tauri/src/commands/mcp_commands.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/mcp_http.rs`

**Interfaces:**
- Consumes: `McpSettingsService::{load,save}`, `McpSettings`, `McpSettingsState`.
- Produces:
  - `BearerToken::generate_for_management() -> String`
  - `pub struct McpStartConfiguration { bind_address: String, token: BearerToken }`
  - `McpStartConfiguration::transient()`
  - `McpStartConfiguration::from_settings(McpSettings)`
  - `McpServerRuntime::start(broker, configuration)`
  - `McpServerRuntime::ensure_stopped() -> Result<(), AppError>`
  - Tauri commands `get_mcp_settings`, `save_mcp_settings`, and `generate_mcp_token`.

- [ ] **Step 1: Replace the old rotating-token test with failing effective-configuration tests**

Extend `server.rs` and `mcp_http.rs` tests to assert:

```rust
let settings = McpSettings {
    port: reserved_port,
    token: "p".repeat(32),
};
let first = runtime
    .start(broker.clone(), McpStartConfiguration::from_settings(settings.clone()))
    .await
    .expect("first start");
assert_eq!(first.endpoint, Some(format!("http://127.0.0.1:{reserved_port}/mcp")));
assert_eq!(first.token, Some(settings.token.clone()));
```

Stop and restart with the same settings and assert exact endpoint/token reuse.
Bind a separate listener to the requested port and assert Start returns an
error without selecting another port. Keep a transient-start test that asserts
two sequential starts receive different generated tokens.

Add unit coverage that `ensure_stopped()` rejects saving in `starting`,
`running`, and `stopping` states and accepts `stopped`.

- [ ] **Step 2: Run focused runtime tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mcp::server -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml mcp_server_starts --test mcp_http -- --nocapture
```

Expected: compilation fails because explicit start configuration and the
stopped guard do not exist.

- [ ] **Step 3: Refactor runtime startup around explicit configuration**

Make `McpStartConfiguration` constructible from transient defaults and validated
saved settings. Change:

```rust
pub async fn start(
    &self,
    broker: McpCommandBroker,
    configuration: McpStartConfiguration,
) -> Result<McpServerStatus, AppError>
```

Keep address parsing and loopback rejection in the runtime. In debug builds,
apply `STATSPLAYGROUND_MCP_BIND` and `STATSPLAYGROUND_MCP_TOKEN` as the final
override before binding. Add `ensure_stopped()` without changing lifecycle
state.

Expose `BearerToken::generate_for_management()` so the command can return a
secure generated token without exposing the internal token wrapper.

- [ ] **Step 4: Add failing command-contract tests**

In `commands/mcp_commands.rs`, introduce these path-based helpers so the logic
is directly testable without constructing an `AppHandle`:

```rust
fn load_start_configuration(home: &Path) -> Result<McpStartConfiguration, AppError>;
fn load_settings(home: &Path) -> Result<McpSettingsState, AppError>;
fn save_settings(
    home: &Path,
    runtime: &McpServerRuntime,
    settings: McpSettings,
) -> Result<McpSettingsState, AppError>;
```

Add direct unit tests that prove:

- home-directory resolution feeds `McpSettingsService`;
- a missing file produces transient configuration;
- a valid file produces fixed configuration;
- save checks `ensure_stopped()` before writing;
- generated tokens pass `McpSettingsService` token validation.

Update `mutation_guard_coverage.rs` expectations for the two new read/write
settings commands.

- [ ] **Step 5: Add the commands and registration**

Use `tauri::{AppHandle, Manager, State}` and a private helper:

```rust
fn settings_service(app: &AppHandle) -> Result<McpSettingsService, AppError>
```

Resolve `app.path().home_dir()`, then implement:

```rust
#[tauri::command]
pub fn get_mcp_settings(app: AppHandle) -> Result<McpSettingsState, AppError>;

#[tauri::command]
pub fn save_mcp_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: McpSettings,
) -> Result<McpSettingsState, AppError>;

#[tauri::command]
pub fn generate_mcp_token() -> Result<String, AppError>;
```

Update `start_mcp_server` to load saved settings and pass either fixed or
transient configuration. Register all three new commands in
`tauri::generate_handler!`.

- [ ] **Step 6: Run runtime and command tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mcp::server -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml mcp_commands -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test mcp_http mcp_server_starts -- --nocapture
```

Expected: explicit, transient, occupied-port, lifecycle, and HTTP tests pass.
Confirm each filter executes at least one test.

- [ ] **Step 7: Format and commit the backend integration**

Run:

```bash
rustfmt --edition 2021 src-tauri/src/mcp/security.rs src-tauri/src/mcp/server.rs src-tauri/src/commands/mcp_commands.rs src-tauri/src/commands/mutation_guard_coverage.rs src-tauri/src/lib.rs src-tauri/tests/mcp_http.rs
git add src-tauri/src/mcp/security.rs src-tauri/src/mcp/server.rs src-tauri/src/commands/mcp_commands.rs src-tauri/src/commands/mutation_guard_coverage.rs src-tauri/src/lib.rs src-tauri/tests/mcp_http.rs
git commit -m "feat(mcp): apply persistent server configuration"
```

### Task 3: Typed frontend settings state

**Files:**
- Modify: `src/types/mcp.ts`
- Modify: `src/services/mcpManagementService.ts`
- Modify: `src/stores/useMcpStore.ts`
- Modify: `tests/mcpManagementService.test.ts`
- Modify: `tests/mcpStore.test.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 2.
- Produces:
  - `McpSettings` and `McpSettingsState` TypeScript interfaces.
  - Service methods `getSettings`, `saveSettings`, and `generateToken`.
  - Store fields `settings`, `settingsPort`, `settingsToken`,
    `settingsTokenVisible`, `settingsBusy`.
  - Store actions `setSettingsPort`, `setSettingsToken`,
    `toggleSettingsTokenVisible`, `generateSettingsToken`, and `saveSettings`.

- [ ] **Step 1: Add failing service and store tests**

In `mcpManagementService.test.ts`, mock `@tauri-apps/api/core` and assert exact
invocations:

```ts
invoke("get_mcp_settings");
invoke("save_mcp_settings", {
  settings: { port: 48123, token: "a".repeat(32) },
});
invoke("generate_mcp_token");
```

In `mcpStore.test.ts`, extend the fake service and assert:

- opening/refreshing the view loads saved settings into edit fields;
- missing settings produce empty edit fields;
- edit actions do not persist automatically;
- save parses the decimal port and sends the exact token;
- invalid local port/token values set `lastError` and do not invoke save;
- generated tokens replace only the editable token;
- backend failures remain in `lastError`;
- settings actions reject while status is not `stopped`.

- [ ] **Step 2: Run frontend unit tests and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/mcpManagementService.test.ts
npx tsx --tsconfig tsconfig.app.json tests/mcpStore.test.ts
```

Expected: type/compile failures because the settings interfaces and methods do
not exist.

- [ ] **Step 3: Add types and typed IPC wrappers**

Add:

```ts
export interface McpSettings {
  port: number;
  token: string;
}

export interface McpSettingsState {
  settings: McpSettings | null;
}
```

Extend `mcpManagementService` with the exact invocations from Step 1 and include
the methods in `McpManagementServiceLike`.

- [ ] **Step 4: Implement the Zustand edit/save lifecycle**

Load status, audit, command requests, and settings together in `refresh`.
Represent port input as a string so invalid intermediate input is not coerced.
Validate decimal digits and range before calling the service. Validate token
length and visible ASCII before calling the backend, while retaining backend
validation as authority. Apply the returned saved settings after success.
Preserve editable values and expose the error on failure.

- [ ] **Step 5: Run frontend unit tests and verify GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/mcpManagementService.test.ts
npx tsx --tsconfig tsconfig.app.json tests/mcpStore.test.ts
```

Expected: both scripts print their success messages and exit `0`.

- [ ] **Step 6: Commit the typed frontend state**

Run:

```bash
git add src/types/mcp.ts src/services/mcpManagementService.ts src/stores/useMcpStore.ts tests/mcpManagementService.test.ts tests/mcpStore.test.ts
git commit -m "feat(mcp): manage persistent settings state"
```

### Task 4: MCP settings editor and localization

**Files:**
- Modify: `src/components/ai/McpServerPanel.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `tests/McpManagementHarness.tsx`
- Modify: `tests/mcpManagement.spec.tsx`

**Interfaces:**
- Consumes: Task 3 store fields/actions.
- Produces: accessible Port/Token inputs, Reveal/Hide, Generate token, and Save
  settings controls in the existing MCP Server panel.

- [ ] **Step 1: Add failing component tests**

Extend the harness fake service with saved settings and capture save calls.
Add Playwright component tests that:

```ts
await expect(component.getByLabel("Port")).toHaveValue("48123");
await expect(component.getByLabel("Token")).toHaveAttribute("type", "password");
await component.getByRole("button", { name: "Reveal token" }).click();
await expect(component.getByLabel("Token")).toHaveAttribute("type", "text");
```

Also assert:

- Generate token replaces the token field;
- Save settings sends the edited port/token and shows no secret in ordinary
  body text while masked;
- invalid port/token displays the store error;
- all controls are disabled in starting/running/stopping states;
- stopped state keeps Start enabled;
- the constrained-height and mobile-width tests still pass.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/mcpManagement.spec.tsx --output test-results/issue-254-red
```

Expected: failures because the settings controls are absent.

- [ ] **Step 3: Render the settings editor**

Add a Settings section above the endpoint/token runtime details. Bind all input
values and actions to the store; do not add independent component copies of
settings state. Use `type="number"` with `min={1}`, `max={65535}`, and
`inputMode="numeric"` for Port. Use `type={visible ? "text" : "password"}` and
`autoComplete="off"` for Token.

Disable editing/generation/saving unless `status.state === "stopped"`. Keep
Start independent so missing saved settings can still launch transient
configuration.

- [ ] **Step 4: Add responsive styling and locale parity**

Use existing `ai-detail-*`, button, and form-control patterns. Add only the
minimum layout rules needed to keep labels, fields, and actions usable at the
existing 390px component-test viewport.

Add matching keys to all three locales:

```text
settings, port, savedToken, revealToken, hideToken, generateToken,
saveSettings, transientSettingsHint, savedSettingsHint
```

Use `defaultValue` in the component consistently with existing MCP copy.

- [ ] **Step 5: Run component tests and verify GREEN**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/mcpManagement.spec.tsx --output test-results/issue-254-green
```

Expected: settings behavior plus all pre-existing MCP panel tests pass.

- [ ] **Step 6: Run the frontend build**

Run:

```bash
npm run build
```

Expected: Vite production build succeeds with no TypeScript errors.

- [ ] **Step 7: Commit the UI slice**

Run:

```bash
git add src/components/ai/McpServerPanel.tsx src/styles.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json tests/McpManagementHarness.tsx tests/mcpManagement.spec.tsx
git commit -m "feat(mcp): add persistent settings editor"
```

### Task 5: Integrated verification and issue evidence

**Files:**
- Modify if required by discovered regressions: only files already listed in
  Tasks 1 through 4, plus `tests/McpEndToEndHarness.tsx` as the integrated MCP
  regression-fix and test-harness surface.
- Update external record: GitHub Issue 254 comment.

**Interfaces:**
- Consumes: the complete backend/frontend implementation.
- Produces: repository verification evidence and a manually testable branch.

- [ ] **Step 1: Run the complete MCP gate**

Run:

```bash
npm run test:mcp
```

Expected: all TypeScript, component, Rust MCP HTTP, end-to-end, tools, artifact
parity, and project-service checks pass. Confirm Rust filters execute nonzero
tests.

- [ ] **Step 2: Run backend build, Clippy, and tests**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands pass. If an unrelated baseline failure appears, reproduce
it on `origin/dev` before classifying it as pre-existing.

- [ ] **Step 3: Re-run the production frontend build after all fixes**

Run:

```bash
npm run build
```

Expected: Vite production build succeeds from this issue worktree.

- [ ] **Step 4: Verify Git scope and persistent artifacts**

Run:

```bash
git status --short
git diff --check
git diff origin/dev...HEAD --stat
```

Expected: no temporary settings files, test-result artifacts, unrelated source
changes, or whitespace errors are present.

- [ ] **Step 5: Publish and read back completion evidence**

Post a GitHub Issue 254 comment containing:

- implemented UX and persistence behavior;
- security boundaries;
- exact passing commands and test counts;
- commit SHA;
- any remaining manual acceptance steps.

Read the created comment back through `gh issue view 254 --json comments` and
verify the persisted body.

- [ ] **Step 6: Prepare manual acceptance**

Launch the Tauri app from this exact worktree, verify the executable/process
path, then manually prove:

1. save a fixed port and token;
2. start and connect using the copied client configuration;
3. stop and restart the MCP server;
4. restart the application;
5. confirm the same endpoint and token still work;
6. occupy the saved port and confirm the application shows an explicit start
   failure without changing settings.
