/* Euler Instability Archive: the reading app.
   It talks only to the local tool that serves it (tools/archive.py). The files on disk are the
   database; this page reads them through /api/state and changes them through /api/<action>. */
(function () {
'use strict';

var rootEl = document.getElementById('app');
if (!window.preact || !window.preactHooks || !window.htm || !window.marked || !window.DOMPurify || !window.katex) {
  var opening = rootEl && rootEl.querySelector('[data-opening]');
  if (opening) opening.textContent = 'Part of the app is missing from tools/app/vendor. Restore that folder from the repository, then reload.';
  return;
}

const { h, render } = preact;
const { useState, useEffect, useRef, useMemo } = preactHooks;
const html = htm.bind(h);
let TOKEN = (document.querySelector('meta[name="archive-token"]') || {}).content || '';

/* ------------------------------------------------------------------ vocabulary */

const STANDINGS = [
  { id: 'verified', label: 'Verified', desc: 'One of you has checked the proof.' },
  { id: 'claimed', label: 'Claimed', desc: 'A proof is written. Nobody has checked it.' },
  { id: 'heuristic', label: 'Heuristic', desc: 'Rests on a formal or heuristic argument.' },
  { id: 'numerical', label: 'Numerical', desc: 'Supported by computation only.' },
  { id: 'conjecture', label: 'Conjecture', desc: 'Stated without an argument.' },
  { id: 'gap', label: 'Gap', desc: 'The argument has a hole that is not repaired.' },
  { id: 'refuted', label: 'Refuted', desc: 'Shown to be false.' },
];
const ST = {};
STANDINGS.forEach(s => { ST[s.id] = s; });
const KINDS = ['theorem', 'proposition', 'lemma', 'corollary', 'conjecture', 'heuristic', 'observation', 'example'];
const ITALIC = new Set(['theorem', 'proposition', 'lemma', 'corollary', 'conjecture']);
const defaultStanding = k => k === 'conjecture' ? 'conjecture' : k === 'heuristic' ? 'heuristic' : k === 'observation' ? 'numerical' : 'claimed';
const MAX_PDF = 95 * 1048576;

/* ------------------------------------------------------------------ small helpers */

const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
const cx = (...a) => a.filter(Boolean).join(' ');
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : (ws || w + 's'));
const DF = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDate = s => { if (!s) return ''; const d = new Date(s.length === 10 ? s + 'T12:00:00' : s); return isNaN(d) ? s : DF.format(d); };
const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fidHash = id => '#finding-' + String(id).replace('.', '-');
const isPdf = f => !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
const isTex = f => !!f && /\.(tex|ltx|latex)$/i.test(f.name || '');
const terms = q => q.toLowerCase().split(/\s+/).filter(Boolean);
const idOrder = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1]; };

/* ------------------------------------------------------------------ the online, read-only copy */

/* Published as a plain web page, the app has no tool behind it and holds no data. With the
   reader's own GitHub token it fetches STATE.json and the PDFs from the private repository,
   straight from GitHub into this browser. Nothing can be changed from here. The token is kept
   in this browser only and is sent to GitHub and nowhere else. */
const REMOTE = window.ARCHIVE_REMOTE || null;
const ASSETS = REMOTE ? '' : '/app/';
/* The fingerprint of the code this page was loaded with. The data says which fingerprint is current,
   so an open page can tell when it has been updated and still runs old code or styles. */
const APPV = REMOTE ? (REMOTE.app || '') : ((document.querySelector('meta[name="archive-app"]') || {}).content || '');
if (REMOTE && /[?&]v=/.test(location.search)) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {} }
let ghToken = REMOTE ? (lsGet('eia.token') || '') : '';

const undo = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const segs = path => path.split('/').map(s => encodeURIComponent(undo(s))).join('/');
const pathOf = url => undo(url.replace(/^\/files\//, ''));
const fileHref = path => REMOTE
  ? 'https://github.com/' + REMOTE.repo + '/blob/' + encodeURIComponent(REMOTE.branch) + '/' + segs(path)
  : '/files/' + segs(path);
const outHref = url => REMOTE ? fileHref(pathOf(url)) : url;

async function ghFetch(path, etag) {
  const headers = { Authorization: 'Bearer ' + ghToken, Accept: 'application/vnd.github.raw+json' };
  if (etag) headers['If-None-Match'] = etag;
  let res;
  try {
    res = await fetch(REMOTE.api + '/repos/' + REMOTE.repo + '/contents/' + segs(path) + '?ref=' + encodeURIComponent(REMOTE.branch), { headers: headers, cache: 'no-store' });
  } catch (e) {
    throw { code: 'offline' };
  }
  if (res.status === 304) return null;
  if (res.status === 401) throw { code: 'token' };
  if (res.status === 404) throw { code: 'missing' };
  if (res.status === 403 || res.status === 429) throw { code: 'refused' };
  if (!res.ok) throw { code: 'offline' };
  return res;
}

/* A file of the archive, as bytes: from the local tool, or from GitHub in the online copy. */
async function fetchBytes(url) {
  if (REMOTE) return (await ghFetch(pathOf(url))).arrayBuffer();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.arrayBuffer();
}

/* The archive as GitHub last built it, or null if it has not changed since we last asked. */
async function remoteState() {
  const res = await ghFetch('STATE.json', S.rev);
  if (!res) return null;
  const st = await res.json();
  st.rev = res.headers.get('ETag') || String(Date.now());
  st.me = '';
  st.inbox = [];
  st.git = { repo: true, remote: true, upstream: true, ahead: 0, behind: 0, dirty: 0 };
  return st;
}

function signOut(code) {
  lsDel('eia.token');
  ghToken = '';
  S.rev = '';
  S.notes = [];
  S.findings = [];
  S.questions = [];
  S.picture = '';
  S.problems = [];
  reindex();
  S.signinError = typeof code === 'string' ? code : null;
  S.phase = 'signin';
  emit();
}

async function openRemote() {
  if (!ghToken) { S.phase = 'signin'; emit(); return; }
  try {
    const st = await remoteState();
    if (st) apply(st);
  } catch (e) {
    if (e && e.code === 'offline') { S.phase = 'down'; emit(); }
    else signOut(e && e.code);
  }
}

const SIGNIN_ERRORS = {
  token: 'GitHub did not accept that token. It may be mistyped, expired or revoked.',
  missing: 'The token works, but it cannot see the archive. It needs read access to the contents of the repository named above.',
  refused: 'GitHub refused the request. The token may be restricted, or too many requests were made. Try again in a few minutes.',
  offline: 'GitHub could not be reached. Check your connection and try again.',
};

function SignIn() {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault();
    const t = v.trim();
    if (!t) return;
    setBusy(true);
    ghToken = t;
    S.rev = '';
    S.signinError = null;
    try {
      const st = await remoteState();
      lsSet('eia.token', t);
      apply(st);
    } catch (x) {
      ghToken = '';
      S.signinError = (x && x.code) || 'offline';
      emit();
    }
    setBusy(false);
  };
  const own = 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent('Archive viewer')
    + '&description=' + encodeURIComponent('Read-only access for the online reading page') + '&contents=read&expires_in=365';
  const classic = 'https://github.com/settings/tokens/new?scopes=repo&description=' + encodeURIComponent('Archive viewer');
  return html`<div class="wrap pad"><form class="signin panel" onSubmit=${submit}>
    <h2>Sign in to read the archive</h2>
    <p>This page holds none of the archive. It fetches the notes from the private repository <code>${REMOTE.repo}</code> on GitHub, using an access token that shows you are allowed to read it.</p>
    <div>
      <label class="lab" for="gh-token">GitHub access token</label>
      <input id="gh-token" class="in" type="password" autocomplete="off" spellcheck="false" value=${v} onInput=${e => setV(e.target.value)} placeholder="github_pat_… or ghp_…" />
    </div>
    ${S.signinError ? html`<p class="err-line" role="alert">${SIGNIN_ERRORS[S.signinError] || SIGNIN_ERRORS.offline}</p>` : null}
    <div class="hstack"><button class="btn primary" type="submit" disabled=${busy || !v.trim()}>${busy ? 'Opening…' : 'Open the archive'}</button></div>
    <p class="hint">The token is kept in this browser and sent only to GitHub. Signing out removes it. This page can read the archive but never change it.</p>
    <details>
      <summary>How to get a token</summary>
      <p><b>If the repository is yours.</b> <a href=${own} target="_blank" rel="noopener">Create a fine-grained token</a>. Under "Repository access" choose "Only select repositories" and pick the archive. Under "Permissions", "Contents" must say "Read-only". Generate the token and paste it above.</p>
      <p><b>If you were invited to the repository.</b> GitHub's narrow tokens do not reach repositories you were invited to, so <a href=${classic} target="_blank" rel="noopener">create a classic token</a> with the "repo" scope. That token can read every private repository you can, so use it for this page only.</p>
    </details>
  </form></div>`;
}

/* ------------------------------------------------------------------ Markdown with mathematics */

const MACROS = {
  '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}', '\\C': '\\mathbb{C}', '\\T': '\\mathbb{T}',
  '\\eps': '\\varepsilon', '\\curl': '\\operatorname{curl}', '\\supp': '\\operatorname{supp}',
  '\\sgn': '\\operatorname{sgn}', '\\dd': '\\mathrm{d}',
};
const MATH_ENV = /^\\begin\{((?:equation|align|alignat|gather|multline|flalign|eqnarray)\*?)\}/;

/* Markdown would mangle LaTeX (underscores, backslashes), so the mathematics is lifted out first
   and put back, typeset, after the Markdown has been rendered and sanitised. */
function splitMath(src) {
  const out = [], maths = [], n = src.length;
  const push = (tex, display) => { maths.push({ tex: tex, display: display }); out.push('' + (maths.length - 1) + ''); };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const fence = src.slice(i, j), end = src.indexOf(fence, j);
      if (end === -1) { out.push(src.slice(i)); break; }
      out.push(src.slice(i, end + fence.length));
      i = end + fence.length;
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '$') { out.push('\\$'); i += 2; continue; }
      if (nx === '[' || nx === '(') {
        const end = src.indexOf(nx === '[' ? '\\]' : '\\)', i + 2);
        if (end !== -1) { push(src.slice(i + 2, end), nx === '['); i = end + 2; continue; }
      }
      const m = nx === 'b' ? MATH_ENV.exec(src.slice(i, i + 24)) : null;
      if (m) {
        const close = '\\end{' + m[1] + '}', end = src.indexOf(close, i);
        if (end !== -1) { push(src.slice(i, end + close.length), true); i = end + close.length; continue; }
      }
      out.push(c + (nx === undefined ? '' : nx));
      i += 2;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '$') {
        const end = src.indexOf('$$', i + 2);
        if (end !== -1) { push(src.slice(i + 2, end), true); i = end + 2; continue; }
      } else if (i + 1 < n && !/\s/.test(src[i + 1])) {
        let j = i + 1, ok = false;
        for (; j < n; j++) {
          const d = src[j];
          if (d === '\\') { j++; continue; }
          if (d === '\n' && src[j + 1] === '\n') break;
          if (d === '$') { ok = !/\s/.test(src[j - 1]); break; }
        }
        if (ok) { push(src.slice(i + 1, j), false); i = j + 1; continue; }
      }
    }
    out.push(c);
    i++;
  }
  return { text: out.join(''), maths: maths };
}

function texHtml(m) {
  try {
    return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, strict: 'ignore', trust: false, output: 'html', macros: Object.assign({}, MACROS) });
  } catch (e) {
    return '<code>' + escHtml(m.tex) + '</code>';
  }
}

/* `12.3`, `N12` and `Q7` written in backticks become links to that finding, note or question. */
function refNode(label) {
  label = String(label).trim();
  let m, href;
  if ((m = /^(\d+)\.(\d+)$/.exec(label))) href = '#finding-' + m[1] + '-' + m[2];
  else if ((m = /^N(\d+)$/i.exec(label))) { href = '#note-' + m[1]; label = 'N' + m[1]; }
  else if ((m = /^Q(\d+)$/i.exec(label))) { href = '#question-' + m[1]; label = 'Q' + m[1]; }
  else return null;
  const a = document.createElement('a');
  a.className = 'ref';
  a.setAttribute('href', href);
  a.textContent = label;
  return a;
}

const PURIFY = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span', 'div'],
  ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'start', 'align', 'colspan', 'rowspan'],
};
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const richCache = new Map();

