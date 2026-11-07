/**
 * The small "3 new" badge beside a proposal with unread comments, or null for
 * none. Capped, so a long thread does not push the row out of shape.
 */
export const UNREAD_BADGE_CAP = 99;

export function unreadLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const whole = Math.floor(count);
  return whole > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+ new` : `${whole} new`;
}
