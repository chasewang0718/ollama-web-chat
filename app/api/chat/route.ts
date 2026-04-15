import { convertToModelMessages, streamText, UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  countUserTurns,
  formatRecentConversation,
  getLastUserText,
} from "@/lib/memory/messages";
import {
  buildMemorySystemPrompt,
  persistConversationMemory,
  runMemoryHealthCheck,
} from "@/lib/memory/rag";
import {
  getLatestSummary,
  persistSummary,
  shouldRefreshSummary,
  summarizeConversationWithOllama,
} from "@/lib/memory/summary";
import {
  createServiceRoleClient,
  getMemoryOrgId,
  isMemoryStorageConfigured,
} from "@/lib/supabase/service";

const modelName = process.env.OLLAMA_MODEL || "gemma2:9b";

const ollama = createOpenAICompatible({
  name: "ollama",
  baseURL: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
});

function isMemoryFeatureEnabled(): boolean {
  if (process.env.MEMORY_ENABLED === "false") return false;
  return isMemoryStorageConfigured();
}

function isLikelyChinese(text: string | undefined): boolean {
  if (!text) return false;
  return /[\u4e00-\u9fff]/.test(text);
}

function buildCombinedSystemPrompt(
  l2Summary?: string,
  l3Memory?: string,
  preferredLanguage: "zh" | "same" = "same",
): string | undefined {
  const sections: string[] = [];
  const behaviorPrompt =
    preferredLanguage === "zh"
      ? "请默认使用简体中文回答，除非用户明确要求其他语言。语气自然、简洁、口语化。"
      : "Reply in the same language as the user. Keep responses natural and concise.";
  sections.push(`[Response Policy]\n${behaviorPrompt}`);

  if (l2Summary?.trim()) {
    sections.push(["[L2 Session Summary]", l2Summary.trim()].join("\n"));
  }

  if (l3Memory?.trim()) {
    sections.push(["[L3 Retrieved Memories]", l3Memory.trim()].join("\n"));
  }

  if (!sections.length) return undefined;
  return sections.join("\n\n");
}

export async function POST(req: Request) {
  try {
    const { messages, model } = (await req.json()) as { messages: UIMessage[]; model?: string };
    const activeModel = model || modelName;

    const memoryOn = isMemoryFeatureEnabled();
    const supabase = memoryOn ? createServiceRoleClient() : null;
    const memoryUserId = process.env.MEMORY_USER_ID;
    const memoryOrgId = getMemoryOrgId();
    const lastUserText = getLastUserText(messages);
    const userTurns = countUserTurns(messages);
    const preferredLanguage: "zh" | "same" = isLikelyChinese(lastUserText) ? "zh" : "same";

    let l2SummaryText: string | undefined;
    let l3MemoryPrompt: string | undefined;

    if (memoryOn && supabase && memoryUserId) {
      const latestSummary = await getLatestSummary(supabase, memoryUserId, memoryOrgId);
      l2SummaryText = latestSummary?.summary;
    }

    if (memoryOn && supabase && memoryUserId && lastUserText) {
      l3MemoryPrompt = await buildMemorySystemPrompt(
        supabase,
        memoryUserId,
        memoryOrgId,
        lastUserText,
        Number.parseInt(process.env.MEMORY_MATCH_COUNT || "5", 10) || 5,
      );
    }

    const baseMessages = await convertToModelMessages(messages);
    const systemPrompt = buildCombinedSystemPrompt(
      l2SummaryText,
      l3MemoryPrompt,
      preferredLanguage,
    );

    const result = await streamText({
      model: ollama.chatModel(activeModel),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: baseMessages,
      onFinish: async ({ text }) => {
        if (!memoryOn || !supabase || !memoryUserId || !lastUserText || !text?.trim()) {
          return;
        }

        await persistConversationMemory(supabase, memoryUserId, memoryOrgId, lastUserText, text);

        const healthInterval =
          Number.parseInt(process.env.MEMORY_HEALTHCHECK_INTERVAL || "20", 10) || 20;
        if (userTurns > 0 && userTurns % healthInterval === 0) {
          await runMemoryHealthCheck(supabase, memoryUserId, memoryOrgId);
        }

        const interval = Number.parseInt(process.env.MEMORY_SUMMARY_INTERVAL || "8", 10) || 8;
        if (!shouldRefreshSummary(userTurns, interval)) {
          return;
        }

        const recentConversation = formatRecentConversation(messages, 14);
        if (!recentConversation.trim()) return;

        const generatedSummary = await summarizeConversationWithOllama(
          recentConversation,
          l2SummaryText,
          activeModel,
        );
        if (!generatedSummary) return;

        await persistSummary(supabase, memoryUserId, memoryOrgId, generatedSummary, userTurns);
      },
    });

    return result.toUIMessageStreamResponse();
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