function richHtml(src, inline, base) {
  src = String(src == null ? '' : src);
  const key = (inline ? 'i|' : 'b|') + (base || '') + '|' + src;
  const hit = richCache.get(key);
  if (hit !== undefined) return hit;
  const parts = splitMath(src);
  let raw;
  try { raw = inline ? marked.parseInline(parts.text, { gfm: true }) : marked.parse(parts.text, { gfm: true }); }
  catch (e) { raw = escHtml(parts.text); }
  const tpl = document.createElement('template');
  tpl.innerHTML = DOMPurify.sanitize(raw, PURIFY);
  const root = tpl.content;
  root.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    else if (href.charAt(0) === '#') { /* a link inside the app */ }
    else if (base && href && !SCHEME.test(href) && href.charAt(0) !== '/') { a.setAttribute('href', fileHref(base + '/' + href)); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
    else a.removeAttribute('href');
  });
  root.querySelectorAll('img').forEach(img => {
    const s = img.getAttribute('src') || '';
    if (REMOTE && base && s && !SCHEME.test(s) && s.charAt(0) !== '/') {
      /* GitHub serves a private file only to a signed-in request, so link to the figure instead of embedding it */
      const a = document.createElement('a');
      a.setAttribute('href', fileHref(base + '/' + s));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      a.textContent = img.getAttribute('alt') || s;
      img.replaceWith(a);
    }
    else if (base && s && !SCHEME.test(s) && s.charAt(0) !== '/') { img.setAttribute('src', fileHref(base + '/' + s)); img.setAttribute('loading', 'lazy'); }
    else img.remove();
  });
  root.querySelectorAll('code').forEach(c => {
    if (c.closest('pre')) return;
    const a = refNode(c.textContent);
    if (a) c.replaceWith(a);
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  texts.forEach(node => {
    const s = node.nodeValue;
    if (s.indexOf('') === -1) return;
    const frag = document.createDocumentFragment();
    const re = /(\d+)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const holder = document.createElement('span');
      holder.innerHTML = texHtml(parts.maths[+m[1]] || { tex: '', display: false });
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      last = re.lastIndex;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    node.replaceWith(frag);
  });
  const box = document.createElement('div');
  box.appendChild(root);
  const out = box.innerHTML;
  if (richCache.size > 4000) richCache.clear();
  richCache.set(key, out);
  return out;
}

function Rich(props) {
  const src = props.src, inline = !!props.inline, base = props.base || '';
  const out = useMemo(() => richHtml(src, inline, base), [src, inline, base]);
  return h(props.tag || (inline ? 'span' : 'div'), { class: cx('rich', !inline && 'prose', props.class), dangerouslySetInnerHTML: { __html: out } });
}

const hasMath = s => /[$\\]/.test(s || '');
function Preview({ src, base }) {
  if (!hasMath(src)) return null;
  return html`<div class="preview"><div class="preview-k">Preview</div><${Rich} src=${src} base=${base} /></div>`;
}

/* ------------------------------------------------------------------ state */

function parseRoute() {
  const hsh = (location.hash || '').replace(/^#/, '');
  let m;
  if ((m = /^note-(\d+)$/.exec(hsh))) return { view: 'note', num: +m[1] };
  if ((m = /^finding-(\d+)-(\d+)$/.exec(hsh))) return { view: 'note', num: +m[1], focus: m[1] + '.' + m[2] };
  if ((m = /^question-(\d+)$/.exec(hsh))) return { view: 'questions', focus: +m[1] };
  if (['notes', 'findings', 'questions', 'picture', 'agents', 'add'].indexOf(hsh) !== -1) return { view: hsh };
  return { view: 'notes' };
}

const S = {
  phase: 'opening', rev: '', me: '', by: lsGet('eia.by') || '',
  notes: [], findings: [], questions: [], picture: '', problems: [], inbox: [], git: { repo: false },
  ix: { byId: new Map(), byNote: new Map(), usedBy: new Map(), noteByNum: new Map(), topics: new Map(), models: [], risk: new Map() },
  ui: { qNotes: '', topic: '', qFind: '', standing: 'all', identOpen: false, panel: null, notice: null, keyOpen: lsGet('eia.key') === '1' },
  route: parseRoute(), toast: null, pendingFiles: null, pendingTick: 0, syncing: false, dragging: false, signinError: null, appNew: '',
  seenMax: parseInt(lsGet('eia.seen') || '', 10),
};

/* The whole view is redrawn from S whenever something changes. App registers its updater while it
   renders, so it is in place before the first data arrives; Preact batches the updates itself, and
   nothing here waits on animation frames, which a background tab does not deliver. */
let redraw = null;
function emit() {
  if (redraw) redraw(x => x + 1);
}
function useTick() {
  redraw = useState(0)[1];
}

let toastTimer = 0;
function toast(msg, kind) {
  S.toast = { msg: msg, kind: kind || 'ok' };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; emit(); }, kind === 'err' ? 8000 : 3600);
  emit();
}

function reindex() {
  const byId = new Map(), byNote = new Map(), usedBy = new Map(), noteByNum = new Map(), topics = new Map(), models = new Set();
  S.notes.sort((a, b) => b.num - a.num);
  S.notes.forEach(n => {
    noteByNum.set(n.num, n);
    n.topics.forEach(t => topics.set(t, (topics.get(t) || 0) + 1));
    if (n.written_by) models.add(n.written_by);
  });
  S.findings.forEach(f => {
    byId.set(f.id, f);
    if (!byNote.has(f.note)) byNote.set(f.note, []);
    byNote.get(f.note).push(f);
  });
  byNote.forEach(a => a.sort((x, y) => x.idx - y.idx));
  S.findings.forEach(f => f.rests_on.forEach(d => { if (!usedBy.has(d)) usedBy.set(d, []); usedBy.get(d).push(f.id); }));
  const memo = new Map();
  const culprit = (id, stack) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return null;
    stack.add(id);
    let res = null;
    const f = byId.get(id);
    for (const d of (f ? f.rests_on : [])) {
      const g = byId.get(d);
      if (!g) continue;
      if (g.standing === 'gap' || g.standing === 'refuted') { res = d; break; }
      const c = culprit(d, stack);
      if (c) { res = c; break; }
    }
    stack.delete(id);
    memo.set(id, res);
    return res;
  };
  const risk = new Map();
  S.findings.forEach(f => { if (f.rests_on.length) { const c = culprit(f.id, new Set()); if (c) risk.set(f.id, c); } });
  S.notes.forEach(n => {
    n._hay = [n.title, n.summary, n.written_by, n.filed_by, n.topics.join(' '), 'note ' + n.num].concat((byNote.get(n.num) || []).map(f => f.name + ' ' + f.statement)).join('\n').toLowerCase();
  });
  S.findings.forEach(f => {
    const n = noteByNum.get(f.note);
    f._hay = [f.id, f.kind, f.name, f.statement, f.remarks.map(r => r.text).join(' '), n ? n.title : ''].join('\n').toLowerCase();
  });
  S.findings.sort((a, b) => b.note - a.note || a.idx - b.idx);
  S.questions.sort((a, b) => b.num - a.num);
  S.ix = { byId: byId, byNote: byNote, usedBy: usedBy, noteByNum: noteByNum, topics: topics, models: Array.from(models).sort(), risk: risk };
}

function apply(st) {
  S.rev = st.rev;
  S.me = st.me || '';
  if (!S.by) S.by = S.me;
  S.notes = st.notes || [];
  S.findings = st.findings || [];
  S.questions = st.questions || [];
  S.picture = st.picture || '';
  S.problems = st.problems || [];
  S.inbox = st.inbox || [];
  S.git = st.git || { repo: false };
  S.viewer = st.viewer || '';
  S.appNew = (st.app && APPV && st.app !== APPV && st.app !== lsGet('eia.appv')) ? st.app : '';
  S.phase = 'live';
  reindex();
  emit();
}

/* Every change carries a token the tool issued with the page. When the tool is restarted the token
   changes; the page then picks up the new one and tries once more, so nothing typed is lost. */
async function post(url, type, payload) {
  const go = () => fetch(url, { method: 'POST', headers: { 'Content-Type': type, 'X-Archive-Token': TOKEN }, body: payload });
  let res = await go();
  if (res.status === 403) {
    const m = /name="archive-token" content="([^"]+)"/.exec(await (await fetch('/', { cache: 'no-store' })).text());
    if (m && m[1] !== TOKEN) { TOKEN = m[1]; res = await go(); }
  }
  return res;
}

async function call(path, body) {
  if (REMOTE) throw new Error('This online copy is read-only. To change the archive, use the app on your computer or an agent.');
  let res, data = null;
  try {
    res = body === undefined ? await fetch('/api/' + path, { cache: 'no-store' }) : await post('/api/' + path, 'application/json', JSON.stringify(body));
    data = await res.json();
  } catch (e) {
    throw new Error('The archive tool is not answering. Check that ./archive open is still running.');
  }
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || 'That did not go through.');
  if (data.state) apply(data.state);
  return data;
}

async function act(path, body, okMsg) {
  try {
    const d = await call(path, body);
    if (okMsg) toast(okMsg);
    return d;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

async function uploadFile(file) {
  let res, data = null;
  try {
    res = await post('/api/upload?name=' + encodeURIComponent(file.name), 'application/octet-stream', file);
    data = await res.json();
  } catch (e) {
    throw new Error('The archive tool is not answering. Check that ./archive open is still running.');
  }
  if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'The file could not be saved.');
  return data.upload;
}

async function poll() {
  if (document.hidden) return;
  if (REMOTE) {
    if (S.phase !== 'live' && S.phase !== 'down') return;
    try {
      const st = await remoteState();
      if (S.phase === 'down') { S.phase = 'live'; emit(); }
      if (st) apply(st);
    } catch (e) {
      if (e && e.code !== 'offline') signOut(e.code);
      else if (S.phase === 'live') { S.phase = 'down'; emit(); }
    }
    return;
  }
  try {
    const r = await fetch('/api/rev', { cache: 'no-store' });
    const d = await r.json();
    if (S.phase === 'down') { S.phase = 'live'; emit(); }
    if (d.app && APPV && d.app !== APPV && d.app !== lsGet('eia.appv') && d.app !== S.appNew) { S.appNew = d.app; emit(); }
    if (d.rev !== S.rev) apply(await call('state'));
  } catch (e) {
    if (S.phase === 'live') { S.phase = 'down'; emit(); }
  }
}

function needBy() {
  if (S.by) return true;
  S.ui.identOpen = true;
  emit();
  window.scrollTo(0, 0);
  toast('First say how your entries should be signed.');
  return false;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || 'Copied.');
  } catch (e) {
    toast('Copying is blocked here. Select the text and copy it by hand.', 'err');
  }
}

async function doSync() {
  if (S.syncing) return;
  S.syncing = true;
  S.ui.notice = null;
  emit();
  try {
    const d = await call('sync', {});
    toast((d.log || []).join(' ') || 'In sync.');
  } catch (e) {
    S.ui.notice = { title: 'The archive could not be synced', text: e.message };
    apply(await call('state').catch(() => ({ rev: S.rev, me: S.me, notes: S.notes, findings: S.findings, questions: S.questions, picture: S.picture, problems: S.problems, inbox: S.inbox, git: S.git })));
  }
  S.syncing = false;
  emit();
}

/* ------------------------------------------------------------------ small parts */

const MARKS = {
  verified: () => html`<path d="M2.5 6.4l2.3 2.4 4.7-5.3" />`,
  claimed: () => html`<circle cx="6" cy="6" r="3.7" />`,
  heuristic: () => html`<path d="M1.8 4.7c1.4-1.5 2.8-1.5 4.2 0s2.8 1.5 4.2 0M1.8 8c1.4-1.5 2.8-1.5 4.2 0s2.8 1.5 4.2 0" />`,
  numerical: () => html`<path d="M2.8 9.8V6.4M6 9.8V2.4M9.2 9.8V4.6" />`,
  conjecture: () => html`<path d="M6 1.7l4.3 4.3L6 10.3 1.7 6z" />`,
  gap: () => html`<path d="M6 2l4.5 8h-9z" />`,
  refuted: () => html`<path d="M3 3l6 6M9 3l-6 6" />`,
};
function Mark({ st }) {
  return html`<svg class="mark" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(MARKS[st] || MARKS.claimed)()}</svg>`;
}

/* A key to the standing marks. With `names`, the marks in use and their names sit on the closed line,
   for pages that show marks without a name. Opened, it gives the meaning of all seven. */
