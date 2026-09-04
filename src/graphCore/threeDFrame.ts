import type { GraphDataFrame } from "@/types/graphData";

export interface Typed3DPoint {
  x: number;
  y: number;
  z?: number;
  group?: string;
  facetX?: string;
  facetY?: string;
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) return true;
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) return false;
  const mask = 1 << (rowIndex & 7);
  return (bitmap[byteIndex] & mask) !== 0;
}

export function collectFrame3DPoints(frame: GraphDataFrame): Typed3DPoint[] {
  const points: Typed3DPoint[] = [];
  const groupDict = frame.dictionaries.group ?? [];
  const facetXDict = frame.dictionaries.facetX ?? [];
  const facetYDict = frame.dictionaries.facetY ?? [];
  for (const chunk of frame.rawChunks) {
    const n = Math.min(
      chunk.rowCount,
      chunk.xValues.length,
      chunk.yValues.length,
      chunk.zValues?.length ?? chunk.rowCount,
      chunk.groupCodes?.length ?? chunk.rowCount,
      chunk.facetXCodes?.length ?? chunk.rowCount,
      chunk.facetYCodes?.length ?? chunk.rowCount,
    );
    for (let row = 0; row < n; row += 1) {
      if (!bitIsSet(chunk.validity.x, row)) continue;
      if (!bitIsSet(chunk.validity.y, row)) continue;
      const x = Number(chunk.xValues[row]);
      const y = Number(chunk.yValues[row]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      let z: number | undefined;
      if (chunk.zValues) {
        if (!bitIsSet(chunk.validity.z, row)) continue;
        const zv = Number(chunk.zValues[row]);
        if (!Number.isFinite(zv)) continue;
        z = zv;
      }

      let group: string | undefined;
      if (chunk.groupCodes && bitIsSet(chunk.validity.group, row)) {
        group = groupDict[chunk.groupCodes[row] >>> 0];
      }

      let facetX: string | undefined;
      if (chunk.facetXCodes && bitIsSet(chunk.validity.facetX, row)) {
        facetX = facetXDict[chunk.facetXCodes[row] >>> 0];
      }

      let facetY: string | undefined;
      if (chunk.facetYCodes && bitIsSet(chunk.validity.facetY, row)) {
        facetY = facetYDict[chunk.facetYCodes[row] >>> 0];
      }

      points.push({ x, y, z, group, facetX, facetY });
    }
  }
  return points;
}
