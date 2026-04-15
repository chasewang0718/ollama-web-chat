import { convertToModelMessages, streamText, UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  countUserTurns,
  formatRecentConversation,
  getLastUserText,
} from "@/lib/memory/messages";
import { bindConversationBackend, getConversationBackend } from "@/lib/storage/bindings";
import {
  getControlPlaneStorageProvider,
  getStorageMode,
  getStorageProviderForBackend,
  resolveDefaultBackendForNewConversation,
} from "@/lib/storage/router";
import { getMemoryOrgId } from "@/lib/supabase/service";

const modelName = process.env.OLLAMA_MODEL || "gemma2:9b";

const ollama = createOpenAICompatible({
  name: "ollama",
  baseURL: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
});

function isMemoryFeatureEnabled(): boolean {
  return process.env.MEMORY_ENABLED !== "false";
}

type ReplyLanguage = "same" | "zh" | "en" | "nl" | "ja";

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

function buildCombinedSystemPrompt(
  l2Summary?: string,
  l3Memory?: string,
  preferredLanguage: ReplyLanguage = "same",
): string | undefined {
  const sections: string[] = [];
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
  sections.push(
    "[Identity]\nYou are a local AI model running in Ollama. Never claim to be OpenAI/ChatGPT/GPT-3.5.",
  );

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
    // probe both backends, then persist binding once source is identified.
    if (!backend && conversationId && memoryUserId && getStorageMode() === "hybrid") {
      const cloudStorage = getStorageProviderForBackend("cloud");
      const cloudMessages = await cloudStorage.conversation.getMessages(
        memoryUserId,
        memoryOrgId,
        conversationId,
      );
      if (cloudMessages.length > 0) {
        selectedBackend = "cloud";
      } else {
        const localStorage = getStorageProviderForBackend("local");
        const localMessages = await localStorage.conversation.getMessages(
          memoryUserId,
          memoryOrgId,
          conversationId,
        );
        if (localMessages.length > 0) {
          selectedBackend = "local";
        }
      }

      if (bindingClient) {
        await bindConversationBackend(bindingClient, memoryUserId, memoryOrgId, conversationId, selectedBackend);
      }
    }

    const storage = getStorageProviderForBackend(selectedBackend);
    const activeModel = model || modelName;

    const supabase = storage.createServiceRoleClient();
    const memoryOn = isMemoryFeatureEnabled() && Boolean(supabase && memoryUserId);
    const lastUserText = getLastUserText(messages);
    const userTurns = countUserTurns(messages);
    const preferredLanguage: ReplyLanguage =
      detectExplicitReplyLanguage(lastUserText) || detectInputLanguage(lastUserText);

    let l2SummaryText: string | undefined;
    let l3MemoryPrompt: string | undefined;

    if (memoryOn && supabase && memoryUserId && conversationId) {
      l2SummaryText = await storage.conversation.getSummary(
        memoryUserId,
        memoryOrgId,
        conversationId,
      );
    }

    if (memoryOn && supabase && memoryUserId && lastUserText) {
      l3MemoryPrompt = await storage.memory.buildSystemPrompt(
        supabase,
        memoryUserId,
        memoryOrgId,
        lastUserText,
        Number.parseInt(process.env.MEMORY_MATCH_COUNT || "5", 10) || 5,
        conversationId,
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
          activeModel,
        );
        await storage.conversation.saveState({
          userId: memoryUserId,
          orgId: memoryOrgId,
          conversationId: conversationId || "default",
          messages: conversationMessages,
          summary: generatedSummary,
        });
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
