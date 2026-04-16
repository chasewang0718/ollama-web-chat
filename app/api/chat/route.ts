import { convertToModelMessages, streamText, UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { acquireOllamaExclusive } from "@/lib/ollama/scheduler";
import {
  applyLargeModelGenerationSafety,
  isLargeModel,
  shouldDisableMemoryForModel,
} from "@/lib/ollama/runtime-policy";
import {
  countUserTurns,
  formatRecentConversation,
  getLastUserText,
} from "@/lib/memory/messages";
import { bindConversationBackend, getConversationBackend } from "@/lib/storage/bindings";
import { ensureBackendReady } from "@/lib/storage/connection";
import {
  getControlPlaneStorageProvider,
  getStorageMode,
  getStorageProviderForBackend,
  resolveDefaultBackendForNewConversation,
} from "@/lib/storage/router";
import { getMemoryOrgId } from "@/lib/supabase/service";

const modelName = process.env.OLLAMA_MODEL || "gemma2:9b";
const CYDONIA_LONG_INPUT_THRESHOLD = 1200;
const MEMORY_RETRIEVE_TIMEOUT_MS = Number.parseInt(process.env.MEMORY_RETRIEVE_TIMEOUT_MS || "", 10) || 2500;
const OLLAMA_HEALTH_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "", 10) || 1800;
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_AUTO_HEAL_ENABLED = process.env.OLLAMA_AUTO_HEAL === "true";
const OLLAMA_AUTO_HEAL_COOLDOWN_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_COOLDOWN_MS || "", 10) || 180_000;
const OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS || "", 10) || 15_000;
const OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS || "", 10) || 25_000;
const OLLAMA_AUTO_FALLBACK_ENABLED = process.env.OLLAMA_AUTO_FALLBACK !== "false";
const OLLAMA_FALLBACK_MODEL = (process.env.OLLAMA_FALLBACK_MODEL || "gemma2:9b").trim();
const STORAGE_HYBRID_LEGACY_PROBE_ENABLED = process.env.STORAGE_HYBRID_LEGACY_PROBE !== "false";

const execAsync = promisify(exec);
let ollamaAutoHealUntil = 0;

const ollama = createOpenAICompatible({
  name: "ollama",
  baseURL: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
});

function isMemoryFeatureEnabled(): boolean {
  return process.env.MEMORY_ENABLED !== "false";
}

type ReplyLanguage = "same" | "zh" | "en" | "nl" | "ja";
type ResponseMode = "strict-task" | "creative-continue";
type StrictTaskType = "polish" | "summarize" | "extract" | "analyze" | "qa" | "generic";
type PromptProfile = "default" | "cydonia";
type RoutedTask = {
  taskType: StrictTaskType;
  responseMode: ResponseMode;
  confidence: number;
};

function isModelLoadFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybe = error as { message?: string; cause?: unknown; statusCode?: number; responseBody?: string };
  const message = (maybe.message || "").toLowerCase();
  const responseBody = (maybe.responseBody || "").toLowerCase();
  if (message.includes("model failed to load") || responseBody.includes("model failed to load")) return true;
  if (message.includes("resource limitations") || responseBody.includes("resource limitations")) return true;
  return false;
}

function isCydoniaModel(model: string): boolean {
  return /^cydonia/i.test(model.trim());
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

type OllamaHealthResult = { ok: true } | { ok: false; error: string };

type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    until?: string;
  }>;
};

type EngineHealthResult =
  | { ok: true }
  | { ok: false; error: string; stoppingModel?: string };

const OLLAMA_QUARANTINE_MS =
  Number.parseInt(process.env.OLLAMA_QUARANTINE_MS || "", 10) || 10 * 60_000;
const modelQuarantineUntil = new Map<string, number>();

function isModelQuarantined(model: string): boolean {
  const until = modelQuarantineUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelQuarantineUntil.delete(model);
    return false;
  }
  return true;
}

function quarantineModel(model: string): void {
  modelQuarantineUntil.set(model, Date.now() + OLLAMA_QUARANTINE_MS);
}

