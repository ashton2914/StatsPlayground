# Issue 262 Launch VS Code Design

## Goal

Add a `Launch VS Code` action to the MCP management panel so a user can
select a working directory and open it in Visual Studio Code with a working
StatsPlayground MCP workspace configuration.

The flow must be safe by default:

- preserve unrelated VS Code MCP configuration;
- never silently replace a different StatsPlayground server entry;
- never place a bearer token in a Git-tracked file;
- keep the MCP endpoint stable across application restarts;
- launch only Stable Visual Studio Code;
- support Windows, macOS, and Linux.

## Scope

### Approved VS Code 1.141 compatibility amendment (2026-10-10)

New workspaces use root `.mcp.json` with top-level `mcpServers`. Existing root configurations take precedence over legacy `.vscode/mcp.json`; legacy-only workspaces continue using `servers` in place. The application does not automatically delete or migrate existing files. If a root configuration coexists with a legacy `StatsPlayground` entry, refuse launch planning and ask the user to complete migration or resolve the duplicate before creating another managed entry. Bind both configuration snapshots and the selected format into the launch plan so migration during confirmation invalidates it. Preview and result expose only the relative configuration path. Git protection, JSONC preservation, conflict approval, private atomic writes and rollback apply to the selected path and format.

This amendment supersedes the legacy-only path and schema references below. References: [VS Code configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [migration](https://code.visualstudio.com/docs/agent-customization/migrate-customizations).

The first release:

1. selects one existing local directory;
2. establishes a persistent StatsPlayground MCP endpoint and token;
3. creates or merges `<workspace>/.vscode/mcp.json`;
4. protects a newly created local configuration from Git commits;
5. launches Stable Visual Studio Code with the selected directory;
6. reports partial completion accurately when configuration succeeds but VS
   Code cannot be launched.

The first release does not:

- support VS Code Insiders or arbitrary editors;
- install Visual Studio Code;
- configure Remote SSH, Dev Containers, WSL, or remote workspaces;
- write a token into a Git-tracked configuration file;
- modify repository `.gitignore`;
- remove or rewrite unrelated MCP servers or `inputs`;
- start a VS Code Chat session or suppress VS Code's own session-runtime
  requirements.

## User Experience

The MCP Server panel adds a primary `Launch VS Code` action near the existing
server lifecycle controls.

When selected:

1. StatsPlayground opens the native directory picker.
2. The backend prepares a launch plan.
3. If no persistent MCP settings exist, the plan shows that StatsPlayground
   will select an available loopback port and generate a token.
4. If an existing `servers.StatsPlayground` entry differs from the required
   configuration, the UI shows a non-secret summary of the current and
   proposed endpoint and asks for confirmation.
5. The UI executes the approved plan.
6. StatsPlayground writes the workspace configuration and opens VS Code.
7. The panel reports one of:
   - configured and launched;
   - configured, but VS Code was not found or could not be launched;
   - no changes made, with a specific validation or security error.

The token is never displayed in the confirmation summary. The existing reveal
and copy controls remain the deliberate token-disclosure surfaces.

## Architecture

### Frontend responsibilities

`McpServerPanel` remains a presentation component. The Zustand MCP store owns
the launch workflow state and calls a typed service wrapper.

The frontend:

- opens the native directory picker;
- requests a backend launch plan;
- presents conflict and security information;
- asks for overwrite confirmation when required;
- executes an approved plan;
- displays the structured result.

It does not parse workspace files, inspect Git metadata, construct process
commands, or write credentials.

### Tauri command layer

Add thin commands in the MCP command domain:

- `plan_vscode_mcp_launch(workspace_path)`;
- `execute_vscode_mcp_launch(request)`.

Both delegate to a `VsCodeLaunchService`. The execute request includes the
plan identity and the user's explicit conflict approval. The service rejects a
stale plan if relevant workspace or MCP settings state changed between plan
and execution.

The commands return `Result<T, AppError>`, use camelCase serialization at the
IPC boundary, and are registered in `tauri::generate_handler!`.

### VS Code launch service

The backend service owns:

- workspace path validation;
- persistent MCP configuration readiness;
- VS Code workspace configuration planning and writing;
- Git tracking protection;
- Stable VS Code discovery and process launch;
- structured, non-secret diagnostics.

The service is split into pure helpers for configuration planning, Git-state
classification, and platform launch command construction. File and process
side effects remain behind small interfaces so tests do not launch real
applications.

## MCP Settings State Machine

The launch flow requires one endpoint and token that are both currently active
and persisted for later application restarts.

### Saved settings exist

- If the server is stopped, start it with the saved port and token.
- If the server is running with the same endpoint and token, reuse it.
- If runtime and saved settings disagree, stop before writing workspace
  configuration and return an explicit state-conflict error.

### No saved settings exist and the server is stopped

1. Generate a token.
2. Bind the MCP server on `127.0.0.1:0`.
3. Read the actual OS-assigned port from the running server.
4. Persist that exact port and token atomically.
5. Use the active endpoint in the workspace configuration.

Binding before persistence avoids selecting a free port and losing it to
another process before the server starts.

### No saved settings exist and a transient server is running

Persist the exact active port and token through a narrow runtime operation that
first verifies the values still describe the current running server. This is
the only running-state settings write allowed; ordinary settings editing
remains stopped-only.

If persistence fails after a new server starts, stop that newly started server
and return the persistence error. Do not leave a success-shaped transient
runtime behind.

## Workspace Validation

The selected path must:

- exist;
- be a directory;
- resolve to a stable canonical path;
- remain the same directory through plan and execution;
- allow creation of or writing within its `.vscode` child.

The service opens filesystem objects relative to the validated workspace
directory where platform APIs permit it. It rejects symlink or reparse-point
traversal that would place `.vscode/mcp.json` outside the selected workspace.

No absolute workspace path is returned to the normal frontend state. Result
messages use the selected folder's display name. Raw paths remain internal to
the command invocation and backend diagnostics.

## VS Code MCP Configuration

The managed entry is:

```json
{
  "servers": {
    "StatsPlayground": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

The planner accepts VS Code JSON with comments. It preserves:

- the top-level `inputs` value;
- every server other than `StatsPlayground`;
- unknown top-level properties;
- unrelated comments and formatting where the JSONC edit library can retain
  them.

Only `servers.StatsPlayground` is inserted or replaced. A malformed JSONC file
is never overwritten; the user receives a parse error with line and column
when available.

The implementation should use a source-aware JSONC edit operation rather than
deserialize and reserialize the complete file. The resulting file is parsed
again before replacement and must contain the exact intended managed entry.

### Conflict policy

- Missing entry: insert without a conflict prompt.
- Semantically identical entry: make no content change.
- Different StatsPlayground entry: return `confirmationRequired` with
  non-secret old/new endpoint summaries.
- Changed file after planning: reject execution as stale and require a new
  plan.

## Credential and Git Protection

The workspace configuration contains a bearer token and must be treated as a
credential-bearing local file.

For a Git working tree:

1. Determine whether `.vscode/mcp.json` is tracked using Git plumbing from the
   selected workspace.
2. If tracked, refuse to write a plaintext token. Existing bytes remain
   unchanged.
3. If untracked, add `/.vscode/mcp.json` to the worktree-local
   `.git/info/exclude` when needed.
4. Preserve existing exclude entries and line-ending style.
5. Verify Git reports the configuration ignored before writing the token.

The service never edits repository `.gitignore`, stages files, or invokes a
shell.

For a non-Git directory, the user-selected local directory is sufficient
authorization. The confirmation UI warns that the generated file contains a
local credential.

## Atomic Write

Configuration writes follow this transaction:

1. Capture the original file bytes and metadata.
2. Create `.vscode` if absent.
3. Write the complete planned bytes to a temporary file in `.vscode`.
4. Apply owner-only permissions where supported.
5. Flush and sync the temporary file.
6. Atomically replace `mcp.json`.
7. Read it back and verify the exact managed entry.

If the replace or verification fails, restore the original bytes when a file
previously existed and report failure. A new file is removed only when the
service can prove it created that exact file during the failed transaction.

## Stable VS Code Discovery and Launch

Process launch uses executable plus argument arrays, never a shell command.
The working directory argument is passed as one validated value.

### Windows

Check supported Stable installation locations under the current user and
Program Files, then the `code` command when it resolves to a real executable.
Launch `Code.exe <workspace>`.

### macOS

Prefer `/Applications/Visual Studio Code.app`, then the current user's
Applications directory. Launch through the operating-system application API
or `/usr/bin/open -a "Visual Studio Code" --args <workspace>` with fixed
arguments.

### Linux

Resolve the Stable `code` executable from a bounded executable search path and
launch `code <workspace>`.

The launch result distinguishes:

- `launched`;
- `configuredVsCodeNotFound`;
- `configuredLaunchFailed`.

Configuration success is retained when launching fails. The UI provides the
folder name and tells the user to open that folder manually in Stable VS Code.

## Data Contracts

The plan response includes:

- a random plan ID;
- workspace display name;
- configuration action: `create`, `merge`, `replaceManagedEntry`, or
  `unchanged`;
- whether confirmation is required;
- current and proposed endpoint summaries without tokens;
- Git protection status;
- MCP settings action: `reuse`, `startSaved`, `persistRunning`, or
  `initializePersistent`;
- warnings.

The execute response includes:

- configuration result;
- MCP server status;
- launch result;
- warnings.

Plan records live only in memory, expire after a short bounded interval, and
are single-use. They bind to the canonical workspace identity, source config
hash, Git tracking classification, and relevant MCP settings/runtime
fingerprint.

## Error Handling

Errors remain explicit and actionable:

- workspace missing, inaccessible, or unsafe;
- malformed workspace MCP JSONC;
- tracked credential-bearing configuration;
- stale or expired plan;
- MCP port bind failure;
- MCP settings persistence failure;
- configuration write or rollback failure;
- VS Code not installed;
- VS Code process launch failure.

No broad catch converts these failures into success. Messages exposed to the
frontend omit tokens and absolute paths.

## Testing

### Rust unit and integration tests

- new strict JSON configuration;
- merge while preserving `inputs`, other servers, comments, and unknown keys;
- identical managed entry is a no-op;
- different managed entry requires confirmation;
- malformed JSONC is preserved;
- source change invalidates a plan;
- tracked config rejects plaintext token;
- local exclude merge is idempotent and preserves existing entries;
- symlink/reparse escape is rejected;
- new settings bind first, then persist the active port and token;
- persistence failure stops a server started by the transaction;
- running transient settings persist only when the runtime fingerprint
  matches;
- Stable VS Code command construction for Windows, macOS, and Linux;
- not-found and launch-failure results preserve configuration success;
- result serialization never exposes tokens or absolute paths.

### Frontend tests

- button availability and directory-picker cancellation;
- plan preview for create, merge, conflict, and tracked-file rejection;
- explicit confirmation before managed-entry replacement;
- no execute call when confirmation is declined;
- configured-and-launched success;
- configured-but-not-found recovery message;
- settings and server status refresh after execution;
- localized strings in all shipped locales.

### Required verification

- focused Rust service and command tests;
- focused MCP management store and component tests;
- full frontend build;
- `cargo build`, `cargo clippy`, and affected Rust tests;
- `git diff --check`;
- manual acceptance on macOS plus command-construction coverage for Windows and
  Linux before platform-specific manual acceptance is available.

## Documentation

Update the development and troubleshooting documentation with:

- the one-click launch workflow;
- the local credential file behavior;
- Git-tracked configuration refusal;
- Stable VS Code discovery behavior;
- the remaining VS Code requirement to create a Chat session before manually
  starting a server from certain VS Code surfaces;
- manual recovery when VS Code cannot be launched.

## Acceptance Criteria

1. From a running StatsPlayground application, a user can select an ordinary
   local folder and open it in Stable VS Code with a ready StatsPlayground MCP
   workspace entry.
2. The server endpoint remains valid across StatsPlayground restarts.
3. Existing unrelated MCP configuration survives byte-for-byte except for the
   smallest source-aware insertion or replacement required for the managed
   entry.
4. Re-running the flow is idempotent.
5. A conflicting managed entry is never overwritten without confirmation.
6. A plaintext token is never written to a Git-tracked file.
7. A failed VS Code launch does not undo a valid configuration and is reported
   as partial completion.
8. No success is reported after a configuration, settings, rollback, or launch
   failure.
