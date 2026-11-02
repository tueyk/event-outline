// 渲染层检查（2026-11-02）
// 目的：把「拆函数后变量拿不到」「某段悄悄没渲染出来」这类错误挡在提交前。
// 做法：用最小 DOM 桩，把源码里的渲染函数按原样拼进 Node 沙箱真跑一遍，
//      再静态扫一遍「用了但本函数拿不到」的裸标识符。
// 跑法：在仓库根执行 node scripts/test-render.js

const fs = require('fs');

const SRC_PATH = 'src/event-outline/index.js';
const src = fs.readFileSync(SRC_PATH, 'utf8');
const LINES = src.split('\n');
const SEP = String.fromCharCode(10, 10);

let fail = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log('[ok]   ' + name);
    } else {
        fail++;
        console.log('[FAIL] ' + name + (extra ? ' → ' + extra : ''));
    }
}

// ---------- 最小 DOM 桩 ----------
class El {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.style = {};
        this.dataset = {};
        this._classes = new Set();
        this._text = '';
        this._listeners = {};
        this.parentNode = null;
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.isConnected = true;
        this.id = '';
        this.type = '';
        this.placeholder = '';
        this.autocomplete = '';
        this.rows = 0;
        this.min = '';
        this.max = '';
        this.step = '';
    }
    get classList() {
        const self = this;
        return {
            add() { for (const a of arguments) self._classes.add(a); },
            remove() { for (const a of arguments) self._classes.delete(a); },
            toggle(n, on) { const v = on === undefined ? !self._classes.has(n) : on; if (v) self._classes.add(n); else self._classes.delete(n); return v; },
            contains(n) { return self._classes.has(n); },
        };
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
    get innerHTML() { return this._text; }
    set innerHTML(v) { this._text = String(v == null ? '' : v); this.children = []; }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; }
    insertBefore(c) { if (c) { this.children.unshift(c); c.parentNode = this; } return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
    removeEventListener() {}
    setAttribute() {}
    getAttribute() { return null; }
    // 桩里的 querySelector 要在本子树里真查，不能恒返回 null：
    // 2026-11-02 盘点页就因为「查不到→补一个」导致页面上出现两个操作区，
    // 而当时桩恒返回 null，测试毫无反应。
    querySelector(sel) {
        const cls = String(sel || "").replace(/^\./, "");
        const walk = (n) => {
            if (!n) return null;
            if ((n.className || "").split(/\s+/).indexOf(cls) >= 0) return n;
            for (const c of (n.children || [])) { const h = walk(c); if (h) return h; }
            return null;
        };
        return walk(this);
    }
    querySelectorAll(sel) {
        const cls = String(sel || "").replace(/^\./, "");
        const acc = [];
        const walk = (n) => {
            if (!n) return;
            if ((n.className || "").split(/\s+/).indexOf(cls) >= 0) acc.push(n);
            for (const c of (n.children || [])) walk(c);
        };
        walk(this);
        return acc;
    }
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
    focus() {}
    click() {}
    scrollIntoView() {}
    contains() { return false; }
}

const docStub = {
    createElement: (t) => new El(t),
    createTextNode: (t) => { const e = new El('#text'); e._text = t; return e; },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    head: new El('head'),
    body: new El('body'),
    activeElement: null,
    execCommand: () => true,
};
const winStub = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, scrollTo() {}, scrollY: 0 };

// ---------- 从源码里抠函数与常量 ----------
function grabFunction(name) {
    const ln = LINES.findIndex(l => l.indexOf('function ' + name + '(') >= 0);
    if (ln < 0) return null;
    let depth = 0;
    let end = ln;
    for (let i = ln; i < LINES.length; i++) {
        depth += (LINES[i].split('{').length - 1) - (LINES[i].split('}').length - 1);
        if (depth <= 0 && i > ln) { end = i; break; }
    }
    return LINES.slice(ln, end + 1).join('\n');
}

function grabConst(name) {
    const m = src.match(new RegExp('^    const ' + name + ' = .*$', 'm'));
    return m ? m[0] : '';
}

function makeSandbox(stubs, fnNames, constNames) {
    const helpers = fnNames.map(grabFunction).filter(Boolean).join(SEP);
    const consts = (constNames || []).map(grabConst).filter(Boolean).join('\n');
    const body = stubs + '\n' + consts + '\n' + helpers + '\nreturn { ' + fnNames.join(', ') + ' };';
    const factory = new Function('document', 'window', 'navigator', 'console', body);
    return factory(docStub, winStub, {}, console);
}

