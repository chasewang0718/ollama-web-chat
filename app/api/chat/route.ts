import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { getLastUserText } from '@/lib/memory/messages';
import {
  buildMemorySystemPrompt,
  persistConversationMemory,
} from '@/lib/memory/rag';
import { createServiceRoleClient, isMemoryStorageConfigured } from '@/lib/supabase/service';

const modelName = process.env.OLLAMA_MODEL || 'gemma2:9b';

const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama',
});

function isMemoryFeatureEnabled(): boolean {
  if (process.env.MEMORY_ENABLED === 'false') return false;
  return isMemoryStorageConfigured();
}

export async function POST(req: Request) {
  try {
    const { messages, model } = (await req.json()) as { messages: UIMessage[]; model?: string };
    const activeModel = model || modelName;

    const memoryOn = isMemoryFeatureEnabled();
    const supabase = memoryOn ? createServiceRoleClient() : null;
    const memoryUserId = process.env.MEMORY_USER_ID;
    const lastUserText = getLastUserText(messages);

    let systemPrompt: string | undefined;
    if (memoryOn && supabase && memoryUserId && lastUserText) {
      systemPrompt = await buildMemorySystemPrompt(
        supabase,
        memoryUserId,
        lastUserText,
        Number.parseInt(process.env.MEMORY_MATCH_COUNT || '5', 10) || 5,
      );
    }

    const baseMessages = await convertToModelMessages(messages);

    const result = await streamText({
      model: ollama.chatModel(activeModel),
      ...(systemPrompt
        ? {
            system: systemPrompt,
          }
        : {}),
      messages: baseMessages,
      onFinish: async ({ text }) => {
        if (!memoryOn || !supabase || !memoryUserId || !lastUserText || !text?.trim()) {
          return;
        }
        await persistConversationMemory(supabase, memoryUserId, lastUserText, text);
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('chat route error:', error);
    return Response.json(
      {
        error: '聊天请求失败，请确认 Ollama 服务和模型可用。',
      },
      { status: 500 },
    );
  }
}