async function probeEngineHealthy(): Promise<EngineHealthResult> {
  try {
    const psResponse = await fetch(`${OLLAMA_HOST}/api/ps`, {
      cache: "no-store",
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!psResponse.ok) {
      // If ps itself is unhealthy, treat as engine unhealthy (recoverable).
      return { ok: false, error: `Ollama 引擎状态不可用（${psResponse.status}）。` };
    }
    const data = (await psResponse.json()) as OllamaPsResponse;
    const models = data.models || [];
    const stopping = models.find((m) => (m.until || "").toLowerCase().includes("stopping"));
    if (stopping) {
      return {
        ok: false,
        error: `Ollama 引擎正在停止模型（${stopping.name || "unknown"}）。`,
        stoppingModel: stopping.name,
      };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Ollama 引擎探测失败（${message}）。` };
  }
}

async function probeModelReady(activeModel: string): Promise<OllamaHealthResult> {
  try {
    const tagsResponse = await fetch(`${OLLAMA_HOST}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!tagsResponse.ok) {
      return { ok: false, error: `Ollama 模型列表不可用（${tagsResponse.status}）。` };
    }
    const tagsData = (await tagsResponse.json()) as { models?: Array<{ name?: string }> };
    const names = new Set((tagsData.models || []).map((item) => item.name).filter(Boolean));
    if (!names.has(activeModel)) {
      return { ok: false, error: `模型 ${activeModel} 不在 Ollama 列表中。` };
    }

    const showResponse = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: activeModel }),
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!showResponse.ok) {
      const details = await showResponse.text();
      return { ok: false, error: `模型 ${activeModel} 当前不可用：${details || showResponse.status}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法连接 Ollama（${message}）。` };
  }
}

function isRecoverableOllamaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("无法连接 ollama") ||
    lower.includes("headers timeout") ||
    lower.includes("当前不可用") ||
    lower.includes("stopping") ||
    lower.includes("connection")
  );
}

