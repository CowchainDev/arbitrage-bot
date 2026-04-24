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

const BOTS_REFETCH_MS = 2000;
const LEGS_REFETCH_MS = 5000;

export function useBots() {
  const botsQuery = useListBots({
    query: {
      refetchInterval: BOTS_REFETCH_MS,
      staleTime: BOTS_REFETCH_MS / 2,
      queryKey: getListBotsQueryKey(),
    },
  });

  const bots: BotConfig[] = botsQuery.data?.bots ?? [];

  const legsQueries = useQueries({
    queries: bots.map((bot) => ({
      queryKey: getGetBotLegsQueryKey(bot.id),
      queryFn: () => getBotLegs(bot.id),
      refetchInterval: LEGS_REFETCH_MS,
      staleTime: LEGS_REFETCH_MS / 2,
      enabled: bot.enabled,
    })),
  });

  const botStatusMap = new Map<string, BotStatusInfo>();
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const openLegs = legsQueries[i]?.data?.legs?.filter((l) => l.status === "open") ?? [];
    botStatusMap.set(bot.symbol, { bot, openLegs, openLegsCount: openLegs.length });
  }

  const allOpenLegs: BotLeg[] = [];
  const allOpenLegsWithBot: Array<{ leg: BotLeg; bot: BotConfig }> = [];
  for (const { bot, openLegs } of botStatusMap.values()) {
    allOpenLegs.push(...openLegs);
    for (const leg of openLegs) {
      allOpenLegsWithBot.push({ leg, bot });
    }
  }

  function getBotStatusForSymbol(symbol: string): BotStatusInfo | undefined {
    return botStatusMap.get(symbol);
  }

  return {
    bots,
    getBotStatusForSymbol,
    allOpenLegs,
    allOpenLegsWithBot,
    isLoading: botsQuery.isLoading,
  };
}
