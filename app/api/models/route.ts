export async function GET() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`ollama tags failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };

    const models = (data.models || [])
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name));

    return Response.json({ models });
  } catch (error) {
    console.error('models route error:', error);
    return Response.json({ models: [], error: '无法读取本地模型列表' }, { status: 500 });
  }
}
