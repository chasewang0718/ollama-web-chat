import { createClient } from "@/utils/supabase/server";
import Link from "next/link";
import { cookies } from "next/headers";

export default async function SupabaseDemoPage() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: todos } = await supabase.from("todos").select();

  return (
    <div className="mx-auto max-w-lg p-8">
      <p className="mb-4 text-sm text-slate-500">
        Supabase 连接示例（需在 Dashboard 中创建 <code className="rounded bg-slate-100 px-1">todos</code>{" "}
        表）。聊天首页仍在{" "}
        <Link href="/" className="text-blue-600 underline">
          /
        </Link>
        。
      </p>
      <ul className="list-disc pl-5">
        {todos?.map((todo: { id: number; name?: string }) => (
          <li key={todo.id}>{todo.name ?? "(no name)"}</li>
        ))}
      </ul>
      {!todos?.length && (
        <p className="text-sm text-slate-400">暂无数据或表尚未创建。</p>
      )}
    </div>
  );
}
