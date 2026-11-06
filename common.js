// 公共工具：background.js（importScripts）与 popup.js（<script>）共用

const DEFAULTS = {
  enabled: true,        // 总开关
  backupOnOpen: true,   // 打开/加载文档时自动备份
  periodic: false,      // 定时备份已打开的标签页
  intervalMin: 30,      // 同一文件两次备份的最小间隔（分钟）
  docFormat: 'docx',    // 文档导出格式
  sheetFormat: 'xlsx',  // 表格导出格式
  folder: 'GoogleBackup', // 下载目录下的子文件夹
  excludeList: []       // 排除名单：[{kind:'id'|'keyword', value, label}]
};

const DOC_FORMATS = ['docx', 'pdf', 'txt', 'odt'];
const SHEET_FORMATS = ['xlsx', 'csv', 'pdf', 'ods'];

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}

// 解析 Google 文档/表格 URL，支持多账号 /u/N/
function parseDocUrl(url) {
  if (!url) return null;
  const m = url.match(/^https:\/\/docs\.google\.com\/(document|spreadsheets)\/(?:u\/(\d+)\/)?d\/([\w-]+)/);
  if (!m) return null;
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
  return { type: m[1] === 'document' ? 'doc' : 'sheet', user: m[2], id: m[3], gid };
}

// 去掉标签页标题里的 " - Google 文档" 等后缀
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*-\s*Google\s*(?:文档|表格|Docs|Sheets)\s*$/i, '')
    .trim();
}

// 生成可用于文件名的字符串
function safeName(s, max = 100) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, max)
    .trim();
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 把用户输入（链接 / 文件 ID / 关键词）解析成排除条目
function parseExclusionInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const info = parseDocUrl(text);
  if (info) return { kind: 'id', value: info.id, label: info.id };
  if (/^[\w-]{25,}$/.test(text)) return { kind: 'id', value: text, label: text };
  return { kind: 'keyword', value: text, label: text };
}

// 返回命中的排除条目（没有则 undefined）
function findExclusion(list, id, title) {
  const t = String(title || '').toLowerCase();
  return (list || []).find(e =>
    e.kind === 'id'
      ? e.value === id
      : t && t.includes(String(e.value).toLowerCase())
  );
}

function isExcluded(list, id, title) {
  return !!findExclusion(list, id, title);
}