function StandingKey({ names }) {
  const counts = {};
  S.findings.forEach(f => { counts[f.standing] = (counts[f.standing] || 0) + 1; });
  const toggle = e => {
    const open = e.currentTarget.open;
    if (open === S.ui.keyOpen) return;
    S.ui.keyOpen = open;
    if (open) lsSet('eia.key', '1'); else lsDel('eia.key');
    emit();
  };
  return html`<details class="key" open=${S.ui.keyOpen} onToggle=${toggle}>
    <summary>
      <span class="key-h">Key</span>
      ${names ? STANDINGS.filter(s => counts[s.id]).map(s => html`<span key=${s.id} class="tl" data-st=${s.id}><${Mark} st=${s.id} />${s.label}</span>`) : null}
      <span class="key-more">${names ? 'What they mean' : 'What the standings mean'}<svg class="caret" viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3" /></svg></span>
    </summary>
    <div class="key-body">
      <p>A standing says how far a finding can be trusted.${names ? ' Beside each note, a mark with a number counts its findings with that standing.' : ''}</p>
      <ul class="key-list">${STANDINGS.map(s => html`<li key=${s.id} data-st=${s.id} class=${counts[s.id] ? '' : 'zero'}>
        <${Mark} st=${s.id} /><b>${s.label}</b><span>${s.desc}</span><i>${counts[s.id] ? counts[s.id] : 'none yet'}</i>
      </li>`)}</ul>
      ${S.ix.risk.size ? html`<p><b>At risk</b> marks a finding that rests on one marked gap or refuted.</p>` : null}
    </div>
  </details>`;
}

function Refs({ ids }) {
  return ids.map((id, i) => {
    const f = S.ix.byId.get(id);
    const title = f ? cap(f.kind) + (f.name ? ': ' + f.name : '') + ' (' + ((ST[f.standing] || {}).label || f.standing || 'no standing') + ')' : 'Not in the archive';
    return html`${i ? ', ' : ''}<a class="ref" data-st=${f ? f.standing : null} href=${fidHash(id)} title=${title}>${id}</a>`;
  });
}

function Popover({ onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el.getBoundingClientRect().right > window.innerWidth - 8) { el.style.left = 'auto'; el.style.right = '0'; }
    const onDoc = e => { if (!el.parentElement.contains(e.target)) onClose(); };
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  return html`<div class="pop" ref=${ref}>${children}</div>`;
}