// ---------- 第一组：纯工具函数 ----------
const utilNames = ['el', 'markKey', 'maskKey', 'inventorySummary', 'fileStamp'];
const utilStubs = [
    'const VERSION = "0.1.2";',
    'const LOG_PREFIX = "[事件大纲]";',
    'const TOASTS = [];',
    'function toast(m) { TOASTS.push(String(m)); }',
    'function attachHelp(n) { return n; }',
    'function log() {}',
    'function warn() {}',
    'function error() {}',
    'function debug() {}',
].join('\n');

let util = null;
try {
    util = makeSandbox(utilStubs, utilNames, []);
} catch (e) {
    fail++;
    console.log('[FAIL] 工具函数拼装失败：' + e.message);
}

if (util) {
    const e1 = util.el('div', 'eo-test', '文字');
    check('el 建元素并设文本', e1.tagName === 'DIV' && e1.className === 'eo-test' && e1.textContent === '文字');

    const e2 = util.el('input');
    if (util.markKey) { util.markKey(e2, 'gen.name'); check('markKey 挂 key', e2.dataset.eoKey === 'gen.name'); }

    check('掩码只露头尾', util.maskKey('sk-1234567890abcdef') === 'sk-••••cdef', util.maskKey('sk-1234567890abcdef'));
    check('短密钥整体打码', util.maskKey('short').indexOf('short') < 0);
    check('空密钥不显示', util.maskKey('') === '');

    const rec = {
        parsed: { triggeredNodes: [1, 2], refutedMisleads: ['a'], offPathBranches: [], nodeVetoed: [] },
        suggestedNodes: [3],
    };
    const sum = util.inventorySummary(rec);
    check('盘点摘要含勾选与推翻', sum.indexOf('勾选 2 个') >= 0 && sum.indexOf('推翻误导 1 条') >= 0, sum);
    check('盘点摘要无解析时给说明', util.inventorySummary({}).indexOf('没解析出') >= 0);
}

// ---------- YAML 工具：请求体三段靠它们生效 ----------
let yamlApi = null;
try {
    yamlApi = makeSandbox('const NL = String.fromCharCode(10);\n', ['parseFlatYaml', 'mergeYamlInto', 'excludeYamlKeys'], []);
} catch (e) {
    fail++;
    console.log('[FAIL] YAML 工具拼装失败：' + e.message);
}

if (yamlApi) {
    const o = { temperature: 0.7, top_p: 1 };
    yamlApi.mergeYamlInto(o, 'temperature: 0.3');
    check('包含主体参数能覆盖同名键', o.temperature === 0.3, String(o.temperature));

    const h = {};
    yamlApi.mergeYamlInto(h, 'X-Title: 事件大纲');
    check('包含请求标头能加新键', h['X-Title'] === '事件大纲', JSON.stringify(h));

    const x = { top_p: 1, seed: 5 };
    yamlApi.excludeYamlKeys(x, '- top_p');
    check('排除主体参数能删键', !('top_p' in x) && x.seed === 5, JSON.stringify(x));

    const e1 = {};
    yamlApi.mergeYamlInto(e1, '');
    check('留空等于不设置', Object.keys(e1).length === 0);

    const e2 = { a: 1 };
    yamlApi.mergeYamlInto(e2, '这不是键值对');
    check('填错不炸也不乱加', e2.a === 1 && Object.keys(e2).length === 1, JSON.stringify(e2));
}

// ---------- 第二组：设置页七段 ----------
const setFns = ['renderSetModel', 'renderSetMemory', 'renderSetTrack',
    'renderSetRetention', 'renderSetUi', 'renderSetBook', 'renderSetLevels'];

const setSettings = {
    memory: { source: 'auto', recentFloors: 15 },
    worldbook: { enabled: true, maxChars: 30000 },
    tracker: { mode: 'auto', autoEvery: 10, autoByFloor: true, autoByRound: false },
    ui: { dock: 'none', dockHintShown: false },
    preset: { difficultyLevels: [], groupMode: 'rough' },
    apiProfiles: [], activeProfileId: '',
    retention: { maxEvents: 20 },
    genForm: {},
};

