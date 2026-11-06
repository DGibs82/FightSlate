import {
  effectiveStatus, isUpcoming, eventSortKey, slugify, snapshotOf, buildWatchlist, eventsForFighter, DEFAULT_DURATION_HOURS
} from '/js/core.mjs';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const USER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ---------- local-first storage ----------
const KEYS = { saved: 'fightslate.saved.v2', fighters: 'fightslate.fighters.v2', filters: 'fightslate.filters.v2', legacy: 'fightslateSaved' };
const storage = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ } }
};

const state = {
  events: [], developing: [], meta: null,
  saved: storage.get(KEYS.saved, {}),      // { [eventId]: { snapshot, savedAt } }
  fighters: storage.get(KEYS.fighters, []), // [slug]
  filters: { sport: '', q: '', promotion: '', window: '90', status: '', officialOnly: false, showPast: false, ...storage.get(KEYS.filters, {}) }
};

const persist = () => { storage.set(KEYS.saved, state.saved); storage.set(KEYS.fighters, state.fighters); };

// ---------- formatting ----------
const fmt = (opts, tz = USER_TZ) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts });
const dateOnly = (date, opts) => fmt(opts, 'UTC').format(new Date(`${date}T12:00:00Z`));

function whenText(e) {
  if (!e.start) return `${dateOnly(e.date, { weekday: 'short', month: 'short', day: 'numeric' })} · Time TBA`;
  const d = new Date(e.start);
  const local = fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  const kind = e.startKind === 'main_card' ? 'main card' : 'start';
  return `${local} (${kind})`;
}

