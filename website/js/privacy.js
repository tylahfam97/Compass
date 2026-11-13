// Two separate, independently stored choices (Peitho strings.json, verbatim).
// 1. Opt-in browser counting (unchanged). Nothing is stored or sent until the visitor chooses
//    Allow. Choice: __Host-compass_consent=1.<a|r>.<chosen>.<expires> (Path=/). On Allow only, a
//    random ID in __Secure-compass_browser (Path=/_measure, so it never rides along with pages,
//    downloads, GitHub, Clarity or /api/feedback). Both last 7 days from the choice.
// 2. Microsoft Clarity website recording (project zcrzloqmns). Choice in localStorage
//    compass_clarity = on | cookies | off. Never loaded with a GPC/DNT signal, after "off", or
//    when storage is unusable (an opt-out could not be remembered). ad_Storage is always denied;
//    analytics_Storage is granted only after the visitor clicks "Allow Clarity cookies".
//    The counting choice never implies a Clarity choice and vice versa.
(() => {
  const CHOICE = '__Host-compass_consent', ID = '__Secure-compass_browser', WEEK = 604800;
  const FLAGS = `; Max-Age=${WEEK}; Secure; SameSite=Strict`;
  const CL = 'compass_clarity';
  // PENDING Hermes/Tyler decision (t_aa1fb6c4): may Clarity load cookieless before any choice?
  // true = every visit, consent denied until "Allow Clarity cookies"; false = nothing loads until a choice.
  const PRECHOICE_LOAD = true;
  const T = {
    // first_visit_banner
    clHeading: 'This site records how its pages are used',
    clBody: "We use Microsoft Clarity to record clicks, scrolling and what our pages showed, so we can fix what's confusing. Microsoft also uses this data under its own terms. Text you type is masked. Nothing in the Compass app is recorded.",
    clRegional: "In the EEA, UK and Switzerland, Clarity doesn't use cookies until you allow them.",
    clAllowCookies: 'Allow Clarity cookies', clTurnOff: 'Turn recording off', settingsLink: 'Privacy settings', policy: 'Privacy policy',
    // counting_banner
    bannerHeading: 'Count this browser?',
    bannerBody: 'Optional, and separate from Clarity. If you allow it, this browser gets a random code for seven days so we can count repeat visits. Declining changes nothing on the site.',
    allow: 'Allow', decline: 'Decline',
    // privacy_settings_panel
    settingsHeading: 'Privacy settings',
    intro: "Two separate choices. Changing one doesn't change the other.",
    clSection: 'Website recording (Microsoft Clarity)',
    clSectionBody: "Records how you use this website's pages, such as clicks, scrolling and the page text shown. Text you type is masked. It never records the Compass app or your desktop.",
    clRecordLabel: 'Record my visits to this website', clCookiesLabel: 'Allow Clarity cookies',
    clCookiesHelp: 'Cookies let Clarity connect the pages of a visit into one recording. Without them, Clarity can still record each page on its own.',
    clRegionalHelp: 'Visitors Microsoft places in the EEA, UK or Switzerland: Clarity cookies stay off until you allow them here.',
    clSignal: "Your browser is sending a privacy signal, so this site doesn't load Clarity.",
    clOn: 'Recording is on.', clOff: 'Recording is off in this browser.',
    clOffDone: "Recording is off for this browser. Recordings already made aren't deleted. Microsoft keeps them on its stated schedule.",
    msLink: 'Microsoft Privacy Statement',
    countSection: 'Visit counting (our own counter)',
    countSectionBody: 'Optional and off unless you choose Allow. A random code is kept for seven days so we can count repeat visits. Separate from Clarity.',
    on: 'Visit counting is on for this browser until the date shown.', off: 'Visit counting is off for this browser.',
    unset: "You haven't chosen. Nothing is counted.",
    afterDecline: 'Counting is off and the code is deleted from this browser. Visits already logged drop out as the log rotates, after about seven days.',
    storage: 'These choices are saved in this browser only. Clearing site data or using another browser resets them.',
    save: 'Save choices', close: 'Close',
    // kept from strings-v2 (no replacement in the new pack)
    unavailable: "This browser blocks what counting needs, so it's off. Everything else works.",
    afterAllow: 'Counting is on until {date}.',
  };
  const now = () => Math.floor(Date.now() / 1000);

  // ---- visit counting (behavior unchanged) ----
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

  // ---- Microsoft Clarity ----
  const signal = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
  // undefined = storage unusable, null = no choice yet
  const clGet = () => { try { const v = localStorage.getItem(CL); return ['on', 'cookies', 'off'].includes(v) ? v : null; } catch { return undefined; } };
  const clSet = v => { try { localStorage.setItem(CL, v); return clGet() === v; } catch { return false; } };
  const consent = grant => window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: grant ? 'granted' : 'denied' });
  let loaded = false;
  const loadClarity = () => {
    if (loaded || signal()) return;
    loaded = true;
    if (!window.clarity) { // supplied bootstrap, verbatim apart from formatting; one copy per page
      (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
      })(window, document, "clarity", "script", "zcrzloqmns");
    }
    consent(clGet() === 'cookies'); // queued before the tag runs: no cookies until an explicit grant
  };
  const dropClarityCookies = () => {
    for (const n of ['_clck', '_clsk']) for (const d of ['', `; Domain=${location.hostname}`, `; Domain=.${location.hostname.replace(/^www\./, '')}`]) {
      try { document.cookie = `${n}=; Path=/; Max-Age=0${d}`; } catch {}
    }
  };
  const stop = () => { if (loaded) { consent(false); window.clarity('consent', false); } dropClarityCookies(); };
  // v: 'on' | 'cookies' | 'off'. Returns false when the choice could not be saved.
  const clChoose = v => {
    const saved = clSet(v);
    if (v === 'off') stop(); // stop this page even when the choice can't be remembered
    else if (saved) { if (loaded) consent(v === 'cookies'); else loadClarity(); }
    return saved;
  };

  // ---- UI ----
  let panel, opener;
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const statusText = c => c === undefined ? T.unavailable : !c ? T.unset : c.allow ? `${T.on} ${day(c.exp)}` : T.off;
  const close = () => { if (!panel) return; panel.remove(); panel = null; if (opener) opener.focus(); opener = null; };
  const button = (label, onClick, cls = 'btn btn-outline btn-sm') => {
    const b = el('button', { type: 'button', className: cls, textContent: label });
    b.addEventListener('click', onClick);
    return b;
  };
  const status = () => { const p = el('p', { className: 'privacy-choice-status' }); p.setAttribute('role', 'status'); return p; };
  const countRow = (live, after) => el('div', { className: 'privacy-choice-actions' }, ...[true, false].map(allow =>
    button(allow ? T.allow : T.decline, () => {
      const r = choose(allow);
      live.textContent = r === undefined ? T.unavailable : allow ? T.afterAllow.replace('{date}', day(r.exp)) : T.afterDecline;
      if (after) after();
    })));
  const mount = (kind, h, ...kids) => {
    if (panel) panel.remove();
    panel = el('section', { className: 'privacy-choice' }, h, ...kids);
    panel.dataset.kind = kind;
    panel.setAttribute('aria-labelledby', h.id);
    document.body.prepend(panel);
  };

  const showBanner = (needClarity, needCount) => {
    const kids = [];
    const later = () => setTimeout(() => { if (panel && panel.dataset.kind === 'banner') close(); }, 4000);
    let h;
    if (needClarity) {
      const live = status();
      h = el('h2', { id: 'privacy-choice-title', className: 'privacy-choice-title', tabIndex: -1, textContent: T.clHeading });
      kids.push(el('p', { textContent: T.clBody }), el('p', { textContent: T.clRegional }),
        el('div', { className: 'privacy-choice-actions' },
          button(T.clAllowCookies, () => { live.textContent = clChoose('cookies') ? T.clOn : T.unavailable; if (!needCount) later(); }),
          button(T.clTurnOff, () => { clChoose('off'); live.textContent = T.clOffDone; if (!needCount) later(); }),
          button(T.settingsLink, () => showSettings(), 'btn btn-ghost btn-sm'),
          el('a', { href: '/privacy/', textContent: T.policy })),
        live);
    }
    if (needCount) {
      const live = status();
      const ch = el(h ? 'h3' : 'h2', { id: h ? 'privacy-count-title' : 'privacy-choice-title', className: 'privacy-choice-title', tabIndex: -1, textContent: T.bannerHeading });
      const row = countRow(live, later);
      if (!h) { h = ch; row.append(el('a', { href: '/privacy/', textContent: T.policy })); } else kids.push(ch);
      kids.push(el('p', { textContent: T.bannerBody }), row, live);
    }
    mount('banner', h, ...kids);
  };

  const showSettings = () => {
    const h = el('h2', { id: 'privacy-choice-title', className: 'privacy-choice-title', tabIndex: -1, textContent: T.settingsHeading });
    const kids = [el('p', { textContent: T.intro }), el('h3', { className: 'privacy-choice-title', textContent: T.clSection }), el('p', { textContent: T.clSectionBody })];
    const clLive = status();
    if (signal()) kids.push(el('p', { textContent: T.clSignal }));
    else {
      const cur = clGet();
      const box = (label, checked) => { const i = el('input', { type: 'checkbox', checked }); return [i, el('label', {}, i, ' ', label)]; };
      const [rec, recL] = box(T.clRecordLabel, cur !== undefined && cur !== 'off' && (cur !== null || PRECHOICE_LOAD));
      const [ck, ckL] = box(T.clCookiesLabel, cur === 'cookies');
      ck.disabled = !rec.checked;
      rec.addEventListener('change', () => { ck.disabled = !rec.checked; if (!rec.checked) ck.checked = false; });
      clLive.textContent = rec.checked ? T.clOn : T.clOff;
      kids.push(el('div', {}, recL), el('div', {}, ckL), el('p', { textContent: T.clCookiesHelp }), el('p', { textContent: T.clRegionalHelp }),
        el('div', { className: 'privacy-choice-actions' },
          button(T.save, () => {
            const v = !rec.checked ? 'off' : ck.checked ? 'cookies' : 'on';
            const ok = clChoose(v);
            clLive.textContent = v === 'off' ? T.clOffDone : ok ? T.clOn : T.unavailable;
          }),
          el('a', { href: 'https://privacy.microsoft.com/en-us/privacystatement', target: '_blank', rel: 'noopener noreferrer', textContent: T.msLink })));
    }
    kids.push(clLive);
    const cLive = status();
    cLive.textContent = statusText(read());
    kids.push(el('h3', { className: 'privacy-choice-title', textContent: T.countSection }), el('p', { textContent: T.countSectionBody }), countRow(cLive), cLive,
      el('p', { textContent: T.storage }),
      el('div', { className: 'privacy-choice-actions' }, button(T.close, close, 'btn btn-ghost btn-sm')));
    mount('settings', h, ...kids);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    h.focus();
  };

  const start = () => {
    const nav = document.querySelector('.footer-links');
    if (nav) {
      const b = el('button', { type: 'button', className: 'footer-privacy-settings', textContent: T.settingsLink });
      b.addEventListener('click', () => { opener = b; showSettings(); });
      nav.append(b);
    }
    const cl = clGet();
    if (cl === 'on' || cl === 'cookies' || (cl === null && PRECHOICE_LOAD)) loadClarity();
    const c = read();
    // cookies blocked: no counting banner; privacy signal or unusable storage: no Clarity banner
    const needClarity = cl === null && !signal();
    if (needClarity || c === null) showBanner(needClarity, c === null);
    if (c && c.allow) send();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
