import { useQueries } from "@tanstack/react-query";
import {
  useListBots,
  getBotLegs,
  getGetBotLegsQueryKey,
  getListBotsQueryKey,
} from "@workspace/api-client-react";
import type { BotConfig, BotLeg } from "@workspace/api-client-react";

export interface BotStatusInfo {
  bot: BotConfig;
  openLegs: BotLeg[];
  openLegsCount: number;
}

export function useBots() {
  const botsQuery = useListBots({
    query: { refetchInterval: 2000, queryKey: getListBotsQueryKey() },
  });

  const bots: BotConfig[] = botsQuery.data?.bots ?? [];

  const legsQueries = useQueries({
    queries: bots.map((bot) => ({
      queryKey: getGetBotLegsQueryKey(bot.id),
      queryFn: () => getBotLegs(bot.id),
      refetchInterval: 2000,
    })),
  });

  const botStatusMap = new Map<string, BotStatusInfo>();
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const openLegs = legsQueries[i]?.data?.legs?.filter((l) => l.status === "open") ?? [];
    botStatusMap.set(bot.symbol, { bot, openLegs, openLegsCount: openLegs.length });
  }

  const allOpenLegs: BotLeg[] = [];
  for (const { openLegs } of botStatusMap.values()) {
    allOpenLegs.push(...openLegs);
  }

  function getBotStatusForSymbol(symbol: string): BotStatusInfo | undefined {
    return botStatusMap.get(symbol);
  }

  return {
    bots,
    getBotStatusForSymbol,
    allOpenLegs,
    isLoading: botsQuery.isLoading,
  };
}
