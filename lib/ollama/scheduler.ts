import { AsyncLocalStorage } from "node:async_hooks";

export class OllamaBusyError extends Error {
  readonly name = "OllamaBusyError";
  constructor(message = "Ollama is busy") {
    super(message);
  }
}

type LockState = { depth: number };

const als = new AsyncLocalStorage<LockState>();

let locked = false;
const waiters: Array<() => void> = [];

function acquireGlobal(): Promise<void> {
  if (!locked) {
    locked = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      locked = true;
      resolve();
    });
  });
}

function releaseGlobal(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  locked = false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

  await acquireGlobal();
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
export async function acquireOllamaExclusive(): Promise<() => void> {
  await acquireGlobal();
  return once(() => releaseGlobal());
}

export async function tryAcquireOllamaExclusive(options?: { waitMs?: number }): Promise<() => void> {
  const waitMs = options?.waitMs ?? 0;
  const started = Date.now();
  while (true) {
    if (!locked) {
      await acquireGlobal();
      return once(() => releaseGlobal());
    }
    if (Date.now() - started >= waitMs) {
      throw new OllamaBusyError();
    }
    await sleep(25);
  }
}

export async function tryRunOllamaExclusive<T>(
  fn: () => Promise<T>,
  options?: { waitMs?: number },
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

  const waitMs = options?.waitMs ?? 0;
  const started = Date.now();
  while (true) {
    if (!locked) {
      await acquireGlobal();
      break;
    }
    if (Date.now() - started >= waitMs) {
      throw new OllamaBusyError();
    }
    await sleep(25);
  }

  try {
    return await als.run({ depth: 1 }, fn);
  } finally {
    releaseGlobal();
  }
}

