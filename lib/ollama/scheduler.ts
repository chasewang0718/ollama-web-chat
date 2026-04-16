import { AsyncLocalStorage } from "node:async_hooks";

export class OllamaBusyError extends Error {
  readonly name = "OllamaBusyError";
  constructor(message = "Ollama is busy") {
    super(message);
  }
}

export class OllamaQueueCancelledError extends Error {
  readonly name = "OllamaQueueCancelledError";
  constructor(message = "Ollama queue wait cancelled") {
    super(message);
  }
}

type LockState = { depth: number };
type OllamaPriority = "high" | "normal" | "low";
type QueueEntry = {
  id: number;
  priorityScore: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  aborted: boolean;
  abortHandler?: () => void;
  signal?: AbortSignal;
};
type AcquireOptions = {
  waitMs?: number;
  priority?: OllamaPriority;
  signal?: AbortSignal;
};

const als = new AsyncLocalStorage<LockState>();

let locked = false;
let nextQueueId = 1;
const waiters: QueueEntry[] = [];

function priorityToScore(priority?: OllamaPriority): number {
  if (priority === "high") return 3;
  if (priority === "low") return 1;
  return 2;
}

function removeEntry(id: number): void {
  const index = waiters.findIndex((item) => item.id === id);
  if (index >= 0) {
    waiters.splice(index, 1);
  }
}

function cleanupEntry(entry: QueueEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  if (entry.signal && entry.abortHandler) {
    entry.signal.removeEventListener("abort", entry.abortHandler);
  }
}

function acquireGlobal(options?: AcquireOptions): Promise<void> {
  if (!locked) {
    locked = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const id = nextQueueId++;
    const entry: QueueEntry = {
      id,
      priorityScore: priorityToScore(options?.priority),
      resolve: () => {
        cleanupEntry(entry);
        locked = true;
        resolve();
      },
      reject: () => undefined,
      aborted: false,
      signal: options?.signal,
    };
    entry.reject = (error: Error) => {
      if (entry.aborted) return;
      entry.aborted = true;
      cleanupEntry(entry);
      removeEntry(id);
      reject(error);
    };

    if (typeof options?.waitMs === "number" && options.waitMs >= 0) {
      entry.timer = setTimeout(() => {
        entry.reject(new OllamaBusyError());
      }, options.waitMs);
    }

    if (entry.signal) {
      entry.abortHandler = () => {
        entry.reject(new OllamaQueueCancelledError());
      };
      entry.signal.addEventListener("abort", entry.abortHandler, { once: true });
    }

    waiters.push(entry);
    waiters.sort((a, b) => {
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      return a.id - b.id;
    });
  });
}

function releaseGlobal(): void {
  while (waiters.length > 0) {
    const next = waiters.shift();
    if (!next || next.aborted) {
      continue;
    }
    next.resolve();
    return;
  }
  locked = false;
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

export async function runOllamaExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const state = als.getStore();
  if (state) {
    state.depth += 1;
    try {
      return await fn();
    } finally {
      state.depth -= 1;
    }
  }

  await acquireGlobal({ priority: "normal" });
  try {
    return await als.run({ depth: 1 }, fn);
  } finally {
    releaseGlobal();
  }
}

/**
 * Acquire the global Ollama lock and return a release callback.
 * Note: this is intended for long-lived operations (e.g. streaming) where the caller
 * must control when the lock is released.
 */
export async function acquireOllamaExclusive(options?: Omit<AcquireOptions, "priority">): Promise<() => void> {
  await acquireGlobal({ ...options, priority: "high" });
  return once(() => releaseGlobal());
}

export async function tryAcquireOllamaExclusive(options?: AcquireOptions): Promise<() => void> {
  if (options?.signal?.aborted) {
    throw new OllamaQueueCancelledError();
  }
  const waitMs = options?.waitMs ?? 0;
  if (waitMs <= 0 && locked) throw new OllamaBusyError();
  await acquireGlobal(options);
  if (options?.signal?.aborted) {
    releaseGlobal();
    throw new OllamaQueueCancelledError();
  }
  return once(() => releaseGlobal());
}

export async function tryRunOllamaExclusive<T>(
  fn: () => Promise<T>,
  options?: AcquireOptions,
): Promise<T> {
  const state = als.getStore();
  if (state) {
    state.depth += 1;
    try {
      return await fn();
    } finally {
      state.depth -= 1;
    }
  }

  const release = await tryAcquireOllamaExclusive(options);

  try {
    return await als.run({ depth: 1 }, fn);
  } finally {
    release();
  }
}

export function getOllamaQueueDepth(): number {
  return waiters.filter((item) => !item.aborted).length;
}

