import type { AppDatabase } from "./db.js";

export type LeaderboardRow = Readonly<{
  rank: number;
  player_id: string;
  nickname: string;
  points: number;
  connected: boolean;
}>;

export type Leaderboard = Readonly<{
  scope: "session";
  rows: readonly LeaderboardRow[];
}>;

export function buildLeaderboard(
  database: AppDatabase,
  sessionId: string,
  connectedPlayerIds: ReadonlySet<string>,
): Leaderboard {
  const players = database
    .prepare(
      `SELECT player_id, nickname, points FROM session_players
       WHERE session_id = ?
       ORDER BY points DESC, joined_at_ms, player_id`,
    )
    .all(sessionId) as Array<{ player_id: string; nickname: string; points: number }>;

  return Object.freeze({
    scope: "session",
    // Equal scores remain deterministic, and the join-order tiebreak assigns unique positions.
    rows: Object.freeze(
      players.map((player, index) =>
        Object.freeze({
          rank: index + 1,
          player_id: player.player_id,
          nickname: player.nickname,
          points: player.points,
          connected: connectedPlayerIds.has(player.player_id),
        }),
      ),
    ),
  });
}
