// 渲染层检查（2026-11-02）
// 目的：把「拆函数后变量拿不到」「某段悄悄没渲染出来」这类错误挡在提交前。
// 做法：用最小 DOM 桩，把源码里的渲染函数按原样拼进 Node 沙箱真跑一遍，
//      再静态扫一遍「用了但本函数拿不到」的裸标识符。
// 跑法：在仓库根执行 node scripts/test-render.js

const fs = require('fs');
const path = require('path');

// 按脚本自身位置取源码，不看当前目录（2026-11-02）：
// 原来写的是相对路径 'src/event-outline/index.js'，只有在仓库根执行才对；
// 从别处调用时直接 ENOENT，跑流程的人会以为测试挂了，其实是路径找不到。
const SRC_PATH = path.join(__dirname, '..', 'src', 'event-outline', 'index.js');
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

// 状态对象 S 从源码原样搬过来（2026-11-02 收口后，各模块状态都在这里）
const S_BLOCK = (src.match(/^ {4}const S = \{[\s\S]*?^ {4}\};$/m) || [''])[0];

/**
 * 拼一个沙箱：stubs 是假的依赖，fnNames 是要从源码里搬出来的函数，
 * exposeState.S 为真时额外导出 S 与 __setDebug（待选事件卡那组要自己摆「展开中」的状态）。
 */
function makeSandbox(stubs, fnNames, constNames, exposeState) {
    const helpers = fnNames.map(grabFunction).filter(Boolean).join(SEP);
    const consts = (constNames || []).map(grabConst).filter(Boolean).join('\n');
    const extraList = [];
    if (exposeState && exposeState.S) extraList.push('S');
    if (exposeState && exposeState.setDebug) extraList.push('__setDebug');
    const extra = extraList.join(', ');
    const body = stubs + '\n' + S_BLOCK + '\n' + consts + '\n' + helpers + '\nreturn { '
        + fnNames.join(', ') + (extra ? ', ' + extra : '') + ' };';
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
    'const attachHelp = (n) => { n.appendChild(el("span", "eo-help", "?")); return n; };',
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
    // 世界书段新增「条目顺序」输入框后要用到这两个常量与取值函数（2026-11-04）
    'const DEFAULT_ENTRY_ORDER = 200;',
    'const MAX_ENTRY_ORDER = 9999;',
    'const eventOrderValue = () => 200;',
    // renderSetAuto 与 renderSetPage 要用到（2026-11-04 拆组）
    'let __debug = true;',
    'const debugEnabled = () => __debug;',
    'const __setDebug = (v) => { __debug = v; };',
    'const countFloors = () => 0;',
    'const runInventory = async () => {};',
    'const ensureFab = () => {};',
    'const LOG_PREFIX = "[事件大纲]";',
    'const VERSION = "0.1.2";',
].join('\n');

