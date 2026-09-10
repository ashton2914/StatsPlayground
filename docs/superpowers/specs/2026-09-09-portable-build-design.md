# Portable Build Design

## Goal

Add one local build command that produces one portable download artifact for the
current host platform:

- Windows: one `StatsPlayground-<version>-windows-<arch>.zip` file containing
  `StatsPlayground.exe`.
- macOS: one `StatsPlayground-<version>-macos-<arch>.zip` file containing the
  runnable `StatsPlayground.app` bundle.

The command builds only for the host operating system. The GitHub Release
workflow runs it independently on native Windows and macOS runners; it does not
cross-compile.

## Platform Contract

The Windows executable may depend on the system WebView2 runtime. Windows 10 and
Windows 11 normally provide it, but the build documentation must state this
runtime requirement.

Both platforms use versioned ZIP filenames while keeping stable application
names inside the archives, so users can replace an older extracted application
without changing its filename. The macOS application remains an `.app` bundle
because that is the native GUI application format. Local unsigned builds may
trigger Gatekeeper; signing and notarization are outside this issue.

## Build Interface

`npm run build:portable` invokes a cross-platform Node script. The script:

1. Reads the package version and detects the host platform and architecture.
2. Removes and recreates `release/portable/` so stale artifacts cannot be
   mistaken for current output.
3. Runs the existing Tauri production build for the host-specific bundle type.
4. Copies or archives the native build output into the portable output folder.
5. Verifies that exactly one final artifact exists and reports its relative
   path and size.

Any failed command, missing native output, unsupported platform, or unexpected
final artifact count exits non-zero with an actionable message.

## Components

- `scripts/buildPortable.mjs`: thin command-line orchestration and filesystem
  operations.
- `scripts/portableBuildCore.mjs`: pure platform, naming, and build-plan logic
  that can be tested on either supported operating system.
- `scripts/portableBuildCore.test.mjs`: Node built-in tests for Windows and
  macOS plans, artifact naming, unsupported platforms, and final artifact
  validation.
- `package.json`: `build:portable` and focused test scripts.
- `docs/development.md`: usage, output locations, prerequisites, and platform
  limitations.
- `.github/workflows/release.yml`: native platform matrix builds and GitHub
  Release publication.
- `.gitignore`: generated portable output, if it is not already ignored.

## Verification

Development follows red-green-refactor: the core contract tests are added and
observed failing before implementation. Final verification includes:

- Node portable-build contract tests.
- A real `npm run build:portable` on macOS and inspection of the ZIP contents.
- Frontend production build.
- Rust build and tests in `src-tauri/`.
- `git diff --check` and a bounded final status/diff review.

Windows command planning is covered by platform-independent tests. Producing and
launching the Windows executable requires a Windows host or a later CI matrix;
that limitation must be reported rather than inferred from a macOS run.