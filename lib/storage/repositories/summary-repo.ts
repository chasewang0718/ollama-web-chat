export interface SummaryRepository {
  shouldRefresh(userTurns: number, interval: number): boolean;
  generate(
    conversationText: string,
    previousSummary?: string,
    activeModel?: string,
  ): Promise<string | undefined>;
}
