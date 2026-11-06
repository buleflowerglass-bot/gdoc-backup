importScripts('common.js');

const MAX_LOGS = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 所有读写 storage 的操作串行执行，避免并发覆盖
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function addLog(entry) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift(entry);
  await chrome.storage.local.set({ logs: logs.slice(0, MAX_LOGS) });
}

async function backupTab(tab, { force = false } = {}) {
  const info = parseDocUrl(tab.url);
  if (!info) return { ok: false, reason: 'not-doc' };

  const s = await getSettings();
  // 手动备份可以跳过频率限制，但仍必须遵守总开关。
  if (!s.enabled) return { ok: false, reason: 'disabled' };

  const title = cleanTitle(tab.title);
  if (isExcluded(s.excludeList, info.id, title)) return { ok: false, reason: 'excluded' };

  const { lastBackup = {} } = await chrome.storage.local.get('lastBackup');
  const now = Date.now();
  if (!force && lastBackup[info.id] && now - lastBackup[info.id] < s.intervalMin * 60000) {
    return { ok: false, reason: 'throttled' };
  }

  const format = info.type === 'doc' ? s.docFormat : s.sheetFormat;
  const base =
    'https://docs.google.com/' +
    (info.type === 'doc' ? 'document' : 'spreadsheets') +
    (info.user !== undefined ? `/u/${info.user}` : '') +
    `/d/${info.id}/export?format=${format}`;
  const url = base + (format === 'csv' && info.gid ? `&gid=${info.gid}` : '');

  const folderParts = String(s.folder || '').split(/[\\/]+/).map(p => safeName(p)).filter(Boolean);
  if (!folderParts.length) folderParts.push('GoogleBackup');
  const filename = [
    ...folderParts,
    info.type === 'doc' ? '文档' : '表格',
    `${safeName(title) || info.id}_${stamp()}.${format}`
  ].join('/');

  // 先记录时间，防止同一文件重复触发；失败时再回滚
  lastBackup[info.id] = now;
  await chrome.storage.local.set({ lastBackup });

  const log = {
    fileId: info.id,
    title: title || info.id,
    type: info.type,
    format,
    time: now,
    filename
  };

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    await addLog({ ...log, downloadId, status: 'pending' });
    return { ok: true };
  } catch (e) {
    delete lastBackup[info.id];
    await chrome.storage.local.set({ lastBackup });
    await addLog({ ...log, status: 'failed', error: e.message });
    return { ok: false, reason: 'error', error: e.message };
  }
}

// 下载结束后更新记录状态
chrome.downloads.onChanged.addListener(delta => {
  const st = delta.state && delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;

  enqueue(async () => {
    const { logs = [], lastBackup = {} } = await chrome.storage.local.get(['logs', 'lastBackup']);
    const entry = logs.find(l => l.downloadId === delta.id && l.status === 'pending');
    if (!entry) return;

    if (st === 'complete') {
      entry.status = 'done';
    } else {
      entry.status = 'failed';
      entry.error = (delta.error && delta.error.current) || 'INTERRUPTED';
      delete lastBackup[entry.fileId]; // 失败后允许下次重试
    }
    await chrome.storage.local.set({ logs, lastBackup });
  });
});

// 打开 / 刷新 / 跳转到文档页面时备份
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !parseDocUrl(tab.url)) return;
  handleOpened(tabId);
});

async function handleOpened(tabId) {
  const s = await getSettings();
  if (!s.enabled || !s.backupOnOpen) return;
  await sleep(2500); // 等页面标题加载完整
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  enqueue(() => backupTab(tab));
}

// 定时备份已打开的标签页（间隔由 intervalMin 控制）
function setupAlarm() {
  chrome.alarms.create('periodic', { periodInMinutes: 5 });
}
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'periodic') return;
  const s = await getSettings();
  if (!s.enabled || !s.periodic) return;
  const tabs = await chrome.tabs.query({
    url: ['https://docs.google.com/document/*', 'https://docs.google.com/spreadsheets/*']
  });
  for (const tab of tabs) {
    if (tab.status === 'complete') await enqueue(() => backupTab(tab));
  }
});

// 来自弹窗的“立即备份”
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'backupNow') return;
  // 仅允许扩展弹窗发起手动备份，并校验调用者提供的标签页 ID。
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  if (!Number.isInteger(msg.tabId)) {
    sendResponse({ ok: false, reason: 'not-doc' });
    return;
  }
  chrome.tabs.get(msg.tabId)
    .then(tab => enqueue(() => backupTab(tab, { force: true })))
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, reason: 'error', error: e.message }));
  return true; // 异步响应
});
