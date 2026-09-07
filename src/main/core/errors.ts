/**
 * core 层统一错误:携带机器可读 code。
 * §12 的 Result 判别联合在 IPC 边界(M2 ipc.ts)完成——core 内抛 CoreError,
 * 由壳层 catch 后转 `{ ok:false, code, message }`,异常不跨进程裸抛。
 */
export class CoreError extends Error {
  readonly code: string;
  /** 附带上下文(路径、URL、期望值等),供 UI 展示与日志 */
  readonly context?: Record<string, unknown>;

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.context = context;
  }
}

/** 判定未知异常是否为 CoreError(避免 instanceof 在模块双实例下失效) */
export function isCoreError(e: unknown): e is CoreError {
  return e instanceof Error && (e as { name?: string }).name === 'CoreError';
}
