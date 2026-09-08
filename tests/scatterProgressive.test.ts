import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildGraph } from "../src/graphCore/transform.ts";
import { getGraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

function bits(flags: number[]): Uint8Array {
	const out = new Uint8Array(Math.max(1, Math.ceil(flags.length / 8)));
	for (let i = 0; i < flags.length; i += 1) {
		if (flags[i]) out[i >> 3] |= 1 << (i & 7);
	}
	return out;
}

function getSeries(option: unknown): any[] {
	const record = option as { series?: unknown };
	return Array.isArray(record?.series) ? (record.series as any[]) : [];
}

function hasPickPayload(series: any): boolean {
	if (!series || series.type !== "scatter" || !Array.isArray(series.data)) return false;
	return series.data.some((item: any) => !!item && typeof item === "object" && "__pick" in item);
}

function scatterSeries(option: unknown): any[] {
	return getSeries(option).filter((s) => s && typeof s === "object" && s.type === "scatter");
}

const graphSource = readFileSync(new URL("../src/graphCore/Graph.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(graphSource.includes("RawPointsLayer"), false, "Graph.tsx must not host a second point renderer");
assert.equal(graphSource.includes("./rawPoints"), false, "Graph.tsx must not use Canvas point hit testing");

const sourceData: GraphData = {
	columns: ["x", "y", "overlay", "_row_id"],
	rows: [
		[1, 10, "A", 101],
		[2, 20, "B", 102],
		[3, 30, "A", 103],
	],
};

const baseSpec: GraphSpec = {
	encoding: {
		x: { name: "x", type: "continuous" },
		y: { name: "y", type: "continuous" },
		overlay: { name: "overlay", type: "nominal" },
	},
	elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
};

const frame: GraphDataFrame = {
	requestId: "req-1",
	datasetId: "ds-1",
	generation: 1,
	sourceRows: 3,
	processedRows: 3,
	sampling: { mode: "full" },
	dictionaries: {
		x: [],
		group: ["A", "B"],
		facetX: ["F1", "F2"],
	},
	extents: {},
	rawChunks: [
		{
			chunkIndex: 0,
			rowOffset: 0,
			rowCount: 3,
			xValues: new Float64Array([1, 2, 3]),
			yValues: new Float64Array([10, 20, 30]),
			rowIds: new BigInt64Array([101n, 102n, 103n]),
			groupCodes: new Uint32Array([0, 1, 0]),
			facetXCodes: new Uint32Array([0, 1, 0]),
			roleVectors: {
				group: new Uint32Array([0, 1, 0]),
				groupX: new Uint32Array([0, 1, 0]),
			},
			validity: {
				x: bits([1, 1, 1]),
				y: bits([1, 1, 1]),
				group: bits([1, 1, 1]),
				facetX: bits([1, 1, 1]),
			},
		},
	],
	aggregates: [],
};

const theme = getGraphTheme();

const builtWithoutFrame = buildGraph(baseSpec, sourceData, theme);
assert.equal(builtWithoutFrame.panels.length, 1, "non-frame path should produce one panel for the baseline spec");

const nonFrameScatter = scatterSeries(builtWithoutFrame.panels[0].option);
const nonFrameRawScatter = nonFrameScatter.find((s) => hasPickPayload(s));
assert.ok(nonFrameRawScatter, "non-frame raw scatter fallback should retain __pick metadata for table selection");
assert.equal(nonFrameRawScatter.progressive, 0, "non-frame raw scatter fallback should pin progressive to 0");
assert.ok(nonFrameScatter.every((s) => s.large !== true), "raw scatter fallback should never enable large mode");

const builtWithFrameSingle = buildGraph(baseSpec, sourceData, theme, undefined, frame);
assert.equal(builtWithFrameSingle.panels.length, 1, "frame-backed single-panel path should produce one panel");
const frameScatterSeries = scatterSeries(builtWithFrameSingle.panels[0].option);
assert.ok(
	frameScatterSeries.length > 0,
	"frame-backed points must produce standard ECharts scatter series",
);
assert.ok(
	frameScatterSeries.some(hasPickPayload),
	"frame-backed ECharts scatter must retain __pick metadata",
);
assert.ok(
	frameScatterSeries.every((s) => s.large !== true),
	"frame-backed points rendering should never enable large mode",
);

const facetedSpec: GraphSpec = {
	...baseSpec,
	encoding: {
		...baseSpec.encoding,
		groupX: { name: "facet_col", type: "nominal" },
	},
};

const builtWithFrameFaceted = buildGraph(facetedSpec, sourceData, theme, undefined, frame);
assert.ok(builtWithFrameFaceted.panels.length >= 2, "frame-backed faceted path should produce multiple panels from facet keys");
assert.ok(
	builtWithFrameFaceted.panels.every((panel) => scatterSeries(panel.option).some(hasPickPayload)),
	"every populated facet must expose frame-backed ECharts pick metadata",
);
assert.ok(
	builtWithFrameFaceted.panels.every((panel) => scatterSeries(panel.option).every((s) => s.large !== true)),
	"frame-backed faceted panels must never enable large mode on scatter series",
);
const facetPickCounts = builtWithFrameFaceted.panels
	.map((panel) => scatterSeries(panel.option).reduce((count, series) => (
		count + (Array.isArray(series.data)
			? series.data.filter((item: any) => !!item?.__pick).length
			: 0)
	), 0))
	.sort((left, right) => left - right);
assert.deepEqual(facetPickCounts, [1, 2], "each facet must contain only its matching frame-backed points");

console.log("scatter progressive source regression passed");