function StandingChip({ f }) {
  const [open, setOpen] = useState(false);
  const st = ST[f.standing] || { id: f.standing || 'claimed', label: f.standing ? cap(f.standing) : 'No standing' };
  const choose = async s => {
    setOpen(false);
    if (s.id === f.standing || !needBy()) return;
    await act('standing', { id: f.id, standing: s.id, by: S.by }, f.id + ' is now ' + s.label.toLowerCase() + '.');
  };
  return html`<span class="pop-anchor">
    <button class="chip" data-st=${st.id} aria-haspopup="menu" aria-expanded=${open} title="Change the standing" onClick=${() => setOpen(!open)}>
      <${Mark} st=${st.id} />${st.label}
      <svg class="caret" viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3" /></svg>
    </button>
    ${open ? html`<${Popover} onClose=${() => setOpen(false)}>
      <div role="menu">${STANDINGS.map(s => html`<button key=${s.id} class="menu-item" role="menuitemradio" aria-checked=${s.id === f.standing ? 'true' : 'false'} data-st=${s.id} onClick=${() => choose(s)}>
        <${Mark} st=${s.id} /><span><b>${s.label}</b><small>${s.desc}</small></span>
      </button>`)}</div>
    <//>` : null}
  </span>`;
}

function CodeBox({ label, text }) {
  return html`<div class="codebox">
    <div class="codebox-head"><span>${label}</span><button class="btn quiet sm" onClick=${() => copyText(text)}>Copy</button></div>
    <pre>${text}</pre>
  </div>`;
}

function TopicInput({ id, value, onChange }) {
  const [t, setT] = useState('');
  const add = raw => {
    let v = raw.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    setT('');
    if (!v) return;
    const known = Array.from(S.ix.topics.keys()).find(k => k.toLowerCase() === v.toLowerCase());
    if (known) v = known;
    if (!value.some(x => x.toLowerCase() === v.toLowerCase())) onChange(value.concat([v]));
  };
  return html`<div class="topics-in">
    ${value.map(x => html`<span class="topic" key=${x}>${x}<button type="button" aria-label=${'Remove ' + x} onClick=${() => onChange(value.filter(y => y !== x))}>×</button></span>`)}
    <input id=${id} class="bare" list="topic-list" value=${t} placeholder=${value.length ? 'Add another' : 'e.g. shear flows'}
      onInput=${e => { const v = e.target.value; if (/[,;]$/.test(v)) add(v); else setT(v); }}
      onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); add(t); } else if (e.key === 'Backspace' && !t && value.length) onChange(value.slice(0, -1)); }}
      onBlur=${() => { if (t.trim()) add(t); }} />
  </div>`;
}

/* ------------------------------------------------------------------ masthead and rail */

/* Stuart's cat's-eye vortices: psi = log(a cosh y + sqrt(a^2 - 1) cos x), a steady solution of the
   two-dimensional Euler equations. At a = 1 it is the tanh shear layer; as a grows the layer rolls
   up into a row of vortices. The masthead draws that passage once. */
function drawFlow(svg, W, H, a) {
  const b = Math.sqrt(Math.max(a * a - 1, 0));
  const Y = 2.15, sy = (H / 2) / Y, sx = sy * 1.7, per = 2 * Math.PI * sx;
  const x0 = W - 0.58 * per - Math.PI * sx, mid = H / 2;
  const levels = [];
  for (let s = 0.2; s < Y + 0.5; s += 0.22) levels.push(Math.cosh(s));
  if (b > 1e-6) [0.3, 0.62, 0.86].forEach(q => levels.push((a - b) + q * (1 - (a - b))));
  const kmin = Math.floor(-x0 / per) - 1, kmax = Math.ceil((W - x0) / per) + 1;
  let d = '';
  levels.forEach(L => {
    const kappa = b > 1e-6 ? (L - a) / b : 2;
    if (kappa >= 1) {
      let up = '', dn = '';
      for (let x = -4; x <= W + 4; x += 4) {
        const y = Math.acosh(Math.max((L - b * Math.cos((x - x0) / sx)) / a, 1)) * sy;
        up += (up ? 'L' : 'M') + x.toFixed(1) + ' ' + (mid - y).toFixed(1);
        dn += (dn ? 'L' : 'M') + x.toFixed(1) + ' ' + (mid + y).toFixed(1);
      }
      d += up + dn;
    } else if (kappa > -1) {
      const t1 = Math.acos(kappa), n = 28;
      for (let k = kmin; k <= kmax; k++) {
        let up = '', dn = '';
        for (let i = 0; i <= n; i++) {
          const th = t1 + (2 * Math.PI - 2 * t1) * i / n, x = x0 + (th + 2 * Math.PI * k) * sx;
          const y = Math.acosh(Math.max((L - b * Math.cos(th)) / a, 1)) * sy;
          up += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + (mid - y).toFixed(1);
          dn = 'L' + x.toFixed(1) + ' ' + (mid + y).toFixed(1) + dn;
        }
        d += up + dn + 'Z';
      }
    }
  });
  svg.setAttribute('viewBox', '0 0 ' + W.toFixed(0) + ' ' + H.toFixed(0));
  svg.innerHTML = '<path d="' + d + '"/>';
}

function Streamlines() {
  const ref = useRef(null);
  useEffect(() => {
    const svg = ref.current, END = 1.22;
    let a = 1, W = 0, H = 0, raf = 0, settle = 0;
    const size = () => { const r = svg.getBoundingClientRect(); W = r.width; H = r.height; if (W > 0 && H > 0) drawFlow(svg, W, H, a); };
    const ro = new ResizeObserver(size);
    ro.observe(svg);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { a = END; size(); }
    else {
      size();
      const t0 = performance.now() + 250, D = 2600;
      const step = t => {
        const u = Math.min(1, Math.max(0, (t - t0) / D));
        a = 1 + (END - 1) * (1 - Math.pow(1 - u, 3));
        if (W > 0 && H > 0) drawFlow(svg, W, H, a);
        if (u < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      /* If no frames arrive (a tab opened in the background), settle on the final state anyway. */
      settle = setTimeout(() => { if (a < END) { cancelAnimationFrame(raf); a = END; size(); } }, 3400);
    }
    return () => { ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(settle); };
  }, []);
  return html`<svg class="flow" ref=${ref} preserveAspectRatio="none" aria-hidden="true"></svg>`;
}

function tallyLine() {
  if (!S.notes.length && !S.questions.length) return 'Nothing filed yet';
  const v = S.findings.filter(f => f.standing === 'verified').length;
  const oq = S.questions.filter(q => q.status === 'open').length;
  return [plural(S.notes.length, 'note'), plural(S.findings.length, 'finding') + (S.findings.length ? ', ' + v + ' verified' : ''), oq + ' open ' + (oq === 1 ? 'question' : 'questions')].join(' · ');
}

function Identity() {
  const [v, setV] = useState('');
  const inp = useRef(null);
  const open = S.ui.identOpen;
  useEffect(() => { if (open && inp.current) { inp.current.focus(); inp.current.select(); } }, [open]);
  if (S.phase === 'opening' || REMOTE) return null;
  const save = e => {
    e.preventDefault();
    const s = v.replace(/:/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    S.by = s;
    if (s) lsSet('eia.by', s); else lsDel('eia.by');
    S.ui.identOpen = false;
    emit();
  };
  if (open) return html`<form class="ident" onSubmit=${save}>
    <label class="lab" for="by-in">Sign your entries as</label>
    <div class="hstack"><input id="by-in" ref=${inp} class="in" value=${v} onInput=${e => setV(e.target.value)} placeholder="Your first name" maxlength="40" /><button class="btn primary sm" type="submit">Save</button></div>
  </form>`;
  return html`<button class="ident-btn" onClick=${() => { setV(S.by); S.ui.identOpen = true; emit(); }}>
    ${S.by ? html`Signing as <b>${S.by}</b>` : html`<b>Set your name</b> to sign what you add`}
  </button>`;
}

function Masthead() {
  return html`<header class="mast">
    <${Streamlines} />
    <div class="wrap">
      <div>
        <h1>Euler Instability Archive</h1>
        <p class="tally">${(S.phase === 'opening' || S.phase === 'signin') ? 'Notes, findings and open questions on instability in the Euler equations' : tallyLine()}</p>
      </div>
      <${Identity} />
    </div>
  </header>`;
}

function SyncControl() {
  const g = S.git;
  if (S.phase === 'opening') return null;
  if (!g.repo || !g.remote) return html`<a class="btn quiet sm" href="#agents" title="This archive is not on GitHub yet">Not shared yet</a>`;
  if (!g.upstream) return html`<button class="btn sm" disabled=${S.syncing} onClick=${doSync} title="Nothing has been sent to the GitHub repository yet">${S.syncing ? 'Sending…' : 'Send to GitHub'}</button>`;
  const out = g.ahead + (g.dirty ? 1 : 0), inn = g.behind;
  const label = S.syncing ? 'Syncing…' : (!out && !inn) ? 'In sync' : 'Sync';
  const detail = [inn ? inn + ' to take in' : '', g.ahead ? g.ahead + ' to send' : '', g.dirty ? plural(g.dirty, 'unsaved file') : ''].filter(Boolean).join(', ');
  return html`<button class=${cx('btn sm', !out && !inn && 'quiet')} disabled=${S.syncing} onClick=${doSync}
    aria-label=${label + (detail ? ': ' + detail : '')}
    title=${detail ? 'Save, take in your collaborator’s changes, and send yours' : 'Nothing to send or take in. Click to check GitHub now.'}>${label}${detail && !S.syncing ? html`<span class="wide"> · ${detail}</span>` : null}</button>`;
}

function Rail() {
  const cur = (S.route.view === 'note' || S.route.view === 'add') ? 'notes' : S.route.view;
  const oq = S.questions.filter(q => q.status === 'open').length;
  const tabs = [['notes', 'Notes', S.notes.length], ['findings', 'Findings', S.findings.length], ['questions', 'Questions', oq], ['picture', 'The picture', 0], ['agents', 'Agents', 0]];
  const bad = S.problems.filter(p => p.level !== 'todo');
  return html`<nav class="rail" aria-label="Sections"><div class="wrap">
    <div class="tabs">${tabs.map(t => html`<a key=${t[0]} class="tab" href=${'#' + t[0]} aria-current=${cur === t[0] ? 'page' : null}>${t[1]}${t[2] ? html`<span class="n">${t[2]}</span>` : null}</a>`)}</div>
    <div class="rail-end">
      ${bad.length ? html`<button class="btn sm warn" aria-expanded=${S.ui.panel === 'problems'} onClick=${() => { S.ui.panel = S.ui.panel === 'problems' ? null : 'problems'; emit(); }}>${plural(bad.length, 'problem')}</button>` : null}
      ${REMOTE ? (S.phase === 'signin' ? null : html`<span class="ro">Read-only</span><button class="btn quiet sm" onClick=${signOut}>Sign out</button>`) : html`<${SyncControl} />
      <a class="btn primary sm" href="#add"><span class="wide">Add a PDF</span><span class="narrow">Add</span></a>`}
    </div>
  </div></nav>`;
}

function reloadApp() {
  lsSet('eia.appv', S.appNew);
  // Online, a plain reload can be answered from a stored copy of the page. A new address cannot.
  if (REMOTE) location.replace(location.pathname + '?v=' + encodeURIComponent(S.appNew) + location.hash);
  else location.reload();
}

function Banners() {
  const out = [];
  if (S.appNew) out.push(html`<div class="banner" key="appnew"><h4>This page has been updated</h4>
    Reload it to get the new version. Until you do, parts of it can look wrong.
    <div class="hstack"><button class="btn sm primary" onClick=${reloadApp}>Reload</button><button class="btn sm" onClick=${() => { lsSet('eia.appv', S.appNew); S.appNew = ''; emit(); }}>Not now</button></div></div>`);
  if (S.phase === 'down') out.push(REMOTE
    ? html`<div class="banner err" key="down"><h4>GitHub is not answering</h4>What you see may be out of date. This page keeps trying and catches up by itself.</div>`
    : html`<div class="banner err" key="down"><h4>The archive tool has stopped</h4>What you see may be out of date, and changes cannot be saved. Run <code>./archive open</code> again in the archive folder; this page reconnects by itself.</div>`);
  if (S.ui.notice) out.push(html`<div class="banner err" key="notice"><h4>${S.ui.notice.title}</h4><pre>${S.ui.notice.text}</pre><div class="hstack"><button class="btn sm" onClick=${() => { S.ui.notice = null; emit(); }}>Dismiss</button></div></div>`);
  if (S.ui.panel === 'problems') {
    const bad = S.problems.filter(p => p.level !== 'todo');
    out.push(html`<div class="banner" key="problems"><h4>${bad.length ? 'These files do not follow the format' : 'Everything is in order'}</h4>
      ${bad.length ? html`The archive still works, but fix these before sending: an agent can do it from the list.
      <ul>${bad.map((p, i) => html`<li key=${i}><code>${p.where}</code> ${p.msg}${p.level === 'error' ? '' : ' (warning)'}</li>`)}</ul>` : null}
      <div class="hstack"><button class="btn sm" onClick=${() => { S.ui.panel = null; emit(); }}>Close</button></div></div>`);
  }
  return out.length ? html`<div class="wrap">${out}</div>` : null;
}

/* ------------------------------------------------------------------ notes */

const isNew = n => !isNaN(S.seenMax) && n.num > S.seenMax && n.filed_by !== S.by;

function NoteRow({ n }) {
  const fs = S.ix.byNote.get(n.num) || [];
  const tally = {};
  fs.forEach(f => { tally[f.standing] = (tally[f.standing] || 0) + 1; });
  return html`<article class="row">
    <div class="num">${n.num}</div>
    <div>
      <h3><a href=${'#note-' + n.num}><${Rich} src=${n.title || 'Untitled'} inline=${true} /></a>${isNew(n) ? html`<span class="new">new</span>` : null}</h3>
      ${n.summary ? html`<${Rich} src=${n.summary} inline=${true} tag="div" class="sum" />` : null}
      <div class="meta">
        <span>${fmtDate(n.date)}</span>
        ${n.filed_by ? html`<span>filed by ${n.filed_by}</span>` : null}
        ${n.written_by ? html`<span>written by ${n.written_by}</span>` : null}
        ${n.pdf && n.source ? null : html`<span>${n.pdf ? 'no LaTeX source' : n.source ? 'LaTeX source only, no PDF' : 'no PDF or source'}</span>`}
        ${!fs.length ? html`<span class="todo-tag">findings not recorded yet</span>` : null}
        ${n.topics.map(t => html`<button key=${t} class="topic" onClick=${() => { S.ui.topic = t; emit(); }}>${t}</button>`)}
      </div>
    </div>
    <div class="row-tally">${STANDINGS.filter(s => tally[s.id]).map(s => html`<span key=${s.id} class="tl" data-st=${s.id} title=${s.label}><${Mark} st=${s.id} />${tally[s.id]}</span>`)}</div>
  </article>`;
}

function NotesView() {
  const ui = S.ui;
  if (!S.notes.length) {
    return html`<div class="wrap pad"><div class="empty">
      <h2>Nothing filed yet</h2>
      <p>Drop a PDF anywhere on this page to file the first note, or ask an agent working in this folder to file one. Each note keeps its PDF, the claims it makes, and whether one of you has checked them.</p>
      <div class="hstack"><a class="btn primary" href="#add">Add a PDF</a><a class="btn" href="#agents">Connect an agent</a></div>
    </div></div>`;
  }
  const ts = terms(ui.qNotes);
  const list = S.notes.filter(n => (!ui.topic || n.topics.indexOf(ui.topic) !== -1) && ts.every(t => n._hay.indexOf(t) !== -1));
  const topics = Array.from(S.ix.topics.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return html`<div class="wrap pad">
    <div class="filters">
      <input id="q-notes" class="in search" type="search" placeholder="Search titles, summaries and statements" aria-label="Search notes" value=${ui.qNotes} onInput=${e => { ui.qNotes = e.target.value; emit(); }} />
      ${topics.length ? html`<select id="topic-filter" class="in sel" aria-label="Filter by topic" value=${ui.topic} onChange=${e => { ui.topic = e.target.value; emit(); }}>
        <option value="">All topics</option>
        ${topics.map(t => html`<option key=${t[0]} value=${t[0]}>${t[0]} (${t[1]})</option>`)}
      </select>` : null}
    </div>
    ${S.findings.length ? html`<${StandingKey} names=${true} />` : null}
    ${list.length ? html`<div class="rows">${list.map(n => html`<${NoteRow} key=${n.num} n=${n} />`)}</div>`
      : html`<p class="quiet-line">No note matches. <button class="lnk" onClick=${() => { ui.qNotes = ''; ui.topic = ''; emit(); }}>Clear the filters</button></p>`}
  </div>`;
}

/* ------------------------------------------------------------------ PDF reader */

function pdfLib() {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdf.js is missing');
  lib.GlobalWorkerOptions.workerSrc = ASSETS + 'vendor/pdfjs/pdf.worker.min.js';
  return lib;
}

async function readPdfInfo(file) {
  const doc = await pdfLib().getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  let title = '';
  try { const md = await doc.getMetadata(); title = String((md && md.info && md.info.Title) || '').trim(); } catch (e) {}
  if (title.length < 4 || /^untitled|\.(tex|dvi|pdf)$/i.test(title)) {
    title = '';
    try {
      const tc = await (await doc.getPage(1)).getTextContent();
      const big = tc.items.filter(it => it.str && it.str.trim());
      if (big.length) {
        const top = Math.max.apply(null, big.slice(0, 40).map(it => it.height || 0));
        title = big.slice(0, 40).filter(it => (it.height || 0) >= top * 0.95).map(it => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    } catch (e) {}
  }
  const pages = doc.numPages;
  doc.destroy();
  return { pages: pages, title: title };
}

function PdfReader({ url, name, jump, onHide }) {
  const scroller = useRef(null), pagesEl = useRef(null);
  const [st, setSt] = useState({ phase: 'loading', n: 0 });
  const [zoom, setZoom] = useState(1);
  const [cur, setCur] = useState(1);
  const R = useRef({ doc: null, holders: [], rendered: new Map(), token: 0, cur: 1, raf: 0, width: 0 }).current;

  const renderPage = async i => {
    const hd = R.holders[i - 1];
    if (!hd || !R.doc || R.rendered.has(i)) return;
    const token = R.token;
    R.rendered.set(i, 'busy');
    try {
      const page = await R.doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      hd.style.aspectRatio = String(base.width / base.height);
      const cssW = hd.clientWidth || 600, dpr = Math.min(window.devicePixelRatio || 1, 2), scale = cssW / base.width;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
      if (token !== R.token || !R.doc) return;
      hd.textContent = '';
      hd.appendChild(canvas);
      R.rendered.set(i, 'done');
      try {
        const layer = document.createElement('div');
        layer.className = 'textLayer';
        layer.style.setProperty('--scale-factor', String(scale));
        hd.appendChild(layer);
        const task = window.pdfjsLib.renderTextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport: page.getViewport({ scale: scale }) });
        if (task && task.promise) await task.promise;
      } catch (e) {}
    } catch (e) {
      if (token === R.token) R.rendered.delete(i);
    }
  };

  const evict = () => {
    const done = Array.from(R.rendered.entries()).filter(e => e[1] === 'done').map(e => e[0]);
    if (done.length <= 10) return;
    done.sort((a, b) => Math.abs(b - R.cur) - Math.abs(a - R.cur));
    done.slice(0, done.length - 10).forEach(i => { R.holders[i - 1].textContent = ''; R.rendered.delete(i); });
  };

  const refresh = () => {
    const sc = scroller.current;
    if (!sc) return;
    R.token++;
    R.rendered.clear();
    const top = sc.scrollTop - 700, bot = sc.scrollTop + sc.clientHeight + 700;
    R.holders.forEach((hd, k) => {
      if (hd.offsetTop + hd.offsetHeight >= top && hd.offsetTop <= bot) renderPage(k + 1);
      else hd.textContent = '';
    });
  };

  useEffect(() => {
    let dead = false;
    setSt({ phase: 'loading', n: 0 });
    (async () => {
      try {
        const doc = await pdfLib().getDocument({ data: await fetchBytes(url), isEvalSupported: false }).promise;
        if (dead) { doc.destroy(); return; }
        const v = (await doc.getPage(1)).getViewport({ scale: 1 });
        R.ratio = v.width / v.height;
        R.doc = doc;
        setSt({ phase: 'ready', n: doc.numPages });
      } catch (e) {
        if (!dead) setSt({ phase: 'error', n: 0 });
      }
    })();
    return () => { dead = true; R.token++; if (R.doc) { R.doc.destroy(); R.doc = null; } R.rendered.clear(); R.holders = []; };
  }, [url]);

  useEffect(() => {
    if (st.phase !== 'ready') return undefined;
    const host = pagesEl.current, sc = scroller.current;
    host.textContent = '';
    R.holders = [];
    R.rendered.clear();
    for (let i = 1; i <= st.n; i++) {
      const hd = document.createElement('div');
      hd.className = 'pg';
      hd.dataset.p = String(i);
      hd.style.aspectRatio = String(R.ratio || 0.77);
      host.appendChild(hd);
      R.holders.push(hd);
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) renderPage(+en.target.dataset.p); });
      evict();
    }, { root: sc, rootMargin: '700px 0px' });
    R.holders.forEach(hd => io.observe(hd));
    const onScroll = () => {
      if (R.raf) return;
      R.raf = setTimeout(() => {
        R.raf = 0;
        const midline = sc.scrollTop + sc.clientHeight * 0.35;
        let p = 1;
        for (let k = 0; k < R.holders.length; k++) { if (R.holders[k].offsetTop <= midline) p = k + 1; else break; }
        if (p !== R.cur) { R.cur = p; setCur(p); }
      }, 80);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    R.width = sc.clientWidth;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(sc.clientWidth - R.width) < 24) return;
      R.width = sc.clientWidth;
      clearTimeout(timer);
      timer = setTimeout(refresh, 220);
    });
    ro.observe(sc);
    return () => { io.disconnect(); ro.disconnect(); clearTimeout(timer); sc.removeEventListener('scroll', onScroll); };
  }, [st.phase, st.n, url]);

  useEffect(() => {
    if (st.phase !== 'ready') return;
    pagesEl.current.style.width = (zoom * 100) + '%';
    refresh();
  }, [zoom]);

  useEffect(() => {
    if (!jump || st.phase !== 'ready') return;
    const hd = R.holders[Math.min(Math.max(jump.p, 1), st.n) - 1];
    if (hd) {
      scroller.current.scrollTop = hd.offsetTop - 8;
      const box = scroller.current.getBoundingClientRect();
      if (box.top < 0 || box.top > window.innerHeight * 0.6) scroller.current.parentElement.scrollIntoView({ block: 'start' });
    }
  }, [jump, st.phase]);

  return html`<section class="reader" aria-label=${'PDF: ' + (name || '')}>
    <div class="reader-bar">
      <span class="pgno">${st.phase === 'ready' ? 'p. ' + cur + ' / ' + st.n : st.phase === 'loading' ? 'Opening the PDF…' : ''}</span>
      <span class="grow"></span>
      <button class="btn quiet sm" aria-label="Zoom out" disabled=${zoom <= 0.6 || st.phase !== 'ready'} onClick=${() => setZoom(z => Math.max(0.6, +(z - 0.2).toFixed(2)))}>−</button>
      <button class="btn quiet sm" aria-label="Zoom in" disabled=${zoom >= 2.4 || st.phase !== 'ready'} onClick=${() => setZoom(z => Math.min(2.4, +(z + 0.2).toFixed(2)))}>+</button>
      <a class="btn quiet sm" href=${outHref(url)} target="_blank" rel="noopener">${REMOTE ? 'Open on GitHub' : 'Open in a new tab'}</a>
      <button class="btn quiet sm" onClick=${onHide}>Hide</button>
    </div>
    <div class="reader-scroll" ref=${scroller}>
      ${st.phase === 'error' ? html`<p class="reader-msg">This PDF could not be shown here. <a href=${outHref(url)} target="_blank" rel="noopener">${REMOTE ? 'Open it on GitHub' : 'Open it in a new tab'}</a> instead.</p>` : null}
      <div class="pages" ref=${pagesEl}></div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ findings */