function venueTimeText(e) {
  if (!e.start || !e.timezone || e.timezone === USER_TZ) return '';
  const venueTime = fmt({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, e.timezone).format(new Date(e.start));
  const userOffset = fmt({ timeZoneName: 'shortOffset' }).format(new Date(e.start));
  const venueOffset = fmt({ timeZoneName: 'shortOffset' }, e.timezone).format(new Date(e.start));
  return userOffset === venueOffset ? '' : `${venueTime} at the venue`;
}

function tileParts(e) {
  if (e.start) {
    const d = new Date(e.start);
    return { m: fmt({ month: 'short' }).format(d), d: fmt({ day: 'numeric' }).format(d), w: fmt({ weekday: 'short' }).format(d) };
  }
  return { m: dateOnly(e.date, { month: 'short' }), d: dateOnly(e.date, { day: 'numeric' }), w: dateOnly(e.date, { weekday: 'short' }) };
}

const monthKey = e => e.start ? fmt({ month: 'long', year: 'numeric' }).format(new Date(e.start)) : dateOnly(e.date, { month: 'long', year: 'numeric' });
const isOfficial = e => e.sources.some(s => s.official);
const relTime = iso => {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(diff) < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
};

const STATUS_LABEL = { CONFIRMED: 'Confirmed', ANNOUNCED: 'Announced', POSTPONED: 'Postponed', CANCELED: 'Canceled', COMPLETED: 'Completed', PAST: 'Past' };
function badges(e, extra = '') {
  const st = effectiveStatus(e);
  return `<div class="badges">
    <span class="badge ${e.sport === 'Boxing' ? 'boxing' : 'mma'}">${esc(e.sport)}</span>
    <span class="badge">${esc(e.promotion === 'TBA' ? 'Promoter TBA' : e.promotion)}</span>
    <span class="badge ${st.toLowerCase()}">${STATUS_LABEL[st] ?? st}</span>
    ${isOfficial(e) ? '' : '<span class="badge unofficial" title="Not yet listed by an official promoter or broadcaster source">Unofficial source</span>'}
    ${e.missingFromSource ? '<span class="badge unofficial" title="The source no longer lists this event">Needs re-check</span>' : ''}
    ${extra}
  </div>`;
}

function networkText(e) {
  if (!e.network || e.network === 'TBA') return '<span>Broadcast TBA</span>';
  return `<span>📺 ${esc(e.network)}${e.broadcastVerified ? '' : ' <span class="unverified">(unverified)</span>'}</span>`;
}

// ---------- favourites ----------
const isSaved = id => Boolean(state.saved[id]);
function toggleSave(id) {
  const ev = state.events.find(e => e.id === id);
  if (isSaved(id)) { delete state.saved[id]; toast('Removed from My Slate'); }
  else if (ev) { state.saved[id] = { snapshot: snapshotOf(ev), savedAt: new Date().toISOString() }; toast('Saved to My Slate. We will flag any changes.'); }
  persist(); renderAll();
}
function acknowledge(id) {
  const ev = state.events.find(e => e.id === id);
  if (ev && state.saved[id]) { state.saved[id].snapshot = snapshotOf(ev); persist(); renderAll(); toast('Marked as seen'); }
}
function toggleFighter(slug, name) {
  if (state.fighters.includes(slug)) { state.fighters = state.fighters.filter(s => s !== slug); toast(`Unfollowed ${name}`); }
  else { state.fighters.push(slug); toast(`Following ${name}`); }
  persist(); renderAll();
}
function migrateLegacy() {
  // The original prototype stored a plain list of ids under "fightslateSaved".
  const legacy = storage.get(KEYS.legacy, null);
  if (!Array.isArray(legacy)) return;
  for (const id of legacy) {
    const ev = state.events.find(e => e.id === id);
    if (ev && !state.saved[id]) state.saved[id] = { snapshot: snapshotOf(ev), savedAt: new Date().toISOString() };
  }
  try { localStorage.removeItem(KEYS.legacy); } catch { /* ignore */ }
  persist();
}
const fighterName = slug => state.events.flatMap(e => e.fights).flatMap(f => [f.a, f.b]).find(n => slugify(n) === slug) ?? slug;

// ---------- feeds ----------
function feedUrl(params) {
  const u = new URL('/api/calendar.ics', location.origin);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}
const webcal = url => url.replace(/^https?:/, 'webcal:');
function personalFeed() {
  const ids = Object.keys(state.saved);
  if (!ids.length && !state.fighters.length) return null;
  return feedUrl({ ids: ids.join(','), fighters: state.fighters.join(','), name: 'My FightSlate', download: '0' });
}
function googleLink(e) {
  const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dates = e.start
    ? `${stamp(e.start)}/${stamp(Date.parse(e.start) + DEFAULT_DURATION_HOURS * 3600000)}`
    : `${e.date.replaceAll('-', '')}/${new Date(Date.parse(`${e.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10).replaceAll('-', '')}`;
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', e.title);
  u.searchParams.set('dates', dates);
  u.searchParams.set('location', [e.venue, e.location].filter(Boolean).join(', '));
  u.searchParams.set('details', `${e.headline}\nWatch: ${e.network}\n${location.origin}/?event=${e.id}`);
  return u.toString();
}

// ---------- filtering ----------
function visibleEvents() {
  const f = state.filters;
  const now = Date.now();
  const horizon = now + Number(f.window) * 86400000;
  const pastFloor = new Date(now - 30 * 86400000);
  const q = f.q.trim().toLowerCase();
  return state.events.filter(e => {
    const upcoming = isUpcoming(e);
    if (!upcoming && !(f.showPast && isUpcoming(e, pastFloor))) return false;
    if (eventSortKey(e) > horizon) return false;
    if (f.sport && e.sport !== f.sport) return false;
    if (f.promotion && e.promotion !== f.promotion) return false;
    if (f.status && e.status !== f.status) return false;
    if (f.officialOnly && !isOfficial(e)) return false;
    if (q && ![e.title, e.headline, e.promotion, e.venue, e.location, e.network, ...e.fights.flatMap(b => [b.a, b.b])].join(' ').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => eventSortKey(a) - eventSortKey(b));
}

// ---------- rendering ----------
function eventCard(e, { changes = [] } = {}) {
  const t = tileParts(e);
  const st = effectiveStatus(e);
  const off = ['CANCELED', 'POSTPONED'].includes(st);
  const live = e.fights.filter(f => f.status !== 'CANCELED');
  const preview = live.slice(1, 4);
  const venueTime = venueTimeText(e);
  const saved = isSaved(e.id);
  const photo = e.images?.[0];
  return `<article class="event ${off ? 'is-off' : ''} ${changes.length ? 'has-change' : ''}" aria-labelledby="t-${esc(e.id)}">
    ${photo ? `<img class="event-bg ${isCutout(photo) ? '' : 'square'}" src="${esc(photo)}" alt="" loading="lazy" decoding="async">` : ''}
    <div class="date" aria-hidden="true"><div class="m">${esc(t.m)}</div><div class="d">${esc(t.d)}</div><div class="w">${esc(t.w)}</div></div>
    <div>
      ${badges(e, changes.length ? `<span class="badge changed">${changes.length} change${changes.length > 1 ? 's' : ''}</span>` : '')}
      <h3 class="event-title" id="t-${esc(e.id)}"><button class="linkish" data-open="${esc(e.id)}">${esc(e.title)}</button></h3>
      ${e.headline && !e.title.includes(e.headline) ? `<div class="event-headline">${esc(e.headline)}</div>` : ''}
      <div class="meta"><span>🕘 ${esc(whenText(e))}${venueTime ? ` · ${esc(venueTime)}` : ''}</span><span>📍 ${esc([e.venue, e.location].filter(Boolean).join(', '))}</span>${networkText(e)}</div>
      ${e.statusReason ? `<div class="meta"><span>ℹ️ ${esc(e.statusReason)}</span></div>` : ''}
      ${preview.length ? `<div class="chips">${preview.map(b => `<span class="chip">${esc(b.a)} vs ${esc(b.b)}</span>`).join('')}${live.length > 4 ? `<span class="chip">+${live.length - 4} more</span>` : ''}</div>` : (e.fights.length ? '' : '<div class="chips"><span class="chip">Card not yet announced</span></div>')}
      ${changes.length ? `<div class="change-note"><strong>Changed since you saved it:</strong> ${changes.map(c => esc(c.summary)).join(' · ')} <button class="btn small" data-ack="${esc(e.id)}">Mark as seen</button></div>` : ''}
    </div>
    <div class="actions">
      <button class="btn primary" data-open="${esc(e.id)}">Full card</button>
      <button class="btn" data-save="${esc(e.id)}" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button>
      <a class="btn" href="/api/calendar.ics?id=${encodeURIComponent(e.id)}" download>Add to calendar</a>
    </div>
  </article>`;
}

function renderSchedule() {
  const rows = visibleEvents();
  const watch = new Map(buildWatchlist(state.events, state.saved, []).map(i => [i.id, i.changes]));
  $('#resultCount').textContent = `${rows.length} event${rows.length === 1 ? '' : 's'}`;
  const f = state.filters;
  const dl = new URLSearchParams();
  if (f.sport) dl.set('sport', f.sport);
  if (f.promotion) dl.set('promotion', f.promotion);
  if (f.status) dl.set('status', f.status);
  if (rows.length && rows.length < state.events.length) dl.set('ids', rows.map(e => e.id).join(','));
  $('#downloadVisible').href = `/api/calendar.ics?${dl}`;
  if (!rows.length) {
    const hasFilters = f.sport || f.q || f.promotion || f.status || f.officialOnly || f.window !== '3650';
    $('#eventList').innerHTML = `<div class="empty"><p><strong>No events match these filters.</strong></p>
      <p>${hasFilters ? 'Try widening the date range or clearing filters.' : 'No upcoming events are on file right now. Check back soon.'}</p>
      ${hasFilters ? '<button class="btn" data-clear-filters>Clear filters</button>' : ''}</div>`;
    return;
  }
  let html = '', month = '';
  for (const e of rows) {
    const m = monthKey(e);
    if (m !== month) { if (month) html += '</div>'; html += `<h3 class="month">${esc(m)}</h3><div class="events">`; month = m; }
    html += eventCard(e, { changes: watch.get(e.id) ?? [] });
  }
  $('#eventList').innerHTML = html + '</div>';
}

function renderSlate() {
  const items = buildWatchlist(state.events, state.saved, state.fighters);
  const changed = items.filter(i => i.changes.length);
  const count = Object.keys(state.saved).length;
  $('#slateCount').hidden = count === 0 && !changed.length;
  $('#slateCount').textContent = changed.length ? `${changed.length}!` : count;
  $('#slateCount').setAttribute('aria-label', changed.length ? `${changed.length} saved events changed` : `${count} saved events`);
  const feed = personalFeed();
  const side = `<div class="panel">
      <h3>Fighters you follow</h3>
      ${state.fighters.length ? `<div class="fighter-chips">${state.fighters.map(s => `<span class="fighter-chip"><button class="linkish" data-fighter="${esc(s)}">${esc(fighterName(s))}</button><button data-unfollow="${esc(s)}" aria-label="Unfollow ${esc(fighterName(s))}">×</button></span>`).join('')}</div>` : '<p class="muted">Open any fight card and tap "Follow" next to a fighter to see their upcoming bouts here.</p>'}
      <h3 style="margin-top:16px">Your calendar feed</h3>
      ${feed ? `<p class="muted">Includes saved events and new bouts for fighters you follow. Updates automatically.</p>
        <div class="copy-row"><label class="sr-only" for="myFeed">Personal calendar feed URL</label><input class="control" id="myFeed" readonly value="${esc(webcal(feed))}"><button class="btn small" data-copy="#myFeed">Copy</button></div>
        <p><a class="btn small" href="${esc(webcal(feed))}">Subscribe</a> <a class="btn small" href="${esc(feed.replace('download=0', 'download=1'))}" download>Download .ics</a></p>` : '<p class="muted">Save an event or follow a fighter to get a personal feed.</p>'}
    </div>`;
  let main;
  if (!items.length) {
    main = `<div class="empty"><p><strong>Your slate is empty.</strong></p><p>Tap "☆ Save" on any event. If its time, opponent or status changes, it will be flagged here.</p><a class="btn" href="#schedule">Browse fights</a></div>`;
  } else {
    const summary = changed.length ? `<div class="changes-summary" role="alert"><strong>${changed.length} saved event${changed.length > 1 ? 's have' : ' has'} changed</strong><ul>${changed.map(i => `<li>${esc(i.event?.title ?? i.id)}: ${i.changes.map(c => esc(c.summary)).join('; ')}</li>`).join('')}</ul></div>` : '';
    main = summary + `<div class="events">${items.map(i => i.event ? eventCard(i.event, { changes: i.changes }) : `<div class="empty">A saved event (${esc(i.id)}) is no longer listed by our sources. <button class="btn small" data-save="${esc(i.id)}">Remove</button></div>`).join('')}</div>`;
  }
  $('#slateBody').innerHTML = `<div class="slate-grid"><div>${main}</div>${side}</div>`;
}

// Transparent cutouts blend into the backdrop; square headshots get a round mask.
const isCutout = src => /\.(png|webp)$/i.test(src) && !/(guskov|du-plessis|ankalaev)/.test(src);

// Hero backdrop: photos of fighters who are actually on upcoming cards only,
// so the page never implies someone is fighting when they aren't.
function renderHeroFighters() {
  const seen = new Set();
  const photos = state.events
    .filter(e => isUpcoming(e) && !['CANCELED', 'POSTPONED'].includes(e.status))
    .sort((a, b) => eventSortKey(a) - eventSortKey(b))
    .flatMap(e => e.images ?? [])
    .filter(src => !seen.has(src) && seen.add(src))
    .sort((a, b) => isCutout(b) - isCutout(a))
    .slice(0, 3);
  $('#heroFighters').innerHTML = photos.map(src => `<img src="${esc(src)}" alt="" class="${isCutout(src) ? '' : 'square'}" decoding="async">`).join('');
}

let countdownTimer;
function renderNextUp() {
  const upcoming = state.events.filter(e => isUpcoming(e) && e.status === 'CONFIRMED' && isOfficial(e)).sort((a, b) => eventSortKey(a) - eventSortKey(b));
  const withTime = upcoming.filter(e => e.start && Date.parse(e.start) > Date.now());
  const pick = withTime.find(e => e.images?.length === 2) ?? withTime.find(e => e.fights.some(f => f.titleFight)) ?? withTime[0] ?? upcoming[0];
  clearInterval(countdownTimer);
  if (!pick) { $('#nextUp').innerHTML = '<div class="next-label">Next major card</div><p class="muted">No confirmed events with official start times are on file yet.</p>'; return; }
  const main = pick.fights[0];
  $('#nextUp').innerHTML = `<div class="next-label">${pick.start ? 'Next confirmed card · main card in' : 'Next confirmed card'}</div>
    ${pick.images?.length === 2 ? `<div class="faces" aria-hidden="true">${pick.images.map(src => `<img src="${esc(src)}" alt="" class="${isCutout(src) ? '' : 'square'}">`).join('<div class="vs">VS</div>')}</div>`
      : pick.images?.length === 1 ? `<div class="face-solo" aria-hidden="true"><img src="${esc(pick.images[0])}" alt="" class="${isCutout(pick.images[0]) ? '' : 'square'}"></div>` : ''}
    ${pick.start ? '<div class="countdown" id="countdown" aria-hidden="true"></div>' : ''}
    ${badges(pick)}
    <div class="next-title">${esc(pick.title)}</div>
    ${main && !pick.title.includes(pick.headline) ? `<div class="event-headline">${esc(main.a)} vs ${esc(main.b)}</div>` : ''}
    <div class="meta"><span>${esc(whenText(pick))}</span><span>${esc(pick.venue)}, ${esc(pick.location)}</span>${networkText(pick)}</div>
    <p><button class="btn small" data-open="${esc(pick.id)}">Full card</button></p>`;
  if (!pick.start) return;
  const tick = () => {
    const el = $('#countdown');
    if (!el) return clearInterval(countdownTimer);
    const diff = Math.max(0, Date.parse(pick.start) - Date.now());
    const parts = [[Math.floor(diff / 86400000), 'Days'], [Math.floor(diff / 3600000) % 24, 'Hrs'], [Math.floor(diff / 60000) % 60, 'Min'], [Math.floor(diff / 1000) % 60, 'Sec']];
    el.innerHTML = parts.map(([v, l]) => `<div><strong>${String(v).padStart(2, '0')}</strong><span>${l}</span></div>`).join('');
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderStatus() {
  const m = state.meta;
  const bar = $('#statusBar');
  if (!m) { bar.className = 'status-bar warn'; bar.innerHTML = '<div class="shell"><span class="dot"></span>Could not reach the schedule service. Showing nothing rather than stale data.</div>'; return; }
  const verified = m.dataVerifiedAt ? `cards verified against official sources ${relTime(m.dataVerifiedAt)}` : 'no verification date on file';
  const ingest = m.lastSuccessfulIngestAt ? `updated ${relTime(m.lastSuccessfulIngestAt)}` : 'never updated';
  bar.className = `status-bar ${m.fresh ? '' : 'warn'}`;
  bar.innerHTML = `<div class="shell"><span class="dot" aria-hidden="true"></span><strong>${m.fresh ? 'Schedule current' : 'Schedule may be out of date'}</strong> · ${esc(ingest)} · ${esc(verified)}${m.fresh ? '' : '. Check official sources before relying on times.'}</div>`;
  $('#sourceStatus').innerHTML = `<h3>Data status</h3><ul>
    <li>Last successful update: ${m.lastSuccessfulIngestAt ? esc(new Date(m.lastSuccessfulIngestAt).toLocaleString()) : 'never'}</li>
    <li>Most recent official-source check: ${m.dataVerifiedAt ? esc(dateOnly(m.dataVerifiedAt.slice(0, 10), { dateStyle: 'medium' })) : 'unknown'}</li>
    <li>Upcoming events on file: ${m.upcomingEvents}</li>
    ${m.needsReverify?.length ? `<li>${m.needsReverify.length} event(s) due for re-verification</li>` : ''}
  </ul>`;
}

function renderDeveloping() {
  $('#developing').innerHTML = state.developing.length ? state.developing.map(d => `<article class="dev">
    <span class="badge unofficial">Not confirmed · ${esc(d.status)}</span>
    <h3>${esc(d.title)}</h3>
    <p class="muted">${esc(d.target)}</p>
    <p>${esc(d.summary)}</p>
    <div class="sources">${(d.sources ?? []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>`).join('')}</div>
  </article>`).join('') : '<div class="empty">No developing matchups are being tracked right now.</div>';
}

function renderFeeds() {
  const all = feedUrl({ download: '0' });
  const box = feedUrl({ sport: 'Boxing', download: '0' });
  const mma = feedUrl({ sport: 'MMA', download: '0' });
  const row = (title, url, id) => `<div class="panel"><h3>${title}</h3><div class="copy-row"><label class="sr-only" for="${id}">${title} feed URL</label><input class="control" id="${id}" readonly value="${esc(webcal(url))}"><button class="btn small" data-copy="#${id}">Copy</button></div><p><a class="btn small" href="${esc(webcal(url))}">Subscribe</a></p></div>`;
  $('#feeds').innerHTML = row('All fights', all, 'feedAll') + row('Boxing only', box, 'feedBox') + row('MMA only', mma, 'feedMma') +
    '<div class="panel"><h3>How it works</h3><p class="muted">Apple Calendar: tap Subscribe. Google Calendar: Settings → Add calendar → From URL, paste the link. Canceled events stay in the feed marked as canceled so your calendar updates.</p></div>';
}

function renderFilters() {
  const f = state.filters;
  document.querySelectorAll('[data-sport]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sport === f.sport)));
  $('#q').value = f.q; $('#windowSel').value = f.window; $('#statusSel').value = f.status;
  $('#officialOnly').checked = f.officialOnly; $('#showPast').checked = f.showPast;
  const promos = [...new Set(state.events.filter(e => isUpcoming(e)).map(e => e.promotion))].sort();
  $('#promotion').innerHTML = '<option value="">All promotions</option>' + promos.map(p => `<option ${p === f.promotion ? 'selected' : ''}>${esc(p)}</option>`).join('');
}

function renderAll() { renderSlate(); renderSchedule(); }

// ---------- dialogs ----------
const SEGMENTS = { main: 'Main card', prelim: 'Prelims', early: 'Early prelims' };
let openEventId = null;
// refresh: re-render an already-open dialog (e.g. after Save/Follow) without reopening a closed one.
async function openEvent(id, { pushState = true, refresh = false } = {}) {
  const base = state.events.find(e => e.id === id);
  if (!base) return toast('That event is no longer listed.');
  if (!refresh) openEventId = id;
  let changes = [];
  try { changes = (await fetch(`/api/events/${encodeURIComponent(id)}`).then(r => r.json())).changes ?? []; } catch { /* history is optional */ }
  if (openEventId !== id || (refresh && !$('#eventDialog').open)) return;
  const e = base;
  let lastSeg = null;
  const bouts = e.fights.map((f, i) => {
    const seg = f.segment && f.segment !== lastSeg ? `<div class="segment-title">${esc(SEGMENTS[f.segment] ?? f.segment)}</div>` : '';
    lastSeg = f.segment ?? lastSeg;
    const followBtn = name => {
      const slug = slugify(name);
      if (!slug || slug === 'tba') return '';
      const on = state.fighters.includes(slug);
      return `<button class="btn follow" data-follow="${esc(slug)}" data-name="${esc(name)}" aria-pressed="${on}">${on ? '✓ Following' : '+ Follow'} ${esc(name.split(' ').at(-1))}</button>`;
    };
    const details = [f.weightClass, f.rounds ? `${f.rounds} rounds` : null, f.titleFight ? 'Title fight' : null].filter(Boolean).join(' · ');
    return `${seg}<div class="bout ${f.status === 'CANCELED' ? 'canceled' : ''}">
      <div><div class="names">${i === 0 && f.status !== 'CANCELED' ? '🏆 ' : ''}<button class="linkish" data-fighter="${esc(slugify(f.a))}">${esc(f.a)}</button> vs <button class="linkish" data-fighter="${esc(slugify(f.b))}">${esc(f.b)}</button></div>
      <div class="sub">${esc(details)}${f.status === 'CANCELED' ? ' · <strong>Canceled</strong>' : ''}${f.note ? ` · ${esc(f.note)}` : ''}</div></div>
      <div>${followBtn(f.a)} ${followBtn(f.b)}</div></div>`;
  }).join('');
  const saved = isSaved(e.id);
  const venueTime = venueTimeText(e);
  $('#eventDialogBody').innerHTML = `<div class="dlg-head"><div>${badges(e)}<h2 id="dlgTitle">${esc(e.title)}</h2>
      <div class="meta"><span>🕘 ${esc(whenText(e))}${venueTime ? ` · ${esc(venueTime)}` : ''}</span><span>📍 ${esc([e.venue, e.location].filter(Boolean).join(', '))}</span>${networkText(e)}</div>
      ${e.timeNote ? `<div class="meta"><span>${esc(e.timeNote)}</span></div>` : ''}
      ${e.statusReason ? `<div class="meta"><span>ℹ️ ${esc(e.statusReason)}</span></div>` : ''}</div>
      <button class="btn" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body">
      <div class="hero-actions">
        <button class="btn primary" data-save="${esc(e.id)}" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save to My Slate'}</button>
        <a class="btn" href="/api/calendar.ics?id=${encodeURIComponent(e.id)}" download>Download .ics</a>
        <a class="btn" href="${esc(googleLink(e))}" target="_blank" rel="noopener noreferrer">Google Calendar</a>
        <button class="btn" data-share="${esc(e.id)}">Copy link</button>
      </div>
      ${e.fights.length ? bouts : '<p class="muted">The fight card has not been announced yet.</p>'}
      <div class="provenance">
        <strong>Sources</strong>
        <div class="sources">${e.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}${s.official ? ' (official)' : ''}</a>`).join('')}</div>
        <p>Last verified: ${e.verifiedAt ? esc(dateOnly(e.verifiedAt.slice(0, 10), { dateStyle: 'medium' })) : 'unknown'}${e.updatedAt ? ` · Last changed: ${esc(new Date(e.updatedAt).toLocaleString())}` : ''}</p>
        ${e.conflicts?.length ? `<p>⚠️ Sources disagree: ${e.conflicts.map(c => `${esc(c.source)} reports ${esc(c.value.toLowerCase())}`).join('; ')}. We show the official source until it is resolved.</p>` : ''}
        ${changes.length ? `<strong>Change history</strong><ul class="history">${changes.map(c => `<li><time datetime="${esc(c.createdAt)}">${esc(new Date(c.createdAt).toLocaleDateString())}</time>${esc(c.summary)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
  const dlg = $('#eventDialog');
  if (!dlg.open) dlg.showModal();
  if (pushState) history.replaceState(null, '', `?event=${encodeURIComponent(id)}${location.hash}`);
}

async function openFighter(slug) {
  const events = eventsForFighter(state.events, slug).sort((a, b) => eventSortKey(a) - eventSortKey(b));
  const name = fighterName(slug);
  const on = state.fighters.includes(slug);
  $('#fighterDialogBody').innerHTML = `<div class="dlg-head"><div><div class="eyebrow">Fighter</div><h2 id="fighterTitle">${esc(name)}</h2>
      <p class="muted">Bouts on file at FightSlate. Records and stats are shown only when a licensed data source is connected.</p></div>
      <button class="btn" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body">
      <p><button class="btn ${on ? '' : 'primary'}" data-follow="${esc(slug)}" data-name="${esc(name)}" aria-pressed="${on}">${on ? '✓ Following' : '+ Follow'}</button></p>
      ${events.map(e => {
        const bout = e.fights.find(f => slugify(f.a) === slug || slugify(f.b) === slug);
        const opp = bout ? (slugify(bout.a) === slug ? bout.b : bout.a) : 'TBA';
        return `<div class="bout ${bout?.status === 'CANCELED' ? 'canceled' : ''}"><div><div class="names">vs ${esc(opp)}</div><div class="sub">${esc(e.title)} · ${esc(whenText(e))} · ${STATUS_LABEL[effectiveStatus(e)]}${bout?.weightClass ? ` · ${esc(bout.weightClass)}` : ''}</div></div><div><button class="btn small" data-open="${esc(e.id)}">Card</button></div></div>`;
      }).join('') || '<p class="muted">No bouts on file.</p>'}
    </div>`;
  const dlg = $('#fighterDialog');
  if (!dlg.open) dlg.showModal();
}

// ---------- interactions ----------
let toastTimer;
function toast(message) {
  const t = $('#toast'); t.textContent = message; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
function setFilter(patch) {
  Object.assign(state.filters, patch);
  storage.set(KEYS.filters, { ...state.filters, q: '' });
  renderSchedule();
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-open],[data-save],[data-ack],[data-follow],[data-unfollow],[data-fighter],[data-close],[data-copy],[data-share],[data-sport],[data-clear-filters]');
  if (!el) return;
  const d = el.dataset;
  if ('sport' in d && el.closest('.segmented')) return setFilter({ sport: d.sport }), renderFilters();
  if ('clearFilters' in d) { state.filters = { sport: '', q: '', promotion: '', window: '3650', status: '', officialOnly: false, showPast: false }; renderFilters(); return renderSchedule(); }
  if (d.open) { $('#fighterDialog').open && $('#fighterDialog').close(); return openEvent(d.open); }
  if (d.save) { toggleSave(d.save); if ($('#eventDialog').open) openEvent(d.save, { pushState: false, refresh: true }); return; }
  if (d.ack) return acknowledge(d.ack);
  if (d.follow) {
    toggleFighter(d.follow, d.name);
    if ($('#fighterDialog').open) openFighter(d.follow);
    else if ($('#eventDialog').open && openEventId) openEvent(openEventId, { pushState: false, refresh: true });
    return;
  }
  if (d.unfollow) return toggleFighter(d.unfollow, fighterName(d.unfollow));
  if (d.fighter) return openFighter(d.fighter);
  if ('close' in d) return el.closest('dialog').close();
  if (d.copy) {
    const input = $(d.copy);
    try { await navigator.clipboard.writeText(input.value); toast('Link copied'); } catch { input.select(); toast('Press Ctrl/Cmd+C to copy'); }
    return;
  }
  if (d.share) {
    const url = `${location.origin}/?event=${encodeURIComponent(d.share)}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
  }
});

$('#eventDialog').addEventListener('close', () => { openEventId = null; history.replaceState(null, '', location.pathname + location.hash); });
for (const dlg of document.querySelectorAll('dialog')) dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

let searchTimer;
$('#q').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setFilter({ q: e.target.value }), 120); });
$('#promotion').addEventListener('change', e => setFilter({ promotion: e.target.value }));
$('#windowSel').addEventListener('change', e => setFilter({ window: e.target.value }));
$('#statusSel').addEventListener('change', e => setFilter({ status: e.target.value }));
$('#officialOnly').addEventListener('change', e => setFilter({ officialOnly: e.target.checked }));
$('#showPast').addEventListener('change', e => setFilter({ showPast: e.target.checked }));
$('#filters').addEventListener('submit', e => e.preventDefault());

$('#sub').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.target, f = new FormData(form), msg = $('#msg');
  const email = String(f.get('email') ?? '').trim();
  if (!form.email.checkValidity() || !email) { msg.className = 'form-msg err'; msg.textContent = 'Enter a valid email address.'; form.email.focus(); return; }
  const body = { email, boxing: f.has('boxing'), mma: f.has('mma'), newFightAlerts: f.has('newFightAlerts'), upcomingAlerts: f.has('upcomingAlerts'), reminderHours: Number(f.get('reminderHours')) };
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    msg.className = `form-msg ${r.ok ? 'ok' : 'err'}`;
    msg.textContent = j.message || j.error || 'Something went wrong.';
    if (r.ok) form.reset();
  } catch { msg.className = 'form-msg err'; msg.textContent = 'Network error. Please try again.'; }
  finally { btn.disabled = false; }
});

// ---------- boot ----------
async function load() {
  $('#userTz').textContent = USER_TZ.replaceAll('_', ' ');
  renderFeeds();
  try {
    const [events, developing, meta] = await Promise.all([
      fetch('/api/events?include=past').then(r => r.json()),
      fetch('/api/developing').then(r => r.json()),
      fetch('/api/meta').then(r => r.json())
    ]);
    Object.assign(state, { events, developing, meta });
  } catch { state.meta = null; }
  migrateLegacy();
  renderStatus(); renderFilters(); renderHeroFighters(); renderNextUp(); renderDeveloping(); renderAll();
  const params = new URLSearchParams(location.search);
  if (params.get('event')) openEvent(params.get('event'), { pushState: false });
  if (params.get('confirmed')) { const m = $('#msg'); m.className = 'form-msg ok'; m.textContent = 'You are subscribed. Alerts will arrive by email.'; toast('Subscription confirmed'); }
}
load();
