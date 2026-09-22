# Issue 254 MCP Persistent Settings Design

## Goal

Allow users to configure a fixed MCP loopback port and a persistent bearer
token once, so external MCP clients do not need new connection settings after
every server or application restart.

## Current behavior and root cause

The production MCP start path always binds `127.0.0.1:0`, which asks the
operating system for an arbitrary free port, and generates a new 256-bit bearer
token. The frontend invokes `start_mcp_server` without configuration and has no
settings editor. Fixed bind and token overrides exist only as debug environment
variables. No MCP preference file is read or written.

## User experience

The MCP Server panel adds an editable Settings section:

- `Port` accepts a decimal integer from 1 through 65535.
- `Token` is a password field and is masked by default.
- `Reveal` and `Hide` affect only the input presentation.
- `Generate token` requests a cryptographically random token from the Rust
  backend.
- `Save settings` explicitly persists both fields.

The inputs and save/generate controls are disabled while the MCP server is
starting, running, or stopping. A running server keeps its current endpoint and
token until it is stopped; settings are never applied partially to a live
server.

When no saved settings exist, Start preserves the existing behavior: the
server uses a random available loopback port and a new random token. When saved
settings exist, every later Start reloads and uses the exact saved port and
token. If the fixed port is occupied, Start fails visibly and does not fall back
to a random port.

The status token remains masked in ordinary rendering. Its clear value is used
only by explicit copy actions. The saved token input follows the same rule and
is clear only after an explicit Reveal action.

## Persistence contract

The backend owns this file:

```text
~/.statsplayground/settings.json
```

Version 1 is:

```json
{
  "version": 1,
  "mcp": {
    "port": 48123,
    "token": "a-user-entered-or-generated-token"
  }
}
```

The file is not created until the user explicitly saves settings. The frontend
never receives the absolute settings path.

`McpSettingsService` receives the already resolved home directory and derives
the settings directory and file itself. It validates the document version,
port, and token on both read and write. A token must:

- be 32 through 256 bytes;
- contain only visible ASCII bytes from `!` through `~`;
- contain no whitespace or control characters.

The service creates the settings directory with user-only permissions where
the platform supports Unix modes. It writes JSON to a temporary file in the
same directory, flushes it, applies user-only permissions, and atomically
persists it over the destination. On Unix, the directory is `0700` and the file
is `0600`.

Missing settings are a valid state and return `None`. Unsupported versions,
malformed JSON, invalid values, permission failures, and other I/O failures are
reported as `AppError`; they never produce a success-shaped fallback. A failed
save leaves the previous settings file intact.

## Backend interfaces

Rust models in `src-tauri/src/models/mcp.rs`:

```rust
pub struct McpSettings {
    pub port: u16,
    pub token: String,
}

pub struct McpSettingsState {
    pub settings: Option<McpSettings>,
}
```

Commands:

```rust
get_mcp_settings(app: AppHandle) -> Result<McpSettingsState, AppError>
save_mcp_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: McpSettings,
) -> Result<McpSettingsState, AppError>
generate_mcp_token() -> Result<String, AppError>
```

`save_mcp_settings` rejects changes unless the MCP runtime is stopped. The
runtime exposes `ensure_stopped()` for this guard.

`start_mcp_server` resolves the home directory, loads saved settings, converts
them into a loopback-only `McpStartConfiguration`, and passes that
configuration into `McpServerRuntime::start`. In debug builds, explicit
`STATSPLAYGROUND_MCP_BIND` and `STATSPLAYGROUND_MCP_TOKEN` environment
variables continue to override persisted/default values for development
automation. Release builds have no address override.

## Frontend interfaces

TypeScript mirrors the Rust models:

```ts
export interface McpSettings {
  port: number;
  token: string;
}

export interface McpSettingsState {
  settings: McpSettings | null;
}
```

The service adds `getSettings`, `saveSettings`, and `generateToken`. The Zustand
store owns:

- persisted settings;
- editable port and token strings;
- token visibility;
- settings loading/saving/generating state;
- actions to edit, reveal, generate, and save.

The component remains thin and renders those store values/actions.

## Security boundaries

- MCP remains default-off and manually started.
- The listener remains IPv4 loopback-only.
- The token remains required for every MCP request and is compared in constant
  time.
- No persisted setting can select a non-loopback address.
- The settings path is never sent to the frontend.
- No token is logged.
- A corrupted or unreadable persisted file blocks saved-configuration loading
  with an explicit error rather than silently weakening authentication.

## Verification

Backend tests cover missing, valid, malformed, unsupported-version, invalid
port/token, atomic replacement, permissions, fixed-port reuse, fixed-token
reuse, occupied-port failure, loopback enforcement, and stopped-only saves.

Frontend tests cover typed IPC calls, load/edit/save state, generated tokens,
masked/revealed presentation, disabled live-server editing, validation errors,
and visible backend failures.

The existing MCP command/runtime/HTTP suite, frontend build, Rust build, Clippy,
and Rust tests remain required.