function FindingForm({ f, noteNum, onDone }) {
  const editing = !!f;
  const [d, setD] = useState(() => editing
    ? { kind: f.kind || 'theorem', name: f.name || '', statement: f.statement || '', page: f.page || '', rests: f.rests_on.join(', ') }
    : { kind: 'theorem', name: '', statement: '', standing: 'claimed', page: '', rests: '' });
  const [busy, setBusy] = useState(false);
  const pre = 'ff-' + (editing ? f.id.replace('.', '-') : 'new-' + noteNum) + '-';
  const set = (k, v) => setD(p => {
    const nx = Object.assign({}, p);
    nx[k] = v;
    if (k === 'kind' && !editing && p.standing === defaultStanding(p.kind)) nx.standing = defaultStanding(v);
    return nx;
  });
  const refs = d.rests.split(/[,;\s]+/).filter(x => /^\d+\.\d+$/.test(x));
  const unknown = refs.filter(r => !S.ix.byId.has(r));
  const submit = async e => {
    e.preventDefault();
    if (!d.statement.trim() || !needBy()) return;
    setBusy(true);
    const body = { kind: d.kind, name: d.name, statement: d.statement, page: d.page || null, rests_on: refs };
    const ok = editing
      ? await act('finding/edit', Object.assign({ id: f.id }, body), 'Finding ' + f.id + ' updated.')
      : await act('finding', Object.assign({ note: noteNum, standing: d.standing, by: S.by }, body));
    setBusy(false);
    if (ok) onDone();
  };
  const kinds = KINDS.indexOf(d.kind) === -1 ? KINDS.concat([d.kind]) : KINDS;
  return html`<form class="form panel" onSubmit=${submit}>
    <div class="grid2">
      <div><label class="lab" for=${pre + 'kind'}>Kind</label>
        <select id=${pre + 'kind'} class="in" value=${d.kind} onChange=${e => set('kind', e.target.value)}>${kinds.map(k => html`<option key=${k} value=${k}>${cap(k)}</option>`)}</select></div>
      <div><label class="lab" for=${pre + 'name'}>Name (optional)</label>
        <input id=${pre + 'name'} class="in" value=${d.name} onInput=${e => set('name', e.target.value)} placeholder="e.g. Rayleigh's criterion" /></div>
      ${editing ? null : html`<div><label class="lab" for=${pre + 'st'}>Standing</label>
        <select id=${pre + 'st'} class="in" value=${d.standing} onChange=${e => set('standing', e.target.value)}>${STANDINGS.map(s => html`<option key=${s.id} value=${s.id}>${s.label}</option>`)}</select></div>`}
      <div><label class="lab" for=${pre + 'page'}>Page in the PDF</label>
        <input id=${pre + 'page'} class="in" type="number" min="1" value=${d.page} onInput=${e => set('page', e.target.value)} /></div>
    </div>
    <div><label class="lab" for=${pre + 'stmt'}>Statement</label>
      <textarea id=${pre + 'stmt'} class="in tex" rows="5" value=${d.statement} onInput=${e => set('statement', e.target.value)} placeholder="The full statement with its hypotheses. Markdown, with $…$ and $$…$$ for mathematics." />
      <${Preview} src=${d.statement} /></div>
    <div><label class="lab" for=${pre + 'rests'}>Rests on (optional)</label>
      <input id=${pre + 'rests'} class="in" value=${d.rests} onInput=${e => set('rests', e.target.value)} placeholder="Findings this one uses, e.g. 12.1, 9.2" />
      ${unknown.length ? html`<p class="hint">Not in the archive: ${unknown.join(', ')}</p>` : null}</div>
    <div class="hstack">
      <button class="btn primary" type="submit" disabled=${busy || !d.statement.trim()}>${editing ? 'Save' : 'Add the finding'}</button>
      <button class="btn" type="button" onClick=${onDone}>Cancel</button>
    </div>
  </form>`;
}

function FindingBlock({ f, source, onPage }) {
  const [mode, setMode] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const n = S.ix.noteByNum.get(f.note);
  const culprit = S.ix.risk.get(f.id);
  const usedBy = S.ix.usedBy.get(f.id) || [];
  const dom = 'f-' + f.note + '-' + f.idx;
  if (mode === 'edit') return html`<div class="thm" id=${dom}><${FindingForm} f=${f} onDone=${() => setMode(null)} /></div>`;
  const addRemark = async e => {
    e.preventDefault();
    if (!text.trim() || !needBy()) return;
    setBusy(true);
    const ok = await act('remark', { id: f.id, by: S.by, text: text.trim() });
    setBusy(false);
    if (ok) { setText(''); setMode(null); }
  };
  const del = async () => {
    setBusy(true);
    await act('finding/delete', { id: f.id }, 'Finding ' + f.id + ' removed.');
    setBusy(false);
  };
  return html`<article class="thm" id=${dom}>
    <div class="thm-head">
      <span class="thm-label">${cap(f.kind || 'claim')} ${f.id}</span>
      ${f.name ? html`<span class="thm-name">(<${Rich} src=${f.name} inline=${true} />)</span>` : null}
      <${StandingChip} f=${f} />
    </div>
    <${Rich} src=${f.statement} base=${n ? n.dir : ''} class=${cx('thm-body', ITALIC.has(f.kind) && 'it')} />
    ${culprit ? html`<p class="risk">Rests on <${Refs} ids=${[culprit]} />, which is marked ${(S.ix.byId.get(culprit) || {}).standing}.</p>` : null}
    ${f.remarks.length ? html`<ul class="remarks">${f.remarks.map((r, i) => html`<li class="remark" key=${i}><span class="remark-k">Remark.</span> <${Rich} src=${r.text} inline=${true} /> <span class="remark-by">${[r.who, fmtDate(r.date)].filter(Boolean).join(', ')}</span></li>`)}</ul>` : null}
    ${mode === 'remark' ? html`<form class="inline-form" onSubmit=${addRemark}>
      <label class="lab" for=${dom + '-rem'}>Remark on ${f.id}</label>
      <textarea id=${dom + '-rem'} class="in tex" rows="3" value=${text} onInput=${e => setText(e.target.value)} placeholder="What you checked, where it fails, what it needs. Signed and dated for you." />
      <${Preview} src=${text} />
      <div class="hstack"><button class="btn primary sm" type="submit" disabled=${busy || !text.trim()}>Add the remark</button><button class="btn sm" type="button" onClick=${() => setMode(null)}>Cancel</button></div>
    </form>` : null}
    ${mode === 'del' ? html`<div class="confirm">
      <p>Remove finding ${f.id} and its remarks from the note? ${usedBy.length ? 'Other findings rest on it. ' : ''}The repository's history keeps the old text.</p>
      <div class="hstack"><button class="btn danger solid sm" disabled=${busy} onClick=${del}>Remove it</button><button class="btn sm" onClick=${() => setMode(null)}>Keep it</button></div>
    </div>` : null}
    <div class="thm-foot">
      ${source && n ? html`<a class="src" href=${'#note-' + n.num}>Note ${n.num} · <${Rich} src=${n.title} inline=${true} /></a>` : null}
      ${f.checked_by.length ? html`<span>checked by ${f.checked_by.map(c => c.who).join(' and ')}</span>` : null}
      ${f.page ? (onPage ? html`<button class="lnk" onClick=${() => onPage(f.page)}>p. ${f.page}</button>` : html`<span>p. ${f.page}</span>`) : null}
      ${f.rests_on.length ? html`<span>rests on <${Refs} ids=${f.rests_on} /></span>` : null}
      ${usedBy.length ? html`<span>used by <${Refs} ids=${usedBy} /></span>` : null}
      ${mode ? null : html`<span class="grow"></span>
        <button class="lnk act" onClick=${() => setMode('remark')}>Remark</button>
        <button class="lnk act" onClick=${() => setMode('edit')}>Edit</button>
        <button class="lnk act danger" onClick=${() => setMode('del')}>Remove</button>`}
    </div>
  </article>`;
}

function FindingsView() {
  const ui = S.ui;
  const [limit, setLimit] = useState(40);
  if (!S.findings.length) {
    return html`<div class="wrap pad"><div class="empty">
      <h2>No findings yet</h2>
      <p>Findings are the individual claims a note makes: theorems, conjectures, heuristics, numerical observations. Each carries a standing, so you can always tell what one of you has checked from what has only been claimed.</p>
      <p>They appear here as notes are filed.</p>
    </div></div>`;
  }
  const counts = {};
  S.findings.forEach(f => { counts[f.standing] = (counts[f.standing] || 0) + 1; });
  const ts = terms(ui.qFind);
  const list = S.findings.filter(f => {
    if (ui.standing === 'risk' ? !S.ix.risk.has(f.id) : (ui.standing !== 'all' && f.standing !== ui.standing)) return false;
    if (ui.topic) { const n = S.ix.noteByNum.get(f.note); if (!n || n.topics.indexOf(ui.topic) === -1) return false; }
    return ts.every(t => f._hay.indexOf(t) !== -1);
  });
  const pill = (id, label, n) => html`<button key=${id} class=${cx('pill', ui.standing === id && 'on')} data-st=${ST[id] ? id : null} aria-pressed=${ui.standing === id} onClick=${() => { ui.standing = id; setLimit(40); emit(); }}>
    ${ST[id] ? html`<${Mark} st=${id} />` : null}${label}<span class="n">${n}</span></button>`;
  return html`<div class="wrap pad">
    <div class="filters">
      <input id="q-find" class="in search" type="search" placeholder="Search statements, names and remarks" aria-label="Search findings" value=${ui.qFind} onInput=${e => { ui.qFind = e.target.value; setLimit(40); emit(); }} />
      ${ui.topic ? html`<span class="topic">${ui.topic}<button type="button" aria-label="Clear the topic filter" onClick=${() => { ui.topic = ''; emit(); }}>×</button></span>` : null}
    </div>
    <div class="pills" role="group" aria-label="Filter by standing">
      ${pill('all', 'All', S.findings.length)}
      ${STANDINGS.filter(s => counts[s.id]).map(s => pill(s.id, s.label, counts[s.id]))}
      ${S.ix.risk.size ? pill('risk', 'At risk', S.ix.risk.size) : null}
    </div>
    <${StandingKey} />
    ${list.length ? html`<div class="thms">${list.slice(0, limit).map(f => html`<${FindingBlock} key=${f.id} f=${f} source=${true} />`)}</div>` : html`<p class="quiet-line">No finding matches.</p>`}
    ${list.length > limit ? html`<div class="hstack" style="margin-top:14px"><button class="btn" onClick=${() => setLimit(limit + 60)}>Show ${Math.min(60, list.length - limit)} more</button></div>` : null}
  </div>`;
}

/* ------------------------------------------------------------------ one note */

