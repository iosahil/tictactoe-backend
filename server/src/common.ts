/**
 * Common utilities and constants shared across all modules.
 * This file consolidates shared functions to avoid duplication.
 */

// Shared configuration constant
const AVATAR_VARIANTS = 6;

/**
 * Normalizes an avatar ID from metadata by applying modulo operation.
 * Handles both numeric and non-numeric values gracefully.
 *
 * @param metadata - User metadata containing avatar_id
 * @returns Normalized avatar ID (0-5)
 */
function normalizeAvatarId(metadata: unknown): number {
    if (!metadata) return 0;
    const numeric = Number((metadata as Record<string, unknown>).avatar_id);
    if (!Number.isFinite(numeric)) return 0;
    const mod = Math.floor(numeric) % AVATAR_VARIANTS;
    return mod < 0 ? mod + AVATAR_VARIANTS : mod;
}