let setApi = null;
try {
    setApi = makeSandbox(setStubs, ['el', 'markKey'].concat(setFns).concat(['renderSetAuto', 'renderSetDebug', 'renderSetPage']), [], { S: true, setDebug: true });
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
    // ---------- 设置页区块顺序（2026-11-04 危晓定） ----------
    // 以前「调试」排第一、「世界书」压在界面后面。现在按「先配好怎么跑，再调细节，排障垫底」排。
    // 断言按实际渲染出来的顺序比，不是看代码里 sections 数组写成什么样。
    try {
        const orderPage = new El('div');
        setApi.renderSetPage(orderPage);
        const secTitles = [];
        for (const c of orderPage.children) {
            if (String(c.className || '').split(/\s+/).indexOf('eo-sec') >= 0) {
                secTitles.push(collectText(c, []).join('').trim());
            }
        }
        const want = ['模型', '世界书', '记忆来源', '打勾与自动盘点', '自动盘点',
            '难度档位', '历史保留', '界面', '调试'];
        // 标题后面可能跟着问号标记，按前缀比，别按全等比（2026-11-04）
        const got = secTitles
            .map(t => want.filter(w => t.indexOf(w) === 0).sort((a, b) => b.length - a.length)[0])
            .filter(Boolean);
        check('设置页区块顺序按约定', got.join('|') === want.join('|'), '实际：' + got.join('|'));
        check('调试模式排在最后', got[got.length - 1] === '调试', '最后一个是 ' + got[got.length - 1]);
        check('世界书排在模型之后', got.indexOf('世界书') === got.indexOf('模型') + 1);
        check('自动盘点单独成组', got.indexOf('自动盘点') === got.indexOf('打勾与自动盘点') + 1);
    } catch (e) {
        check('设置页区块顺序能跑通', false, e && e.message);
    }

    // 世界书段必须真的把「条目顺序」控件画出来（2026-11-04 加）：只断言「能跑通」的话，
    // 如果把整个 input 删掉、只留一行说明，这条测试照样通过，等于没测。
    try {
        const bookPage = new El('div');
        setApi.renderSetBook(bookPage, setSettings);
        const texts = collectText(bookPage, []).join('｜');
        const inputs = [];
        (function walk(n) { if (!n) return; if (n.tagName === 'INPUT' && n.dataset && n.dataset.eoKey === 'set.entryOrder') inputs.push(n); (n.children || []).forEach(walk); })(bookPage);
        check('世界书段有「条目顺序」标签', texts.indexOf('条目顺序') >= 0, texts.slice(0, 120));
        check('条目顺序是一个控件且只有一个', inputs.length === 1, '实际 ' + inputs.length + ' 个');
        if (inputs.length === 1) check('条目顺序初始值取设置', String(inputs[0].value) === '200', 'value=' + inputs[0].value);
        check('世界书段有恢复默认按钮', texts.indexOf('恢复默认') >= 0);
        // 用控件个数判定，别用文案：整段说明文字里本来就可能出现「写入测试」这些词，
        // 拿文案做断言，守卫拆掉了也照样通过（2026-11-04 反向验证抓到的假通过）。
        const btnLabels = [];
        (function walk(n) { if (!n) return; if (n.tagName === 'BUTTON') btnLabels.push(String(n.textContent || '')); (n.children || []).forEach(walk); })(bookPage);
        check('调试模式关时不显示写入测试', btnLabels.indexOf('写入测试') < 0, btnLabels.join('｜'));
        check('调试模式关时不显示删除测试', btnLabels.indexOf('删除测试') < 0, btnLabels.join('｜'));
        check('调试模式关时只留自检与恢复默认', btnLabels.length === 2
            && btnLabels.indexOf('自检世界书') >= 0 && btnLabels.indexOf('恢复默认') >= 0, btnLabels.join('｜'));
        const dbgPage = new El('div');
        setApi.renderSetBook(dbgPage, Object.assign({}, setSettings, { debug: true }));
        const dbgBtns = [];
        (function walk(n) { if (!n) return; if (n.tagName === 'BUTTON') dbgBtns.push(String(n.textContent || '')); (n.children || []).forEach(walk); })(dbgPage);
        check('调试模式开时才出现写入测试', dbgBtns.indexOf('写入测试') >= 0, dbgBtns.join('｜'));
        check('调试模式开时才出现删除测试', dbgBtns.indexOf('删除测试') >= 0, dbgBtns.join('｜'));
    } catch (e) {
        check('世界书段条目顺序能跑通', false, e && e.message);
    }
}

// ---------- 待选事件卡：原始输出要看得到（2026-11-04 危晓要求） ----------
// 以前只有「采用」之后的事件详情里才有模型原始输出，待选阶段想看原文得先采用，
// 顺序整个反了。这条测试盯住待选卡里那一块确实渲染出来了，且只在调试模式开着时给。
let draftApi = null;
{
    const draftStubs = [
        // S 由 makeSandbox 从源码原样搬进来，这里不能再声明一次；
        // 所以要从返回的对象里拿 S 来摆「正在展开」这个状态
        'const MAX_DRAFTS = 5;',
        'let __debug = true;',
        'const debugEnabled = () => __debug;',
        'const __setDebug = (v) => { __debug = v; };',
        'const isPreviewing = (id) => S.previewDraftIds.has(id);',        'const renderOutlineText = (o) => "大纲正文";',
        'const renderDraftEditor = (d) => el("div", "eo-editor", "编辑器");',
        'const askConfirm = async () => false;',
        'const commitDraft = async () => {};',
        'const discardDraft = () => {};',
        'const closeDraftEditor = async () => {};',
        'const discardPendingEdit = () => {};',
        'const makeDraftEditBuf = () => ({});',
        'const attachHelp = (n) => { n.appendChild(el("span", "eo-help", "?")); return n; };',
        'const renderPanel = () => {};',
        'const toast = () => {};',
        'const error = () => {};',
        'const LOG_PREFIX = "[事件大纲]";',
    ].join('\n');
    try {
        draftApi = makeSandbox(draftStubs, ['el', 'renderDraftCard'], [], { S: true, setDebug: true });
    } catch (e) {
        fail++;
        console.log('[FAIL] 待选事件卡拼装失败：' + e.message);
    }
}