const setStubs = [
    'const SETTINGS = { memory: { source: "auto", recentFloors: 15 }, worldbook: { enabled: true, maxChars: 30000 }, tracker: { mode: "auto" }, ui: { dock: "none" }, preset: {}, apiProfiles: [], activeProfileId: "", retention: {}, genForm: {} };',
    'const getSettings = () => SETTINGS;',
    'const saveSettings = () => {};',
    'const getMeta = () => ({ events: {}, activeEventId: "" });',
    'const getCurrentEvent = () => null;',
    'const listEvents = () => [];',
    'const updateProfile = () => {};',
    'function resolveAdapter() { return { degraded: false, wanted: "auto", adapter: { id: "none", describe: () => "仅最近楼层" } }; }',
    'function getCharacterBookName() { return ""; }',
    'const listEventEntries = async () => [];',
    'const readWorldBook = async () => ({ entries: {} });',
    'const toast = () => {};',
    'const log = () => {};',
    'const warn = () => {};',
    'const error = () => {};',
    'const debug = () => {};',
    'const attachHelp = (n) => n;',
    'const makeActivatable = (n) => n;',
    'const closeAllTips = () => {};',
    'const repaintPage = () => {};',
    'const askConfirm = async () => false;',
    'const downloadText = () => true;',
    'const diagnoseShujuku = () => ["ok"];',
    'const DEFAULT_DIFFICULTY_LEVELS = ["一", "二", "三"];',
    'const MEMORY_SOURCES = { auto: "自动选择", floors: "仅最近楼层", shujuku: "shujuku 纪要" };',
    'const TRACKER_MODES = { auto: "自动", semi: "半自动", manual: "手动" };',
    'const RETENTION_MODES = { count: "按数量", forever: "永久" };',
    'const UI_DOCK_MODES = { none: "不吸附", left: "吸左", right: "吸右" };',
    'const LOG_PREFIX = "[事件大纲]";',
    'const VERSION = "0.1.2";',
].join('\n');

let setApi = null;
try {
    setApi = makeSandbox(setStubs, ['el', 'markKey'].concat(setFns), []);
} catch (e) {
    fail++;
    console.log('[FAIL] 设置页拼装失败：' + e.message);
}

if (setApi) {
    for (const name of setFns) {
        const fn = setApi[name];
        if (typeof fn !== 'function') { fail++; console.log('[FAIL] ' + name + ' 没抓到'); continue; }
        try {
            fn(new El('div'), setSettings);
            check(name + ' 能跑通', true);
        } catch (e) {
            check(name + ' 能跑通', false, e && e.message);
        }
    }
}

// ---------- 第三组：盘点页与日志页 ----------
const invStubs = [
    'const runtimeLog = [{ at: "12:00:00", level: "info", text: "启动" }];',
    'const RUNTIME_LOG_MAX = 500;',
    'const LOG_LEVELS = ["debug", "info", "warn", "error"];',
    'const LOG_LEVEL_LABEL = { debug: "调试", info: "信息", warn: "警告", error: "错误" };',
    'let logFilter = "all";',
    'let logKeyword = "";',
    'const debugEnabled = () => false;',
    'const busy = false;',
    'const progress = { steps: [], startedAt: 0 };',
    'const runInventory = async () => { throw new Error("stub"); };',
    'const ctx = () => ({ chatId: "test" });',
    'const buildStateCard = () => "状态卡";',
    'const buildEntryContent = () => "核心真相内容";',
    'const renderProgress = () => {};',
    'const getCurrentEvent = () => ({ name: "测试事件", outline: { nodes: [{ id: 1, info: "节点一" }, { id: 2, info: "节点二" }] }, tracker: { triggeredNodes: [1], pendingNodes: [], nodeVetoed: [], autoCommitted: [], refutedMisleads: [] }, inventories: [], entryUid: 1 });',
    'const TRACKER_MODES = { auto: "自动", semi: "半自动", manual: "手动" };',
    'const getMeta = () => ({ events: {}, activeEventId: "e1" });',
    'const listEvents = () => [];',
    'const getSettings = () => ({ tracker: { mode: "auto" }, preset: {}, memory: { source: "auto" }, worldbook: {} });',
    'const saveSettings = () => {};',
    'const renderPanel = () => {};',
    'const repaintPage = () => {};',
    'const toast = () => {};',
    'const log = () => {};',
    'const warn = () => {};',
    'const error = () => {};',
    'const debug = () => {};',
    'const attachHelp = (n) => n;',
    'const makeActivatable = (n) => n;',
    'const confirmPending = () => {};',
    'const togglePanel = () => {};',
    'const restoreVetoedNodes = () => 0;',
    'const downloadText = () => true;',
    'const copyText = async () => true;',
    'const LOG_PREFIX = "[事件大纲]";',
    'const VERSION = "0.1.2";',
].join('\n');

