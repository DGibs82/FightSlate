const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenKey = 'fightslate.adminToken';
try { $('#token').value = sessionStorage.getItem(tokenKey) ?? ''; } catch { /* ignore */ }

async function call(path, method = 'GET') {
  const token = $('#token').value.trim();
  try { sessionStorage.setItem(tokenKey, token); } catch { /* ignore */ }
  const r = await fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const when = iso => (iso ? new Date(iso).toLocaleString() : '—');
function render(s) {
  const f = s.freshness;
  $('#out').innerHTML = `
    <div class="grid4">
      <div class="panel stat"><strong class="${f.fresh ? 'ok' : 'bad'}">${f.fresh ? 'Fresh' : 'Stale'}</strong><span class="muted">Data status</span></div>
      <div class="panel stat"><strong>${esc(when(f.lastSuccessfulIngestAt))}</strong><span class="muted">Last successful ingest</span></div>
      <div class="panel stat"><strong>${f.upcomingEvents}</strong><span class="muted">Upcoming events</span></div>
      <div class="panel stat"><strong class="${f.needsReverify.length ? 'warn' : 'ok'}">${f.needsReverify.length}</strong><span class="muted">Need re-verification (&gt;${'7'} days)</span></div>
      <div class="panel stat"><strong>${s.stats.subscribers}</strong><span class="muted">Active subscribers</span></div>
      <div class="panel stat"><strong class="${s.emailMode === 'live' ? 'warn' : 'ok'}">${esc(s.emailMode)}</strong><span class="muted">Email mode</span></div>
    </div>
    <div class="panel"><h3>Needs review</h3>${s.review.length ? `<ul>${s.review.map(r => `<li><strong>${esc(r.title)}</strong> (${esc(r.id)}) ${r.missingFromSource ? '· missing from source' : ''} ${r.conflicts?.length ? `· conflicts: ${esc(JSON.stringify(r.conflicts))}` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing flagged.</p>'}
      ${f.needsReverify.length ? `<p class="warn">Re-verify against official pages: ${f.needsReverify.map(esc).join(', ')}</p>` : ''}</div>
    <div class="panel scroll" style="margin-top:12px"><h3>Ingestion runs</h3><table><thead><tr><th>Started</th><th>Source</th><th>Status</th><th>Accepted</th><th>Rejected</th><th>ms</th><th>Detail</th></tr></thead><tbody>
      ${s.runs.map(r => `<tr><td>${esc(when(r.startedAt))}</td><td>${esc(r.source)}</td><td class="${r.status === 'SUCCESS' ? 'ok' : 'bad'}">${esc(r.status)}</td><td>${r.accepted}</td><td>${r.rejected}</td><td>${r.durationMs}</td><td>${esc(r.error ?? '')}${r.usedCacheFrom ? ` (served cache from ${esc(when(r.usedCacheFrom))})` : ''}${(r.warnings ?? []).length ? `<details><summary>${r.warnings.length} warnings</summary>${r.warnings.map(esc).join('<br>')}</details>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="panel scroll" style="margin-top:12px"><h3>Recent changes</h3><table><thead><tr><th>When</th><th>Event</th><th>Type</th><th>Summary</th></tr></thead><tbody>
      ${s.changes.map(c => `<tr><td>${esc(when(c.createdAt))}</td><td>${esc(c.eventId)}</td><td>${esc(c.type)}</td><td>${esc(c.summary)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No changes recorded.</td></tr>'}
    </tbody></table></div>`;
}

async function load() {
  try { render(await call('/internal/status')); } catch (e) { $('#out').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}
$('#auth').addEventListener('submit', e => { e.preventDefault(); load(); });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  b.disabled = true;
  try { const res = await call(b.dataset.run, 'POST'); await load(); $('#out').insertAdjacentHTML('afterbegin', `<div class="panel"><h3>Result</h3><pre>${esc(JSON.stringify(res, null, 2))}</pre></div>`); }
  catch (err) { $('#out').insertAdjacentHTML('afterbegin', `<p class="bad">${esc(err.message)}</p>`); }
  finally { b.disabled = false; }
});
