export class ProjectUiTelemetryError extends Error {
  constructor(public readonly operationError: unknown, public readonly telemetryError: unknown) {
    super('UI operation and telemetry completion failed');
    this.name = 'ProjectUiTelemetryError';
  }
}

export interface ProjectUiObservation {
  uiReadyMs: number | null;
  retention: unknown;
  verification: boolean;
  error?: string;
}
interface Measurement<T> {
  begin(): Promise<number>;
  operation(): Promise<unknown>;
  ready(): boolean;
  isCurrent?(): boolean;
  retention(): unknown;
  finish(sampleId: number, observation: ProjectUiObservation): Promise<T>;
  clock?: () => number;
  frame?: () => Promise<void>;
  timeoutMs?: number;
}

/** Observe the real view, then allow two frames before completing native telemetry. */
export async function measurePaintedProjectOperation<T>(deps: Measurement<T>): Promise<T> {
  const sampleId = await deps.begin();
  const clock = deps.clock ?? (() => performance.now());
  const frame = deps.frame ?? (() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  }));
  let finishing = false;
  try {
    const started = clock();
    if (!Number.isFinite(started)) throw new Error('UI measurement clock is unavailable');
    const elapsed = () => {
      const value = clock() - started;
      if (!Number.isFinite(value) || value < 0) throw new Error('UI measurement clock is invalid');
      return value;
    };
    const assertCurrent = () => {
      if (deps.isCurrent && !deps.isCurrent()) throw new Error('Project UI benchmark owner changed');
    };
    await deps.operation();
    for (;;) {
      assertCurrent();
      if (elapsed() > (deps.timeoutMs ?? 15000)) throw new Error('Project UI visible state timed out');
      if (deps.ready()) break;
      await frame();
    }
    await frame();
    await frame();
    assertCurrent();
    if (!deps.ready()) throw new Error('Project UI visible state changed before paint');
    const observation = {uiReadyMs: elapsed(), retention: deps.retention(), verification: true};
    finishing = true;
    return await deps.finish(sampleId, observation);
  } catch (error) {
    if (!finishing) {
      try {
        await deps.finish(sampleId, {uiReadyMs: null, retention: null, verification: false,
          error: error instanceof Error ? error.message : String(error)});
      } catch (telemetryError) {
        throw new ProjectUiTelemetryError(error, telemetryError);
      }
    }
    throw error;
  }
}

/** Keep measured navigation outside the initial 500-row window and its prefetch. */
export function projectProbeRow(index:number,rows:number):number {
  if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(rows)||rows<20000)throw new RangeError('Project probe requires a large fixture and nonnegative sample index');
  return 10000+((Math.floor(rows/2)+index*997)%(rows-10100));
}
