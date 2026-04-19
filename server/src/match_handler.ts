const MATCH_MODULE = "tictactoe";

// Operation codes for real-time messages
const OP_CODE = {
    MOVE: 1,
    STATE: 2,
    GAME_OVER: 3,
    FORFEIT: 4,
    ROOM_STATE: 7,
    START_MATCH_REQUEST: 8,
    ROOM_MODE_UPDATE: 9,
    RETURN_TO_ROOM_LOBBY: 10,
} as const;

// Winning lines in tic-tac-toe (3x3 board)
const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
    [0, 4, 8], [2, 4, 6], // Diagonals
] as const;

// Scoring rules for ranked matches
const SCORE_CONFIG = {
    MOVE_BASE: 100,
    MOVE_QUICK: 150,
    MOVE_FAST: 200,
    WIN_BONUS: 100,
    FORFEIT_PENALTY: 200,
} as const;

// Match configuration constants
const MATCH_CONFIG = {
    HOST_RETURN_TIMEOUT_SEC: 60,
    AVATAR_VARIANTS: 6,
    BOARD_SIZE: 9,
    COUNTDOWN_SEC: 3,
} as const;

interface MatchState {
    board: (number | null)[];
    players: Record<string, PlayerInfo>;
    hostUserId: string;
    playerX: string;
    playerO: string;
    currentTurn: string;
    status: "waiting" | "countdown" | "playing" | "done" | "waiting_host" | "closed";
    gameMode: "CLASSIC" | "TIMED";
    turnTimerSec: number;
    turnStartTick: number;
    tickRate: number;
    roomCode: string | null;
    scores: Record<string, number>;
    countdownEndTick: number | null;
    lastCountdownValue: number | null;
    hostReturnDeadlineTick: number | null;
    hostReturnLastSeconds: number | null;
    requestedLobbyReturn: Record<string, true>;
}

interface PlayerInfo {
    userId: string;
    nickname: string;
    mark: "X" | "O";
    avatar_id: number;
}

function matchInit(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    params: Record<string, string>
): { state: nkruntime.MatchState; tickRate: number; label: string } {
    const gameMode = params.game_mode === "TIMED" ? "TIMED" : "CLASSIC";
    const roomCode = params.room_code ?? null;
    const tickRate = 5;

    const state: MatchState = {
        board: Array(MATCH_CONFIG.BOARD_SIZE).fill(null),
        players: {},
        hostUserId: "",
        playerX: "",
        playerO: "",
        currentTurn: "",
        status: "waiting",
        gameMode,
        turnTimerSec: gameMode === "TIMED" ? 10 : 30,
        turnStartTick: 0,
        tickRate,
        roomCode,
        scores: {},
        countdownEndTick: null,
        lastCountdownValue: null,
        hostReturnDeadlineTick: null,
        hostReturnLastSeconds: null,
        requestedLobbyReturn: {},
    };

    const label = buildMatchLabel(state.gameMode, roomCode, true);
    return {state, tickRate, label};
}

function matchJoinAttempt(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presence: nkruntime.Presence,
    _metadata: Record<string, unknown>
): { state: nkruntime.MatchState; accept: boolean; rejectMessage?: string } {
    const s = state as MatchState;

    if (s.status === "closed") {
        return {state: s, accept: false, rejectMessage: "room_closed"};
    }

    const isKnownPlayer = s.players[presence.userId] !== undefined;
    const playerCount = Object.keys(s.players).length;

    if (!isKnownPlayer && playerCount >= 2) {
        return {state: s, accept: false, rejectMessage: "match_full"};
    }

    // Check if private room host deadline has expired
    if (s.roomCode !== null && s.status === "waiting_host" && currentHostReturnSeconds(s, tick) === null) {
        return {state: s, accept: false, rejectMessage: "room_closed"};
    }

    // Only allow host to rejoin when waiting for host's return
    if (s.roomCode !== null && s.status === "waiting_host" && !isKnownPlayer && presence.userId !== s.hostUserId) {
        return {state: s, accept: false, rejectMessage: "waiting_for_host"};
    }

    return {state: s, accept: true};
}

function matchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const s = state as MatchState;

    for (const p of presences) {
        const account = nk.accountGetId(p.userId);
        const nickname = account.user?.displayName || "ANON";
        const avatarId = normalizeAvatarId(account.user?.metadata);

        // Assign host on first join for private rooms
        if (s.roomCode !== null && !s.hostUserId) {
            s.hostUserId = p.userId;
        }

        s.players[p.userId] = {
            userId: p.userId,
            nickname,
            mark: s.players[p.userId]?.mark || "O",
            avatar_id: avatarId,
        };

        // Initialize player score for current game
        if (typeof s.scores[p.userId] !== "number") {
            s.scores[p.userId] = 0;
        }
    }

    reconcilePlayerSlots(s);
    logSlotState(logger, s, "matchJoin");

    if (shouldAutoStartRankedMatch(s)) {
        logger.info(
            "Auto-starting ranked match: playerX=%s playerO=%s matchId=%s",
            s.playerX,
            s.playerO,
            ctx.matchId || "",
        );
        startRound(s, tick, dispatcher, logger);
    }

    broadcastRoomState(s, dispatcher, tick);

    return {state: s};
}

function matchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const s = state as MatchState;
    let shouldClosePrivateRoom = false;

    for (const p of presences) {
        const wasHost = p.userId === s.hostUserId;
        const wasPlaying = s.status === "playing";

        if (wasPlaying) {
            addScore(s, p.userId, -SCORE_CONFIG.FORFEIT_PENALTY);
            const winner = p.userId === s.playerX ? s.playerO : s.playerX;
            endGame(s, nk, dispatcher, winner, "forfeit", logger, ctx.matchId || "");
        }

        delete s.players[p.userId];
        delete s.requestedLobbyReturn[p.userId];
        if (s.playerX === p.userId) s.playerX = "";
        if (s.playerO === p.userId) s.playerO = "";

        // Close room when host leaves (private room mode)
        if (s.roomCode !== null && wasHost && !wasPlaying && s.status !== "waiting_host") {
            shouldClosePrivateRoom = true;
        }
    }

    if (shouldClosePrivateRoom) {
        closeRoomState(s);
        broadcastRoomState(s, dispatcher, tick);
        return null;
    }

    if (Object.keys(s.players).length === 0) return null;

    // Revert countdown if someone leaves during countdown
    if (s.status === "countdown") {
        s.status = "waiting";
        s.countdownEndTick = null;
        s.lastCountdownValue = null;
    }

    reconcilePlayerSlots(s);
    logSlotState(logger, s, "matchLeave");
    broadcastRoomState(s, dispatcher, tick);
    return {state: s};
}

function matchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    messages: nkruntime.MatchMessage[]
): { state: nkruntime.MatchState } | null {
    const s = state as MatchState;

    // Process control messages
    for (const msg of messages) {
        if (msg.opCode === OP_CODE.ROOM_MODE_UPDATE) {
            tryUpdateRoomMode(s, msg.sender.userId, msg.data, nk, dispatcher, tick, logger);
        } else if (msg.opCode === OP_CODE.RETURN_TO_ROOM_LOBBY) {
            tryReturnToRoomLobby(s, msg.sender.userId, dispatcher, tick, logger);
        } else if (msg.opCode === OP_CODE.START_MATCH_REQUEST) {
            tryStartCountdown(s, msg.sender.userId, tick, dispatcher, logger);
        }
    }

    // Handle host return deadline expiration
    if (s.status === "waiting_host") {
        const hostReturnSeconds = currentHostReturnSeconds(s, tick);
        if (hostReturnSeconds !== s.hostReturnLastSeconds) {
            s.hostReturnLastSeconds = hostReturnSeconds;
            broadcastRoomState(s, dispatcher, tick);
        }

        if (hostReturnSeconds === null) {
            closeRoomState(s);
            broadcastRoomState(s, dispatcher, tick);
            return null;
        }

        return {state: s};
    }

    // Handle countdown timer
    if (s.status === "countdown") {
        const countdownValue = currentCountdownValue(s, tick);
        if (countdownValue !== s.lastCountdownValue) {
            s.lastCountdownValue = countdownValue;
            broadcastRoomState(s, dispatcher, tick);
        }

        if (countdownValue === null) {
            startRound(s, tick, dispatcher, logger);
        }
        return {state: s};
    }

    // Only process game moves during active gameplay
    if (s.status !== "playing") return {state: s};

    // Check for turn timeout
    const elapsed = (tick - s.turnStartTick) / s.tickRate;
    if (elapsed >= s.turnTimerSec) {
        const winner = s.currentTurn === s.playerX ? s.playerO : s.playerX;
        endGame(s, nk, dispatcher, winner, "timeout", logger, ctx.matchId || "");
        return {state: s};
    }

    // Process player moves
    for (const msg of messages) {
        if (msg.opCode !== OP_CODE.MOVE || msg.sender.userId !== s.currentTurn) continue;

        const data = JSON.parse(nk.binaryToString(msg.data)) as { position?: number };
        const pos = data.position;

        if (typeof pos !== "number" || pos < 0 || pos > 8 || s.board[pos] !== null) continue;

        const elapsedTurnSeconds = (tick - s.turnStartTick) / s.tickRate;
        addScore(s, msg.sender.userId, scoreForMove(elapsedTurnSeconds));

        s.board[pos] = s.currentTurn === s.playerX ? 0 : 1;

        // Check win condition
        const winner = checkWin(s.board);
        if (winner !== null) {
            const winnerId = winner === 0 ? s.playerX : s.playerO;
            endGame(s, nk, dispatcher, winnerId, "win", logger, ctx.matchId || "");
            return {state: s};
        }

        // Check draw condition
        if (s.board.every((c) => c !== null)) {
            endGame(s, nk, dispatcher, null, "draw", logger, ctx.matchId || "");
            return {state: s};
        }

        s.currentTurn = s.currentTurn === s.playerX ? s.playerO : s.playerX;
        s.turnStartTick = tick;
        broadcastState(s, dispatcher, logger);
    }

    return {state: s};
}

function matchTerminate(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: nkruntime.MatchState,
    _graceSeconds: number
): { state: nkruntime.MatchState } | null {
    // No specific cleanup needed for this match type
    return {state};
}

function matchSignal(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: nkruntime.MatchState,
    _data: string
): { state: nkruntime.MatchState; data?: string } | null {
    // Signal handler: returns acknowledgement
    return {state, data: "ok"};
}

function startRound(
    s: MatchState,
    tick: number,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
): void {
    s.board = Array(MATCH_CONFIG.BOARD_SIZE).fill(null);
    s.currentTurn = s.playerX;
    s.status = "playing";
    s.turnStartTick = tick;
    s.countdownEndTick = null;
    s.lastCountdownValue = null;
    s.hostReturnDeadlineTick = null;
    s.hostReturnLastSeconds = null;
    broadcastState(s, dispatcher, logger);
}

function tryStartCountdown(
    s: MatchState,
    senderUserId: string,
    tick: number,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
): void {
    if (s.status !== "waiting") return;

    const hostUserId = s.roomCode !== null ? s.hostUserId : s.playerX;
    const hasRequiredPlayers = !!(hostUserId && s.players[hostUserId] && s.playerO && s.players[s.playerO]);
    if (!hasRequiredPlayers) return;

    if (senderUserId !== hostUserId) {
        logger.debug("Ignoring start request from non-host userId=%s", senderUserId);
        return;
    }

    s.status = "countdown";
    s.countdownEndTick = tick + (MATCH_CONFIG.COUNTDOWN_SEC * s.tickRate);
    s.lastCountdownValue = null;
    broadcastRoomState(s, dispatcher, tick);
}

