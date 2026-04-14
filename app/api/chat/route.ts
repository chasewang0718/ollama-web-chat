import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const modelName = process.env.OLLAMA_MODEL || 'gemma2:9b';

const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama',
});

export async function POST(req: Request) {
  try {
    const { messages, model } = (await req.json()) as { messages: UIMessage[]; model?: string };
    const activeModel = model || modelName;

    const result = await streamText({
      model: ollama.chatModel(activeModel),
      messages: await convertToModelMessages(messages),
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