function NoteForm({ n, onDone }) {
  const [d, setD] = useState({ title: n.title, written_by: n.written_by, topics: n.topics.slice(), summary: n.summary, origin: n.origin });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setD(p => { const nx = Object.assign({}, p); nx[k] = v; return nx; });
  const submit = async e => {
    e.preventDefault();
    if (!d.title.trim()) return;
    setBusy(true);
    const ok = await act('note/edit', Object.assign({ num: n.num }, d), 'Note ' + n.num + ' updated.');
    setBusy(false);
    if (ok) onDone();
  };
  return html`<form class="form panel" onSubmit=${submit}>
    <div><label class="lab" for="ne-title">Title</label><input id="ne-title" class="in" value=${d.title} onInput=${e => set('title', e.target.value)} /></div>
    <div class="grid2">
      <div><label class="lab" for="ne-model">Written by (the model or agent)</label><input id="ne-model" class="in" list="model-list" value=${d.written_by} onInput=${e => set('written_by', e.target.value)} /></div>
      <div><label class="lab" for="ne-topics">Topics</label><${TopicInput} id="ne-topics" value=${d.topics} onChange=${v => set('topics', v)} /></div>
    </div>
    <div><label class="lab" for="ne-sum">Summary of what it proves</label><textarea id="ne-sum" class="in tex" rows="5" value=${d.summary} onInput=${e => set('summary', e.target.value)} placeholder="Under about 120 words: the main results with their key hypotheses, the method, what it leaves open. Agents scan these instead of opening the PDF." /><${Preview} src=${d.summary} base=${n.dir} /></div>
    <div><label class="lab" for="ne-origin">How it was produced (optional)</label><textarea id="ne-origin" class="in" rows="3" value=${d.origin} onInput=${e => set('origin', e.target.value)} placeholder="The prompt, the context it was given, anything needed to reproduce it." /></div>
    <div class="hstack"><button class="btn primary" type="submit" disabled=${busy || !d.title.trim()}>Save</button><button class="btn" type="button" onClick=${onDone}>Cancel</button></div>
  </form>`;
}

function Discussion({ n }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async e => {
    e.preventDefault();
    if (!text.trim() || !needBy()) return;
    setBusy(true);
    const ok = await act('say', { note: n.num, by: S.by, text: text.trim() });
    setBusy(false);
    if (ok) setText('');
  };
  return html`<section class="sec">
    <div class="sec-head"><h3>Discussion</h3>${n.discussion.length ? html`<span class="count">${n.discussion.length}</span>` : null}</div>
    ${n.discussion.map((c, i) => html`<div class="entry" key=${i}><div class="who">${[c.who, fmtDate(c.date)].filter(Boolean).join(' · ')}</div><${Rich} src=${c.text} base=${n.dir} /></div>`)}
    <form class="inline-form" onSubmit=${post}>
      <label class="lab" for="say-text">${n.discussion.length ? 'Add to the discussion' : 'Start the discussion'}</label>
      <textarea id="say-text" class="in" rows="2" value=${text} onInput=${e => setText(e.target.value)} placeholder="Anything about the note as a whole. Remarks on one claim belong on that finding." />
      <${Preview} src=${text} base=${n.dir} />
      <div class="hstack"><button class="btn sm" type="submit" disabled=${busy || !text.trim()}>Post</button></div>
    </form>
  </section>`;
}

