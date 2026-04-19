/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

// Leaderboard and match history configuration
const LEADERBOARD_ID = "tictactoe_global";
const MATCH_HISTORY_COLLECTION = "match_history";
const MATCH_HISTORY_KEY = "summary";
const MAX_RECENT_RESULTS = 20;

type MatchHistoryResult = "win" | "loss" | "draw";

interface StoredRecentMatch {
    result: MatchHistoryResult;
    reason: string;
    ts: number;
    opponent_id: string;
    opponent_nickname: string;
    match_id: string;
    player_score: number;
    opponent_score: number;
    match_type: "ranked" | "room";
}

interface StoredMatchHistory {
    total_wins: number;
    total_losses: number;
    total_draws: number;
    best_streak: number;
    current_streak: number;
    recent_results: StoredRecentMatch[];
}

function emptyMatchHistory(): StoredMatchHistory {
    return {
        total_wins: 0,
        total_losses: 0,
        total_draws: 0,
        best_streak: 0,
        current_streak: 0,
        recent_results: [],
    };
}

function normalizeMatchHistory(raw: any): StoredMatchHistory {
    const base = emptyMatchHistory();
    if (!raw || typeof raw !== "object") {
        return base;
    }

    const recent = Array.isArray(raw.recent_results) ? raw.recent_results : [];
    return {
        total_wins: Number(raw.total_wins || 0),
        total_losses: Number(raw.total_losses || 0),
        total_draws: Number(raw.total_draws || 0),
        best_streak: Number(raw.best_streak || 0),
        current_streak: Number(raw.current_streak || 0),
        recent_results: recent.map((r: any) => ({
            result: (r?.result || "draw") as MatchHistoryResult,
            reason: String(r?.reason || ""),
            ts: Number(r?.ts || 0),
            opponent_id: String(r?.opponent_id || ""),
            opponent_nickname: String(r?.opponent_nickname || "ANON"),
            match_id: String(r?.match_id || ""),
            player_score: Number(r?.player_score || 0),
            opponent_score: Number(r?.opponent_score || 0),
            match_type: (r?.match_type === "room" ? "room" : "ranked") as "ranked" | "room",
        })),
    };
}

function readMatchHistory(
    nk: nkruntime.Nakama,
    userId: string,
): StoredMatchHistory {
    const objects = nk.storageRead([
        {
            collection: MATCH_HISTORY_COLLECTION,
            key: MATCH_HISTORY_KEY,
            userId: userId,
        } as any,
    ]) as any[];

    if (!objects || objects.length === 0) {
        return emptyMatchHistory();
    }

    const raw = objects[0]?.value;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeMatchHistory(parsed);
}

function writeMatchHistory(
    nk: nkruntime.Nakama,
    userId: string,
    history: StoredMatchHistory,
) {
    nk.storageWrite([
        {
            collection: MATCH_HISTORY_COLLECTION,
            key: MATCH_HISTORY_KEY,
            userId: userId,
            value: history,
            permissionRead: 1,
            permissionWrite: 0,
        } as any,
    ]);
}

function updateMatchHistoryWithResult(
    history: StoredMatchHistory,
    result: MatchHistoryResult,
    reason: string,
    opponentId: string,
    opponentNickname: string,
    matchId: string,
    playerScore: number,
    opponentScore: number,
    matchType: "ranked" | "room",
): StoredMatchHistory {
    if (result === "win") {
        history.total_wins += 1;
        history.current_streak += 1;
        if (history.current_streak > history.best_streak) {
            history.best_streak = history.current_streak;
        }
    } else if (result === "loss") {
        history.total_losses += 1;
        history.current_streak = 0;
    } else {
        history.total_draws += 1;
        history.current_streak = 0;
    }

    history.recent_results.unshift({
        result: result,
        reason: reason,
        ts: Math.floor(Date.now() / 1000),
        opponent_id: opponentId,
        opponent_nickname: opponentNickname || "ANON",
        match_id: matchId,
        player_score: playerScore,
        opponent_score: opponentScore,
        match_type: matchType,
    });
    history.recent_results = history.recent_results.slice(0, MAX_RECENT_RESULTS);
    return history;
}

function setupLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger) {
    try {
        nk.leaderboardCreate(
            LEADERBOARD_ID,
            true,
            nkruntime.SortOrder.DESCENDING,
            nkruntime.Operator.SET,
            "0 0 * * 1",
            undefined
        );
        logger.info("Leaderboard created: %s", LEADERBOARD_ID);
    } catch (e) {
        logger.info("Leaderboard already exists: %s", LEADERBOARD_ID);
    }
}

function updateLeaderboard(
    nk: nkruntime.Nakama,
    userId: string,
    matchScore: number,
    logger: nkruntime.Logger
) {
    try {
        const delta = Math.max(0, Number(matchScore || 0));
        const account = nk.accountGetId(userId);
        const nickname = account.user?.displayName || "ANON";
        // Cumulative ranked score.
        nk.leaderboardRecordWrite(
            LEADERBOARD_ID,
            userId,
            nickname,
            delta,
            0,
            undefined,
            nkruntime.OverrideOperator.INCREMENTAL,
        );
    } catch (e) {
        logger.error("Failed to write leaderboard record: %s", e);
    }
}

function recordMatchResult(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    userId: string,
    opponentId: string,
    opponentNickname: string,
    result: MatchHistoryResult,
    reason: string,
    matchId: string,
    playerScore: number,
    opponentScore: number,
    matchType: "ranked" | "room",
) {
    try {
        const history = readMatchHistory(nk, userId);
        const updated = updateMatchHistoryWithResult(
            history,
            result,
            reason,
            opponentId,
            opponentNickname,
            matchId,
            playerScore,
            opponentScore,
            matchType,
        );
        writeMatchHistory(nk, userId, updated);
    } catch (e) {
        logger.error("Failed to record match history for user %s: %s", userId, e);
    }
}

function rpcGetLeaderboard(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const req = payload ? JSON.parse(payload) : {};
    const limit = req.limit || 20;

    const result = nk.leaderboardRecordsList(LEADERBOARD_ID, undefined, limit, undefined, 0);
    const records = (result.records || []).slice();

    records.sort((a: nkruntime.LeaderboardRecord, b: nkruntime.LeaderboardRecord) => {
        const ar = Number(a.rank || 0);
        const br = Number(b.rank || 0);
        if (ar > 0 && br > 0) {
            return ar - br;
        }
        return Number(b.score || 0) - Number(a.score || 0);
    });

    const entries = records.map((r: nkruntime.LeaderboardRecord, i: number) => {
        let avatarId = 0;
        try {
            if (r.ownerId) {
                const account = nk.accountGetId(r.ownerId);
                avatarId = normalizeAvatarId(account.user?.metadata);
            }
        } catch (e) {
            logger.debug("Leaderboard metadata lookup failed for user=%s", r.ownerId);
        }

        return {
            rank: Number(r.rank || i + 1),
            user_id: r.ownerId,
            // Native username fallback.
            nickname: r.username || "ANON",
            score: Number(r.score || 0),
            avatar_id: avatarId,
        };
    });

    return JSON.stringify({entries});
}

function rpcGetMatchHistory(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
): string {
    const userId = ctx.userId;
    if (!userId) {
        return JSON.stringify({
            total_wins: 0,
            total_losses: 0,
            total_draws: 0,
            best_streak: 0,
            recent_results: [],
        });
    }

    const req = payload ? JSON.parse(payload) : {};
    const limit = Math.min(Math.max(Number(req.limit) || 3, 1), MAX_RECENT_RESULTS);

    try {
        const history = readMatchHistory(nk, userId);
        return JSON.stringify({
            total_wins: history.total_wins,
            total_losses: history.total_losses,
            total_draws: history.total_draws,
            best_streak: history.best_streak,
            recent_results: history.recent_results.slice(0, limit),
        });
    } catch (e) {
        logger.error("Failed to fetch match history for user=%s: %s", userId, e);
        return JSON.stringify({
            total_wins: 0,
            total_losses: 0,
            total_draws: 0,
            best_streak: 0,
            recent_results: [],
        });
    }
}
