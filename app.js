'use strict';
/* 看板（GitHub 連動）— 正本は GitHub。この画面は読む・コメントする・マージするだけ。
   トークンはこの端末のブラウザ（localStorage）にだけ保存し、送り先は api.github.com のみ。 */

const API = 'https://api.github.com';
const VERSION = '1.0.0';

/* ---------- 保存 ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ghk.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ghk.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem('ghk.' + k); } catch (e) {} },
  clear() { try { Object.keys(localStorage).filter(k => k.startsWith('ghk.')).forEach(k => localStorage.removeItem(k)); } catch (e) {} }
};
let cfg = Object.assign({ token: '', login: '', repos: [], boards: [] }, LS.get('cfg', {}));
const saveCfg = () => LS.set('cfg', cfg);

/* ---------- 小道具 ---------- */
const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const chip = (text, cls) => h('span', { class: 'chip ' + cls, text });
const enc = s => s.split('/').map(encodeURIComponent).join('/');

const TZ = 'Asia/Tokyo';
function fmtTime(iso) {
  if (!iso) return '';
  const t = new Date(iso), now = Date.now(), s = (now - t) / 1000;
  if (s < 60) return 'たった今';
  if (s < 3600) return Math.floor(s / 60) + '分前';
  if (s < 86400) return Math.floor(s / 3600) + '時間前';
  const d = t.toLocaleString('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return s < 172800 ? '昨日 ' + t.toLocaleString('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : d;
}
const clock = () => new Date().toLocaleString('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function md(src) {
  const html = window.marked ? window.marked.parse(String(src || ''), { gfm: true, breaks: true }) : '';
  const div = h('div', { class: 'md' });
  div.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] }) : '';
  if (!window.DOMPurify) div.textContent = String(src || '');
  div.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return div;
}
function b64utf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

