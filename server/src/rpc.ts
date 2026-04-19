function rpcCreateRoom(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const req = payload ? JSON.parse(payload) : {};
    const gameMode = resolveRequestedGameMode(req.game_mode);
    const roomCode = generateRoomCode();
    const matchId = nk.matchCreate(MATCH_MODULE, {
        game_mode: gameMode,
        room_code: roomCode,
    });

    logger.info("Room created: code=%s matchId=%s", roomCode, matchId);
    return JSON.stringify({
        room_code: roomCode,
        match_id: matchId,
        game_mode: gameMode,
    });
}

function generateRoomCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function rpcJoinRoom(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const req = JSON.parse(payload);
    const roomCode: string = req.room_code;

    if (!roomCode || roomCode.length < 4) {
        throw Error("invalid room code");
    }

    const limit = 100;
    const authoritative = true;
    const label = "";
    const minSize = 0;
    const maxSize = 2;
    const query = `+label.room:${roomCode}`;

    const result = nk.matchList(limit, authoritative, label, minSize, maxSize, query);

    if (!result || result.length === 0) {
        throw Error("room not found");
    }

    const match = result[0];
    const matchLabel = parseMatchLabel(match.label);
    if (!matchLabel.open) {
        throw Error("room unavailable");
    }

    return JSON.stringify({
        match_id: match.matchId,
        room_code: roomCode,
        game_mode: matchLabel.mode,
    });
}

function rpcAvatarIdFromMetadata(metadata: unknown): number | null {
    return parseAvatarId(metadataAsObject(metadata).avatar_id);
}

function rpcSetAvatar(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
): string {
    if (!ctx.userId) {
        throw Error("unauthorized");
    }

    const req = payload ? JSON.parse(payload) : {};
    const requestedAvatarId = parseAvatarId(req.avatar_id);
    if (requestedAvatarId === null) {
        throw Error("invalid avatar_id");
    }

    const accountBefore = nk.accountGetId(ctx.userId);
    const displayName = accountBefore.user?.displayName || "ANON";
    const nextMetadata = metadataAsObject(accountBefore.user?.metadata);
    nextMetadata.avatar_id = requestedAvatarId;

    nk.accountUpdateId(
        ctx.userId,
        null,
        displayName,
        null,
        null,
        null,
        null,
        nextMetadata,
    );

    const accountAfter = nk.accountGetId(ctx.userId);
    const persistedAvatarId =
        rpcAvatarIdFromMetadata(accountAfter.user?.metadata) ?? requestedAvatarId;

    logger.info(
        "Avatar updated: userId=%s requested=%d persisted=%d",
        ctx.userId,
        requestedAvatarId,
        persistedAvatarId,
    );

    return JSON.stringify({
        user_id: ctx.userId,
        avatar_id: persistedAvatarId,
        metadata: accountAfter.user?.metadata ?? nextMetadata,
    });
}

function resolveRequestedGameMode(mode: unknown): "CLASSIC" | "TIMED" {
    if (mode === undefined || mode === null) {
        return "CLASSIC";
    }

    if (mode === "CLASSIC" || mode === "TIMED") {
        return mode;
    }

    throw Error("invalid game_mode");
}

type RoomMatchLabel = {
    mode: "CLASSIC" | "TIMED";
    room: string | null;
    open: boolean;
};

function parseMatchLabel(label: string): RoomMatchLabel {
    const parsed = JSON.parse(label) as RoomMatchLabel;

    if (parsed.mode !== "CLASSIC" && parsed.mode !== "TIMED") {
        throw Error("invalid match label mode");
    }

    return parsed;
}