function NotePage({ num, focus }) {
  const n = S.ix.noteByNum.get(num);
  const [mode, setMode] = useState(null);
  const [showPdf, setShowPdf] = useState(() => window.innerWidth >= 980);
  const [jump, setJump] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qText, setQText] = useState('');
  const pick = useRef(null), pickTex = useRef(null);
  const nf = S.findings.length;
  useEffect(() => {
    if (!focus) return undefined;
    const el = document.getElementById('f-' + focus.replace('.', '-'));
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 1800);
    return () => clearTimeout(t);
  }, [focus, !!n, nf > 0]);
  if (!n) {
    return html`<div class="wrap pad"><p class="quiet-line">Note ${num} is not in the archive. It may have been removed or renumbered.</p><p><a href="#notes">Back to all notes</a></p></div>`;
  }
  const fs = S.ix.byNote.get(num) || [];
  const qs = S.questions.filter(q => q.raised_in === num);
  const pdfUrl = n.pdf ? '/files/' + n.dir + '/' + encodeURIComponent(n.pdf) : '';
  const split = !!pdfUrl && showPdf;
  const others = n.files.filter(f => f.name !== n.pdf && f.name !== n.source);
  const attach = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!isPdf(f)) { toast('That file is not a PDF.', 'err'); return; }
    if (f.size > MAX_PDF) { toast('That PDF is ' + fmtBytes(f.size) + '. GitHub accepts files up to 95 MB.', 'err'); return; }
    setBusy(true);
    try {
      const up = await uploadFile(f);
      await call('note/pdf', { num: n.num, upload: up });
      toast(n.pdf ? 'The PDF was replaced. The earlier version stays in the repository history.' : 'PDF attached.');
      setShowPdf(true);
    } catch (x) { toast(x.message, 'err'); }
    setBusy(false);
  };
  const attachTex = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!isTex(f)) { toast('That file is not a LaTeX source (.tex).', 'err'); return; }
    if (f.size > MAX_PDF) { toast('That file is ' + fmtBytes(f.size) + '. GitHub accepts files up to 95 MB.', 'err'); return; }
    setBusy(true);
    try {
      const up = await uploadFile(f);
      await call('note/source', { num: n.num, upload: up });
      toast(n.source ? 'The source was replaced. The earlier version stays in the repository history.' : 'LaTeX source attached.');
    } catch (x) { toast(x.message, 'err'); }
    setBusy(false);
  };
  const del = async () => {
    setBusy(true);
    const ok = await act('note/delete', { num: n.num }, 'Note ' + n.num + ' removed.');
    setBusy(false);
    if (ok) location.hash = 'notes';
  };
  const ask = async e => {
    e.preventDefault();
    if (!qText.trim() || !needBy()) return;
    const ok = await act('question', { text: qText.trim(), by: S.by, raised_in: n.num });
    if (ok) setQText('');
  };
  const doc = n.pdf || n.source;
  const prompt = doc ? 'Complete note ' + n.num + ' of the archive. Read ' + n.dir + '/' + doc + ', then in ' + n.dir + '/README.md write the summary and record every finding, as AGENTS.md describes. Add the questions it raises. Run ./archive check, then ./archive sync.' : '';
  return html`<div class=${cx('note', split ? 'split' : 'solo')}>
    ${split ? html`<${PdfReader} key=${pdfUrl} url=${pdfUrl} name=${n.pdf} jump=${jump} onHide=${() => setShowPdf(false)} />` : null}
    <div class="ledger">
      <a class="back" href="#notes">← All notes</a>
      ${mode === 'edit' ? html`<${NoteForm} n=${n} onDone=${() => setMode(null)} />` : html`<header>
        <div class="eyebrow">Note ${n.num}${isNew(n) ? html`<span class="new">new</span>` : null}</div>
        <h2 class="note-title"><${Rich} src=${n.title || 'Untitled'} inline=${true} /></h2>
        <div class="meta">
          <span>${fmtDate(n.date)}</span>
          ${n.filed_by ? html`<span>filed by ${n.filed_by}</span>` : null}
          ${n.written_by ? html`<span>written by ${n.written_by}</span>` : null}
          ${n.topics.map(t => html`<button key=${t} class="topic" onClick=${() => { S.ui.topic = t; location.hash = 'notes'; }}>${t}</button>`)}
        </div>
        ${n.summary ? html`<${Rich} src=${n.summary} base=${n.dir} class="note-sum" />` : null}
        ${n.origin ? html`<details class="origin"><summary>How it was produced</summary><${Rich} src=${n.origin} base=${n.dir} /></details>` : null}
        <div class="actions">
          ${pdfUrl && !showPdf ? html`<button class="btn sm primary" onClick=${() => setShowPdf(true)}>Read the PDF</button>` : null}
          <button class="btn sm" onClick=${() => setMode('edit')}>Edit details</button>
          <button class="btn sm" disabled=${busy} onClick=${() => pick.current.click()}>${n.pdf ? 'Replace the PDF' : 'Attach a PDF'}</button>
          <button class="btn sm" disabled=${busy} onClick=${() => pickTex.current.click()}>${n.source ? 'Replace the source' : 'Attach the LaTeX source'}</button>
          <button class="btn sm quiet danger" onClick=${() => setMode('del')}>Remove the note</button>
          <input ref=${pick} id="attach-pdf" type="file" accept="application/pdf,.pdf" hidden onChange=${attach} />
          <input ref=${pickTex} id="attach-tex" type="file" accept=".tex,.ltx,.latex" hidden onChange=${attachTex} />
        </div>
        ${n.source || others.length ? html`<p class="filelist">${n.source ? html`<span>LaTeX source:</span><a href=${outHref('/files/' + n.dir + '/' + encodeURIComponent(n.source))} target="_blank" rel="noopener">${n.source}</a>` : null}${others.length ? html`<span>Also in the folder:</span>${others.map(f => html`<a key=${f.name} href=${outHref('/files/' + n.dir + '/' + encodeURIComponent(f.name))} target="_blank" rel="noopener">${f.name}</a>`)}` : null}</p>` : null}
        ${mode === 'del' ? html`<div class="confirm">
          <p>Remove note ${n.num} with its ${plural(fs.length, 'finding')}${n.pdf || n.source ? ' and its files' : ''}? It disappears from the archive for both of you at the next sync. The repository's history keeps a copy.</p>
          <div class="hstack"><button class="btn danger solid sm" disabled=${busy} onClick=${del}>Remove the note</button><button class="btn sm" onClick=${() => setMode(null)}>Keep it</button></div>
        </div>` : null}
      </header>`}

      ${(!fs.length || !n.summary) && mode !== 'edit' && prompt ? html`<div class="handoff">
        <p>${!fs.length ? 'No findings are recorded from this note yet. Add them by hand below, or' : 'This note has no summary yet. Write one under Edit details, or'} give this to an agent working in the archive folder:</p>
        <${CodeBox} label="For Claude Code or Codex" text=${prompt} />
      </div>` : null}

      <section class="sec">
        <div class="sec-head"><h3>Findings</h3><span class="count">${fs.length}</span>
          ${mode !== 'addf' ? html`<button class="btn sm" onClick=${() => setMode('addf')}>Add a finding</button>` : null}</div>
        ${fs.length ? html`<div class="thms">${fs.map(f => html`<${FindingBlock} key=${f.id} f=${f} onPage=${pdfUrl ? (p => { setShowPdf(true); setJump({ p: p, t: Date.now() }); }) : null} />`)}</div>` : null}
        ${mode === 'addf' ? html`<div style="margin-top:14px"><${FindingForm} noteNum=${num} onDone=${() => setMode(null)} /></div>` : null}
      </section>

      <section class="sec">
        <div class="sec-head"><h3>Questions it raises</h3>${qs.length ? html`<span class="count">${qs.length}</span>` : null}</div>
        ${qs.length ? html`<div class="qlist">${qs.map(q => html`<${QuestionItem} key=${q.num} q=${q} compact=${true} />`)}</div>` : null}
        <form class="inline-form" onSubmit=${ask}>
          <label class="lab" for="note-q">Ask a question this note raises</label>
          <textarea id="note-q" class="in tex" rows="2" value=${qText} onInput=${e => setQText(e.target.value)} placeholder="One self-contained question." />
          <${Preview} src=${qText} />
          <div class="hstack"><button class="btn sm" type="submit" disabled=${!qText.trim()}>Add the question</button></div>
        </form>
      </section>

      <${Discussion} n=${n} />
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ questions */

function QuestionItem({ q, compact }) {
  const [mode, setMode] = useState(null);
  const [text, setText] = useState('');
  const [ans, setAns] = useState('');
  const [busy, setBusy] = useState(false);
  const resolved = q.status !== 'open';
  const dom = 'q-' + q.num;
  const run = async (path, body, msg) => { setBusy(true); const ok = await act(path, body, msg); setBusy(false); if (ok) setMode(null); };
  const refs = ans.split(/[,;\s]+/).filter(x => /^\d+\.\d+$/.test(x));
  return html`<article class=${cx('q', resolved && 'done')} id=${dom}>
    <div class="q-label">Q${q.num}</div>
    <div>
      ${mode === 'edit' ? html`<form class="inline-form" style="margin-top:0" onSubmit=${e => { e.preventDefault(); if (text.trim()) run('question/edit', { num: q.num, text: text.trim() }); }}>
        <label class="lab" for=${dom + '-edit'}>Question ${q.num}</label>
        <textarea id=${dom + '-edit'} class="in tex" rows="3" value=${text} onInput=${e => setText(e.target.value)} /><${Preview} src=${text} />
        <div class="hstack"><button class="btn primary sm" type="submit" disabled=${busy || !text.trim()}>Save</button><button class="btn sm" type="button" onClick=${() => setMode(null)}>Cancel</button></div>
      </form>` : html`<${Rich} src=${q.text} class="q-text" />`}
      ${resolved && q.resolution ? html`<p class="remark" style="margin-top:8px"><span class="remark-k">Resolution.</span> <${Rich} src=${q.resolution} inline=${true} /></p>` : null}
      ${mode === 'resolve' ? html`<form class="inline-form" onSubmit=${e => { e.preventDefault(); if (needBy()) run('question/resolve', { num: q.num, by: S.by, resolution: text.trim(), answered_by: refs }, 'Q' + q.num + ' resolved.'); }}>
        <label class="lab" for=${dom + '-res'}>How was it settled?</label>
        <textarea id=${dom + '-res'} class="in tex" rows="3" value=${text} onInput=${e => setText(e.target.value)} placeholder="The answer in a sentence or two." /><${Preview} src=${text} />
        <label class="lab" for=${dom + '-ans'}>Answered by (findings, optional)</label>
        <input id=${dom + '-ans'} class="in" value=${ans} onInput=${e => setAns(e.target.value)} placeholder="e.g. 14.2" />
        <div class="hstack"><button class="btn primary sm" type="submit" disabled=${busy || (!text.trim() && !refs.length)}>Mark resolved</button><button class="btn sm" type="button" onClick=${() => setMode(null)}>Cancel</button></div>
      </form>` : null}
      ${mode === 'del' ? html`<div class="confirm"><p>Remove question Q${q.num}? The repository's history keeps the old text.</p>
        <div class="hstack"><button class="btn danger solid sm" disabled=${busy} onClick=${() => run('question/delete', { num: q.num }, 'Q' + q.num + ' removed.')}>Remove it</button><button class="btn sm" onClick=${() => setMode(null)}>Keep it</button></div></div>` : null}
      <div class="thm-foot">
        <span>${[q.asked_by, fmtDate(q.date)].filter(Boolean).join(' · ')}</span>
        ${q.raised_in != null && !compact ? html`<a class="src" href=${'#note-' + q.raised_in}>raised in note ${q.raised_in}</a>` : null}
        ${resolved ? html`<span>resolved</span>` : null}
        ${q.answered_by.length ? html`<span>answered by <${Refs} ids=${q.answered_by} /></span>` : null}
        ${mode ? null : html`<span class="grow"></span>
          ${resolved ? html`<button class="lnk act" onClick=${() => run('question/reopen', { num: q.num }, 'Q' + q.num + ' reopened.')}>Reopen</button>`
            : html`<button class="lnk act" onClick=${() => { setText(''); setAns(''); setMode('resolve'); }}>Resolve</button>`}
          <button class="lnk act" onClick=${() => { setText(q.text); setMode('edit'); }}>Edit</button>
          <button class="lnk act danger" onClick=${() => setMode('del')}>Remove</button>`}
      </div>
    </div>
  </article>`;
}

function QuestionsView({ focus }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const open = S.questions.filter(q => q.status === 'open'), done = S.questions.filter(q => q.status !== 'open');
  const focusDone = focus != null && done.some(q => q.num === focus);
  useEffect(() => {
    if (focus == null) return undefined;
    const el = document.getElementById('q-' + focus);
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 1800);
    return () => clearTimeout(t);
  }, [focus, S.questions.length > 0]);
  const ask = async e => {
    e.preventDefault();
    if (!text.trim() || !needBy()) return;
    setBusy(true);
    const ok = await act('question', { text: text.trim(), by: S.by });
    setBusy(false);
    if (ok) setText('');
  };
  return html`<div class="wrap pad">
    <div class="view-head"><h2>Open questions</h2><p class="lede">What the theory still has to explain. Point an agent at one, or settle it and say which finding does.</p></div>
    <form class="inline-form panel" style="margin-bottom:8px" onSubmit=${ask}>
      <label class="lab" for="q-new">Ask a question</label>
      <textarea id="q-new" class="in tex" rows="2" value=${text} onInput=${e => setText(e.target.value)} placeholder="One self-contained question. Markdown, with $…$ for mathematics." />
      <${Preview} src=${text} />
      <div class="hstack"><button class="btn primary sm" type="submit" disabled=${busy || !text.trim()}>Add the question</button></div>
    </form>
    ${open.length ? html`<div class="qlist">${open.map(q => html`<${QuestionItem} key=${q.num} q=${q} />`)}</div>`
      : html`<p class="quiet-line">${done.length ? 'No question is open.' : 'No questions yet. The first one you ask appears here.'}</p>`}
    ${done.length ? html`<details class="resolved" open=${focusDone}><summary>${plural(done.length, 'resolved question')}</summary>
      <div class="qlist">${done.map(q => html`<${QuestionItem} key=${q.num} q=${q} />`)}</div></details>` : null}
  </div>`;
}

/* ------------------------------------------------------------------ the picture */

function PictureAside() {
  const total = S.findings.length;
  const counts = {};
  S.findings.forEach(f => { counts[f.standing] = (counts[f.standing] || 0) + 1; });
  const topics = Array.from(S.ix.topics.keys()).map(t => {
    const nums = new Set(S.notes.filter(n => n.topics.indexOf(t) !== -1).map(n => n.num));
    const fs = S.findings.filter(f => nums.has(f.note));
    return { t: t, n: fs.length, v: fs.filter(f => f.standing === 'verified').length, q: S.questions.filter(q => q.status === 'open' && nums.has(q.raised_in)).length };
  }).sort((a, b) => b.n - a.n || a.t.localeCompare(b.t));
  const waiting = S.findings.filter(f => f.standing === 'claimed').sort((a, b) => {
    const da = (S.ix.noteByNum.get(a.note) || {}).date || '', db = (S.ix.noteByNum.get(b.note) || {}).date || '';
    return da < db ? -1 : da > db ? 1 : idOrder(a.id, b.id);
  }).slice(0, 6);
  if (!total) return null;
  return html`<aside class="aside">
    <div><h3>Where things stand</h3>
      <div class="bar" role="img" aria-label=${STANDINGS.filter(s => counts[s.id]).map(s => counts[s.id] + ' ' + s.id).join(', ')}>${STANDINGS.filter(s => counts[s.id]).map(s => html`<span key=${s.id} data-st=${s.id} style=${'flex:' + counts[s.id]}></span>`)}</div>
      <ul class="legend">${STANDINGS.map(s => html`<li key=${s.id} data-st=${s.id} class=${counts[s.id] ? '' : 'zero'}><${Mark} st=${s.id} /><span>${s.label}</span><b>${counts[s.id] || 0}</b></li>`)}</ul>
    </div>
    ${topics.length ? html`<div><h3>By topic</h3>
      <table class="ttable"><thead><tr><th>Topic</th><th>Findings</th><th>Verified</th><th>Open Q</th></tr></thead>
      <tbody>${topics.map(r => html`<tr key=${r.t}><td><button class="lnk" onClick=${() => { S.ui.topic = r.t; S.ui.standing = 'all'; location.hash = 'findings'; }}>${r.t}</button></td><td>${r.n}</td><td>${r.v}</td><td>${r.q}</td></tr>`)}</tbody></table>
    </div>` : null}
    ${waiting.length ? html`<div><h3>Waiting for a reader</h3>
      <ul class="waitlist">${waiting.map(f => html`<li key=${f.id}><${Refs} ids=${[f.id]} /> ${cap(f.kind)}${f.name ? html`: <${Rich} src=${f.name} inline=${true} />` : ''}</li>`)}</ul>
    </div>` : null}
  </aside>`;
}

function PictureView() {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState('');
  const body = S.picture.replace(/^\s*#[ \t]+[^\n]*\n?/, '').trim();
  const begin = () => {
    const draft = lsGet('eia.picture');
    setText(draft != null && draft.trim() ? draft : (S.picture.trim() || '# The picture\n\n'));
    setBase(S.picture);
    setPreview(false);
    setEdit(true);
  };
  const save = async () => {
    if (!needBy()) return;
    setBusy(true);
    const ok = await act('picture', { text: text, by: S.by }, 'The picture is saved.');
    setBusy(false);
    if (ok) { lsDel('eia.picture'); setEdit(false); }
  };
  const prompt = 'Revise PICTURE.md so that it reflects the current ledger, as AGENTS.md describes: organise by theme, say for each claim how far it can be trusted, flag what rests on gaps, and end with what to do next. Then run ./archive sync.';
  return html`<div class="wrap pad"><div class="picture">
    <div class="pic-main">
      ${edit ? html`<div class="form">
        <div class="pic-tools">
          <button class="btn primary" disabled=${busy} onClick=${save}>Save</button>
          <button class="btn" onClick=${() => setPreview(!preview)}>${preview ? 'Back to editing' : 'Preview'}</button>
          <button class="btn quiet" onClick=${() => { lsDel('eia.picture'); setEdit(false); }}>Discard changes</button>
        </div>
        ${base !== S.picture ? html`<div class="banner">The picture changed on disk while you were editing (an agent or your collaborator revised it). Saving replaces that version; the repository's history keeps it.</div>` : null}
        ${preview ? html`<${Rich} src=${text} />` : html`<div>
          <label class="lab" for="pic-text">PICTURE.md (Markdown; refer to findings as \`12.3\`, notes as \`N12\`, questions as \`Q7\`)</label>
          <textarea id="pic-text" class="in editor" value=${text} onInput=${e => { setText(e.target.value); lsSet('eia.picture', e.target.value); }} />
        </div>`}
      </div>` : body ? html`<div>
        <div class="pic-tools"><button class="btn sm" onClick=${begin}>Edit</button></div>
        <${Rich} src=${S.picture} />
      </div>` : html`<div class="empty" style="margin-top:0">
        <h2>The picture is not drawn yet</h2>
        <p>This is where the theory is written down as it stands: what is established, what is only claimed, how the pieces fit, and what to do next. It is one Markdown file, PICTURE.md, that you and your agents revise as the ledger grows.</p>
        <div class="hstack" style="margin-bottom:16px"><button class="btn primary" onClick=${begin}>Start writing</button></div>
        <${CodeBox} label="Or ask an agent" text=${prompt} />
      </div>`}
    </div>
    <${PictureAside} />
  </div></div>`;
}

/* ------------------------------------------------------------------ agents */

const PROMPTS = [
  ['Get briefed', 'Read AGENTS.md, then PICTURE.md, INDEX.md and QUESTIONS.md. Tell me in ten lines where the theory stands and what is weakest.'],
  ['See what is already done', 'Scan INDEX.md and tell me whether anything in the archive already addresses this question, and with what standing: QUESTION'],
  ['File a PDF', 'File ~/Downloads/NAME.pdf and its LaTeX source ~/Downloads/NAME.tex in the archive as AGENTS.md describes: create the note with both files, write the summary of what it proves, record every finding with its page and standing, add the questions it raises. Run ./archive check, then ./archive sync.'],
  ['Empty the inbox', 'File everything in inbox/ as AGENTS.md describes, one note per PDF, then run ./archive check and ./archive sync.'],
  ['Check a claim', 'Check the proof of finding 12.3 line by line against its PDF. Record what you find as a remark on the finding. If the argument fails, set its standing to gap and say exactly where. Do not mark it verified: only we do that.'],
  ['Attack a question', 'Read QUESTIONS.md, pick the open question you judge most tractable, and work on it. Write the result up as a PDF with its LaTeX source and file it as a new note.'],
  ['Correct a note', 'In note 12, correct THIS in the LaTeX source, rebuild the PDF, and update the note as "Revising a note" in AGENTS.md describes. Run ./archive check, then ./archive sync.'],
  ['Add missing files', 'Run ./archive check. For every note it lists as lacking a LaTeX source or a PDF, add the file with ./archive attach if you have it, and tell me which notes you could not supply.'],
  ['Redraw the picture', 'Revise PICTURE.md so that it reflects the current ledger, as AGENTS.md describes. Then run ./archive sync.'],
];

