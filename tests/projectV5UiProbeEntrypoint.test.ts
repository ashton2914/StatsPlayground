import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Guard capability boundaries independently of the optional native benchmark build.
const entry=readFileSync('src/main.tsx','utf8');
assert.match(entry,/if \(import\.meta\.env\.VITE_PROJECT_V5_BENCHMARK === "1"\)/);
assert.doesNotMatch(entry,/import\.meta\.env\.DEV && import\.meta\.env\.VITE_PROJECT_V5_BENCHMARK/);
const native=readFileSync('src-tauri/src/perf_project_v5_ui.rs','utf8');
assert.match(native,/option_env!\("VITE_PROJECT_V5_BENCHMARK"\)!=Some\("1"\)/);
assert.match(native,/STATSPG_PROJECT_V5_UI_CONFIG/);
const app=readFileSync('src/benchmarks/ProjectV5UiBenchmark.tsx','utf8');
assert.match(app,/<App\/>/);
assert.match(app,/measurePaintedProjectOperation/);
assert.match(app,/snapshot\(\)\.status==='saved'/);
assert.match(app,/projectViewportBudget\.snapshot\(\)/);
console.log('Project v5 UI probe entrypoint boundaries passed');
