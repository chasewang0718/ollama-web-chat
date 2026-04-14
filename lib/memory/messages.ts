import type { UIMessage } from "ai";

/** 取最近一条用户文本，用于检索记忆与落库摘要 */
export function getLastUserText(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