function tryUpdateRoomMode(
    s: MatchState,
    senderUserId: string,
    data: ArrayBuffer,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    logger: nkruntime.Logger,
): void {
    if (s.status !== "waiting") return;

    if (senderUserId !== s.hostUserId) {
        logger.debug("Ignoring mode update from non-host userId=%s", senderUserId);
        return;
    }

    let nextModeRaw: string | undefined;
    try {
        const payload = JSON.parse(nk.binaryToString(data)) as { game_mode?: unknown };
        nextModeRaw = typeof payload?.game_mode === "string" ? payload.game_mode : undefined;
    } catch {
        logger.debug("Ignoring invalid mode update payload from userId=%s", senderUserId);
        return;
    }

    if (!nextModeRaw) return;

    const normalized = nextModeRaw.toUpperCase();
    if (normalized !== "CLASSIC" && normalized !== "TIMED") {
        logger.debug("Ignoring unsupported mode value=%s from userId=%s", normalized, senderUserId);
        return;
    }

    const nextMode = normalized as "CLASSIC" | "TIMED";
    if (s.gameMode === nextMode) return;

    s.gameMode = nextMode;
    s.turnTimerSec = nextMode === "TIMED" ? 10 : 30;
    dispatcher.matchLabelUpdate(buildMatchLabel(nextMode, s.roomCode, true));
    broadcastRoomState(s, dispatcher, tick);
}

function tryReturnToRoomLobby(
    s: MatchState,
    senderUserId: string,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    logger: nkruntime.Logger,
): void {
    if (s.roomCode === null) return;

    if (s.status !== "done" && s.status !== "waiting_host") return;

    if (!s.players[senderUserId]) {
        logger.debug("Ignoring lobby return request from non-member userId=%s", senderUserId);
        return;
    }

    s.requestedLobbyReturn[senderUserId] = true;

    // Host request: reset immediately
    if (senderUserId === s.hostUserId) {
        resetRoomToLobbyState(s);
        broadcastRoomState(s, dispatcher, tick);
        return;
    }

    // Guest request: wait for host or timeout
    if (!s.requestedLobbyReturn[s.hostUserId]) {
        s.status = "waiting_host";
        s.hostReturnDeadlineTick = tick + (MATCH_CONFIG.HOST_RETURN_TIMEOUT_SEC * s.tickRate);
        s.hostReturnLastSeconds = null;
        s.countdownEndTick = null;
        s.lastCountdownValue = null;
        broadcastRoomState(s, dispatcher, tick);
        return;
    }

    // Both players requested: reset now
    resetRoomToLobbyState(s);
    broadcastRoomState(s, dispatcher, tick);
}

function buildMatchLabel(
    gameMode: "CLASSIC" | "TIMED",
    roomCode: string | null,
    open: boolean,
): string {
    return JSON.stringify({
        mode: gameMode,
        room: roomCode,
        open,
    });
}

function broadcastState(
    s: MatchState,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
) {
    const playerXId = s.roomCode !== null ? s.hostUserId : s.playerX;
    const host = s.players[playerXId];
    const guest = s.playerO ? s.players[s.playerO] : undefined;
    if (!host || !guest) {
        logger.debug(
            "broadcastState skipped: status=%s room=%s playerXId=%s playerO=%s hostPresent=%s guestPresent=%s",
            s.status,
            s.roomCode || "ranked",
            playerXId,
            s.playerO,
            !!host,
            !!guest,
        );
        return;
    }

    const payload = JSON.stringify({
        board: s.board,
        current_turn: s.currentTurn,
        player_x: host,
        player_o: guest,
        status: s.status,
        turn_timer_sec: s.turnTimerSec,
        game_mode: s.gameMode,
        scores: s.scores,
    });
    dispatcher.broadcastMessage(OP_CODE.STATE, payload);
    logger.debug(
        "broadcastState sent: status=%s room=%s playerX=%s playerO=%s turn=%s",
        s.status,
        s.roomCode || "ranked",
        host.userId,
        guest.userId,
        s.currentTurn,
    );
}