function AgentsView() {
  const g = S.git;
  return html`<div class="wrap pad"><div class="agents">
    <div class="view-head" style="margin-bottom:0"><h2>Connect an agent</h2>
      <p class="lede">The archive is a folder of plain files: the PDFs, and Markdown that records what each one claims. Any agent that can open the folder can read it and file into it. The rules live in AGENTS.md at the top of the folder, and INDEX.md gives every note's summary, so an agent can see what has been done without opening a PDF.</p></div>

    <section><h3>${REMOTE ? 'Reading online' : g.repo && g.remote && g.upstream ? 'Shared through GitHub' : 'Not shared yet'}</h3>
      ${REMOTE ? html`<p>You are reading the archive online, straight from its private GitHub repository. This copy cannot change anything. To add a note, set a standing or sync, use the app on your computer (<code>./archive open</code>) or an agent.</p>`
        : g.repo && g.remote && g.upstream
        ? html`<p>This folder is tied to a private GitHub repository${g.branch ? html` (branch <code>${g.branch}</code>)` : ''}. Sync sends your changes there and takes in your collaborator's. Whoever can open that repository, and only they, can read the archive.${S.viewer ? html` It can also be read online, after signing in with a GitHub token, at <a href=${S.viewer} target="_blank" rel="noopener">${S.viewer}</a>.` : ''}</p>`
        : g.repo && g.remote
        ? html`<p>This folder knows its GitHub repository but nothing has been sent there yet, so only this computer has the archive. Once the private repository exists on GitHub, press Send to GitHub at the top of the page.</p>`
        : html`<p>This folder is not attached to a GitHub repository yet, so only this computer has it. Create an empty private repository on GitHub, run <code>git remote add origin</code> with its address in this folder, then sync.</p>`}
    </section>

    <section><h3>Claude</h3>
      <p>Open the archive folder in Claude Code: run <code>claude</code> inside it, or choose the folder in the desktop app. Claude reads CLAUDE.md, which points it at AGENTS.md, and can then read, file, check and sync.</p>
    </section>

    <section><h3>ChatGPT</h3>
      <p>Codex, ChatGPT's coding agent, works the same way. Run <code>codex</code> inside the folder, or connect the repository at chatgpt.com/codex and hand it tasks there. It reads AGENTS.md on its own and can file notes.</p>
      <p>In an ordinary ChatGPT conversation or a deep research run, connect GitHub in ChatGPT's settings and give it access to this repository. That route reads but does not write. Start by asking it to read PICTURE.md, INDEX.md and QUESTIONS.md.</p>
    </section>

    <section><h3>Any other agent</h3>
      <p>Give it the folder, or the repository, and tell it to read AGENTS.md first. Nothing here depends on one vendor: it is files, git, and one Python script.</p>
    </section>

    <section><h3>Things to say</h3>
      <p>Paste one of these into an agent working in the folder, and change the names.</p>
      <div class="prompts">${PROMPTS.map(p => html`<${CodeBox} key=${p[0]} label=${p[0]} text=${p[1]} />`)}</div>
    </section>

    ${S.inbox.length ? html`<section><h3>In the inbox</h3>
      <p>${plural(S.inbox.length, 'file')} waiting to be filed: ${S.inbox.join(', ')}.</p></section>` : null}
  </div></div>`;
}

/* ------------------------------------------------------------------ add a PDF */

/* The title a LaTeX source declares, read from its \title{...}. */
async function texTitle(f) {
  try {
    const t = (await f.text()).slice(0, 40000);
    const m = /\\title\s*(?:\[[^\]]*\])?\s*\{/.exec(t);
    if (!m) return '';
    let depth = 1, out = '';
    for (let i = m.index + m[0].length; i < t.length; i++) {
      const c = t[i];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
      out += c;
    }
    return out.replace(/\\\\/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch (e) {
    return '';
  }
}

function AddNote() {
  const [file, setFile] = useState(null);
  const [tex, setTex] = useState(null);
  const [pages, setPages] = useState(null);
  const [d, setD] = useState({ title: '', written_by: '', topics: [], summary: '', origin: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const [started, setStarted] = useState(false);
  const pickAny = useRef(null), pickPdf = useRef(null), pickTex = useRef(null);
  const set = (k, v) => setD(p => { const nx = Object.assign({}, p); nx[k] = v; return nx; });
  const take = async list => {
    setErr('');
    const all = Array.from(list || []);
    const pdf = all.find(isPdf), src = all.find(isTex);
    if (!pdf && !src) { setErr('Only a PDF and its LaTeX source (.tex) can be added here.'); return; }
    const big = [pdf, src].find(f => f && f.size > MAX_PDF);
    if (big) { setErr(big.name + ' is ' + fmtBytes(big.size) + '. GitHub accepts files up to 95 MB.'); return; }
    setStarted(true);
    let guess = '';
    if (pdf) {
      setFile(pdf);
      setPages(null);
      try { const info = await readPdfInfo(pdf); setPages(info.pages); guess = info.title; } catch (e) {}
    }
    if (src) {
      setTex(src);
      if (!guess) guess = await texTitle(src);
    }
    if (!guess) guess = (pdf || src).name.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ').trim();
    setD(p => p.title.trim() ? p : Object.assign({}, p, { title: guess }));
  };
  const tick = S.pendingTick;
  useEffect(() => { if (S.pendingFiles) { const fs = S.pendingFiles; S.pendingFiles = null; take(fs); } }, [tick]);
  const chosen = e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) take(fs); };
  const submit = async e => {
    e.preventDefault();
    setErr('');
    if (!d.title.trim()) { setErr('Give the note a title.'); return; }
    if (!needBy()) return;
    setBusy(true);
    try {
      const up = file ? await uploadFile(file) : null;
      const src = tex ? await uploadFile(tex) : null;
      const res = await call('note', Object.assign({ by: S.by, upload: up, source_upload: src }, d));
      toast('Filed as note ' + res.num + '.');
      location.hash = 'note-' + res.num;
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  if (!started) {
    return html`<div class="wrap pad"><a class="back" href="#notes">← All notes</a>
      <div class=${cx('drop', over && 'over')}
        onDragOver=${e => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
        onDrop=${e => { e.preventDefault(); e.stopPropagation(); setOver(false); S.dragging = false; emit(); take(e.dataTransfer.files); }}>
        <h2>Add a PDF</h2>
        <p>Drop it here, together with its LaTeX source if you have it. The note gets the next number and its own folder; then you, or an agent, record what it claims.</p>
        <div class="hstack" style="justify-content:center">
          <button class="btn primary" onClick=${() => pickAny.current.click()}>Choose the PDF and its .tex</button>
          <button class="btn" onClick=${() => setStarted(true)}>Write a note without a PDF</button>
        </div>
        <input ref=${pickAny} id="add-files" type="file" multiple accept="application/pdf,.pdf,.tex,.ltx,.latex" hidden onChange=${chosen} />
        ${err ? html`<p class="err-line" role="alert">${err}</p>` : null}
      </div>
    </div>`;
  }
  return html`<div class="wrap pad"><a class="back" href="#notes">← All notes</a>
    <form class="form panel" onSubmit=${submit}>
      ${file ? html`<div class="filestrip"><span class="kind">PDF</span><b>${file.name}</b><span>${fmtBytes(file.size)}${pages ? ' · ' + plural(pages, 'page') : ''}</span><span class="grow"></span>
        <button class="lnk act" type="button" onClick=${() => { setFile(null); setPages(null); }}>Remove</button></div>`
        : html`<div class="filestrip"><span>No PDF attached.</span><span class="grow"></span><button class="lnk" type="button" onClick=${() => pickPdf.current.click()}>Choose one</button></div>`}
      ${tex ? html`<div class="filestrip"><span class="kind">LaTeX source</span><b>${tex.name}</b><span>${fmtBytes(tex.size)}</span><span class="grow"></span>
        <button class="lnk act" type="button" onClick=${() => setTex(null)}>Remove</button></div>`
        : html`<div class="filestrip"><span>No LaTeX source attached. With the .tex, the note can be corrected later.</span><span class="grow"></span><button class="lnk" type="button" onClick=${() => pickTex.current.click()}>Choose one</button></div>`}
      <input ref=${pickPdf} id="add-file" type="file" accept="application/pdf,.pdf" hidden onChange=${chosen} />
      <input ref=${pickTex} id="add-tex" type="file" accept=".tex,.ltx,.latex" hidden onChange=${chosen} />
      <div><label class="lab" for="add-title">Title</label>
        <input id="add-title" class="in" value=${d.title} onInput=${e => set('title', e.target.value)} placeholder="The note's title, as written" /></div>
      <div class="grid2">
        <div><label class="lab" for="add-model">Written by (the model or agent)</label>
          <input id="add-model" class="in" list="model-list" value=${d.written_by} onInput=${e => set('written_by', e.target.value)} placeholder="e.g. the model that produced the PDF" /></div>
        <div><label class="lab" for="add-topics">Topics</label><${TopicInput} id="add-topics" value=${d.topics} onChange=${v => set('topics', v)} /></div>
      </div>
      <div><label class="lab" for="add-sum">Summary of what it proves (optional now; an agent can write it)</label>
        <textarea id="add-sum" class="in tex" rows="4" value=${d.summary} onInput=${e => set('summary', e.target.value)} placeholder="Under about 120 words: the main results with their key hypotheses, the method, what it leaves open. Agents scan these instead of opening the PDF." /><${Preview} src=${d.summary} /></div>
      <div><label class="lab" for="add-origin">How it was produced (optional)</label>
        <textarea id="add-origin" class="in" rows="2" value=${d.origin} onInput=${e => set('origin', e.target.value)} placeholder="The prompt, the context it was given, anything needed to reproduce it." /></div>
      ${err ? html`<p class="err-line" role="alert">${err}</p>` : null}
      <div class="hstack">
        <button class="btn primary" type="submit" disabled=${busy}>${busy ? 'Filing…' : 'File this note'}</button>
        <a class="btn" href="#notes">Cancel</a>
        <span class="hint" style="margin:0">Findings are added on the note's page, by you or an agent.</span>
      </div>
    </form>
  </div>`;
}

/* ------------------------------------------------------------------ app */

function App() {
  useTick();
  const r = S.route;
  let view;
  if (S.phase === 'signin') view = html`<${SignIn} />`;
  else if (S.phase === 'opening' || (REMOTE && !S.rev)) view = html`<div class="wrap pad"><p class="quiet-line">Opening the archive…</p></div>`;
  else if (r.view === 'note') view = html`<${NotePage} key=${'note-' + r.num} num=${r.num} focus=${r.focus} />`;
  else if (r.view === 'findings') view = html`<${FindingsView} />`;
  else if (r.view === 'questions') view = html`<${QuestionsView} focus=${r.focus} />`;
  else if (r.view === 'picture') view = html`<${PictureView} />`;
  else if (r.view === 'agents') view = html`<${AgentsView} />`;
  else if (r.view === 'add' && !REMOTE) view = html`<${AddNote} />`;
  else view = html`<${NotesView} />`;
  return html`
    <${Masthead} />
    <${Rail} />
    <main class="main"><${Banners} />${view}</main>
    <datalist id="topic-list">${Array.from(S.ix.topics.keys()).map(t => html`<option key=${t} value=${t} />`)}</datalist>
    <datalist id="model-list">${S.ix.models.map(t => html`<option key=${t} value=${t} />`)}</datalist>
    ${S.toast ? html`<div class=${cx('toast', S.toast.kind)} role="status">${S.toast.msg}</div>` : null}
    ${S.dragging && r.view !== 'add' ? html`<div class="veil"><div>Drop to file it</div></div>` : null}`;
}

window.addEventListener('hashchange', () => {
  const prev = S.route;
  S.route = parseRoute();
  if (prev.view !== S.route.view || prev.num !== S.route.num) window.scrollTo(0, 0);
  emit();
});

const dragHasFiles = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
let dragDepth = 0;
const onDrag = (type, fn) => { if (!REMOTE) window.addEventListener(type, fn); };
onDrag('dragenter', e => { if (dragHasFiles(e)) { dragDepth++; if (!S.dragging) { S.dragging = true; emit(); } } });
onDrag('dragleave', e => { if (dragHasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth && S.dragging) { S.dragging = false; emit(); } } });
onDrag('dragover', e => { if (dragHasFiles(e)) e.preventDefault(); });
onDrag('drop', e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  S.dragging = false;
  const fs = Array.from(e.dataTransfer.files || []).filter(f => isPdf(f) || isTex(f));
  if (fs.length) {
    S.pendingFiles = fs;
    S.pendingTick++;
    if (S.route.view !== 'add') location.hash = 'add';
  } else {
    toast('Only a PDF and its LaTeX source can be filed by dropping them. Put other files in the note’s folder.', 'err');
  }
  emit();
});

rootEl.textContent = '';
render(html`<${App} />`, rootEl);

/* Remember, a little after opening, how far the notes went, so that the next visit can mark the new ones. */
setTimeout(function seen() {
  if (S.phase !== 'live') { setTimeout(seen, 6000); return; }
  lsSet('eia.seen', String(S.notes.reduce((m, n) => Math.max(m, n.num), 0)));
}, 6000);
if (REMOTE) {
  document.body.classList.add('readonly');
  openRemote();
  setInterval(poll, 60000);
} else {
  call('state').then(apply).catch(() => { S.phase = 'down'; emit(); });
  setInterval(poll, 2500);
}
document.addEventListener('visibilitychange', poll);
})();
