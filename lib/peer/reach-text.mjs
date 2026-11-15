// How a teammate is reached, as the roster, the windows and elu peers say it, in one place.
// Kept free of files and networking, like join-text.mjs. member is a row of peerStatus():
// {online, path: 'direct' | 'relayed' | null, via: the computer that passes the connection
// along, reach: 'looking' while a computer on the team that reaches you both is looked for,
// 'blocked' when their computer is there and nothing gets through to it}.
export const NO_WAY = 'no computer on the team reaches you both';
export const LOOKING = 'looking for a way through';
// Why a teammate is offline, shorter for a row too narrow for the words above.
const NO_WAY_SHORT = ['no computer reaches you both', 'nobody reaches you both', 'no way through'];
// whole: the sentences for the window that shows one teammate; otherwise the words for a row.
// fit: the row has room for this many characters, so the why takes the longest wording that
// fits, and a row too narrow for "online · through …" drops "online": its dot says that.
export function reachText(member, { whole = false, fit = Infinity } = {}) {
  const via = typeof member?.via === 'string' && member.via ? member.via : 'another computer';
  if (!member?.online) {
    // While the way is still looked for, never that there is none.
    if (member?.reach === 'looking') {
      if (whole) return 'offline. Their computer is on, but your two networks do not connect directly. ELU is looking for a computer on the team that reaches you both.';
      const forms = [`offline · ${LOOKING}`, LOOKING, 'looking for a way'];
      return forms.find(form => form.length <= fit) ?? forms.at(-1);
    }
    if (member?.reach !== 'blocked') return 'offline';
    if (whole) return `offline. Their computer is on, but your two networks do not connect directly, and ${NO_WAY}. Open ELU on another computer on the team.`;
    const forms = [NO_WAY, ...NO_WAY_SHORT].map(why => `offline · ${why}`);
    return forms.find(form => form.length <= fit) ?? forms.at(-1);
  }
  if (member.path !== 'relayed') return member.path ?? 'online';
  if (whole) return `online, through ${via}. Your two networks do not connect directly, so it passes the connection along. It cannot read it.`;
  return `online · through ${via}`.length <= fit ? `online · through ${via}` : `through ${via}`.length <= fit ? `through ${via}` : `online · through ${via}`;
}
// A computer of mine on an ELU that cannot rename, archive or unarchive its sessions from
// another computer (0.1.25 and earlier), as the daemon and the app both say it. name: its @name.
export const EDIT_UPDATE = (name, verb) => `${name} needs ELU 0.1.26 to ${verb} its sessions.`;
