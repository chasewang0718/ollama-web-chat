'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { FormEvent, useEffect, useMemo, useState } from 'react';

type ConversationItem = {
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
};

export default function Chat() {
  const { messages, setMessages, sendMessage, status, error, clearError } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const [input, setInput] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('gemma2:9b');
  const [modelsError, setModelsError] = useState('');
  const [conversationsError, setConversationsError] = useState('');
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const isBusy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await fetch('/api/models', { cache: 'no-store' });
        const data = (await response.json()) as { models?: string[]; error?: string };
        const fetchedModels = data.models || [];

        if (fetchedModels.length > 0) {
          setModels(fetchedModels);
          setSelectedModel((current) => (fetchedModels.includes(current) ? current : fetchedModels[0]));
        } else if (data.error) {
          setModelsError(data.error);
        }
      } catch {
        setModelsError('读取模型列表失败');
      }
    };

    const loadConversations = async () => {
      setIsLoadingConversations(true);
      try {
        const response = await fetch('/api/conversations', { cache: 'no-store' });
        const data = (await response.json()) as { conversations?: ConversationItem[]; error?: string };
        if (!response.ok) {
          setConversationsError(data.error || '会话功能暂不可用，请先执行 SQL 建表脚本。');
          setConversations([]);
          return;
        }

        const list = data.conversations || [];
        setConversations(list);
        setConversationsError('');

        if (!list.length) {
          const created = await fetch('/api/conversations', { method: 'POST' });
          const createdData = (await created.json()) as {
            conversation?: { id: string; title: string };
            error?: string;
          };
          if (!created.ok) {
            setConversationsError(createdData.error || '会话功能暂不可用，请先执行 SQL 建表脚本。');
            return;
          }
          const id = createdData.conversation?.id;
          if (id) {
            setConversations([
              {
                id,
                title: createdData.conversation?.title || '新对话',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ]);
            setActiveConversationId(id);
            setMessages([]);
          }
        } else {
          setActiveConversationId((current) => current || list[0].id);
        }
      } catch {
        setConversationsError('读取会话失败，请稍后重试。');
      } finally {
        setIsLoadingConversations(false);
      }
    };

    void loadModels();
    void loadConversations();
  }, [setMessages]);

  useEffect(() => {
    const loadMessages = async () => {
      if (!activeConversationId) return;
      setIsLoadingMessages(true);
      try {
        const response = await fetch(`/api/conversations/${activeConversationId}/messages`, {
          cache: 'no-store',
        });
        const data = (await response.json()) as { messages?: typeof messages };
        setMessages((data.messages || []) as typeof messages);
      } finally {
        setIsLoadingMessages(false);
      }
    };

    void loadMessages();
  }, [activeConversationId, setMessages]);

  const handleCreateConversation = async () => {
    if (isBusy) return;
    const response = await fetch('/api/conversations', { method: 'POST' });
    const data = (await response.json()) as {
      conversation?: { id: string; title: string };
      error?: string;
    };
    if (!response.ok) {
      setConversationsError(data.error || '会话功能暂不可用，请先执行 SQL 建表脚本。');
      return;
    }
    if (!data.conversation?.id) return;

    const now = new Date().toISOString();
    setConversations((items) => [
      {
        id: data.conversation!.id,
        title: data.conversation?.title || '新对话',
        created_at: now,
        updated_at: now,
      },
      ...items,
    ]);
    setActiveConversationId(data.conversation.id);
    setMessages([]);
    setInput('');
    setConversationsError('');
  };

  const renderedMessages = useMemo(
    () =>
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      })),
    [messages],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;

    const value = input.trim();
    if (!value) return;
    if (!activeConversationId) return;

    if (error) clearError();
    await sendMessage(
      { text: value },
      { body: { model: selectedModel, conversationId: activeConversationId } },
    );
    setInput('');
  };

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-72 flex-col border-r border-slate-200 bg-[#f7f8fa] p-4 md:flex">
        <button
          type="button"
          className="mb-4 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-400"
          onClick={() => void handleCreateConversation()}
          disabled={isBusy}
        >
          + 发起新对话
        </button>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">历史对话</p>
        <div className="space-y-1 overflow-y-auto">
          {isLoadingConversations && <p className="px-2 py-1 text-xs text-slate-400">加载中...</p>}
          {!isLoadingConversations &&
            conversations.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveConversationId(item.id)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  item.id === activeConversationId
                    ? 'bg-white font-medium text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:bg-white'
                }`}
              >
                <p className="truncate">{item.title || '新对话'}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {new Date(item.updated_at).toLocaleString()}
                </p>
              </button>
            ))}
          {!isLoadingConversations && conversations.length === 0 && (
            <p className="px-2 py-1 text-xs text-slate-400">暂无历史对话</p>
          )}
          {conversationsError && <p className="px-2 py-2 text-xs text-amber-600">{conversationsError}</p>}
        </div>
      </aside>

      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-4 pb-40 pt-8">
        <header className="mb-6">
          <div className="mb-3 flex items-center justify-between gap-3 md:hidden">
            <button
              type="button"
              className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white"
              onClick={() => void handleCreateConversation()}
              disabled={isBusy}
            >
              + 新对话
            </button>
            <span className="text-xs text-slate-400">{conversations.length} 个会话</span>
          </div>
          <p className="text-sm font-medium text-slate-500">本地 AI 助手（Ollama）</p>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="model-select" className="text-xs font-medium text-slate-500">
              当前模型
            </label>
            <select
              id="model-select"
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
              disabled={isBusy || models.length === 0}
            >
              {models.length === 0 ? (
                <option value={selectedModel}>{selectedModel}</option>
              ) : (
                models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))
              )}
            </select>
          </div>
          {renderedMessages.length === 0 && (
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-800">今天想让我帮你做什么？</h1>
          )}
        </header>

        <section className="flex-1 space-y-4">
          {renderedMessages.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
              {isLoadingMessages
                ? '正在加载会话...'
                : '试试这样提问：帮我总结这段文本 / 帮我写一封邮件 / 帮我规划今天任务'}
            </div>
          )}

          {renderedMessages.map((message) => {
            const isUser = message.role === 'user';
            return (
              <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                {isUser ? (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-slate-900 px-4 py-3 text-sm leading-6 text-white shadow-sm">
                    {message.text}
                  </div>
                ) : (
                  <div className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-800 shadow-sm">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-900 shadow-sm">
                        <svg viewBox="0 0 64 64" className="h-6 w-6" aria-hidden="true">
                          <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 18v10" />
                            <path d="M44 18v10" />
                            <path d="M16 29c0-10 7-16 16-16s16 6 16 16v16c0 8-6 14-14 14h-4c-8 0-14-6-14-14V29z" />
                            <circle cx="25" cy="34" r="1.6" fill="currentColor" />
                            <circle cx="39" cy="34" r="1.6" fill="currentColor" />
                            <ellipse cx="32" cy="41" rx="9" ry="6" />
                            <circle cx="32" cy="41" r="1.8" fill="currentColor" />
                          </g>
                        </svg>
                      </span>
                      <span className="text-xs font-medium text-slate-500">助手回复</span>
                    </div>
                    <div className="whitespace-pre-wrap">{message.text}</div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </main>

      <form
        onSubmit={handleSubmit}
        className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 backdrop-blur"
      >
        <div className="mx-auto flex w-full max-w-3xl items-end gap-3 px-4 py-4">
          <textarea
            className="max-h-40 min-h-12 w-full resize-y rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-slate-500 disabled:bg-slate-100"
            value={input}
            placeholder="输入你的问题，回车发送（Shift+Enter 换行）"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit(event as unknown as FormEvent<HTMLFormElement>);
              }
            }}
            disabled={isBusy || !activeConversationId}
          />
          <button
            type="submit"
            className="h-12 rounded-2xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-400"
            disabled={isBusy || !input.trim() || !activeConversationId}
          >
            发送
          </button>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4 text-xs">
          {isBusy && <p className="text-slate-500">AI 正在回复...</p>}
          {modelsError && <p className="text-amber-600">{modelsError}</p>}
          {error && <p className="text-red-500">连接失败，请确认 Ollama 服务已启动。</p>}
        </div>
      </form>
    </div>
  );
}
