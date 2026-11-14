// How a teammate is reached, as the roster, the windows and elu peers say it, in one place.
// Kept free of files and networking, like join-text.mjs. member is a row of peerStatus():
// {online, path: 'direct' | 'relayed' | null, via: the computer that passes the connection
// along, reach: 'blocked' when their computer is there and nothing gets through to it}.
export const NO_WAY = 'no computer on the team reaches you both';
// whole: the sentences for the window that shows one teammate; otherwise the words for a row.
export function reachText(member, { whole = false } = {}) {
  const via = typeof member?.via === 'string' && member.via ? member.via : 'another computer';
  if (!member?.online) {
    if (member?.reach !== 'blocked') return 'offline';
    return whole ? `offline. Their computer is on, but your two networks do not connect directly, and ${NO_WAY}. Open ELU on another computer on the team.` : `offline · ${NO_WAY}`;
  }
  if (member.path !== 'relayed') return member.path ?? 'online';
  return whole ? `online, through ${via}. Your two networks do not connect directly, so it passes the connection along. It cannot read it.` : `online · through ${via}`;
}
