const $ = id => document.getElementById(id);

let settings;
let curTab = null;
let curInfo = null;
let curTitle = '';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  settings = await getSettings();
  initTabs();
  initSettings();
  initExclude();
  initLogs();
  await initCurrent();
}

async function update(patch) {
  Object.assign(settings, patch);
  await saveSettings(patch);
}

/* ---------- 标签页切换 ---------- */
function initTabs() {
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    });
  });
}

/* ---------- 设置 ---------- */
function fillSelect(el, values, current) {
  el.textContent = '';
  values.forEach(v => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  });
  el.value = current;
}

function initSettings() {
  $('enabled').checked = settings.enabled;
  $('backupOnOpen').checked = settings.backupOnOpen;
  $('periodic').checked = settings.periodic;
  $('intervalMin').value = settings.intervalMin;
  $('folder').value = settings.folder;
  fillSelect($('docFormat'), DOC_FORMATS, settings.docFormat);
  fillSelect($('sheetFormat'), SHEET_FORMATS, settings.sheetFormat);

  $('enabled').onchange = e => update({ enabled: e.target.checked });
  $('backupOnOpen').onchange = e => update({ backupOnOpen: e.target.checked });
  $('periodic').onchange = e => update({ periodic: e.target.checked });
  $('docFormat').onchange = e => update({ docFormat: e.target.value });
  $('sheetFormat').onchange = e => update({ sheetFormat: e.target.value });
  $('intervalMin').onchange = e => {
    const n = Math.min(1440, Math.max(5, parseInt(e.target.value, 10) || DEFAULTS.intervalMin));
    e.target.value = n;
    update({ intervalMin: n });
  };
  $('folder').onchange = e => update({ folder: e.target.value.trim() || DEFAULTS.folder });
  $('btnOpenFolder').onclick = () => chrome.downloads.showDefaultFolder();
}

/* ---------- 排除名单 ---------- */
function setMsg(el, text, cls = '') {
  el.textContent = text;
  el.className = 'msg ' + cls;
}

async function addExclusion(entry) {
  const dup = settings.excludeList.some(
    e => e.kind === entry.kind && String(e.value).toLowerCase() === String(entry.value).toLowerCase()
  );
  if (dup) return false;
  await update({ excludeList: [...settings.excludeList, entry] });
  return true;
}

async function removeExclusion(index) {
  const list = settings.excludeList.filter((_, i) => i !== index);
  await update({ excludeList: list });
  renderExclude();
}

function initExclude() {
  const submit = async () => {
    const entry = parseExclusionInput($('excludeInput').value);
    if (!entry) return;
    const added = await addExclusion(entry);
    if (added) {
      $('excludeInput').value = '';
      setMsg($('excludeMsg'), entry.kind === 'id' ? '已按文件添加' : '已按关键词添加', 'ok');
    } else {
      setMsg($('excludeMsg'), '已经在名单里了', 'err');
    }
    renderExclude();
  };
  $('btnAddExclude').onclick = submit;
  $('excludeInput').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  renderExclude();
}

function renderExclude() {
  const ul = $('excludeList');
  ul.textContent = '';
  $('excludeEmpty').hidden = settings.excludeList.length > 0;

  settings.excludeList.forEach((e, i) => {
    const li = document.createElement('li');

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = e.kind === 'id' ? '文件' : '关键词';

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = e.label || e.value;
    txt.title = e.value;
    if (e.kind === 'id' && e.label && e.label !== e.value) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = e.value;
      txt.appendChild(sub);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '移出名单';
    del.onclick = () => removeExclusion(i);

    li.append(badge, txt, del);
    ul.appendChild(li);
  });

  updateCurrent();
}

/* ---------- 当前页面 ---------- */
async function initCurrent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  curTab = tab || null;
  curInfo = parseDocUrl(curTab && curTab.url);
  curTitle = cleanTitle(curTab && curTab.title);

  $('btnBackup').onclick = backupNow;
  $('btnToggleExclude').onclick = toggleExcludeCurrent;
  updateCurrent();
}

