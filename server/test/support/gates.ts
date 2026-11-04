/** 测试用的小工具：把事件等待写成 promise，不使用计时器。 */

/** `signal` 中止时 resolve；已经中止则立即 resolve。 */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}