async function restartOllamaProcess(): Promise<void> {
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec || "cmd.exe";
    await execAsync(`${cmd} /d /s /c "taskkill /IM ollama.exe /F"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    }).catch(() => undefined);
    await execAsync(`${cmd} /d /s /c "taskkill /IM \"ollama app.exe\" /F"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    }).catch(() => undefined);
    // Clear OLLAMA_MODELS for serve restarts. Pointing it to a raw GGUF folder can make the daemon
    // "lose" all models (0 blobs) and break inference endpoints.
    await execAsync(`${cmd} /d /s /c "set OLLAMA_MODELS=&& start \"\" ollama serve"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    });
    return;
  }
  await execAsync(`pkill -f "ollama"`, {
    timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
  }).catch(() => undefined);
  await execAsync(`nohup ollama serve >/tmp/ollama-autorestart.log 2>&1 &`, {
    timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
  });
}

async function verifyModelAfterRestart(activeModel: string): Promise<OllamaHealthResult> {
  const startedAt = Date.now();
  let lastError = "Ollama 重启后模型仍不可用。";
  while (Date.now() - startedAt < OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS) {
    const engine = await probeEngineHealthy();
    if (!engine.ok) {
      lastError = engine.error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    const model = await probeModelReady(activeModel);
    if (model.ok) return model;
    lastError = model.error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return { ok: false, error: `自动自愈后校验超时：${lastError}` };
}

async function tryAutoHealOllama(
  activeModel: string,
  options?: { force?: boolean; reason?: string },
): Promise<OllamaHealthResult> {
  if (!OLLAMA_AUTO_HEAL_ENABLED) {
    return { ok: false, error: "Ollama 自动自愈未开启。" };
  }
  const now = Date.now();
  const force = options?.force === true;
  if (!force && now < ollamaAutoHealUntil) {
    const left = Math.ceil((ollamaAutoHealUntil - now) / 1000);
    return { ok: false, error: `Ollama 自动自愈冷却中（剩余 ${left}s）。` };
  }

  // When engine is in "Stopping..." it often cascades into multi-model unavailability.
  // Allow forced heals to bypass cooldown so the UI "heal" button and stuck detector can recover.
  ollamaAutoHealUntil = now + (force ? 15_000 : OLLAMA_AUTO_HEAL_COOLDOWN_MS);
  try {
    if (options?.reason) {
      console.warn(`chat route: ollama auto-heal triggered (${options.reason}) for model ${activeModel}`);
    }
    await restartOllamaProcess();
    return await verifyModelAfterRestart(activeModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `自动自愈重启失败：${message}` };
  }
}

async function ensureModelReady(activeModel: string): Promise<OllamaHealthResult> {
  if (isModelQuarantined(activeModel)) {
    return { ok: false, error: `模型 ${activeModel} 已被临时隔离（近期触发 Ollama Stopping）。` };
  }
  const engine = await probeEngineHealthy();
  if (!engine.ok) {
    if (engine.stoppingModel) {
      quarantineModel(engine.stoppingModel);
    }
    if (!isRecoverableOllamaError(engine.error)) return engine;
    const healedEngine = await tryAutoHealOllama(activeModel, {
      force: Boolean(engine.stoppingModel),
      reason: engine.stoppingModel ? `engine stopping (${engine.stoppingModel})` : "engine unhealthy",
    });
    if (healedEngine.ok) {
      console.warn(`chat route: ollama auto-heal (engine) succeeded for model ${activeModel}`);
      return healedEngine;
    }
    // If the engine is stopping this same model, quarantine it to protect other models.
    if (engine.stoppingModel && engine.stoppingModel === activeModel) {
      quarantineModel(activeModel);
      console.warn(`chat route: quarantined model due to stopping: ${activeModel}`);
    }
    return { ok: false, error: `${engine.error}；${healedEngine.error}` };
  }

  const first = await probeModelReady(activeModel);
  if (first.ok) return first;
  if (!isRecoverableOllamaError(first.error)) return first;

  const healed = await tryAutoHealOllama(activeModel);
  if (healed.ok) {
    console.warn(`chat route: ollama auto-heal succeeded for model ${activeModel}`);
    return healed;
  }
  return { ok: false, error: `${first.error}；${healed.error}` };
}

function detectExplicitReplyLanguage(text: string | undefined): ReplyLanguage | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();

  if (
    /荷兰语|荷蘭語|nederlands|dutch/.test(t) ||
    /(会说|會說|speak).*(荷兰语|荷蘭語|dutch|nederlands)/.test(t)
  ) {
    return "nl";
  }
  if (/中文|汉语|漢語|chinese|mandarin/.test(t)) return "zh";
  if (/英语|英語|english/.test(t)) return "en";
  if (/日语|日語|japanese|日本語/.test(t)) return "ja";
  return undefined;
}

function detectInputLanguage(text: string | undefined): ReplyLanguage {
  if (!text) return "same";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  return "same";
}

function routeTask(text: string | undefined): RoutedTask {
  if (!text) return { taskType: "generic", responseMode: "strict-task", confidence: 0.3 };
  const t = text.toLowerCase();

  // Pipeline 1: editing / polishing
  if (
    /润色|改写|重写|仿写|优化文案|美化表达|调整语气|改得更顺|改成/.test(t) ||
    /\b(polish|rewrite|rephrase|paraphrase|copyedit|improve wording)\b/.test(t)
  ) {
    return { taskType: "polish", responseMode: "strict-task", confidence: 0.93 };
  }

  // Pipeline 2: creative continuation
  if (
    /续写|接着写|继续写|写下一段|写后续|扩写/.test(t) ||
    /\b(continue writing|continue the story|story continuation|write the next|expand|elaborate)\b/.test(t)
  ) {
    return { taskType: "generic", responseMode: "creative-continue", confidence: 0.9 };
  }

  // Pipeline 3-6: structured task buckets
  if (/总结|摘要|概括|总结一下|核心观点|\b(summary|summarize)\b/.test(t)) {
    return { taskType: "summarize", responseMode: "strict-task", confidence: 0.9 };
  }
  if (/提取|抽取|信息抽取|要点提取|\b(extract|list out|identify)\b/.test(t)) {
    return { taskType: "extract", responseMode: "strict-task", confidence: 0.9 };
  }
  if (/分析|问题|建议|漏洞|评估|\b(analyze|analysis|review)\b/.test(t)) {
    return { taskType: "analyze", responseMode: "strict-task", confidence: 0.86 };
  }
  if (/回答|问答|解答|\b(question|answer)\b/.test(t)) {
    return { taskType: "qa", responseMode: "strict-task", confidence: 0.82 };
  }
  return { taskType: "generic", responseMode: "strict-task", confidence: 0.6 };
}

function getGenerationProfile(
  taskType: StrictTaskType,
  responseMode: ResponseMode,
  cydoniaModel: boolean,
  longInput: boolean,
): { temperature: number; topP: number; maxOutputTokens?: number } {
  if (responseMode === "creative-continue") {
    return {
      temperature: cydoniaModel ? 0.55 : 0.75,
      topP: cydoniaModel ? 0.82 : 0.92,
      maxOutputTokens: cydoniaModel ? (longInput ? 800 : 1100) : undefined,
    };
  }

  const strictBase = (() => {
    switch (taskType) {
      case "polish":
        return { temperature: 0.22, topP: 0.8 };
      case "extract":
        return { temperature: 0.1, topP: 0.65 };
      case "summarize":
        return { temperature: 0.18, topP: 0.72 };
      case "analyze":
        return { temperature: 0.25, topP: 0.78 };
      case "qa":
        return { temperature: 0.2, topP: 0.75 };
      default:
        return { temperature: 0.2, topP: 0.75 };
    }
  })();

  if (cydoniaModel) {
    return {
      temperature: Math.min(strictBase.temperature, 0.2),
      topP: Math.min(strictBase.topP, 0.7),
      maxOutputTokens: longInput ? 800 : 1100,
    };
  }
  return strictBase;
}

function buildCombinedSystemPrompt(
  l2Summary?: string,
  l3Memory?: string,
  preferredLanguage: ReplyLanguage = "same",
  responseMode: ResponseMode = "strict-task",
  strictTaskType: StrictTaskType = "generic",
  taskRoutingConfidence?: number,
  options?: { relaxedForLongInput?: boolean; promptProfile?: PromptProfile },
): string | undefined {
  const sections: string[] = [];
  const relaxedForLongInput = options?.relaxedForLongInput === true;
  const promptProfile = options?.promptProfile || "default";
  const bypassTaskConstraints = promptProfile === "cydonia";
  const languagePolicyByPreference: Record<ReplyLanguage, string> = {
    same:
      "Reply in the same language as the user unless they explicitly request another language. Keep responses natural and concise.",
    zh: "请使用简体中文回答，除非用户明确要求其他语言。语气自然、简洁、口语化。",
    en: "Please answer in English unless the user explicitly requests another language.",
    nl: "Beantwoord in het Nederlands, tenzij de gebruiker expliciet om een andere taal vraagt.",
    ja: "ユーザーが明示的に別言語を求めない限り、日本語で回答してください。",
  };
  const behaviorPrompt = languagePolicyByPreference[preferredLanguage];
  sections.push(`[Response Policy]\n${behaviorPrompt}`);
  if (typeof taskRoutingConfidence === "number") {
    sections.push(`[Task Routing]\nRouted task: ${strictTaskType}; confidence: ${taskRoutingConfidence.toFixed(2)}`);
  }
  if (bypassTaskConstraints) {
    // Cydonia profile: remove task/format constraints entirely and let the model follow user prompt natively.
  } else if (relaxedForLongInput) {
    sections.push(
      [
        "[Task Mode]",
        "Prioritize stable instruction-following for long-input editing tasks.",
        "Do exactly what the user asks (e.g. polish/rewrite/summarize) and avoid adding unrelated tasks.",
        "Keep output concise unless the user asks for expansion.",
      ].join("\n"),
    );
  } else if (responseMode === "strict-task") {
    const strictOutputFormat: Record<StrictTaskType, string> = {
      polish:
        "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 直接给出润色后的结果\n3) 不要添加解释性前言，除非用户要求",
      summarize:
        "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 核心观点（3条项目符号）\n3) 可选：一句结论",
      extract:
        "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 按字段项目符号提取结果\n3) 仅使用原文事实；未提及字段写“未提及”\n4) 禁止添加任何原文中不存在的新句子",
      analyze:
        "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 问题分析（项目符号）\n3) 可执行建议（项目符号）",
      qa: "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 直接回答问题\n3) 必要时补充依据",
      generic:
        "Output format:\n1) 第一行必须是：你的需求是：<一句话任务复述>\n2) 按用户要求给出结构化结果（项目符号或分段）",
    };
    sections.push(
      [
        "[Task Mode]",
        "Default to instruction-following mode, not continuation mode.",
        "Treat long user text as reference material unless the user explicitly asks for continuation.",
        "Do not output any narrative/prose line before the required first line.",
        "The first line must start with: 你的需求是：",
        "Do not continue or expand user-provided prose unless explicitly requested.",
        "If your output looks like story continuation, it is incorrect and must be regenerated.",
        "Do not invent details not present in the user's text for summarize/extract/analyze tasks.",
        strictOutputFormat[strictTaskType],
      ].join("\n"),
    );
  } else {
    sections.push(
      [
        "[Task Mode]",
        "Creative continuation mode is enabled because the user explicitly requested continuation.",
        "Continue writing while preserving tone, facts, and constraints from the provided text.",
      ].join("\n"),
    );
  }
  sections.push(
    "[Identity]\nYou are a local AI model running in Ollama. Never claim to be OpenAI/ChatGPT/GPT-3.5.",
  );

  if (l2Summary?.trim()) {
    sections.push(["[L2 Session Summary]", l2Summary.trim()].join("\n"));
  }

  if (l3Memory?.trim()) {
    sections.push(
      [
        "[Memory Citation Rule]",
        "When using facts from L3 Retrieved Memories, append citation tags like [M1] at sentence end.",
        "Do not fabricate citation tags that are not present in L3 snippets.",
      ].join("\n"),
    );
    sections.push(["[L3 Retrieved Memories]", l3Memory.trim()].join("\n"));
  }

  if (!sections.length) return undefined;
  return sections.join("\n\n");
}

export async function POST(req: Request) {
  try {
    const controlPlane = getControlPlaneStorageProvider();
    const { messages, model, conversationId } = (await req.json()) as {
      messages: UIMessage[];
      model?: string;
      conversationId?: string;
    };
    const memoryUserId = process.env.MEMORY_USER_ID;
    const memoryOrgId = getMemoryOrgId();
    const bindingClient = controlPlane.createServiceRoleClient();
    const backend = conversationId && bindingClient && memoryUserId
      ? await getConversationBackend(bindingClient, memoryUserId, memoryOrgId, conversationId)
      : undefined;
    let selectedBackend = backend || resolveDefaultBackendForNewConversation(getStorageMode());

    // Legacy compatibility for pre-binding conversations in hybrid mode:
    // optional probe of both backends, then persist binding once source is identified.
    if (
      STORAGE_HYBRID_LEGACY_PROBE_ENABLED &&
      !backend &&
      conversationId &&
      memoryUserId &&
      getStorageMode() === "hybrid"
    ) {
      const cloudReady = await ensureBackendReady("cloud");
      const localReady = await ensureBackendReady("local");
      const cloudMessages = cloudReady.ok
        ? await getStorageProviderForBackend("cloud").conversation.getMessages(
            memoryUserId,
            memoryOrgId,
            conversationId,
          )
        : [];
      if (cloudMessages.length > 0) {
        selectedBackend = "cloud";
      } else if (localReady.ok) {
        const localMessages = await getStorageProviderForBackend("local").conversation.getMessages(
          memoryUserId,
          memoryOrgId,
          conversationId,
        );
        if (localMessages.length > 0) {
          selectedBackend = "local";
        }
      } else {
        console.warn("chat route local backend unavailable in hybrid probe", localReady.error);
      }

      if (bindingClient) {
        await bindConversationBackend(bindingClient, memoryUserId, memoryOrgId, conversationId, selectedBackend);
      }
    } else if (!backend && conversationId && getStorageMode() === "hybrid") {
      console.warn(
        "chat route: hybrid legacy probe disabled; relying on control-plane binding/default backend resolution.",
      );
    }

    const selectedReady = await ensureBackendReady(selectedBackend);
    if (!selectedReady.ok) {
      return Response.json({ error: selectedReady.error }, { status: 503 });
    }

    const storage = getStorageProviderForBackend(selectedBackend);
    const release = await acquireOllamaExclusive({ signal: req.signal });
    try {
      const activeModel = model || modelName;
      let runtimeModel = activeModel;
      if (isModelQuarantined(runtimeModel) && OLLAMA_AUTO_FALLBACK_ENABLED && OLLAMA_FALLBACK_MODEL) {
        runtimeModel = OLLAMA_FALLBACK_MODEL;
        console.warn(`chat route: model ${activeModel} quarantined, fallback to ${runtimeModel}`);
      }
      const modelHealth = await ensureModelReady(activeModel);
      if (!modelHealth.ok) {
        const canFallback =
          OLLAMA_AUTO_FALLBACK_ENABLED && OLLAMA_FALLBACK_MODEL && OLLAMA_FALLBACK_MODEL !== activeModel;
        if (!canFallback) {
          return Response.json({ error: modelHealth.error }, { status: 503 });
        }

        const fallbackHealth = await ensureModelReady(OLLAMA_FALLBACK_MODEL);
        if (!fallbackHealth.ok) {
          return Response.json(
            { error: `${modelHealth.error}；自动回退模型 ${OLLAMA_FALLBACK_MODEL} 也不可用：${fallbackHealth.error}` },
            { status: 503 },
          );
        }
        runtimeModel = OLLAMA_FALLBACK_MODEL;
        console.warn(`chat route: model ${activeModel} unavailable, fallback to ${runtimeModel}`);
      }

      const supabase = storage.createServiceRoleClient();
      const largeModel = isLargeModel(runtimeModel);
      const memoryOn =
        isMemoryFeatureEnabled() &&
        Boolean(supabase && memoryUserId) &&
        !shouldDisableMemoryForModel(runtimeModel);
      const lastUserText = getLastUserText(messages);
      const userTurns = countUserTurns(messages);
      const preferredLanguage: ReplyLanguage =
        detectExplicitReplyLanguage(lastUserText) || detectInputLanguage(lastUserText);
      const routedTask = routeTask(lastUserText);
      const responseMode = routedTask.responseMode;
      const strictTaskType = routedTask.taskType;
      const longInput = (lastUserText?.length || 0) >= CYDONIA_LONG_INPUT_THRESHOLD;
      const cydoniaModel = isCydoniaModel(runtimeModel);
      const relaxConstraintsForLongInput = cydoniaModel && longInput;
      const promptProfile: PromptProfile = cydoniaModel ? "cydonia" : "default";

      let l2SummaryText: string | undefined;
      let l3MemoryPrompt: string | undefined;

      if (memoryOn && supabase && memoryUserId && conversationId) {
        l2SummaryText = await storage.conversation.getSummary(memoryUserId, memoryOrgId, conversationId);
      }

    if (memoryOn && supabase && memoryUserId && lastUserText) {
      l3MemoryPrompt = await withTimeout(
        storage.memory.buildSystemPrompt(
          supabase,
          memoryUserId,
          memoryOrgId,
          lastUserText,
          Number.parseInt(process.env.MEMORY_MATCH_COUNT || "5", 10) || 5,
          conversationId,
        ),
        MEMORY_RETRIEVE_TIMEOUT_MS,
        undefined,
      );
    }

    const baseMessages = await convertToModelMessages(messages);
    const systemPrompt = buildCombinedSystemPrompt(
      l2SummaryText,
      l3MemoryPrompt,
      preferredLanguage,
      responseMode,
      strictTaskType,
      routedTask.confidence,
      { relaxedForLongInput: relaxConstraintsForLongInput, promptProfile },
    );
      const generationProfile = applyLargeModelGenerationSafety(
        runtimeModel,
        getGenerationProfile(strictTaskType, responseMode, cydoniaModel, longInput),
      );
      if (largeModel) {
        console.warn(
          `chat route: large model profile enabled for ${runtimeModel} (memory=${memoryOn ? "on" : "off"}, maxOutputTokens=${generationProfile.maxOutputTokens})`,
        );
      }

    const onFinish = async ({ text }: { text: string }) => {
      if (!memoryOn || !supabase || !memoryUserId || !lastUserText || !text?.trim()) {
        return;
      }

      // Two-phase memory path:
      // 1) return chat response immediately
      // 2) run memory persist / summary maintenance in background (best-effort)
      queueMicrotask(() => {
        void (async () => {
          try {
            await storage.memory.persistTurn(
              supabase,
              memoryUserId,
              memoryOrgId,
              lastUserText,
              text,
              conversationId,
            );

            const conversationMessages: UIMessage[] = [
              ...messages,
              {
                id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-assistant`,
                role: "assistant",
                parts: [{ type: "text", text }],
              } as UIMessage,
            ];

            const healthInterval =
              Number.parseInt(process.env.MEMORY_HEALTHCHECK_INTERVAL || "20", 10) || 20;
            if (userTurns > 0 && userTurns % healthInterval === 0) {
              await storage.memory.runHealthCheck(supabase, memoryUserId, memoryOrgId);
            }

            const interval = Number.parseInt(process.env.MEMORY_SUMMARY_INTERVAL || "8", 10) || 8;
            if (!storage.summary.shouldRefresh(userTurns, interval)) {
              await storage.conversation.saveState({
                userId: memoryUserId,
                orgId: memoryOrgId,
                conversationId: conversationId || "default",
                messages: conversationMessages,
              });
              return;
            }

            const recentConversation = formatRecentConversation(messages, 14);
            if (!recentConversation.trim()) return;

            const generatedSummary = await storage.summary.generate(
              recentConversation,
              l2SummaryText,
              runtimeModel,
            );
            await storage.conversation.saveState({
              userId: memoryUserId,
              orgId: memoryOrgId,
              conversationId: conversationId || "default",
              messages: conversationMessages,
              summary: generatedSummary,
            });
          } catch (error) {
            console.warn("chat route: async memory pipeline failed", error);
          }
        })();
      });
    };

    const runStream = async (modelToUse: string) =>
      streamText({
        model: ollama.chatModel(modelToUse),
        temperature: generationProfile.temperature,
        topP: generationProfile.topP,
        ...(typeof generationProfile.maxOutputTokens === "number"
          ? { maxOutputTokens: generationProfile.maxOutputTokens }
          : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: baseMessages,
        onFinish,
      });

    let result;
    try {
      result = await runStream(runtimeModel);
    } catch (e) {
      if (
        runtimeModel !== OLLAMA_FALLBACK_MODEL &&
        OLLAMA_AUTO_FALLBACK_ENABLED &&
        OLLAMA_FALLBACK_MODEL &&
        isModelLoadFailure(e)
      ) {
        quarantineModel(runtimeModel);
        console.warn(`chat route: model load failed, quarantined ${runtimeModel}; fallback to ${OLLAMA_FALLBACK_MODEL}`);
        result = await runStream(OLLAMA_FALLBACK_MODEL);
      } else {
        throw e;
      }
    }

      const response = result.toUIMessageStreamResponse();
      const body = response.body;
      if (!body) {
        release();
        return response;
      }

      const reader = body.getReader();
      const wrapped = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              release();
              controller.close();
              return;
            }
            if (value) controller.enqueue(value);
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        cancel: async () => {
          release();
          await reader.cancel().catch(() => undefined);
        },
      });

      // Preserve headers/status while ensuring lock releases only after stream ends.
      return new Response(wrapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    console.error("chat route error:", error);
    return Response.json(
      {
        error: "聊天请求失败，请确认 Ollama 服务和模型可用。",
      },
      { status: 500 },
    );
  }
}
