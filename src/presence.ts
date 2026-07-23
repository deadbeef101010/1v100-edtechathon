export type PresenceRegistry = { lookup: ((playerId: string) => number) | undefined };

export function createPresenceRegistry(): PresenceRegistry {
  return { lookup: undefined };
}
