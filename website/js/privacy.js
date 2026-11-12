// Opt-in browser counting. Nothing is stored or sent until the visitor chooses Allow.
// Choice: __Host-compass_consent=1.<a|r>.<chosen>.<expires> (Path=/). On Allow only, a
// random ID in __Secure-compass_browser (Path=/_measure, so it never rides along with
// pages, downloads, GitHub or /api/feedback). Both last 7 days from the choice; visits
// never extend them. A failure anywhere here only means nothing is counted.
(() => {
  const CHOICE = '__Host-compass_consent', ID = '__Secure-compass_browser', WEEK = 604800;
  const FLAGS = `; Max-Age=${WEEK}; Secure; SameSite=Strict`;
  const T = { // Peitho strings-v2.json "recognition" + "footer", verbatim
    bannerHeading: 'Count this browser?',
    bannerBody: "If you choose Allow, we'll keep a random code in a cookie for seven days so we can see how many browsers visit and come back. It isn't linked to your name or your downloads. Downloads work the same either way.",
    allow: 'Allow', decline: 'Decline', policy: 'Privacy policy',
    settingsHeading: 'Privacy settings',
    settingsBody: "Visit counting keeps a random code in this browser for seven days so we can count browsers that come back. It's off unless you choose Allow. Downloads work the same either way.",
    on: 'Counting is on in this browser until {date}.', off: 'Counting is off in this browser.',
    unset: "You haven't chosen yet, so nothing is being counted.",
    unavailable: "This browser blocks what counting needs, so it's off. Everything else works.",
    close: 'Close', afterAllow: 'Counting is on until {date}.',
    afterDecline: 'Counting is off, and the code is deleted from this browser. Visits already counted stay in our log until it rotates.',
    settingsLink: 'Privacy settings',
  };
  const now = () => Math.floor(Date.now() / 1000);
  // undefined = cookies unusable here, null = no valid choice (unset/expired/garbled)
  const read = () => {
    let m;
    try {
      if (!navigator.cookieEnabled) return undefined;
      m = document.cookie.match(/(?:^|;\s*)__Host-compass_consent=1\.([ar])\.(\d{10})\.(\d{10})(?:;|$)/);
    } catch { return undefined; }
    if (!m || +m[3] - +m[2] !== WEEK || +m[3] <= now()) return null;
    return { allow: m[1] === 'a', exp: +m[3] };
  };
  const day = exp => new Date(exp * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const dropId = () => { try { document.cookie = `${ID}=; Path=/_measure; Max-Age=0; Secure; SameSite=Strict`; } catch {} };
  const send = () => {
    const c = read(); // re-read: a withdrawal in another tab stops this page's later sends
    if (c && c.allow) fetch('/_measure', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
  };
  const choose = allow => {
    const cur = read();
    if (cur && cur.allow && allow) return cur; // already on: keep the same code and end date
    const t = now();
    try {
      if (allow) {
        const b = crypto.getRandomValues(new Uint8Array(16));
        const id = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        document.cookie = `${ID}=${id}; Path=/_measure${FLAGS}`;
      } else dropId();
      document.cookie = `${CHOICE}=1.${allow ? 'a' : 'r'}.${t}.${t + WEEK}; Path=/${FLAGS}`;
    } catch { dropId(); return undefined; }
    const c = read();
    if (!c || c.allow !== allow) { dropId(); return undefined; }
    if (allow) send();
    return c;
  };

  let panel, opener;
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const statusText = c => c === undefined ? T.unavailable : !c ? T.unset : c.allow ? T.on.replace('{date}', day(c.exp)) : T.off;
  const close = () => { if (!panel) return; panel.remove(); panel = null; if (opener) opener.focus(); opener = null; };
  const show = settings => {
    if (panel) panel.remove();
    const c = read();
    const h = el('h2', { id: 'privacy-choice-title', className: 'privacy-choice-title', tabIndex: -1, textContent: settings ? T.settingsHeading : T.bannerHeading });
    const live = el('p', { className: 'privacy-choice-status', textContent: settings ? statusText(c) : '' });
    live.setAttribute('role', 'status');
    const btn = (label, allow) => {
      const b = el('button', { type: 'button', className: 'btn btn-outline btn-sm', textContent: label });
      b.addEventListener('click', () => {
        const r = choose(allow);
        live.textContent = r === undefined ? T.unavailable : allow ? T.afterAllow.replace('{date}', day(r.exp)) : T.afterDecline;
        if (!settings) setTimeout(close, 4000); // the banner reports the result, then goes
      });
      return b;
    };
    const row = el('div', { className: 'privacy-choice-actions' }, btn(T.allow, true), btn(T.decline, false));
    if (settings) {
      const x = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', textContent: T.close });
      x.addEventListener('click', close);
      row.append(x);
    } else row.append(el('a', { href: '/privacy/', textContent: T.policy }));
    panel = el('section', { className: 'privacy-choice' },
      h, el('p', { textContent: settings ? T.settingsBody : T.bannerBody }), row, live);
    panel.setAttribute('aria-labelledby', h.id);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape' && settings) close(); });
    document.body.prepend(panel);
    if (settings) h.focus();
  };

  const start = () => {
    const nav = document.querySelector('.footer-links');
    if (nav) {
      const b = el('button', { type: 'button', className: 'footer-privacy-settings', textContent: T.settingsLink });
      b.addEventListener('click', () => { opener = b; show(true); });
      nav.append(b);
    }
    const c = read();
    if (c === null) show(false); // undefined (cookies blocked): no banner, nothing counted
    else if (c && c.allow) send();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
