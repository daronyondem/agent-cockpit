import React from 'react';

/* Refreshed icon set — 14×14 default, 1.5px stroke, round caps/joins.
   All currentColor. Exportable individually. */
const svg = (p, s=14) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{p}</svg>
);

export const Ico = {
  // nav + actions
  plus:      (s) => svg(<><path d="M12 5v14M5 12h14"/></>, s),
  minus:     (s) => svg(<path d="M5 12h14"/>, s),
  search:    (s) => svg(<><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></>, s),
  chev:      (s) => svg(<path d="m9 6 6 6-6 6"/>, s),
  chevD:     (s) => svg(<path d="m6 9 6 6 6-6"/>, s),
  chevU:     (s) => svg(<path d="m6 15 6-6 6 6"/>, s),
  x:         (s) => svg(<path d="m6 6 12 12M18 6 6 18"/>, s),
  check:     (s) => svg(<path d="m4 12 5 5 11-11"/>, s),
  dots:      (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>,
  arrow:     (s) => svg(<><path d="M5 12h14M13 5l7 7-7 7"/></>, s),
  up:        (s) => svg(<><path d="M12 19V5M5 12l7-7 7 7"/></>, s),
  down:      (s) => svg(<><path d="M12 5v14M5 12l7 7 7-7"/></>, s),
  // file/folder
  folder:    (s) => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>, s),
  file:      (s) => svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></>, s),
  fileAdd:   (s) => svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 13v6M9 16h6"/></>, s),
  fileText:  (s) => svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></>, s),
  // chat + people
  user:      (s) => svg(<><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>, s),
  users:     (s) => svg(<><circle cx="9" cy="8" r="3.5"/><path d="M3 21a6 6 0 0 1 12 0"/><path d="M16 4a3.5 3.5 0 0 1 0 7M20 21a5 5 0 0 0-3-4.6"/></>, s),
  message:   (s) => svg(<path d="M21 12a7 7 0 0 1-7 7H8l-4 3v-9a7 7 0 0 1 7-7h3a7 7 0 0 1 7 6z"/>, s),
  // cockpit
  terminal:  (s) => svg(<><path d="m4 7 5 5-5 5M12 19h8"/></>, s),
  diff:      (s) => svg(<><path d="M6 3v13a3 3 0 0 0 3 3h9M18 21V8a3 3 0 0 0-3-3H6"/><path d="m3 16 3 3 3-3M21 8l-3-3-3 3"/></>, s),
  play:      (s) => svg(<path d="M6 4v16l13-8z"/>, s),
  stop:      (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>,
  pause:     (s) => svg(<><rect x="7" y="5" width="3" height="14" rx="1"/><rect x="14" y="5" width="3" height="14" rx="1"/></>, s),
  // status
  alert:     (s) => svg(<><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/></>, s),
  info:      (s) => svg(<><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></>, s),
  ok:        (s) => svg(<><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>, s),
  clock:     (s) => svg(<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>, s),
  zap:       (s) => svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>, s),
  bolt:      (s) => svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>, s),
  // utility
  settings:  (s) => svg(<><circle cx="12" cy="12" r="3"/><path d="M19 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>, s),
  paperclip: (s) => svg(<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5L10.5 17.5a2 2 0 0 1-3-3L16 6"/>, s),
  copy:      (s) => svg(<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>, s),
  download:  (s) => svg(<><path d="M12 3v13M6 12l6 6 6-6"/><path d="M4 21h16"/></>, s),
  upload:    (s) => svg(<><path d="M12 21V8M6 13l6-6 6 6"/><path d="M4 3h16"/></>, s),
  reset:     (s) => svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></>, s),
  logout:    (s) => svg(<><path d="M15 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><path d="M21 12H9M18 9l3 3-3 3"/></>, s),
  archive:   (s) => svg(<><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 13h4"/></>, s),
  trash:     (s) => svg(<><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7 7 21h10l1-14M9 7V4h6v3"/></>, s),
  edit:      (s) => svg(<><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>, s),
  eye:       (s) => svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>, s),
  eyeOff:    (s) => svg(<><path d="M4 4l16 16M10.6 6.1A9 9 0 0 1 22 12s-1.3 2.5-3.7 4.5M6 7.5C3.5 9.3 2 12 2 12s3.5 7 10 7a9 9 0 0 0 4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>, s),
  moon:      (s) => svg(<path d="M20 14a8 8 0 1 1-9.9-9.9 7 7 0 0 0 9.9 9.9z"/>, s),
  sun:       (s) => svg(<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>, s),
  // brand + KB
  book:      (s) => svg(<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5a2.5 2.5 0 0 0 0 5H20"/>, s),
  sparkNode: (s) => svg(<><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="17" r="2.4"/><path d="M7.5 7.5 11 15M17 9l-4 6M8 6h8"/></>, s),
  graph:     (s) => svg(<><circle cx="5" cy="6" r="2"/><circle cx="19" cy="8" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="6" cy="17" r="1.5"/><path d="M6.8 7.2 11 16M17.7 9.5l-5 7M10 17.5 7.5 17.2"/></>, s),
  wifiOff:   (s) => svg(<><path d="M2 2l20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 2.8-2M19 12.6a10 10 0 0 0-6.2-2.9"/><path d="M12 20v.01"/></>, s),
  key:       (s) => svg(<><circle cx="7" cy="15" r="3.5"/><path d="M10 13l9-9 3 3-2 2 2 2-2 2-2-2-2 2"/></>, s),
  globe:     (s) => svg(<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>, s),
  hash:      (s) => svg(<><path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/></>, s),
  reflect:   (s) => svg(<><path d="M12 3v18"/><path d="M8 7h-3v10h3M16 7h3v10h-3"/></>, s),
  cmd:       (s) => svg(<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>, s),
  brand:     (s=20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2 21 7v10l-9 5-9-5V7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="m12 7 5 3v5l-5 3-5-3v-5z" fill="currentColor" opacity=".22"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>,
};

export default Ico;
