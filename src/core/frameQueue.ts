/** Apply the newest pointer sample once per frame; flush before committing history. */
export function createFrameQueue<T>(apply: (value: T) => void,
  schedule = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancel = (id: number) => cancelAnimationFrame(id)) {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (frame != null) cancel(frame);
    frame = null;
    const sample = pending;
    pending = null;
    if (sample) apply(sample.value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (frame == null) frame = schedule(() => { frame = null; flush(); });
    },
    flush,
    clear() {
      if (frame != null) cancel(frame);
      frame = null;
      pending = null;
    }
  };
}
