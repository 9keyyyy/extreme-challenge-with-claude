let readyPromise: Promise<void> = Promise.resolve();

export const mswReady = {
  set(p: Promise<void>) {
    readyPromise = p;
  },
  wait() {
    return readyPromise;
  },
};
