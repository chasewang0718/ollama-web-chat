'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const WARMUP_INTERVAL_MS = 5 * 60 * 1000;
const WARMUP_IDLE_STOP_MS = 30 * 60 * 1000;

type ConversationItem = {
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
  storage_backend?: 'cloud' | 'local';
};

type ConversationContextMenuState = {
  conversationId: string;
  x: number;
  y: number;
} | null;

type MigrationTaskItem = {
  conversation_id: string;
  storage_backend: 'cloud' | 'local';
  migration_status: 'none' | 'pending' | 'running' | 'failed' | 'done';
  updated_at: string;
};

export default function Chat() {
  const { messages, setMessages, sendMessage, regenerate, stop, status, error, clearError } = useChat({
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
  const [keepWarmEnabled, setKeepWarmEnabled] = useState(true);
  const lastActivityAtRef = useRef(Date.now());
  const [contextMenu, setContextMenu] = useState<ConversationContextMenuState>(null);
  const [migrationItems, setMigrationItems] = useState<MigrationTaskItem[]>([]);
  const [migrationOnlyFailed, setMigrationOnlyFailed] = useState(false);
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState('');
  const isBusy = status === 'submitted' || status === 'streaming';

  const getBackendLabel = (backend: ConversationItem['storage_backend']) => {
    if (backend === 'local') return '本地';
    if (backend === 'cloud') return '云端';
    return '未知';
  };

  const loadMigrationItems = useCallback(async (onlyFailed = migrationOnlyFailed) => {
    setMigrationLoading(true);
    try {
      const response = await fetch(
        `/api/storage/migrations?mode=batch&limit=30&offset=0&onlyFailed=${onlyFailed ? 'true' : 'false'}`,
        { cache: 'no-store' },
      );
      const data = (await response.json()) as { items?: MigrationTaskItem[]; error?: string };
      if (!response.ok) {
        setMigrationMessage(data.error || '迁移任务读取失败');
        setMigrationItems([]);
        return;
      }
      setMigrationItems(data.items || []);
      setMigrationMessage('');
    } catch {
      setMigrationMessage('迁移任务读取失败');
      setMigrationItems([]);
    } finally {
      setMigrationLoading(false);
    }
  }, [migrationOnlyFailed]);

  const runBatchMigration = async (options: {
    dryRun?: boolean;
    onlyFailed?: boolean;
    rollback?: boolean;
  }) => {
    setMigrationRunning(true);
    setMigrationMessage('');
    try {
      const response = await fetch('/api/storage/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'batch',
          targetBackend: 'local',
          continueOnError: true,
          limit: 30,
          offset: 0,
          onlyFailed: options.onlyFailed || false,
          rollback: options.rollback || false,
          dryRun: options.dryRun || false,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        total?: number;
        succeeded?: number;
        failed?: number;
        error?: string;
      };
      if (!response.ok || !data.ok) {
        setMigrationMessage(data.error || `迁移执行失败（成功 ${data.succeeded || 0} / ${data.total || 0}）`);
      } else {
        const modeLabel = options.dryRun ? 'DryRun' : options.rollback ? '回滚' : '迁移';
        setMigrationMessage(
          `${modeLabel}完成：成功 ${data.succeeded || 0}，失败 ${data.failed || 0}，总计 ${data.total || 0}`,
        );
      }
    } catch {
      setMigrationMessage('迁移执行失败');
    } finally {
      setMigrationRunning(false);
      await loadMigrationItems(migrationOnlyFailed);
    }
  };

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
            conversation?: { id: string; title: string; storage_backend?: 'cloud' | 'local' };
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
                storage_backend: createdData.conversation?.storage_backend,
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
    void loadMigrationItems(false);
  }, [setMessages, loadMigrationItems]);

  useEffect(() => {
    const loadMessages = async () => {
      if (!activeConversationId) return;
      setIsLoadingMessages(true);
      try {
        const response = await fetch(`/api/conversations/${activeConversationId}/messages`, {
          cache: 'no-store',
        });
        const raw = await response.text();
        const data = (() => {
          if (!raw.trim()) return { messages: [] } as { messages?: typeof messages };
          try {
            return JSON.parse(raw) as { messages?: typeof messages };
          } catch {
            return { messages: [] } as { messages?: typeof messages };
          }
        })();

        if (!response.ok) {
          setMessages([]);
          setConversationsError('读取会话消息失败，请稍后重试。');
          return;
        }

        setMessages((data.messages || []) as typeof messages);
      } catch {
        setMessages([]);
        setConversationsError('读取会话消息失败，请稍后重试。');
      } finally {
        setIsLoadingMessages(false);
      }
    };

    void loadMessages();
  }, [activeConversationId, setMessages]);

  const handleCreateConversation = async () => {
    if (isBusy) return;
    // 避免在“已是空白新会话”时重复创建会话壳。
    if (activeConversationId && messages.length === 0 && !isLoadingMessages) {
      return;
    }

    const response = await fetch('/api/conversations', { method: 'POST' });
    const data = (await response.json()) as {
      conversation?: { id: string; title: string; storage_backend?: 'cloud' | 'local' };
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
        storage_backend: data.conversation?.storage_backend,
      },
      ...items,
    ]);
    setActiveConversationId(data.conversation.id);
    setMessages([]);
    setInput('');
    setConversationsError('');
    lastActivityAtRef.current = Date.now();
  };

  const createBlankConversation = async (): Promise<string | undefined> => {
    const created = await fetch('/api/conversations', { method: 'POST' });
    const createdData = (await created.json()) as {
      conversation?: { id: string; title: string; storage_backend?: 'cloud' | 'local' };
      error?: string;
    };
    if (!created.ok || !createdData.conversation?.id) return undefined;

    const now = new Date().toISOString();
    const conversation = {
      id: createdData.conversation.id,
      title: createdData.conversation.title || '新对话',
      created_at: now,
      updated_at: now,
      storage_backend: createdData.conversation.storage_backend,
    };
    setConversations((items) => [conversation, ...items]);
    return conversation.id;
  };

  const handleRenameConversation = async (conversationId: string) => {
    const target = conversations.find((item) => item.id === conversationId);
    if (!target) return;
    const renamed = window.prompt('请输入新的对话标题', target.title || '新对话');
    if (!renamed || !renamed.trim()) return;

    const response = await fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renamed.trim() }),
    });
    if (!response.ok) return;

    setConversations((items) =>
      items.map((item) => (item.id === conversationId ? { ...item, title: renamed.trim() } : item)),
    );
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const target = conversations.find((item) => item.id === conversationId);
    if (!target) return;

    const response = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' });
    if (!response.ok) return;

    const remaining = conversations.filter((item) => item.id !== conversationId);
    setConversations(remaining);

    if (activeConversationId === conversationId) {
      if (remaining.length > 0) {
        setActiveConversationId(remaining[0].id);
      } else {
        const newId = await createBlankConversation();
        setActiveConversationId(newId || '');
        setMessages([]);
      }
    }
  };

  const handleMigrateConversation = async (
    conversationId: string,
    targetBackend: 'cloud' | 'local',
  ) => {
    setConversationsError('');
    try {
      const response = await fetch('/api/storage/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          conversationId,
          targetBackend,
        }),
      });
      const data = (await response.json()) as { error?: string; ok?: boolean };
      if (!response.ok || data.ok === false) {
        setConversationsError(data.error || '迁移失败，请稍后重试。');
        return;
      }

      setConversations((items) =>
        items.map((item) =>
          item.id === conversationId ? { ...item, storage_backend: targetBackend } : item,
        ),
      );
      setMigrationMessage(`会话已迁移到${targetBackend === 'cloud' ? '云端' : '本地'}`);
      await loadMigrationItems(migrationOnlyFailed);
    } catch {
      setConversationsError('迁移失败，请稍后重试。');
    }
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
  const canRetry = !isBusy && renderedMessages.length > 0;
  const contextConversation = contextMenu
    ? conversations.find((item) => item.id === contextMenu.conversationId)
    : undefined;
  const migrationTarget = contextConversation?.storage_backend === 'local' ? 'cloud' : 'local';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;

    const value = input.trim();
    if (!value) return;
    if (!activeConversationId) return;

    if (error) clearError();
    lastActivityAtRef.current = Date.now();
    await sendMessage(
      { text: value },
      { body: { model: selectedModel, conversationId: activeConversationId } },
    );
    setInput('');
  };

  const handleRetry = async () => {
    if (!activeConversationId || isBusy || renderedMessages.length === 0) return;
    if (error) clearError();
    lastActivityAtRef.current = Date.now();
    await regenerate({ body: { model: selectedModel, conversationId: activeConversationId } });
  };

  useEffect(() => {
    const bumpActivity = () => {
      lastActivityAtRef.current = Date.now();
    };
    window.addEventListener('pointerdown', bumpActivity);
    window.addEventListener('keydown', bumpActivity);

    return () => {
      window.removeEventListener('pointerdown', bumpActivity);
      window.removeEventListener('keydown', bumpActivity);
    };
  }, []);

  useEffect(() => {
    if (!keepWarmEnabled || !selectedModel) return;

    const warmup = async () => {
      const now = Date.now();
      if (now - lastActivityAtRef.current > WARMUP_IDLE_STOP_MS) return;
      if (isBusy) return;

      try {
        await fetch('/api/warmup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: selectedModel }),
        });
      } catch {
        // best-effort keep-warm; ignore transient errors
      }
    };

    // Warm once after model switch / resume, then keep alive on interval.
    void warmup();
    const timer = window.setInterval(() => {
      void warmup();
    }, WARMUP_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [keepWarmEnabled, selectedModel, isBusy]);

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
      <aside className="hidden h-full w-72 flex-col border-r border-slate-200 bg-[#f7f8fa] p-4 md:flex">
        <button
          type="button"
          className="mb-4 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-400"
          onClick={() => void handleCreateConversation()}
          disabled={isBusy}
        >
          + 发起新对话
        </button>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">历史对话</p>
        <div
          className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1"
          onWheel={(event) => event.stopPropagation()}
        >
          {isLoadingConversations && <p className="px-2 py-1 text-xs text-slate-400">加载中...</p>}
          {!isLoadingConversations &&
            conversations.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveConversationId(item.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    conversationId: item.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  item.id === activeConversationId
                    ? 'bg-white font-medium text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:bg-white'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    title={`当前存储：${getBackendLabel(item.storage_backend)}`}
                    className="inline-flex h-4 w-4 items-center justify-center text-slate-500"
                  >
                    {item.storage_backend === 'local' ? (
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                        <g
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="3.5" y="5" width="17" height="11.5" rx="2" />
                          <path d="M8 19h8" />
                          <path d="M10 16.5v2.5" />
                          <path d="M14 16.5v2.5" />
                        </g>
                      </svg>
                    ) : item.storage_backend === 'cloud' ? (
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                        <g
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M7.5 18.5h9a4 4 0 0 0 .2-8 5.5 5.5 0 0 0-10.5 1.8 3.4 3.4 0 0 0 1.3 6.2z" />
                        </g>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                        <g
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 16v.01" />
                          <path d="M12 12a2 2 0 1 0-2-2" />
                        </g>
                      </svg>
                    )}
                  </span>
                  <p className="truncate">{item.title || '新对话'}</p>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  {new Date(item.updated_at).toLocaleString()}
                </p>
              </button>
            ))}
          {!isLoadingConversations && conversations.length === 0 && (
            <p className="px-2 py-1 text-xs text-slate-400">暂无历史对话</p>
          )}
          {conversationsError && <p className="px-2 py-2 text-xs text-amber-600">{conversationsError}</p>}

          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-slate-600">迁移任务</p>
              <button
                type="button"
                className="text-[11px] text-slate-500 hover:text-slate-700"
                onClick={() => void loadMigrationItems(migrationOnlyFailed)}
                disabled={migrationLoading || migrationRunning}
              >
                刷新
              </button>
            </div>
            <label className="mb-2 inline-flex items-center gap-1 text-[11px] text-slate-500">
              <input
                type="checkbox"
                checked={migrationOnlyFailed}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setMigrationOnlyFailed(checked);
                  void loadMigrationItems(checked);
                }}
                className="h-3 w-3 rounded border-slate-300"
                disabled={migrationLoading || migrationRunning}
              />
              仅失败项
            </label>
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                type="button"
                className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
                onClick={() => void runBatchMigration({ dryRun: true, onlyFailed: migrationOnlyFailed })}
                disabled={migrationRunning}
              >
                DryRun
              </button>
              <button
                type="button"
                className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
                onClick={() => void runBatchMigration({ onlyFailed: migrationOnlyFailed })}
                disabled={migrationRunning}
              >
                批量迁移
              </button>
              <button
                type="button"
                className="rounded-md border border-amber-300 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-50 disabled:text-slate-400"
                onClick={() => void runBatchMigration({ rollback: true, onlyFailed: migrationOnlyFailed })}
                disabled={migrationRunning}
              >
                批量回滚
              </button>
            </div>
            {migrationMessage && <p className="mb-2 text-[11px] text-slate-600">{migrationMessage}</p>}
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {migrationLoading && <p className="text-[11px] text-slate-400">任务加载中...</p>}
              {!migrationLoading && migrationItems.length === 0 && (
                <p className="text-[11px] text-slate-400">暂无迁移任务</p>
              )}
              {!migrationLoading &&
                migrationItems.map((item) => (
                  <div key={item.conversation_id} className="rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                    <p className="truncate text-slate-700">{item.conversation_id}</p>
                    <p className="text-slate-500">
                      {item.storage_backend} / {item.migration_status}
                    </p>
                    <p className="text-slate-400">{new Date(item.updated_at).toLocaleString()}</p>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </aside>

      <main className="h-full w-full overflow-y-auto px-4 pb-40 pt-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col">
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
          {renderedMessages.length === 0 && (
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-800">今天想让我帮你做什么？</h1>
          )}
        </header>

        <section className="space-y-4" onWheel={(event) => event.stopPropagation()}>
          {renderedMessages.length === 0 && isLoadingMessages && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
              正在加载会话...
            </div>
          )}

          {renderedMessages.map((message) => {
            const isUser = message.role === 'user';
            return (
              <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                {isUser ? (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-slate-200 px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm">
                    {message.text}
                  </div>
                ) : (
                  <div className="w-full px-2 py-1 text-sm leading-7 text-slate-800">
                    <div className="mb-2 flex items-center gap-2 text-slate-500">
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
        </div>
      </main>

      <form
        onSubmit={handleSubmit}
        className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 backdrop-blur md:left-72"
      >
        <div className="mx-auto w-full max-w-4xl px-4 py-4">
          <div className="rounded-3xl border border-slate-300 bg-white px-4 py-3 shadow-sm">
            <textarea
              className="max-h-40 min-h-12 w-full resize-y bg-transparent text-sm text-slate-900 outline-none transition disabled:bg-slate-100"
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
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <div className="flex items-center gap-3">
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
                <label className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={keepWarmEnabled}
                    onChange={(event) => setKeepWarmEnabled(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  常热
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:text-slate-400"
                  onClick={() => stop()}
                  disabled={!isBusy}
                >
                  停止
                </button>
                <button
                  type="button"
                  className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:text-slate-400"
                  onClick={() => void handleRetry()}
                  disabled={!canRetry || !activeConversationId}
                >
                  重试
                </button>
                <button
                  type="submit"
                  className="h-10 rounded-xl bg-slate-900 px-4 text-xs font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-400"
                  disabled={isBusy || !input.trim() || !activeConversationId}
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="mx-auto w-full max-w-4xl px-4 pb-4 text-xs">
          {isBusy && <p className="text-slate-500">AI 正在回复...</p>}
          {modelsError && <p className="text-amber-600">{modelsError}</p>}
          {error && <p className="text-red-500">连接失败，请确认 Ollama 服务已启动。</p>}
        </div>
      </form>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            onClick={() => {
              setActiveConversationId(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            打开对话
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            onClick={() => {
              const target = conversations.find((item) => item.id === contextMenu.conversationId);
              if (target?.title) {
                void navigator.clipboard?.writeText(target.title);
              }
              setContextMenu(null);
            }}
          >
            复制标题
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            onClick={() => {
              void navigator.clipboard?.writeText(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            复制会话ID
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            onClick={() => {
              void handleRenameConversation(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            重命名
          </button>
          {contextConversation?.storage_backend && (
            <button
              type="button"
              className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
              onClick={() => {
                void handleMigrateConversation(contextMenu.conversationId, migrationTarget);
                setContextMenu(null);
              }}
            >
              迁移到{migrationTarget === 'cloud' ? '云端' : '本地'}
            </button>
          )}
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              void handleDeleteConversation(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            删除该对话
          </button>
        </div>
      )}
    </div>
  );
}