if (draftApi) {
    const mkDraft = (raw) => ({
        id: 'd1', name: '测试草稿', brief: '一句话',
        outline: { nodes: [{ id: 1, info: '节点一' }], characters: {} },
        outlineRaw: raw,
        parseQuality: { ok: true, missing: [] },
    });
    draftApi.S.previewDraftIds.add('d1');

    const rawText = 'nodes:\n  - id: 1\n    info: 节点一';
    const cardBefore = draftApi.renderDraftCard(mkDraft(rawText));
    const beforeText = collectText(cardBefore, []).join('｜');
    // 只展开大纲、没点「展示原文」时，原文不该跟着一起出来（2026-11-04 危晓要求：两个开关各管各的）
    check('只展开大纲时不出原文', beforeText.indexOf('模型原始输出') < 0, beforeText.slice(0, 160));
    check('待选卡有独立的展示原文按钮', beforeText.indexOf('展示原文') >= 0, beforeText.slice(0, 160));

    // 点「展示原文」：原文出来，且大纲不用展开
    draftApi.S.previewDraftIds.delete('d1');
    draftApi.S.previewRawDraftIds.add('d1');
    const cardOnlyRaw = draftApi.renderDraftCard(mkDraft(rawText));
    const onlyRawText = collectText(cardOnlyRaw, []).join('｜');
    check('只点展示原文也能看到原文', onlyRawText.indexOf('模型原始输出') >= 0 && onlyRawText.indexOf('nodes:') >= 0, onlyRawText.slice(0, 200));
    check('只点展示原文不必展开大纲', onlyRawText.indexOf('大纲正文') < 0, onlyRawText.slice(0, 160));
    check('原文按钮此时是收起原文', onlyRawText.indexOf('收起原文') >= 0);
    // 点了「展示原文」就摊开，不再套折叠块（2026-11-04 危晓反馈：按钮写着展示原文、
    // 下面还挂一个要点开才知道是什么的折叠块，等于点了两次）
    check('待选卡原文点了就摊开', findAllByClass(cardOnlyRaw, 'eo-details').length === 0,
        '还有 ' + findAllByClass(cardOnlyRaw, 'eo-details').length + ' 个折叠块');

    // 编辑大纲时按钮要锁住，且原文不渲染（此时这张卡只画编辑器）
    draftApi.S.previewRawDraftIds.add('d1');
    draftApi.S.editingDraftId = 'd1';
    const cardEditing = draftApi.renderDraftCard(mkDraft(rawText));
    const editBtns = [];
    (function walk(n) { if (!n) return; if (n.tagName === 'BUTTON') editBtns.push(n); (n.children || []).forEach(walk); })(cardEditing);
    // 用「包含」不用「等于」：按钮上真要是不小心挂了「?」帮助标记，
    // 等于判断会先认不出按钮、连带几条断言一起假通过（2026-11-04 反向验证踩到过）
    const rawBtn = editBtns.filter(b => String(b.textContent || '').indexOf('展示原文') >= 0)[0];
    check('编辑大纲时有展示原文按钮', !!rawBtn);
    check('编辑大纲时展示原文按钮点不了', !!rawBtn && rawBtn.disabled === true);
    check('编辑大纲时按钮不亮', !!rawBtn && String(rawBtn.className).indexOf('eo-on') < 0);
    check('编辑大纲时原文不渲染', collectText(cardEditing, []).join('｜').indexOf('nodes:') < 0);
    // 按钮上不许挂「?」帮助标记（2026-11-04 危晓要求）：已经灰掉的按钮旁边再挂个问号，
    // 等于多一个要点的小玩意。判据是按钮里既没有 eo-help 子节点、文字也就是「展示原文」四个字。
    // 只数节点不够——这组沙箱里 attachHelp 是假的、直接返回节点，挂了也查不出来（反向验证踩到过）。
    const rawBtnText = rawBtn ? String(rawBtn.textContent || '') : '';
    check('编辑大纲时按钮上不挂问号', !!rawBtn
        && findAllByClass(rawBtn, 'eo-help').length === 0
        && rawBtnText.indexOf('?') < 0
        && rawBtnText.indexOf('？') < 0, '按钮文字是「' + rawBtnText + '」');
    draftApi.S.editingDraftId = null;

    // 调试模式关掉就不许出现：这是排查用的技术细节，平时摆着会被误读
    draftApi.__setDebug(false);
    const cardOff = draftApi.renderDraftCard(mkDraft(rawText));
    const offText = collectText(cardOff, []).join('｜');
    check('调试模式关时待选卡不显示原始输出', offText.indexOf('模型原始输出') < 0, offText.slice(0, 160));
    check('调试模式关时没有展示原文按钮', offText.indexOf('展示原文') < 0, offText.slice(0, 160));

    // 没有原文（老草稿）时不能画出空白块，也不能给按钮
    draftApi.__setDebug(true);
    draftApi.S.previewRawDraftIds.add('d1');
    const cardNoRaw = draftApi.renderDraftCard(mkDraft(''));
    const noRawText = collectText(cardNoRaw, []).join('｜');
    check('没有原始输出时不画空块', noRawText.indexOf('模型原始输出') < 0);
    check('没有原始输出时没有展示原文按钮', noRawText.indexOf('展示原文') < 0);
}

