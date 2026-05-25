export function msgTime(iso){
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/* "Xs" under a minute, "Xm YYs" (zero-padded seconds) otherwise. Used by the
   assistant-message elapsed pill; capped at 1 h upstream so no hour branch
   needed. */
export function formatMsgElapsed(ms){
  const totalSec = Math.floor((ms || 0) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
}
