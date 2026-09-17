import assert from "node:assert/strict";

import {
  createGraphNewFrameReceiver,
  type GraphNewFrameReceiverSnapshot,
} from "../src/services/graphNewTransport.ts";
import type {
  GraphNewFrame,
  GraphNewFrameHeader,
  GraphNewFrameIdentity,
  GraphNewFrameToken,
} from "../src/types/graphNew.ts";

function makeIdentity(cameraGeneration = 2): GraphNewFrameIdentity {
  return {
    requestId: "transport-spike",
    datasetGeneration: 1,
    rendererGeneration: 1,
    cameraGeneration,
  };
}

function makeHeader(
  frameId: number,
  cameraGeneration: number,
  overrides: Partial<GraphNewFrameHeader> = {},
): GraphNewFrameHeader {
  return {
    ...makeIdentity(cameraGeneration),
    frameId,
    width: 4,
    height: 2,
    format: "rgba8",
    byteLength: 32,
    readbackCompletedAtUnixMicros: 1,
    ...overrides,
  };
}

function makeReceiver(activeIdentity = makeIdentity()) {
  const frames: GraphNewFrame[] = [];
  const errors: string[] = [];
  const receiver = createGraphNewFrameReceiver({
    activeIdentity: () => activeIdentity,
    onFrame: (frame) => frames.push(frame),
    onError: (message) => errors.push(message),
  });
  return { receiver, frames, errors };
}

function token(header: GraphNewFrameHeader): GraphNewFrameToken {
  return {
    requestId: header.requestId,
    datasetGeneration: header.datasetGeneration,
    rendererGeneration: header.rendererGeneration,
    cameraGeneration: header.cameraGeneration,
    frameId: header.frameId,
  };
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(1, 1));
  receiver.acceptPayload(token(makeHeader(1, 1)), new ArrayBuffer(32));
  receiver.begin(makeHeader(2, 2));
  receiver.acceptPayload(token(makeHeader(2, 2)), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [2]);
  assert.deepEqual(errors, []);
  assert.deepEqual(receiver.snapshot(), {
    maximumQueueDepth: 1,
    droppedSupersededFrames: 1,
    rejectedFrames: 0,
    presentedFrames: 0,
    pendingFrameId: 2,
  } satisfies GraphNewFrameReceiverSnapshot);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(3, 2));
  receiver.begin(makeHeader(4, 2));
  receiver.acceptPayload(token(makeHeader(3, 2)), new ArrayBuffer(32));
  receiver.acceptPayload(token(makeHeader(4, 2)), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [4]);
  assert.deepEqual(errors, []);
  assert.equal(receiver.snapshot().maximumQueueDepth, 1);
  assert.equal(receiver.snapshot().droppedSupersededFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(5, 2));
  receiver.acceptPayload(token(makeHeader(5, 2)), new ArrayBuffer(31));

  assert.deepEqual(frames, []);
  assert.deepEqual(errors, ["graph-new frame 5 payload length 31 does not match 32"]);
  assert.equal(receiver.snapshot().rejectedFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(6, 2, { width: 0 }));
  receiver.acceptPayload(token(makeHeader(6, 2, { width: 0 })), new ArrayBuffer(32));

  assert.deepEqual(frames, []);
  assert.deepEqual(errors, ["graph-new frame width must be a positive integer"]);
  assert.equal(receiver.snapshot().rejectedFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(7, 2));
  receiver.cancelGeneration(2);
  receiver.acceptPayload(token(makeHeader(7, 2)), new ArrayBuffer(32));

  assert.deepEqual(frames, []);
  assert.deepEqual(errors, []);
  assert.equal(receiver.snapshot().droppedSupersededFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(8, 2));
  receiver.acceptPayload(token(makeHeader(8, 2)), new ArrayBuffer(32));
  receiver.begin(makeHeader(8, 2));
  receiver.acceptPayload(token(makeHeader(8, 2)), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [8]);
  assert.deepEqual(errors, ["graph-new frame 8 is a duplicate"]);
  assert.equal(receiver.snapshot().rejectedFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();

  receiver.begin(makeHeader(9, 2, { format: "png", byteLength: 12 }));
  const frameToken = token(makeHeader(9, 2, { format: "png", byteLength: 12 }));
  receiver.acceptPayload(frameToken, new ArrayBuffer(12));
  assert.equal(receiver.canPresent(frameToken), true);
  receiver.markPresented(frameToken, 42.5);
  assert.equal(receiver.canPresent(frameToken), false);
  receiver.markPresented(frameToken, 43);

  assert.equal(frames[0]?.header.format, "png");
  assert.deepEqual(errors, []);
  assert.equal(receiver.snapshot().presentedFrames, 1);
}

{
  const { receiver, frames, errors } = makeReceiver();
  const current = makeHeader(10, 2);
  const stale = makeHeader(11, 1);

  receiver.begin(current);
  receiver.begin(stale);
  receiver.acceptPayload(token(stale), new ArrayBuffer(32));
  receiver.acceptPayload(token(current), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [10]);
  assert.deepEqual(errors, []);
  assert.equal(receiver.snapshot().droppedSupersededFrames, 1);
}

{
  const { receiver, frames } = makeReceiver();
  const first = makeHeader(12, 2);
  const second = makeHeader(13, 2);

  receiver.begin(first);
  receiver.acceptPayload(token(first), new ArrayBuffer(32));
  receiver.begin(second);
  receiver.acceptPayload(token(second), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [12, 13]);
  assert.equal(receiver.canPresent(token(first)), false);
  assert.equal(receiver.canPresent(token(second)), true);
  assert.equal(receiver.snapshot().droppedSupersededFrames, 1);
  assert.equal(receiver.snapshot().maximumQueueDepth, 1);
}

{
  let activeIdentity = makeIdentity(2);
  const frames: GraphNewFrame[] = [];
  const receiver = createGraphNewFrameReceiver({
    activeIdentity: () => activeIdentity,
    onFrame: (frame) => frames.push(frame),
  });
  const first = makeHeader(14, 2);
  receiver.begin(first);
  receiver.acceptPayload(token(first), new ArrayBuffer(32));
  receiver.markPresented(token(first), 1);

  activeIdentity = {
    ...makeIdentity(3),
    requestId: "transport-spike-next",
  };
  const reused = makeHeader(14, 3, { requestId: "transport-spike-next" });
  receiver.begin(reused);
  receiver.acceptPayload(token(reused), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.requestId), [
    "transport-spike",
    "transport-spike-next",
  ]);
}

{
  const { receiver, frames, errors } = makeReceiver();
  const older = makeHeader(15, 2);
  const newer = makeHeader(16, 2);

  receiver.begin(older);
  receiver.acceptPayload(token(older), new ArrayBuffer(32));
  receiver.begin(newer);
  receiver.acceptPayload(token(newer), new ArrayBuffer(32));
  receiver.markPresented(token(newer), 10);
  receiver.begin(older);
  receiver.acceptPayload(token(older), new ArrayBuffer(32));

  assert.deepEqual(frames.map((frame) => frame.header.frameId), [15, 16]);
  assert.deepEqual(errors, ["graph-new frame 15 is not newer than frame 16"]);
  assert.equal(receiver.snapshot().rejectedFrames, 1);
}

console.log("graphNewTransport tests passed");