// ---------- 生成页：当前事件在前、待选在后，且当前事件自己带子项（2026-11-04 危晓要求） ----------
// 以前待选事件在上面，当前事件挤在下面；当前事件的大纲与原文是自动展开的折叠块，
// 且原文压在大纲底下，想看原文得先把几百行大纲展开。这几条盯住新的排法与开关。
let genApi = null;
{
    const genStubs = [
        'const MAX_DRAFTS = 5;',
        'let __debug = true;',
        'const debugEnabled = () => __debug;',
        'const __setDebug = (v) => { __debug = v; };',
        'const getCurrentEvent = () => ({',
        '    name: "进行中的事件",',
        '    outline: { nodes: [{ id: 1, info: "节点一" }], characters: {} },',
        '    outlineRaw: "nodes:\\n  - id: 1\\n    info: 节点一",',
        '    parseQuality: { ok: true, missing: [] },',
        '});',
        'const getMeta = () => ({ events: { d1: { id: "d1", name: "待选甲", status: "draft", createdAt: "2", outline: { nodes: [], characters: {} }, outlineRaw: "", parseQuality: { ok: true, missing: [] } } } });',
        'const renderOutlineText = (o) => "大纲正文";',
        'const renderDraftCard = (d) => el("div", "eo-draft-proxy", "草稿卡：" + d.name);',
        'const closeEvent = async () => {};',
        'const askConfirm = async () => false;',
        'const attachHelp = (n) => { n.appendChild(el("span", "eo-help", "?")); return n; };',
        'const renderPanel = () => {};',
        'const LOG_PREFIX = "[事件大纲]";',
    ].join('\n');
    try {
        genApi = makeSandbox(genStubs, ['el', 'renderGenDrafts'], [], { S: true, setDebug: true });
    } catch (e) {
        fail++;
        console.log('[FAIL] 生成页拼装失败：' + e.message);
    }
}