/* ---------- GitHub API ---------- */
class GHError extends Error { constructor(status, msg, raw) { super(msg); this.status = status; this.raw = raw; } }
const rate = { remaining: null };
async function gh(path, opt = {}) {
  if (!cfg.token) throw new GHError(0, 'トークンがまだ入っていません。「設定」で入れてください。');
  let res;
  try {
    res = await fetch(API + path, {
      method: opt.method || 'GET', cache: 'no-store',
      headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28' }, opt.body ? { 'Content-Type': 'application/json' } : {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
  } catch (e) { throw new GHError(-1, '通信できませんでした（電波がないか、GitHub に届いていません）。'); }
  rate.remaining = res.headers.get('x-ratelimit-remaining');
  if (res.status === 204) return null;
  const txt = await res.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!res.ok) throw new GHError(res.status, jaError(res, data), data && data.message);
  return data;
}
function jaError(res, d) {
  const s = res.status, m = (d && d.message) ? '：' + d.message : '';
  if (s === 401) return 'トークンが無効か、期限切れです。「設定」で入れ直してください。';
  if (s === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'GitHub の回数制限に達しました。少し待ってから「更新」を押してください。';
  if (s === 403) return 'このトークンには、この操作の権限がありません' + m;
  if (s === 404) return '見つかりません。トークンにこのリポジトリの権限がない時も、この表示になります。';
  if (s === 405) return 'いまはマージできない状態です' + m;
  if (s === 409) return 'PR が先に更新されています。「更新」してから、もう一度確かめてください。';
  if (s === 422) return '受け付けられませんでした' + m;
  return 'エラー ' + s + m;
}

/* ---------- 状態の判定 ---------- */
async function getChecks(full, sha) {
  const out = { total: 0, failed: 0, pending: 0, names: [] };
  try {
    const r = await gh(`/repos/${enc(full)}/commits/${sha}/check-runs?per_page=100`);
    for (const c of r.check_runs || []) {
      out.total++;
      if (c.status !== 'completed') out.pending++;
      else if (!['success', 'neutral', 'skipped'].includes(c.conclusion)) { out.failed++; out.names.push(c.name); }
    }
  } catch (e) { out.checkErr = e.message; }
  try {
    const s = await gh(`/repos/${enc(full)}/commits/${sha}/status`);
    for (const c of s.statuses || []) {
      out.total++;
      if (c.state === 'pending') out.pending++;
      else if (c.state !== 'success') { out.failed++; out.names.push(c.context); }
    }
  } catch (e) { /* 状態の権限がなければ省く */ }
  out.state = out.total === 0 ? 'none' : out.failed ? 'fail' : out.pending ? 'pending' : 'ok';
  return out;
}
const KIND = {
  fail: { label: 'CI が失敗', cls: 'c-bad', order: 0 },
  conflict: { label: '競合あり', cls: 'c-bad', order: 1 },
  ready: { label: 'マージできます', cls: 'c-ok', order: 2 },
  pending: { label: '確認中', cls: 'c-warn', order: 3 },
  draft: { label: '下書き', cls: 'c-idle', order: 4 }
};
function classify(p, d, checks) {
  if (p.draft) return 'draft';
  if (checks && checks.state === 'fail') return 'fail';
  if (d && (d.mergeable === false || d.mergeable_state === 'dirty')) return 'conflict';
  if (d && d.mergeable === true && (!checks || checks.state === 'ok' || checks.state === 'none')) return 'ready';
  return 'pending';
}
const CI_LABEL = { ok: ['CI 成功', 'c-ok'], fail: ['CI 失敗', 'c-bad'], pending: ['CI 実行中', 'c-warn'], none: ['CI なし', 'c-idle'] };

/* ---------- 画面の枠 ---------- */
const view = $('view');
let current = { route: '', loadedAt: 0 };
function setTop(title, opts = {}) {
  $('title').textContent = title;
  $('back').hidden = !opts.back;
  document.title = title === '看板' ? '看板' : title + '｜看板';
}
function setStamp(text) { $('stamp').textContent = text || ''; }
function banner(kind, text) { return h('div', { class: 'banner ' + kind, role: kind === 'err' ? 'alert' : null, text }); }
function skeleton(n = 3) { return h('div', { class: 'list' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' }))); }
function render(...nodes) { view.replaceChildren(...nodes.flat().filter(Boolean)); }
function setBadge(n) {
  const b = $('badge');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n || '');
  try { if (navigator.setAppBadge) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
}

/* ---------- PR 一覧 ---------- */
async function viewPRs() {
  setTop('PR');
  if (!cfg.token) return goSettings();
  if (!cfg.repos.length) return render(banner('info', '見るリポジトリがまだ選ばれていません。「設定」で選んでください。'), h('a', { class: 'btn', href: '#/settings', style: null, text: '設定を開く' }));
  const cached = LS.get('cache.prs', null);
  if (cached) drawPRs(cached, true); else render(skeleton());
  const items = [], errors = [];
  await Promise.all(cfg.repos.map(async full => {
    try {
      const list = await gh(`/repos/${enc(full)}/pulls?state=open&per_page=50&sort=updated&direction=desc`);
      for (const p of list) items.push({ full, p });
    } catch (e) { errors.push({ full, msg: e.message, status: e.status }); }
  }));
  if (errors.length && errors.every(e => e.status === -1) && cached) { drawPRs(cached, true, '通信できないため、前回の内容を出しています。'); return; }
  await pool(items, 4, async it => {
    const [d, checks] = await Promise.all([
      gh(`/repos/${enc(it.full)}/pulls/${it.p.number}`).catch(() => null),
      getChecks(it.full, it.p.head.sha)
    ]);
    it.kind = classify(it.p, d, checks);
    it.ci = checks.state;
    it.ciFailed = checks.names;
    it.reviewComments = d ? d.review_comments : 0;
    it.comments = d ? d.comments : 0;
  });
  const data = {
    at: new Date().toISOString(), errors,
    prs: items.map(it => ({
      full: it.full, number: it.p.number, title: it.p.title, user: it.p.user && it.p.user.login,
      updated: it.p.updated_at, head: it.p.head.ref, base: it.p.base.ref,
      kind: it.kind, ci: it.ci, ciFailed: it.ciFailed, reviewComments: it.reviewComments, comments: it.comments
    }))
  };
  LS.set('cache.prs', data);
  if (current.route === 'prs') drawPRs(data, false);
}
function drawPRs(data, stale, note) {
  const prs = data.prs.slice().sort((a, b) => (KIND[a.kind].order - KIND[b.kind].order) || (b.updated > a.updated ? 1 : -1));
  const cnt = k => prs.filter(p => p.kind === k).length;
  const need = cnt('ready') + cnt('fail') + cnt('conflict');
  setBadge(need);
  setStamp((stale ? '前回 ' : '') + new Date(data.at).toLocaleString('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }));
  const out = [];
  if (note) out.push(banner('warn', note));
  else if (stale) out.push(banner('info', '前回の内容を出しています。最新を読み込み中です…'));
  for (const e of data.errors || []) out.push(banner('err', `${e.full} を読めませんでした。${e.msg}`));
  out.push(h('div', { class: 'summary' },
    h('div', { class: 'sum' }, h('b', { text: cnt('ready') }), h('span', { text: 'マージ可' })),
    h('div', { class: 'sum' }, h('b', { text: cnt('fail') + cnt('conflict') }), h('span', { text: '要対応' })),
    h('div', { class: 'sum' }, h('b', { text: cnt('pending') }), h('span', { text: '確認中' })),
    h('div', { class: 'sum' }, h('b', { text: prs.length }), h('span', { text: '開いている' }))
  ));
  if (!prs.length) out.push(h('div', { class: 'empty', text: '開いている PR はありません。' }));
  const list = h('div', { class: 'list' });
  for (const p of prs) {
    const k = KIND[p.kind], ci = CI_LABEL[p.ci] || CI_LABEL.none;
    list.append(h('a', { class: 'card', href: `#/pr/${p.full}/${p.number}` },
      h('div', { class: 'chips' }, chip(k.label, k.cls), p.kind !== 'fail' ? chip(ci[0], ci[1]) : null, p.reviewComments ? chip('行への指摘 ' + p.reviewComments, 'c-warn') : null),
      h('div', { class: 't', text: p.title }),
      h('div', { class: 'm' }, h('span', { text: `${p.full.split('/')[1]} #${p.number}` }), h('span', { text: `${p.head} → ${p.base}` }), h('span', { text: fmtTime(p.updated) }))
    ));
  }
  out.push(list);
  render(out);
}

/* ---------- PR の中身 ---------- */
const REVIEW_JA = { APPROVED: '承認', CHANGES_REQUESTED: '修正の依頼', COMMENTED: 'レビュー', DISMISSED: '取り下げ', PENDING: '下書き' };
async function viewPR(owner, repo, num) {
  const full = owner + '/' + repo, base = `/repos/${enc(full)}/pulls/${num}`;
  setTop(`${repo} #${num}`, { back: true });
  setStamp('');
  if (!cfg.token) return goSettings();
  render(skeleton(2));
  let d, files, icom, reviews, rcom, checks;
  try {
    [d, files, icom, reviews, rcom] = await Promise.all([
      gh(base), gh(base + '/files?per_page=100').catch(() => []),
      gh(`/repos/${enc(full)}/issues/${num}/comments?per_page=100`).catch(() => []),
      gh(base + '/reviews?per_page=100').catch(() => []),
      gh(base + '/comments?per_page=100').catch(() => [])
    ]);
    checks = await getChecks(full, d.head.sha);
  } catch (e) { return render(banner('err', e.message)); }
  if (current.route !== 'pr') return;
  setStamp(clock());
  const kind = d.merged ? null : d.state === 'closed' ? null : KIND[classify(d, d, checks)];
  const ci = CI_LABEL[checks.state];
  const add = files.reduce((s, f) => s + f.additions, 0), del = files.reduce((s, f) => s + f.deletions, 0);

  const head = h('section', { class: 'panel' },
    h('div', { class: 'chips' },
      d.merged ? chip('マージ済み', 'c-acc') : d.state === 'closed' ? chip('閉じています', 'c-idle') : chip(kind.label, kind.cls),
      chip(ci[0], ci[1])),
    h('h2', { text: d.title }),
    h('dl', { class: 'kv' },
      h('dt', { text: 'リポジトリ' }), h('dd', { text: full }),
      h('dt', { text: 'ブランチ' }), h('dd', { text: `${d.head.ref} → ${d.base.ref}` }),
      h('dt', { text: '作成' }), h('dd', { text: `${d.user.login}・${fmtTime(d.created_at)}` }),
      h('dt', { text: '変更' }), h('dd', null, `${d.changed_files} ファイル `, h('span', { class: 'add', text: '+' + d.additions }), ' ', h('span', { class: 'del', text: '−' + d.deletions })),
      checks.names.length ? [h('dt', { text: '失敗した CI' }), h('dd', { text: checks.names.join('、') })] : null
    ),
    h('a', { href: d.html_url, target: '_blank', rel: 'noopener noreferrer', class: 'note', text: 'GitHub で開く' })
  );

  const body = h('section', { class: 'panel' }, h('h2', { text: '説明' }), d.body ? md(d.body) : h('p', { class: 'note', text: '説明はありません。' }));

  const fl = h('div', { class: 'files' }, files.slice(0, 50).map(f =>
    h('div', null, h('span', { text: f.filename }), h('span', { class: 'add', text: '+' + f.additions }), h('span', { class: 'del', text: '−' + f.deletions }))));
  const filesSec = h('details', { class: 'panel' }, h('summary', null, h('b', { text: `変更したファイル（${files.length}）` }), ` `, h('span', { class: 'add', text: '+' + add }), ' ', h('span', { class: 'del', text: '−' + del })), fl);

  const tl = [];
  for (const c of icom) tl.push({ at: c.created_at, who: c.user.login, kind: 'comment', label: 'コメント', body: c.body });
  for (const r of reviews) if (r.body || r.state !== 'COMMENTED') tl.push({ at: r.submitted_at, who: r.user.login, kind: 'review', label: REVIEW_JA[r.state] || r.state, body: r.body });
  for (const c of rcom) tl.push({ at: c.created_at, who: c.user.login, kind: 'line', label: `行への指摘（${c.path}${c.line ? ':' + c.line : ''}）`, body: c.body });
  tl.sort((a, b) => (a.at > b.at ? 1 : -1));
  const tlSec = h('section', { class: 'panel' }, h('h2', { text: `やりとり（${tl.length}）` }),
    tl.length ? h('div', { class: 'tl' }, tl.map(e => h('div', { class: 'ev k-' + e.kind },
      h('div', { class: 'who', text: `${e.label}・${e.who}・${fmtTime(e.at)}` }), e.body ? md(e.body) : null))) : h('p', { class: 'note', text: 'まだありません。' }));

  // コメント
  const ta = h('textarea', { id: 'cm', placeholder: '例：承認。マージしてください', 'aria-label': 'コメント' });
  const cst = h('div', { class: 'st', role: 'status' });
  const send = h('button', { class: 'btn', type: 'button', text: 'コメントを送る', onclick: async () => {
    const text = ta.value.trim(); if (!text) { cst.className = 'st bad'; cst.textContent = '文を入れてください。'; return; }
    send.disabled = true; cst.className = 'st'; cst.textContent = '送っています…';
    try {
      await gh(`/repos/${enc(full)}/issues/${num}/comments`, { method: 'POST', body: { body: text } });
      LS.del('draft.' + full + '#' + num);
      cst.className = 'st ok'; cst.textContent = '送りました。GitHub の通知として AI 側にも届きます。';
      setTimeout(() => route(), 900);
    } catch (e) { cst.className = 'st bad'; cst.textContent = e.message; send.disabled = false; }
  } });
  const dk = 'draft.' + full + '#' + num;
  ta.value = LS.get(dk, '');
  ta.addEventListener('input', () => LS.set(dk, ta.value));
  const quick = h('div', { class: 'quick' }, ['承認します', '保留にします', '差し戻します'].map(t =>
    h('button', { class: 'btn sub', type: 'button', text: t, onclick: () => { ta.value = t + (ta.value ? '\n' + ta.value : ''); ta.focus(); LS.set(dk, ta.value); } })));
  const cmSec = h('section', { class: 'panel' }, h('h2', { text: 'コメントする' }), quick, ta, send, cst);

  // マージ
  let mergeSec = null;
  if (d.merged) mergeSec = h('section', { class: 'panel' }, h('h2', { text: 'マージ' }), h('p', { text: `マージ済みです（${fmtTime(d.merged_at)}、${d.merged_by ? d.merged_by.login : ''}）。` }));
  else if (d.state === 'open') {
    const sel = h('select', { 'aria-label': 'マージの方法' },
      h('option', { value: 'merge', text: 'マージコミットを作る（ふつう）' }),
      h('option', { value: 'squash', text: '1つにまとめてマージ（スカッシュ）' }),
      h('option', { value: 'rebase', text: '並べ直してマージ（リベース）' }));
    const mst = h('div', { class: 'st', role: 'status' });
    let armed = 0;
    const mb = h('button', { class: 'btn', type: 'button', text: 'マージする', disabled: d.draft || d.mergeable === false ? true : null });
    mb.addEventListener('click', async () => {
      if (!armed) {
        armed = setTimeout(() => { armed = 0; mb.classList.remove('armed'); mb.textContent = 'マージする'; }, 6000);
        mb.classList.add('armed'); mb.textContent = `もう一度押すと ${d.base.ref} にマージします`;
        return;
      }
      clearTimeout(armed); armed = 0; mb.disabled = true; mb.classList.remove('armed'); mb.textContent = 'マージしています…';
      try {
        await gh(base + '/merge', { method: 'PUT', body: { sha: d.head.sha, merge_method: sel.value } });
        mst.className = 'st ok'; mst.textContent = 'マージしました。'; LS.del('cache.prs');
        setTimeout(() => route(), 900);
      } catch (e) { mst.className = 'st bad'; mst.textContent = e.message; mb.disabled = false; mb.textContent = 'マージする'; }
    });
    const why = d.draft ? '下書きの PR はマージできません。' : d.mergeable === false ? '競合があるため、このままではマージできません。' : d.mergeable == null ? 'GitHub がマージできるかを計算中です。少し待って「更新」を押してください。' : checks.state === 'fail' ? 'CI が失敗しています。中身を確かめてからにしてください。' : '';
    mergeSec = h('section', { class: 'panel' }, h('h2', { text: 'マージ' }), why ? h('p', { class: 'note', text: why }) : null, sel, mb, mst,
      h('p', { class: 'note', text: '押し間違い防止のため、2回押すとマージします。PR が途中で更新されていた場合は止まります。' }));
  }
  render(head, tlSec, cmSec, mergeSec, body, filesSec);
}

/* ---------- 看板 ---------- */
function laneColor(s) {
  s = String(s || '');
  if (/完了|済|done|closed/i.test(s)) return 'var(--ok)';
  if (/停止|中止|保留|stop|hold/i.test(s)) return 'var(--idle)';
  if (/待ち|判断|承認|未確認|blocked|wait/i.test(s)) return 'var(--warn)';
  return 'var(--accent)';
}
function normalizeBoard(j) {
  if (j && Array.isArray(j.columns)) {
    return j.columns.map(c => ({ name: c.name || c.title || '列', items: (c.items || c.cards || []).map(normItem) }));
  }
  const arr = Array.isArray(j) ? j : j && Array.isArray(j.tasks) ? j.tasks : j && Array.isArray(j.items) ? j.items : null;
  if (!arr) return null;
  const lanes = new Map();
  for (const t of arr) {
    const it = normItem(t), key = it.status || '状態なし';
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(it);
  }
  return [...lanes].map(([name, items]) => ({ name, items }));
}
function normItem(t) {
  if (typeof t === 'string') return { title: t };
  const title = t.name || t.title || t.proj || t.task || t.id || '（名前なし）';
  return {
    id: t.id != null ? t.id : t.no, title,
    sub: t.proj && t.task && t.task !== title ? t.task : (t.summary || t.description || ''),
    status: t.status || t.state || '', owner: t.owner || t.assignee || '', pri: t.pri || t.priority || '',
    next: t.next || '', note: t.notes || t.note || t.blocker || ''
  };
}
async function viewBoard() {
  setTop('看板');
  if (!cfg.token) return goSettings();
  if (!cfg.boards.length) return render(banner('info', '看板のファイルがまだ登録されていません。「設定」の「看板のファイル」で、リポジトリと JSON のパスを入れてください。'), h('a', { class: 'btn', href: '#/settings', text: '設定を開く' }));
  render(skeleton(3));
  const secs = [];
  for (const b of cfg.boards) {
    const sec = [h('div', { class: 'sec-h', text: `${b.repo} ／ ${b.path}` })];
    try {
      const [file, commits] = await Promise.all([
        gh(`/repos/${enc(b.repo)}/contents/${enc(b.path)}`),
        gh(`/repos/${enc(b.repo)}/commits?path=${encodeURIComponent(b.path)}&per_page=1`).catch(() => [])
      ]);
      const text = b64utf8(file.content);
      const last = commits[0];
      if (last) sec.push(h('p', { class: 'note', text: `最後の更新：${fmtTime(last.commit.author.date)}・${last.commit.author.name}・「${String(last.commit.message).split('\n')[0]}」` }));
      let json = null; try { json = JSON.parse(text); } catch (e) {}
      const lanes = json ? normalizeBoard(json) : null;
      if (!lanes) { sec.push(banner('warn', 'JSON の形が看板として読めなかったので、そのまま出しています。'), h('pre', { class: 'raw', text: text.slice(0, 20000) })); }
      else {
        const wrap = h('div', { class: 'lanes' });
        for (const ln of lanes) {
          wrap.append(h('div', { class: 'lane', style: `--lc:${laneColor(ln.name)}` },
            h('h3', null, h('span', { text: ln.name }), h('span', { class: 'n', text: ln.items.length })),
            h('div', { class: 'list' }, ln.items.map(it => h('div', { class: 'bcard' },
              (it.pri || it.id != null) ? h('div', { class: 'chips' }, it.pri ? chip(it.pri, 'c-acc') : null, it.id != null ? chip(String(it.id), 'c-idle') : null) : null,
              h('div', { class: 't', text: it.title }),
              it.sub ? h('div', { class: 's', text: it.sub }) : null,
              it.owner ? h('div', { class: 's', text: '担当：' + it.owner }) : null,
              it.note ? h('div', { class: 's', text: it.note }) : null,
              it.next ? h('div', { class: 'nx' }, h('b', { text: '次' }), it.next) : null)))));
        }
        sec.push(wrap);
      }
    } catch (e) { sec.push(banner('err', e.message)); }
    secs.push(...sec);
  }
  if (current.route !== 'board') return;
  setStamp(clock());
  render(secs);
}

/* ---------- 動き ---------- */
function evText(e) {
  const p = e.payload || {}, who = e.actor ? e.actor.login : '';
  switch (e.type) {
    case 'PushEvent': {
      const n = p.size != null ? p.size : (p.commits || []).length;
      const msg = (p.commits && p.commits.length) ? String(p.commits[p.commits.length - 1].message).split('\n')[0] : '';
      const br = String(p.ref || '').replace('refs/heads/', '');
      return { t: n ? `${br} に ${n} 件の変更を送信` : `${br} に変更を送信`, s: msg || (p.head ? '最新 ' + String(p.head).slice(0, 7) : ''), who };
    }
    case 'PullRequestEvent': {
      const pr = p.pull_request || {};
      const PA = { opened: '作成', reopened: '再開', synchronize: '更新', merged: 'マージ', edited: '編集', ready_for_review: 'レビュー待ちに', converted_to_draft: '下書きに', labeled: 'ラベル付け', assigned: '担当付け' };
      const a = p.action === 'closed' ? (pr.merged ? 'マージ' : '閉じた') : (PA[p.action] || p.action);
      return { t: `PR #${pr.number} を${a}`, s: pr.title, who, link: pr.number };
    }
    case 'IssueCommentEvent': return { t: `#${p.issue && p.issue.number} にコメント`, s: String((p.comment && p.comment.body) || '').split('\n')[0].slice(0, 120), who, link: p.issue && p.issue.pull_request ? p.issue.number : null };
    case 'PullRequestReviewEvent': return { t: `PR #${p.pull_request && p.pull_request.number} を${({ APPROVED: '承認', CHANGES_REQUESTED: '修正の依頼つきでレビュー', COMMENTED: 'レビュー' })[String(p.review && p.review.state).toUpperCase()] || 'レビュー'}`, s: String((p.review && p.review.body) || '').split('\n')[0].slice(0, 120), who, link: p.pull_request && p.pull_request.number };
    case 'PullRequestReviewCommentEvent': return { t: `PR #${p.pull_request && p.pull_request.number} の行に指摘`, s: String((p.comment && p.comment.body) || '').split('\n')[0].slice(0, 120), who, link: p.pull_request && p.pull_request.number };
    case 'CreateEvent': return { t: `${p.ref_type === 'branch' ? 'ブランチ' : p.ref_type === 'tag' ? 'タグ' : 'リポジトリ'} ${p.ref || ''} を作成`, s: '', who };
    case 'DeleteEvent': return { t: `${p.ref_type === 'branch' ? 'ブランチ' : 'タグ'} ${p.ref || ''} を削除`, s: '', who };
    case 'IssuesEvent': return { t: `課題 #${p.issue && p.issue.number} を${p.action === 'opened' ? '作成' : p.action === 'closed' ? '閉じた' : p.action}`, s: p.issue && p.issue.title, who };
    default: return { t: e.type.replace('Event', ''), s: '', who };
  }
}
async function viewActivity() {
  setTop('動き');
  if (!cfg.token) return goSettings();
  if (!cfg.repos.length) return render(banner('info', '見るリポジトリを「設定」で選んでください。'));
  render(skeleton(4));
  const all = [], errs = [];
  await Promise.all(cfg.repos.map(async full => {
    try { const ev = await gh(`/repos/${enc(full)}/events?per_page=30`); for (const e of ev) all.push({ full, e }); }
    catch (e) { errs.push(banner('err', `${full}：${e.message}`)); }
  }));
  if (current.route !== 'activity') return;
  all.sort((a, b) => (a.e.created_at < b.e.created_at ? 1 : -1));
  setStamp(clock());
  const list = h('div', { class: 'list' }, all.slice(0, 60).map(({ full, e }) => {
    const x = evText(e);
    const inner = [h('div', { class: 't', text: x.t }), x.s ? h('div', { class: 'm', text: x.s }) : null,
      h('div', { class: 'm' }, h('span', { text: full.split('/')[1] }), h('span', { text: x.who }), h('span', { text: fmtTime(e.created_at) }))];
    return x.link ? h('a', { class: 'card', href: `#/pr/${full}/${x.link}` }, inner) : h('div', { class: 'card' }, inner);
  }));
  render(errs, all.length ? list : h('div', { class: 'empty', text: '最近の動きはありません。' }), h('p', { class: 'note', text: 'GitHub の記録は数分遅れて反映されることがあります。' }));
}

/* ---------- 設定 ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (current.route === 'settings') route(); });
function goSettings() { location.hash = '#/settings'; }
async function viewSettings() {
  setTop('設定'); setStamp('');
  const out = [];
  if (!cfg.token) out.push(banner('info', 'はじめに、GitHub のトークンを入れてください。トークンはこの端末の中だけに保存され、送り先は GitHub（api.github.com）だけです。'));

  // トークン
  const tk = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_ で始まる文字列', 'aria-label': 'トークン' });
  const tst = h('div', { class: 'st', role: 'status' });
  if (cfg.login) { tst.className = 'st ok'; tst.textContent = `接続済み：${cfg.login}`; }
  const save = h('button', { class: 'btn', type: 'button', text: '保存して接続を確かめる', onclick: async () => {
    const v = tk.value.trim(); if (!v && !cfg.token) { tst.className = 'st bad'; tst.textContent = 'トークンを入れてください。'; return; }
    const prev = cfg.token; if (v) cfg.token = v;
    save.disabled = true; tst.className = 'st'; tst.textContent = '確かめています…';
    try { const u = await gh('/user'); cfg.login = u.login; saveCfg(); tk.value = ''; tst.className = 'st ok'; tst.textContent = `接続できました：${u.login}`; setTimeout(route, 600); }
    catch (e) { cfg.token = prev; tst.className = 'st bad'; tst.textContent = e.message; }
    save.disabled = false;
  } });
  out.push(h('section', { class: 'panel' }, h('h2', { text: 'GitHub のトークン' }), tk, save, tst,
    h('p', { class: 'note', text: '作り方：GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。対象のリポジトリだけを選び、Contents・Pull requests・Issues を「Read and write」、Commit statuses を「Read-only」にします。' })));

  // リポジトリ
  if (cfg.token) {
    const box = h('div');
    const rst = h('div', { class: 'st', role: 'status' });
    const drawRepos = repos => {
      box.replaceChildren(...repos.map(r => {
        const cb = h('input', { type: 'checkbox', checked: cfg.repos.includes(r.full) ? true : null });
        cb.addEventListener('change', () => {
          cfg.repos = cb.checked ? [...new Set([...cfg.repos, r.full])] : cfg.repos.filter(x => x !== r.full);
          saveCfg(); LS.del('cache.prs'); rst.className = 'st ok'; rst.textContent = `保存しました（${cfg.repos.length} 件を表示）`;
        });
        return h('label', { class: 'repo' }, cb, h('span', { class: 'rn', text: r.full }), r.private ? chip('非公開', 'c-idle') : null, h('span', { class: 'rs', text: fmtTime(r.pushed) }));
      }));
    };
    const known = LS.get('repolist', null);
    if (known) drawRepos(known); else if (cfg.repos.length) drawRepos(cfg.repos.map(full => ({ full })));
    const load = h('button', { class: 'btn sub', type: 'button', text: 'リポジトリ一覧を読み込む', onclick: async () => {
      load.disabled = true; rst.className = 'st'; rst.textContent = '読み込み中…';
      try {
        let page = 1, all = [];
        while (page <= 5) {
          const r = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
          all = all.concat(r); if (r.length < 100) break; page++;
        }
        const repos = all.map(r => ({ full: r.full_name, private: r.private, pushed: r.pushed_at }));
        LS.set('repolist', repos); drawRepos(repos);
        rst.className = 'st ok'; rst.textContent = `${repos.length} 件。表示したいものに印を付けてください。`;
      } catch (e) { rst.className = 'st bad'; rst.textContent = e.message; }
      load.disabled = false;
    } });
    out.push(h('section', { class: 'panel' }, h('h2', { text: '見るリポジトリ' }), load, rst, box));

    // 看板
    const bl = h('div', { class: 'list' });
    const drawBoards = () => bl.replaceChildren(...cfg.boards.map((b, i) => h('div', { class: 'row' },
      h('span', { text: `${b.repo} ／ ${b.path}` }),
      h('button', { class: 'btn sub', type: 'button', text: '外す', style: null, onclick: () => { cfg.boards.splice(i, 1); saveCfg(); drawBoards(); } }))));
    drawBoards();
    const br = h('input', { type: 'text', placeholder: '例：HIDEYUKIKAII/musubi', 'aria-label': '看板のリポジトリ', autocapitalize: 'off', spellcheck: 'false', list: 'repo-dl' });
    const dl = h('datalist', { id: 'repo-dl' }, (LS.get('repolist', null) || cfg.repos.map(full => ({ full }))).map(r => h('option', { value: r.full })));
    const bp = h('input', { type: 'text', placeholder: '例：projects/near-term-tasks/handoff.json', 'aria-label': '看板の JSON のパス', autocapitalize: 'off', spellcheck: 'false' });
    const bst = h('div', { class: 'st', role: 'status' });
    const addB = h('button', { class: 'btn sub', type: 'button', text: '看板を追加', onclick: () => {
      const repo = br.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''), path = bp.value.trim().replace(/^\//, '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !path) { bst.className = 'st bad'; bst.textContent = '「持ち主/リポジトリ名」と「ファイルのパス」を入れてください。'; return; }
      cfg.boards.push({ repo, path }); saveCfg(); br.value = ''; bp.value = ''; drawBoards(); bst.className = 'st ok'; bst.textContent = '追加しました。';
    } });
    out.push(h('section', { class: 'panel' }, h('h2', { text: '看板のファイル' }),
      h('p', { class: 'note', text: 'リポジトリの中の JSON を、状態ごとの列にして出します（tasks の配列、または columns の形）。書き換えは AI 側が行い、この画面は読むだけです。' }),
      bl, br, dl, bp, addB, bst));
  }

  // アプリとして追加
  if (installEvt) out.push(h('section', { class: 'panel' }, h('h2', { text: 'ホーム画面に追加' }),
    h('button', { class: 'btn', type: 'button', text: 'アプリとして追加する', onclick: async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; route(); } })));

  // 消す
  if (cfg.token) {
    let armed = 0;
    const wipe = h('button', { class: 'btn danger', type: 'button', text: 'この端末からトークンと設定を消す' });
    wipe.addEventListener('click', () => {
      if (!armed) { armed = setTimeout(() => { armed = 0; wipe.textContent = 'この端末からトークンと設定を消す'; }, 5000); wipe.textContent = 'もう一度押すと消します'; return; }
      clearTimeout(armed); LS.clear(); cfg = { token: '', login: '', repos: [], boards: [] }; setBadge(0); route();
    });
    out.push(h('section', { class: 'panel' }, h('h2', { text: 'この端末のデータ' }), wipe,
      h('p', { class: 'note', text: `GitHub 側のトークンは消えません。不要になったら GitHub の設定でも削除してください。残り回数：${rate.remaining == null ? '—' : rate.remaining}／版 ${VERSION}` })));
  }
  render(out);
}

/* ---------- 振り分け ---------- */
async function route() {
  const hash = location.hash || '#/prs';
  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || 'prs';
  current = { route: name, loadedAt: Date.now() };
  document.querySelectorAll('nav.tabs a').forEach(a => a.toggleAttribute('aria-current', false));
  const tab = document.querySelector(`nav.tabs a[data-tab="${name === 'pr' ? 'prs' : name}"]`);
  if (tab) tab.setAttribute('aria-current', 'page');
  window.scrollTo(0, 0);
  try {
    if (name === 'pr' && parts.length >= 4) return await viewPR(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]), parseInt(parts[3], 10));
    if (name === 'board') return await viewBoard();
    if (name === 'activity') return await viewActivity();
    if (name === 'settings') return await viewSettings();
    current.route = 'prs';
    return await viewPRs();
  } catch (e) { render(banner('err', e.message || String(e))); }
}
window.addEventListener('hashchange', route);
$('back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/prs'; });
$('refresh').addEventListener('click', async () => {
  const b = $('refresh'); if (b.getAttribute('aria-busy') === 'true') return;
  b.setAttribute('aria-busy', 'true'); try { await route(); } finally { b.removeAttribute('aria-busy'); }
});
// 画面に戻ってきた時と、開いている間は 2 分ごとに一覧を更新（入力中の画面は触らない）
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - current.loadedAt > 60000 && ['prs', 'activity', 'board'].includes(current.route)) route(); });
setInterval(() => { if (document.visibilityState === 'visible' && ['prs', 'activity'].includes(current.route) && Date.now() - current.loadedAt > 110000) route(); }, 30000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
route();
