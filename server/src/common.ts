/**
 * Common utilities and constants shared across all modules.
 * This file consolidates shared functions to avoid duplication.
 */

// Shared configuration constant
const AVATAR_VARIANTS = 6;

/**
 * Normalizes an avatar ID by applying modulo operation.
 *
 * @param avatarId - Numeric avatar identifier
 * @returns Normalized avatar ID (0-5)
 */
function normalizeAvatarId(avatarId: number): number {
    const mod = Math.trunc(avatarId) % AVATAR_VARIANTS;
    return mod < 0 ? mod + AVATAR_VARIANTS : mod;
}

function parseAvatarId(raw: unknown): number | null {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return normalizeAvatarId(numeric);
}

function metadataAsObject(metadata: unknown): Record<string, unknown> {
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        return metadata as Record<string, unknown>;
    }

    if (typeof metadata === "string") {
        try {
            const parsed = JSON.parse(metadata);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Ignore invalid metadata payload and fall back to empty object.
        }
    }

    return {};
}

function avatarIdFromMetadata(metadata: unknown, fallback: number = 0): number {
    return parseAvatarId(metadataAsObject(metadata).avatar_id) ?? fallback;
}

