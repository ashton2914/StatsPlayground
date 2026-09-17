# StatsPlayground
An ultra-lightweight, open-source, and extensible data analysis tool.

Official website: https://statsplayground.org

## MCP Command Layer (Phase 1)

- Default-off: the MCP server is stopped until manually started from the app MCP management panel.
- Runtime endpoint: each start binds a random loopback URL in the form `http://127.0.0.1:<port>/mcp`.
- Rotating token: each start generates a new bearer token; stopping the server revokes the token.

### Streamable HTTP Client Configuration

Use any Streamable HTTP compatible MCP client with:

- Endpoint: app-provided loopback endpoint.
- Header: `Authorization: Bearer <token-from-app>`.
- Protocol header: `MCP-Protocol-Version: 2025-11-25`.

The app intentionally keeps endpoint/token out of logs until users explicitly copy them in the MCP panel.

### Command Safety and File Output Semantics

- CSV export uses authorized roots only.
- Callers must provide `{ rootId, relativePath }`; absolute output paths are rejected.
- Overwrite uses in-app confirmation semantics.
- Snapshot behavior matches current manual app semantics; Phase 1 does not broaden snapshot scope.

### Expected Errors

- `app_not_ready`: MCP dispatcher not available yet.
- `401`: missing or invalid bearer token.
- `403`: hostile or disallowed origin/host.
- `revision_conflict`: stale mutation control revision.

### Phase 1 Exclusions

Phase 1 intentionally excludes MCP resources/prompts/sampling/tasks and any automatic remote exposure. The surface is loopback-only Streamable HTTP tool calls for command-layer operations.