let invApi = null;
try {
    invApi = makeSandbox(invStubs,
        ['el', 'markKey', 'nodeId', 'nodeText', 'nodeTrigger', 'inventorySummary', 'fileStamp',
            'buildInvActions', 'renderInvPage', 'renderRuntimeLogSection', 'renderLogPage'],
        ['NODE_TEXT_KEYS', 'NODE_TRIGGER_KEYS']);
} catch (e) {
    fail++;
    console.log('[FAIL] 盘点页/日志页拼装失败：' + e.message);
}

function collectText(node, out) {
    if (!node) return out;
    out.push(node.textContent);
    for (const c of (node.children || [])) collectText(c, out);
    return out;
}
function findAllByClass(node, cls, out) {
    const acc = out || [];
    if (!node) return acc;
    if ((node.className || "").split(/\s+/).indexOf(cls) >= 0) acc.push(node);
    for (const c of (node.children || [])) findAllByClass(c, cls, acc);
    return acc;
}
function findByClass(node, cls) {
    if (!node) return null;
    if ((node.className || '').split(/\s+/).indexOf(cls) >= 0) return node;
    for (const c of (node.children || [])) {
        const hit = findByClass(c, cls);
        if (hit) return hit;
    }
    return null;
}

if (invApi) {
    const invPage = new El('div');
    try {
        invApi.renderInvPage(invPage);
        const all = collectText(invPage, []).join('｜');
        check('盘点页有操作区', !!findByClass(invPage, 'eo-inv-actions'));
        check('盘点页有「开始盘点」按钮', all.indexOf('开始盘点') >= 0, all.slice(0, 100));
        check('盘点页仍列出节点进度', all.indexOf('节点进度') >= 0);
        // 操作区必须恰好一个，且排在最前面。
        // 2026-11-02 真机事故：兜底判断用了 page.querySelector，渲染时 page 未挂载，
        // 查到的是整个文档，于是每次都判定「缺失」又补一个，页面上出现两个操作区。
        const allActions = findAllByClass(invPage, 'eo-inv-actions');
        check('盘点页操作区恰好一个', allActions.length === 1, '实际 ' + allActions.length + ' 个');
        check('盘点页操作区排在最前', invPage.children[0] === allActions[0], '第 0 个子节点不是操作区');
    } catch (e) {
        check('renderInvPage 能跑通', false, e && e.message);
    }

    // 场景二：page 里已经有一个上一次渲染残留的操作区，再跑一次渲染，
    // 结果仍然只能有一个（2026-11-02 真机事故的回归点）
    try {
        const dirtyPage = new El('div');
        const stale = new El('div');
        stale.className = 'eo-inv-actions';
        dirtyPage.appendChild(stale);
        invApi.renderInvPage(dirtyPage);
        check('页面有残留时操作区仍只有一个', findAllByClass(dirtyPage, 'eo-inv-actions').length === 1,
            '实际 ' + findAllByClass(dirtyPage, 'eo-inv-actions').length + ' 个');
    } catch (e) {
        check('残留场景能跑通', false, e && e.message);
    }

    const logPage = new El('div');
    try {
        invApi.renderLogPage(logPage);
        const t = collectText(logPage, []).join('｜');
        check('日志页有复制全部', t.indexOf('复制全部') >= 0);
        check('日志页有导出文本', t.indexOf('导出文本') >= 0);
        check('日志页有清空按钮', t.indexOf('清空运行日志') >= 0);
        // 世界书条目里有核心真相，默认摊开等于剧透（2026-11-02）
        check('世界书条目默认折叠', t.indexOf('剧透') >= 0 && t.indexOf('点开前想清楚') >= 0);
        check('世界书条目用折叠块包着', !!(function find(node) {
            if (!node) return null;
            if (node.tagName === 'DETAILS') return node;
            for (const c of (node.children || [])) { const hit = find(c); if (hit) return hit; }
            return null;
        })(logPage));

    } catch (e) {
        check('renderRuntimeLogSection 能跑通', false, e && e.message);
    }
}

// ---------- 第四组：静态作用域体检 ----------
const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

function bodyRange(name) {
    const start = LINES.findIndex(l => l.indexOf('function ' + name + '(') >= 0);
    if (start < 0) return null;
    let depth = 0;
    let end = start;
    for (let i = start; i < LINES.length; i++) {
        depth += (LINES[i].split('{').length - 1) - (LINES[i].split('}').length - 1);
        if (depth <= 0 && i > start) { end = i; break; }
    }
    return { start, end };
}

