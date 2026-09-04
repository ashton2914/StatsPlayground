import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { Graph, type GraphSpec } from "../../src/graphCore";
import type { GraphDataFrame } from "../../src/types/graphData";

const frame: GraphDataFrame = {
  requestId: "normal-sigma-bands",
  datasetId: "dataset-1",
  generation: 1,
  sourceRows: 100,
  processedRows: 100,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  rawChunks: [],
  aggregates: [{
    kind: "summary",
    yColumn: "measurement",
    summaries: [{
      count: 100,
      mean: 10,
      median: 10,
      stddev: 2,
      min: 2,
      max: 18,
    }],
  }],
  rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
};

const data = { columns: ["measurement"], rows: [] };

function spec(showSigmaBands: boolean): GraphSpec {
  return {
    encoding: { x: { name: "measurement", type: "continuous" } },
    elements: [{ kind: "normalCurve", enabled: true, options: { showSigmaBands } }],
  };
}

async function paintedPixelCount(canvas: Locator) {
  return canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
}

test("renders optional sigma reference shading beneath the Normal Curve", async ({ mount }) => {
  const withoutBands = await mount(
    <div style={{ width: 520, height: 320 }}>
      <Graph spec={spec(false)} data={data} frame={frame} />
    </div>,
  );
  const plainCanvas = withoutBands.locator("canvas");
  await expect(plainCanvas).toHaveCount(1);
  await expect.poll(() => paintedPixelCount(plainCanvas)).toBeGreaterThan(100);
  const plainPainted = await paintedPixelCount(plainCanvas);
  await withoutBands.unmount();

  const withBands = await mount(
    <div style={{ width: 520, height: 320 }}>
      <Graph spec={spec(true)} data={data} frame={frame} />
    </div>,
  );
  const shadedCanvas = withBands.locator("canvas");
  await expect(shadedCanvas).toHaveCount(1);
  await expect.poll(() => paintedPixelCount(shadedCanvas)).toBeGreaterThan(plainPainted + 500);
});
