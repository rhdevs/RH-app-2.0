import { describe, expect, it } from "vitest";

import { boundedStream } from "../boundedStream";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe("boundedStream", () => {
  it("passes a stream within the bound through unchanged", async () => {
    const source = streamOf([new Uint8Array(40), new Uint8Array(60)]);
    expect(await drain(boundedStream(source, 100))).toBe(100);
  });

  it("fails the stream the moment it runs past the bound", async () => {
    const source = streamOf([new Uint8Array(60), new Uint8Array(60)]);
    await expect(drain(boundedStream(source, 100))).rejects.toThrow(
      "STREAM_TOO_LARGE",
    );
  });
});