const moduleNames = new Set();
const moduleRe = new RegExp('(?:^|\\s)(?:const|let|var)\\s+(' + IDENT + ')|(?:async\\s+)?function\\s+(' + IDENT + ')', 'gm');
for (const m of src.matchAll(moduleRe)) moduleNames.add(m[1] || m[2]);

const hosts = new Set(['window', 'document', 'console', 'navigator', 'location', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'URL', 'Blob',
    'AbortController', 'Promise', 'Error', 'Object', 'Array', 'String', 'Number', 'Math', 'JSON',
    'Date', 'Set', 'Map', 'Boolean', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
    'for', 'if', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'async', 'else',
    'function', 'const', 'let', 'var', 'case', 'throw', 'delete', 'void', 'in', 'of', 'instanceof']);

const auditTargets = ['buildInvActions', 'renderSetModel', 'renderSetMemory', 'renderSetTrack',
    'renderSetRetention', 'renderSetUi', 'renderSetBook', 'renderSetLevels',
    'renderGenStatus', 'renderGenDrafts', 'renderGenForm', 'renderInvPage',
    'renderLogPage', 'renderRuntimeLogSection', 'renderDraftCard'];

const declRe = new RegExp('(?:const|let|var|function)\\s+(' + IDENT + ')', 'g');
const forOfRe = new RegExp('for \\\\(const (' + IDENT + ') of)', 'g');
const arrowParamsRe = new RegExp('\\\\(([^()]*)\\\\)\\\\s*=>', 'g');
const singleArrowRe = new RegExp('(?:^|[^A-Za-z0-9_$.])(' + IDENT + ')\\\\s*=>', 'g');
const fnParamsRe = new RegExp('function\\\\s+' + IDENT + '\\\\s*\\\\(([^)]*)\\\\)', 'g');
const useRe = new RegExp('(' + IDENT + ')\\\\s*(?=[.(])', 'g');

function scrubLiteral(text) {
    return text.split('\n').map(line => {
        const out = [];
        let quote = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quote) {
                if (ch === quote) quote = null;
                out.push(' ');
            } else if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch;
                out.push(' ');
            } else if (ch === '/' && line[i + 1] === '/') {
                break;
            } else {
                out.push(ch);
            }
        }
        return out.join('');
    }).join('\n');
}

for (const name of auditTargets) {
    const range = bodyRange(name);
    if (!range) { console.log('跳过 ' + name); continue; }
    const body = LINES.slice(range.start, range.end + 1).join('\n');
    const local = new Set();
    for (const m of body.matchAll(declRe)) local.add(m[1]);
    for (const m of body.matchAll(forOfRe)) local.add(m[1]);
    for (const m of body.matchAll(singleArrowRe)) local.add(m[1]);
    for (const re of [arrowParamsRe, fnParamsRe]) {
        for (const m of body.matchAll(re)) {
            for (const p of m[1].split(',')) {
                const t = p.trim().split(/[=:]/)[0].trim();
                if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
            }
        }
    }
    const head = body.split('\n')[0];
    const op = head.indexOf('(');
    const cp = head.lastIndexOf(')');
    const params = new Set();
    if (op >= 0 && cp > op) {
        for (const p of head.slice(op + 1, cp).split(',')) {
            const t = p.trim();
            if (t) params.add(t);
        }
    }

    const scan = scrubLiteral(body);
    const missing = new Map();
    for (const m of scan.matchAll(useRe)) {
        const id = m[1];
        const before = m.index > 0 ? scan[m.index - 1] : '';
        if (before === '.' || before === '?') continue;
        if (id.length < 3) continue;
        if (id[0] !== id[0].toLowerCase()) continue;
        if (moduleNames.has(id) || hosts.has(id) || local.has(id) || params.has(id)) continue;
        missing.set(id, (missing.get(id) || 0) + 1);
    }
    const list = Array.from(missing.entries());
    if (list.length) {
        fail++;
        console.log('[FAIL] ' + name + ' 引用了本函数拿不到的名字：' + list.map(x => x[0] + '×' + x[1]).join(' '));
    } else {
        console.log('[ok]   ' + name + ' 引用正常');
    }
}

console.log(fail ? '共 ' + fail + ' 项问题' : '全部通过');
process.exit(fail ? 1 : 0);
