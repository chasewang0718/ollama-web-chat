import type { UIMessage } from "ai";

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/** Return latest user text for retrieval/persist */
export function getLastUserText(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const trimmed = messageText(message);
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Count user turns in this chat session */
export function countUserTurns(messages: UIMessage[]): number {
  return messages.filter((m) => m.role === "user" && messageText(m)).length;
}

/** Format recent turns as plain text for L2 summarization */
export function formatRecentConversation(messages: UIMessage[], limit = 12): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const text = messageText(m);
      if (!text) return undefined;
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${text}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
