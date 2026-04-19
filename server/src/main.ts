function InitModule(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
): void {
    initializer.registerRpc("create_room", rpcCreateRoom);
    initializer.registerRpc("join_room", rpcJoinRoom);
    initializer.registerRpc("set_avatar", rpcSetAvatar);
    initializer.registerRpc("get_leaderboard", rpcGetLeaderboard);
    initializer.registerRpc("get_match_history", rpcGetMatchHistory);

    initializer.registerMatch(MATCH_MODULE, {
        matchInit: matchInit,
        matchJoinAttempt: matchJoinAttempt,
        matchJoin: matchJoin,
        matchLeave: matchLeave,
        matchLoop: matchLoop,
        matchTerminate: matchTerminate,
        matchSignal: matchSignal,
    });

    initializer.registerMatchmakerMatched(onMatchmakerMatched);

    setupLeaderboard(nk, logger);

    logger.info("TicTacToe server module loaded");
}