function updateCurrent() {
  const title = $('curTitle');
  const status = $('curStatus');
  const btnBackup = $('btnBackup');
  const btnToggle = $('btnToggleExclude');

  if (!curInfo) {
    title.textContent = '当前页面不是 Google 文档或表格';
    status.textContent = '';
    status.className = 'cur-status';
    btnBackup.hidden = true;
    btnToggle.hidden = true;
    return;
  }

  title.textContent = curTitle || curInfo.id;
  title.title = curTitle;
  btnBackup.hidden = false;
  btnToggle.hidden = false;

  const hit = findExclusion(settings.excludeList, curInfo.id, curTitle);
  if (hit) {
    status.className = 'cur-status excluded';
    if (hit.kind === 'id') {
      status.textContent = '已在排除名单中，不会备份';
      btnToggle.textContent = '移出排除名单';
      btnToggle.disabled = false;
    } else {
      status.textContent = `被关键词「${hit.value}」排除，不会备份`;
      btnToggle.textContent = '由关键词排除';
      btnToggle.disabled = true;
    }
    btnBackup.disabled = true;
  } else {
    status.className = 'cur-status';
    status.textContent = curInfo.type === 'doc' ? 'Google 文档' : 'Google 表格';
    btnToggle.textContent = '加入排除名单';
    btnToggle.disabled = false;
    btnBackup.disabled = false;
  }
}

async function toggleExcludeCurrent() {
  if (!curInfo) return;
  const hit = findExclusion(settings.excludeList, curInfo.id, curTitle);
  if (hit && hit.kind === 'id') {
    await update({
      excludeList: settings.excludeList.filter(e => !(e.kind === 'id' && e.value === curInfo.id))
    });
  } else if (!hit) {
    await addExclusion({ kind: 'id', value: curInfo.id, label: curTitle || curInfo.id });
  }
  renderExclude();
}

const REASONS = {
  excluded: '该文件在排除名单中',
  disabled: '总开关已关闭',
  'not-doc': '当前页面不是文档或表格',
  error: '下载失败'
};

async function backupNow() {
  if (!curTab || !curInfo) return;
  const btn = $('btnBackup');
  btn.disabled = true;
  setMsg($('curMsg'), '正在备份…');
  const res = await chrome.runtime.sendMessage({ type: 'backupNow', tabId: curTab.id });
  if (res && res.ok) {
    setMsg($('curMsg'), '已开始下载，结果见“记录”', 'ok');
  } else {
    const why = (res && (REASONS[res.reason] || res.reason)) || '未知错误';
    setMsg($('curMsg'), `未备份：${why}${res && res.error ? '（' + res.error + '）' : ''}`, 'err');
  }
  btn.disabled = false;
  updateCurrent();
}

/* ---------- 记录 ---------- */
const STATUS_TEXT = { pending: '下载中', done: '成功', failed: '失败' };

function initLogs() {
  $('btnClearLogs').onclick = async () => {
    await chrome.storage.local.set({ logs: [] });
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.logs) renderLogs(changes.logs.newValue || []);
  });
  chrome.storage.local.get('logs').then(({ logs = [] }) => renderLogs(logs));
}

function renderLogs(logs) {
  const ul = $('logList');
  ul.textContent = '';
  $('logEmpty').hidden = logs.length > 0;

  logs.forEach(l => {
    const li = document.createElement('li');

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = `${l.title}.${l.format}`;
    txt.title = l.filename;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = new Date(l.time).toLocaleString() + (l.error ? ' · ' + l.error : '');
    txt.appendChild(sub);

    const badge = document.createElement('span');
    badge.className = 'badge ' + l.status;
    badge.textContent = STATUS_TEXT[l.status] || l.status;

    li.append(txt, badge);
    ul.appendChild(li);
  });
}
