function onMatchmakerMatched(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    matches: nkruntime.MatchmakerResult[]
): string | void {
    if (matches.length < 2) return;

    const gameMode = matches[0].properties?.["game_mode"] as string || "CLASSIC";

    const matchId = nk.matchCreate(MATCH_MODULE, {game_mode: gameMode});
    logger.info("Matchmaker created match %s for %d players", matchId, matches.length);
    return matchId;
}
