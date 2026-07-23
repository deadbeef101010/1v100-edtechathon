export function createRequestIdRetainer(createRequestId) {
  if (typeof createRequestId !== "function") {
    // Fail at construction, not first use: a missing generator otherwise
    // surfaces as broken buttons deep inside event handlers.
    throw new TypeError("createRequestIdRetainer requires a request-id generator function");
  }
  let requestId;

  return Object.freeze({
    current() {
      requestId ??= createRequestId();
      return requestId;
    },
    reset() {
      requestId = createRequestId();
      return requestId;
    },
    clear() {
      requestId = undefined;
    },
  });
}