function broadcastRoomState(s: MatchState, dispatcher: nkruntime.MatchDispatcher, tick: number) {
    const playerXId = s.roomCode !== null ? s.hostUserId : s.playerX;
    const host = playerXId ? s.players[playerXId] || null : null;
    const guest = s.playerO ? s.players[s.playerO] : null;
    const countdownSec = currentCountdownValue(s, tick);
    const hostReturnSec = currentHostReturnSeconds(s, tick);

    const payload = JSON.stringify({
        room_code: s.roomCode,
        status: s.status,
        game_mode: s.gameMode,
        player_x: host,
        player_o: guest,
        player_count: Object.keys(s.players).length,
        ready: !!(host && guest),
        countdown_sec: countdownSec,
        host_return_sec: hostReturnSec,
        host_user_id: playerXId,
    });

    dispatcher.broadcastMessage(OP_CODE.ROOM_STATE, payload);
}

function currentCountdownValue(s: MatchState, tick: number): number | null {
    if (s.status !== "countdown" || s.countdownEndTick === null) {
        return null;
    }

    const ticksLeft = s.countdownEndTick - tick;
    if (ticksLeft <= 0) {
        return null;
    }

    return Math.ceil(ticksLeft / s.tickRate);
}

function currentHostReturnSeconds(s: MatchState, tick: number): number | null {
    if (s.status !== "waiting_host" || s.hostReturnDeadlineTick === null) {
        return null;
    }

    const ticksLeft = s.hostReturnDeadlineTick - tick;
    if (ticksLeft <= 0) {
        return null;
    }

    return Math.ceil(ticksLeft / s.tickRate);
}

function shouldAutoStartRankedMatch(s: MatchState): boolean {
    if (s.roomCode !== null || s.status !== "waiting") {
        return false;
    }

    if (!s.playerX || !s.playerO) {
        return false;
    }

    return !!(s.players[s.playerX] && s.players[s.playerO]);
}

function logSlotState(logger: nkruntime.Logger, s: MatchState, source: string) {
    logger.debug(
        "%s: room=%s status=%s hostUserId=%s playerX=%s playerO=%s players=[%s]",
        source,
        s.roomCode || "ranked",
        s.status,
        s.hostUserId,
        s.playerX,
        s.playerO,
        Object.keys(s.players).join(","),
    );
}

function reconcilePlayerSlots(s: MatchState): void {
    if (s.roomCode !== null) {
        // Private room: host is always playerX
        if (!s.hostUserId) {
            s.hostUserId = Object.keys(s.players)[0] || "";
        }

        s.playerX = s.players[s.hostUserId] ? s.hostUserId : "";
        s.playerO = Object.keys(s.players).find((id) => id !== s.hostUserId) || "";
    } else {
        // Ranked match: assign first two players
        if (!s.playerX || !s.players[s.playerX]) {
            s.playerX = Object.keys(s.players)[0] || "";
        }

        if (!s.playerO || !s.players[s.playerO]) {
            s.playerO = Object.keys(s.players).find((id) => id !== s.playerX) || "";
        }
    }

    syncPlayerMarks(s);
}

function resetRoomToLobbyState(s: MatchState): void {
    s.board = Array(MATCH_CONFIG.BOARD_SIZE).fill(null);
    s.status = "waiting";
    s.currentTurn = "";
    s.turnStartTick = 0;
    s.countdownEndTick = null;
    s.lastCountdownValue = null;
    s.hostReturnDeadlineTick = null;
    s.hostReturnLastSeconds = null;
    s.requestedLobbyReturn = {};

    // Reset scores for next round
    for (const userId of Object.keys(s.players)) {
        s.scores[userId] = 0;
    }

    reconcilePlayerSlots(s);
}

