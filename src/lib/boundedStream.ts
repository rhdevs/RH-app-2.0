/**
 * Pass a byte stream through, but fail it the moment more than `max` bytes have
 * gone by. Used when proxying a stored file: the size on record is a claim, and
 * this makes the bound a fact, whatever the store sends.
 */
export function boundedStream(
  source: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new Error("STREAM_TOO_LARGE"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