if (genApi) {
    const idxOf = (nodes, pred) => nodes.findIndex(pred);
    const genPage = new El('div');
    genApi.renderGenDrafts(genPage);
    const kids = genPage.children;
    const curIdx = idxOf(kids, n => String(n.textContent || '').indexOf('当前事件') >= 0);
    const draftIdx = idxOf(kids, n => String(n.textContent || '').indexOf('待选事件') >= 0);
    check('生成页有当前事件段', curIdx >= 0, '没找到');
    check('生成页有待选事件段', draftIdx >= 0, '没找到');
    check('当前事件排在待选事件前面', curIdx >= 0 && draftIdx >= 0 && curIdx < draftIdx, curIdx + ' vs ' + draftIdx);

    const allText = collectText(genPage, []).join('｜');
    // 当前事件的子项都在同一段里，且都在待选段之前
    const headEnd = curIdx >= 0 ? (kids[curIdx].children || []) : [];
    check('当前事件段显示事件名', allText.indexOf('进行中的事件') >= 0, allText.slice(0, 120));
    ['去盘点这一页', '完结', '废弃', '展示大纲', '展示原文'].forEach(label => {
        const i = idxOf(kids, n => {
            const t = collectText(n, []).join('｜');
            return t.indexOf(label) >= 0;
        });
        check('当前事件有「' + label + '」', i >= 0 && i < draftIdx, '位置 ' + i);
    });
    check('默认不自动展开大纲', allText.indexOf('大纲正文') < 0, allText.slice(0, 200));

    // 点开关才展开：只展开原文时大纲仍不出现
    genApi.S.currentShowRaw = true;
    const rawPage = new El('div');
    genApi.renderGenDrafts(rawPage);
    const rawTextAll = collectText(rawPage, []).join('｜');
    check('只展开原文时能看到原文', rawTextAll.indexOf('模型原始输出') >= 0 && rawTextAll.indexOf('nodes:') >= 0, rawTextAll.slice(0, 200));
    check('只展开原文时大纲仍收起', rawTextAll.indexOf('大纲正文') < 0, rawTextAll.slice(0, 200));
    check('原文按钮变成收起原文', rawTextAll.indexOf('收起原文') >= 0);

    genApi.S.currentShowRaw = false;
    genApi.S.currentShowOutline = true;
    const outPage = new El('div');
    genApi.renderGenDrafts(outPage);
    const outTextAll = collectText(outPage, []).join('｜');
    check('展开大纲时能看到大纲', outTextAll.indexOf('大纲正文') >= 0);
    check('展开大纲时不带出原文', outTextAll.indexOf('模型原始输出') < 0, outTextAll.slice(0, 200));
    // 点了「展示大纲」就直接摊开，不许再套一层折叠块（2026-11-04 危晓要求：
    // 当前事件的展示大纲后不该还能选择是否折叠）
    check('当前事件大纲点了就摊开', findAllByClass(outPage, 'eo-details').length === 0,
        '还有 ' + findAllByClass(outPage, 'eo-details').length + ' 个折叠块');

    // 调试模式关着时不该有原文入口
    genApi.S.currentShowOutline = false;
    genApi.__setDebug(false);
    const noDbgPage = new El('div');
    genApi.renderGenDrafts(noDbgPage);
    const noDbgText = collectText(noDbgPage, []).join('｜');
    check('调试模式关时当前事件没有展示原文', noDbgText.indexOf('展示原文') < 0, noDbgText.slice(0, 200));
}

// ---------- 盘点页与日志页 ----------
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
    'const attachHelp = (n) => { n.appendChild(el("span", "eo-help", "?")); return n; };',
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
        // 复制全部不再挂问号（2026-11-02 危晓要求）：按钮所在的按钮行里不该有帮助标记
        const copyBtn = (function find(node) {
            if (!node) return null;
            if (node.tagName === 'BUTTON' && String(node.textContent || '').indexOf('复制全部') >= 0) return node;
            for (const c of (node.children || [])) { const hit = find(c); if (hit) return hit; }
            return null;
        })(logPage);
        check('复制全部按钮存在', !!copyBtn);
        if (copyBtn && copyBtn.parentNode) {
            const acts = copyBtn.parentNode;
            const helpMarks = (acts.children || []).filter(c => c.className && String(c.className).indexOf('eo-help') >= 0);
            check('复制全部没有问号', helpMarks.length === 0, '按钮行里有 ' + helpMarks.length + ' 个帮助标记');
        }

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