function closeRoomState(s: MatchState): void {
    s.status = "closed";
    s.currentTurn = "";
    s.playerX = "";
    s.playerO = "";
    s.players = {};
    s.countdownEndTick = null;
    s.lastCountdownValue = null;
    s.hostReturnDeadlineTick = null;
    s.hostReturnLastSeconds = null;
    s.requestedLobbyReturn = {};
}

function syncPlayerMarks(s: MatchState): void {
    if (s.playerX && s.players[s.playerX]) {
        s.players[s.playerX].mark = "X";
    }
    if (s.playerO && s.players[s.playerO]) {
        s.players[s.playerO].mark = "O";
    }
}

function endGame(
    s: MatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    winnerId: string | null,
    reason: string,
    logger: nkruntime.Logger,
    matchId: string,
): void {
    s.status = "done";
    s.currentTurn = "";
    s.countdownEndTick = null;
    s.lastCountdownValue = null;
    s.hostReturnDeadlineTick = null;
    s.hostReturnLastSeconds = null;
    s.requestedLobbyReturn = {};

    if (winnerId) {
        addScore(s, winnerId, SCORE_CONFIG.WIN_BONUS);
    }

    const playerX = s.players[s.playerX];
    const playerO = s.players[s.playerO];
    const isRanked = s.roomCode === null;
    const matchType: "ranked" | "room" = isRanked ? "ranked" : "room";

    // Update leaderboard for ranked matches only
    if (isRanked) {
        if (playerX) {
            updateLeaderboard(nk, playerX.userId, s.scores[playerX.userId] || 0, logger);
        }
        if (playerO) {
            updateLeaderboard(nk, playerO.userId, s.scores[playerO.userId] || 0, logger);
        }
    }

    // Record match results for both players
    if (playerX && playerO) {
        const xScore = s.scores[playerX.userId] || 0;
        const oScore = s.scores[playerO.userId] || 0;

        if (winnerId === null) {
            // Draw
            recordMatchResult(nk, logger, playerX.userId, playerO.userId, playerO.nickname, "draw", reason, matchId, xScore, oScore, matchType);
            recordMatchResult(nk, logger, playerO.userId, playerX.userId, playerX.nickname, "draw", reason, matchId, oScore, xScore, matchType);
        } else if (winnerId === playerX.userId) {
            // PlayerX wins
            recordMatchResult(nk, logger, playerX.userId, playerO.userId, playerO.nickname, "win", reason, matchId, xScore, oScore, matchType);
            recordMatchResult(nk, logger, playerO.userId, playerX.userId, playerX.nickname, "loss", reason, matchId, oScore, xScore, matchType);
        } else if (winnerId === playerO.userId) {
            // PlayerO wins
            recordMatchResult(nk, logger, playerO.userId, playerX.userId, playerX.nickname, "win", reason, matchId, oScore, xScore, matchType);
            recordMatchResult(nk, logger, playerX.userId, playerO.userId, playerO.nickname, "loss", reason, matchId, xScore, oScore, matchType);
        }
    }

    const payload = JSON.stringify({
        winner: winnerId,
        reason,
        board: s.board,
        scores: s.scores,
    });
    dispatcher.broadcastMessage(OP_CODE.GAME_OVER, payload);
}

function scoreForMove(elapsedTurnSeconds: number): number {
    if (elapsedTurnSeconds < 3) {
        return SCORE_CONFIG.MOVE_FAST;
    }
    if (elapsedTurnSeconds < 5) {
        return SCORE_CONFIG.MOVE_QUICK;
    }
    return SCORE_CONFIG.MOVE_BASE;
}

function addScore(s: MatchState, userId: string, delta: number): void {
    const current = s.scores[userId] || 0;
    const next = current + delta;
    s.scores[userId] = Math.max(next, 0);
}

function checkWin(board: (number | null)[]): number | null {
    for (const [a, b, c] of WIN_LINES) {
        if (board[a] !== null && board[a] === board[b] && board[b] === board[c]) {
            return board[a];
        }
    }
    return null;
}
