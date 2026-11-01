// 隔离测试：验证世界书写入的核心防护逻辑，不依赖浏览器
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'src', 'event-outline', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

let fail = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log('[ok]   ' + name);
    } else {
        console.log('[FAIL] ' + name + (extra ? ' :: ' + extra : ''));
        fail++;
    }
}

// ---- 1. 关键函数存在 ----
const fns = [
    'hashString', 'entryFingerprint', 'snapshotForeignEntries',
    'verifyForeignEntriesUnchanged', 'nextUid', 'buildEntry',
    'parseChronicle', 'findChronicleSheet', 'resolveAdapter',
    'upsertEventEntry', 'deleteEventEntry', 'withWriteLock',
    'collectSheetsFromChat', 'detectShujukuMode',
];
for (const fn of fns) {
    const hasDef = new RegExp('function\\s+' + fn + '\\s*\\(').test(src);
    check('定义 ' + fn, hasDef);
}

// ---- 2. 取出纯函数做真实测试 ----
// 用 Function 构造器执行切片，模拟浏览器外的环境
const sandbox = {};
const runner = new Function('exports', `
const ENTRY_PREFIX = '▸事件｜';
const SHUJUKU_EXPORT_PREFIX = 'TavernDB-ACU-CustomExport-';
${src.match(/function hashString[\s\S]*?\n    }/)[0]}
${src.match(/function entryFingerprint[\s\S]*?\n    }/)[0]}
${src.match(/function isForeignManagedEntry[\s\S]*?\n    }/)[0]}
${src.match(/function snapshotForeignEntries[\s\S]*?\n    }/)[0]}
${src.match(/function verifyForeignEntriesUnchanged[\s\S]*?\n    }/)[0]}
${src.match(/function nextUid[\s\S]*?\n    }/)[0]}
${src.match(/function buildEntry[\s\S]*?\n    }/)[0]}
exports.hashString = hashString;
exports.entryFingerprint = entryFingerprint;
exports.isForeignManagedEntry = isForeignManagedEntry;
exports.snapshotForeignEntries = snapshotForeignEntries;
exports.verifyForeignEntriesUnchanged = verifyForeignEntriesUnchanged;
exports.nextUid = nextUid;
exports.buildEntry = buildEntry;
`);

try {
    runner(sandbox);
} catch (e) {
    console.log('[FAIL] 函数提取失败: ' + e.message);
    process.exit(1);
}

// ---- 3. 哈希稳定性 ----
const h1 = sandbox.hashString('测试内容');
const h2 = sandbox.hashString('测试内容');
const h3 = sandbox.hashString('测试内容2');
check('哈希同内容相同', h1 === h2, h1 + ' vs ' + h2);
check('哈希异内容不同', h1 !== h3);
check('哈希含长度', h1.split('-')[2] === '4', h1);

// ---- 4. 条目指纹 ----
const e1 = { content: 'aaa', comment: 'x', constant: true, disable: false, key: [] };
const e2 = { content: 'aaa', comment: 'x', constant: true, disable: false, key: [] };
const e3 = { content: 'bbb', comment: 'x', constant: true, disable: false, key: [] };
check('指纹同内容相同', sandbox.entryFingerprint(e1) === sandbox.entryFingerprint(e2));
check('指纹异内容不同', sandbox.entryFingerprint(e1) !== sandbox.entryFingerprint(e3));

// ---- 5. 外部条目快照（应跳过 ▸事件｜）----
const book = {
    entries: {
        0: { content: '设定A', comment: '普通条目' },
        1: { content: '设定B', comment: 'TavernDB-ACU-CustomExport-纪要-1' },
        2: { content: '我的', comment: '▸事件｜某个事件' },
    },
};
const snap = sandbox.snapshotForeignEntries(book);
check('快照跳过本扩展条目', snap.size === 1, 'size=' + snap.size + '（应只含普通条目）');
check('快照含普通条目', snap.has('0'));
check('快照排除shujuku导出', !snap.has('1'));
check('快照不含本扩展', !snap.has('2'));

// ---- 6. 校验：未改动应通过 ----
const after = JSON.parse(JSON.stringify(book));
after.entries[3] = { content: '新增的', comment: '▸事件｜另一个' };
const r1 = sandbox.verifyForeignEntriesUnchanged(snap, after);
check('新增本扩展条目 -> 校验通过', r1.ok === true, JSON.stringify(r1));

// ---- 7. 校验：改动外部条目应失败 ----
const bad = JSON.parse(JSON.stringify(book));
bad.entries[0].content = '被改了';
const r2 = sandbox.verifyForeignEntriesUnchanged(snap, bad);
check('外部条目被改 -> 校验失败', r2.ok === false, JSON.stringify(r2));

// ---- 8. 校验：shujuku 增删自己的条目应通过 ----
const sj = JSON.parse(JSON.stringify(book));
delete sj.entries[1];
sj.entries[9] = { content: '新导出的', comment: 'TavernDB-ACU-CustomExport-纪要-9' };
const r3 = sandbox.verifyForeignEntriesUnchanged(snap, sj);
check('shujuku增删自己的条目 -> 校验通过', r3.ok === true, JSON.stringify(r3));

// ---- 8b. 校验：外部条目被删除应失败 ----
const del = JSON.parse(JSON.stringify(book));
delete del.entries[0];
const r4 = sandbox.verifyForeignEntriesUnchanged(snap, del);
check('外部条目消失 -> 校验失败', r4.ok === false, JSON.stringify(r4));

// ---- 9. nextUid ----
check('nextUid 空书', sandbox.nextUid({ entries: {} }) === 0);
check('nextUid 连续', sandbox.nextUid({ entries: { 0: {}, 1: {}, 2: {} } }) === 3);
check('nextUid 断档', sandbox.nextUid({ entries: { 0: {}, 5: {} } }) === 6);

// ---- 10. buildEntry 关键字段 ----
const built = sandbox.buildEntry(7, '内容', '▸事件｜测试');
check('条目 constant=true', built.constant === true);
check('条目无 ignoreBudget', !('ignoreBudget' in built) || built.ignoreBudget === false);
check('条目 uid 正确', built.uid === 7);
check('条目 key 为空', Array.isArray(built.key) && built.key.length === 0);

// ---- 11. collectSheetsFromChat：应取最新快照，不能被旧楼层覆盖 ----
// 回归用例。shujuku 经典模式下每个 AI 楼层都存一份纪要表完整快照，逐层增长；
// 早期实现从新到旧遍历但无条件 result.set，结果被最早的残缺版本覆盖
// （异常应对女子高中实测：11 条被读成 3 条）。
function mkSheet(rows, name) {
    return { name: name || '纪要表', content: rows };
}
function mkMsg(sheetKey, sheet, seq) {
    return {
        TavernDB_ACU_IsolatedData: {
            '': {
                storageFrame: {
                    version: 2,
                    logEntries: [{ seq: seq || 1, operations: [{ sheetKey: sheetKey, sheet: sheet }] }],
                },
            },
        },
    };
}
const head = ['row_id', '编码索引', '时间跨度', '概览', '纪要', '重要对话'];
const rowOf = (n) => [String(n), 'AM000' + n, '2010-04-12', '概览' + n, '纪要' + n, ''];

// 楼层数组顺序 = 聊天顺序（旧的在前）。纪要表逐层增长：3、5、8 条
const chatFixture = [
    mkMsg('sheet_ji_yao_biao', mkSheet([head, rowOf(1), rowOf(2), rowOf(3)])),
    mkMsg('sheet_ji_yao_biao', mkSheet([head, rowOf(1), rowOf(2), rowOf(3), rowOf(4), rowOf(5)])),
    mkMsg('sheet_ji_yao_biao', mkSheet([head, rowOf(1), rowOf(2), rowOf(3), rowOf(4), rowOf(5), rowOf(6), rowOf(7), rowOf(8)])),
];

const sheetRunner = new Function('exports', `
const CHRONICLE_NAME = '纪要表';
// 被测代码里带了日志调用，测试沙箱给个空实现即可
const log = () => {};
const warn = () => {};
const error = () => {};
const debug = () => {};
// 节点字段统一读取（被测代码依赖）
const NODE_TEXT_KEYS = ['info', 'desc', 'content', 'points_to', 'point_to', 'pointsTo', 'detail', 'description', 'what', 'reveal'];
const NODE_TRIGGER_KEYS = ['trigger', 'keyword', 'keywords', 'trigger_keyword', 'when'];
function nodeText(n) {
    if (!n || typeof n !== 'object') return '';
    for (const k of NODE_TEXT_KEYS) { const v = n[k]; if (v != null && String(v).trim()) return String(v).trim(); }
    return '';
}
function nodeTrigger(n) {
    if (!n || typeof n !== 'object') return '';
    for (const k of NODE_TRIGGER_KEYS) {
        const v = n[k];
        if (v != null && String(v).trim()) return Array.isArray(v) ? v.join('、') : String(v).trim();
    }
    return '';
}
function nodeId(n) {
    if (!n || typeof n !== 'object') return null;
    const v = n.id != null ? n.id : n.index;
    return v == null ? null : Number(v);
}
function ctx() {
    return window.SillyTavern && window.SillyTavern.getContext
        ? window.SillyTavern.getContext()
        : null;
}
${src.match(/function collectSheetsFromChat[\s\S]*?\n    }/)[0]}
${src.match(/function findChronicleSheet[\s\S]*?\n    }/)[0]}
${src.match(/function parseChronicle[\s\S]*?\n    }/)[0]}
exports.collectSheetsFromChat = collectSheetsFromChat;
exports.findChronicleSheet = findChronicleSheet;
exports.parseChronicle = parseChronicle;
`);
const sheetBox = {};
global.window = { SillyTavern: { getContext: () => ({ chat: chatFixture }) } };
try {
    sheetRunner(sheetBox);
} catch (e) {
    console.log('[FAIL] 纪要函数提取失败: ' + e.message);
}
const gotSheets = sheetBox.collectSheetsFromChat();
const gotSheet = gotSheets.get('sheet_ji_yao_biao');
check('纪要表取到最新快照（8 条数据）', gotSheet && gotSheet.content.length - 1 === 8,
    '实际 ' + (gotSheet ? gotSheet.content.length - 1 : 'null') + ' 条');
const gotRows = sheetBox.parseChronicle(gotSheet);
check('解析出 8 条纪要', gotRows.length === 8, '实际 ' + gotRows.length);
check('最后一条是 AM0008', gotRows[7] && gotRows[7].code === 'AM0008', gotRows[7] && gotRows[7].code);
check('概览列解析正确', gotRows[0] && gotRows[0].summary === '概览1', gotRows[0] && gotRows[0].summary);
check('按 name 找到纪要表', !!sheetBox.findChronicleSheet(gotSheets));
delete global.window;

// ---- 12. 世界书条目筛选 ----
// 回归用例。生成事件时要自己拼世界书（generateRaw 不自动带），
// 但要剔除 shujuku 导出表、变量格式说明、本扩展事件条目、EJS 条件模板。
const wbSrc = src.match(/function shouldIncludeWorldEntry[\s\S]*?\n    }/)[0]
    + '\n' + src.match(/function pickWorldEntries[\s\S]*?\n    }/)[0]
    + '\n' + src.match(/function buildWorldBookBlock[\s\S]*?\n    }/)[0];
const wbBox = {};
new Function('exports', `
const ENTRY_PREFIX = '▸事件｜';
const SHUJUKU_EXPORT_PREFIX = 'TavernDB-ACU-CustomExport-';
${wbSrc}
exports.shouldIncludeWorldEntry = shouldIncludeWorldEntry;
exports.pickWorldEntries = pickWorldEntries;
exports.buildWorldBookBlock = buildWorldBookBlock;
`)(wbBox);

const mkEntry = (o) => Object.assign({
    constant: true, disable: false, comment: '', content: '内容', order: 100, uid: 0,
}, o);

check('蓝灯设定条目 -> 保留',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '世界总纲', content: '这是一个都市怪谈世界' })) === true);
check('绿灯条目 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ constant: false, comment: '触发词条目' })) === false);
check('disable 条目 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ disable: true, comment: '被关掉的' })) === false);
check('shujuku 导出条目 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '纪要-1', content: 'TavernDB-ACU-CustomExport-纪要-1\nAM0001' })) === false);
check('mvu 变量格式 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '[mvu_update]变量输出格式' })) === false);
check('变量列表 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '变量列表', content: 'stat_data.xxx' })) === false);
check('本扩展事件条目 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '▸事件｜石桥镇失踪案' })) === false);
check('EJS 条件模板 -> 剔除',
    wbBox.shouldIncludeWorldEntry(mkEntry({ comment: '多阶段人设', content: "<%_ if (x) { _%>人设<%_ } _%>" })) === false);

// 排序与截断
const picked = wbBox.pickWorldEntries({
    entries: {
        0: mkEntry({ uid: 0, order: 5, comment: '后', content: 'BBB' }),
        1: mkEntry({ uid: 1, order: 1, comment: '前', content: 'AAA' }),
        2: mkEntry({ uid: 2, order: 2, comment: '[mvu_update]x' }),
    },
});
check('筛选后剩 2 条', picked.entries.length === 2, '实际 ' + picked.entries.length);
check('按 order 升序', picked.entries[0].content === 'AAA' && picked.entries[1].content === 'BBB');
check('统计剔除数', picked.dropped === 1, '实际 ' + picked.dropped);

const wbBuilt = wbBox.buildWorldBookBlock(picked.entries, 0);
check('不限字数时全拼', wbBuilt.kept === 2 && wbBuilt.truncated === false);
check('拼接含条目名', wbBuilt.text.includes('〔前〕') && wbBuilt.text.includes('〔后〕'));
const capped = wbBox.buildWorldBookBlock(picked.entries, 12);
check('超上限截断', capped.kept === 1 && capped.truncated === true, JSON.stringify({ k: capped.kept, t: capped.truncated }));

// ---- 13. YAML 块标量解析 ----
// 回归用例。模型 routinely 用 `key: |` 写多行中文，旧解析器只把 "|" 当值，
// 后面所有内容全被吞掉，导致 nodes / characters 整块丢失。
const yamlBox = {};
{
    const start = src.indexOf('function parseSimpleYaml');
    let i = src.indexOf('{', start), depth = 0, end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    new Function('exports', src.slice(start, end) + '\nexports.p = parseSimpleYaml;')(yamlBox);
}

{
    const doc = [
        'event_name: 测试事件',
        'core_truth: |',
        '  第一行真相',
        '  第二行真相',
        'nodes:',
        '  - id: 1',
        '    type: 物证',
        '    info: 一个节点',
        '  - id: 2',
        '    type: 证言',
        '    info: 另一个节点',
        'min_nodes_for_deduction:',
        '  - 1',
    ].join('\n');
    const r = yamlBox.p(doc);
    check('块标量不吞后续键', Object.keys(r).includes('nodes'), '实际键 ' + Object.keys(r).join(','));
    check('块标量保留多行', String(r.core_truth).includes('第一行真相') && String(r.core_truth).includes('第二行真相'),
        JSON.stringify(r.core_truth));
    check('块标量后节点正常解析', Array.isArray(r.nodes) && r.nodes.length === 2, '实际 ' + (r.nodes && r.nodes.length));
    check('块标量后节点字段完整', r.nodes[0].info === '一个节点' && r.nodes[1].type === '证言');
    check('行内数组解出数字', JSON.stringify(r.min_nodes_for_deduction) === '[1]',
        JSON.stringify(r.min_nodes_for_deduction));
}

{
    // 折叠标量 > 应折成单行
    const r = yamlBox.p(['brief: >', '  这 是', '  一句话'].join('\n'));
    check('折叠标量折成一行', !String(r.brief).includes('\n'), JSON.stringify(r.brief));
}

// ---- 14. 大纲中文渲染 ----
const renderSrc = src.match(/function renderOutlineText[\s\S]*?\n    }\n/)[0];
const labelSrc = src.match(/const OUTLINE_KEY_LABEL = \{[\s\S]*?\n    \};/)[0];
const nodeTypeSrc = src.match(/const NODE_TYPE_LABEL = \{[\s\S]*?\n    \};/)[0];
const eventTypeSrc = src.match(/const EVENT_TYPE_LABEL = \{[\s\S]*?\n    \};/)[0];
const labelFnSrc = src.match(/function labelOf[\s\S]*?\n    }/)[0];
const renderBox = {};
const nodeHelpersSrc = (() => {
    const parts = ['NODE_TEXT_KEYS', 'NODE_TRIGGER_KEYS'].map((name) => {
        const s = src.indexOf('const ' + name);
        return src.slice(s, src.indexOf('];', s) + 2);
    });
    for (const fn of ['nodeText', 'nodeTrigger', 'nodeId']) {
        const s = src.indexOf('function ' + fn);
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        parts.push(src.slice(s, e));
    }
    return parts.join('\n');
})();
new Function('exports', `${labelSrc}\n${nodeTypeSrc}\n${eventTypeSrc}\n${labelFnSrc}\n${nodeHelpersSrc}\n${renderSrc}\nexports.render = renderOutlineText;`)(renderBox);

{
    const outline = {
        event_brief: '一句话说清',
        event_type: { primary: '社交博弈', secondary: ['规则悬疑'] },
        core_truth: '真正的隐情',
        nodes: [{ id: 1, type: '物证', trigger: '看背面', info: '空印位', consequence: '得知见习' }],
        min_nodes_for_deduction: [1],
        characters: { helpers: [{ name: '千夏', role: '班长', motive_detail: '维持班级秩序' }] },
        paths: [{ step: '开场', required_nodes: [1] }],
        forbidden: ['不得提前揭示'],
    };
    const text = renderBox.render(outline);
    check('渲染结果非空', !!text);
    check('不含英文字段名', !/event_brief|core_truth|min_nodes|characters|helpers|nodes/.test(text),
        text.slice(0, 200));
    check('含中文小节名', text.includes('一句话简介') && text.includes('信息节点') && text.includes('参与角色'));
    check('节点类型中文化', text.includes('〔物证〕'));
    check('角色分栏中文化', text.includes('助力者'));
    check('空大纲返回 null', renderBox.render(null) === null && renderBox.render({}) === null);
}

// ---- 15. 难度档位 ----
// 旧的「村中琐事/城镇委托/王国要务/禁忌事件」绑死奇幻中世纪，
// 改成通用档位并允许用户在设置里整组替换（有些角色卡自带分级）。
{
    const lvSrc = src.match(/const DEFAULT_DIFFICULTY_LEVELS = \[[\s\S]*?\];/)[0];
    const getLvSrc = (() => {
        const s = src.indexOf('function getDifficultyLevels');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const normSrc = (() => {
        const s = src.indexOf('function normalizePrefs');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const mapSrc = src.match(/const LEGACY_LEVEL_MAP = \{[\s\S]*?\};/)[0];

    let fake = { preset: { difficultyLevels: [] } };
    globalThis.__settings = fake;
    // 每次切换配置都同步写回沙箱读的变量
    const setFake = (v) => { fake = v; globalThis.__settings = v; };
    const lvBox = {};
    new Function('exports', `
const getSettings = () => __settings;
const PREF_GROUPS = [{ key: 'difficultyLevel' }];
const debug = () => {};
${lvSrc}
${mapSrc}
${getLvSrc}
${normSrc}
exports.getLevels = getDifficultyLevels;
exports.normalize = normalizePrefs;
`)(lvBox);
    globalThis.__settings = fake;

    check('空的自定义档位 -> 用默认档', lvBox.getLevels().length === 5, lvBox.getLevels().join(','));
    check('默认档不含奇幻词汇', !lvBox.getLevels().some(x => /村中|城镇|王国/.test(x)));

    fake = { preset: { difficultyLevels: ['F', 'E', 'D'] } };
    setFake(fake);
    check('自定义档位生效', lvBox.getLevels().join(',') === 'F,E,D', lvBox.getLevels().join(','));

    fake = { preset: { difficultyLevels: ['  ', ''] } };
    setFake(fake);
    check('全空白当作未设置', lvBox.getLevels().length === 5);

    fake = {};
    setFake(fake);
    check('没有 preset 字段不崩', lvBox.getLevels().length === 5);

    // 旧字段迁移
    const legacy = { commissionLevel: '城镇委托' };
    lvBox.normalize(legacy);
    check('旧字段 commissionLevel 迁移', legacy.difficultyLevel === '小麻烦', String(legacy.difficultyLevel));
    const unknown = { commissionLevel: '自定义旧档' };
    lvBox.normalize(unknown);
    check('未登记的旧档位原样保留', unknown.difficultyLevel === '自定义旧档');
    const withNew = { difficultyLevel: '重大危机', commissionLevel: '村中琐事' };
    lvBox.normalize(withNew);
    check('已有新字段时不覆盖', withNew.difficultyLevel === '重大危机');
    const wording = { difficultyLevel: '根据委托等级自行设定' };
    lvBox.normalize(wording);
    check('旧文案改成难度等级', wording.difficultyLevel === '根据难度等级自行设定', wording.difficultyLevel);
}

// ---- 16. 设置默认值补全 ----
// 老对话的 extension_settings 里没有后加的 worldbook / preset 字段，
// getSettings 不补的话 s.worldbook 是 undefined，读 .maxChars 直接抛异常
{
    const gsSrc = (() => {
        const s = src.indexOf('function getSettings');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const defSrc = src.match(/const DEFAULT_SETTINGS = \{[\s\S]*?\n    \};/)[0];

    const fakeCtx = { extensionSettings: { event_outline: { memory: { source: 'auto' } } } };
    const gsBox = {};
    new Function('exports', `
const MODULE = 'event_outline';
const ctx = () => __ctx;
${defSrc}
${gsSrc}
exports.get = getSettings;
`)(gsBox);
    globalThis.__ctx = fakeCtx;

    const s = gsBox.get();
    check('老设置补出 worldbook', !!s.worldbook, String(s.worldbook));
    check('worldbook.enabled 默认 true', s.worldbook.enabled === true);
    check('worldbook.maxChars 默认 30000', s.worldbook.maxChars === 30000, String(s.worldbook.maxChars));
    check('老设置补出 preset', !!s.preset);
    check('preset.difficultyLevels 默认空数组', Array.isArray(s.preset.difficultyLevels) && s.preset.difficultyLevels.length === 0);
    check('原有字段不被覆盖', s.memory.source === 'auto');

    // 用户已改过的值要保留
    globalThis.__ctx = {
        extensionSettings: {
            event_outline: { worldbook: { enabled: false, maxChars: 50000 }, preset: { difficultyLevels: ['F', 'E'] } },
        },
    };
    const s2 = gsBox.get();
    check('已改的 enabled 保留', s2.worldbook.enabled === false);
    check('已改的 maxChars 保留', s2.worldbook.maxChars === 50000, String(s2.worldbook.maxChars));
    check('已改的档位保留', s2.preset.difficultyLevels.join(',') === 'F,E');
}

// ---- 17. 危险/时间子项语义不重叠 ----
// 致死性(高)、失败后果(不可逆的惨重损失)、超时后果(角色死亡) 原本是三份互相加强的指令，
// 模型会理解成「要特别狠」。这里锁死三者的取值范围不许有语义重复。
{
    const groupsSrc = (() => {
        const s = src.indexOf('const PREF_GROUPS = [');
        let i = src.indexOf('[', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '[') d++;
            else if (src[i] === ']') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const subAuto = src.match(/const SUB_AUTO = '[^']*';/)[0];
    const box = {};
    new Function('exports', `${subAuto}\n${groupsSrc}\nexports.g = PREF_GROUPS;`)(box);
    const byKey = {};
    for (const g of box.g) byKey[g.key] = g;

    const opts = (k) => (byKey[k].options || []).filter(o => o !== '__eo_sub_auto__');

    check('致死性不再有「低/中/高」以外的暗示', opts('lethality').join(',') === '无,低,中,高', opts('lethality').join(','));

    check('失败后果不再写「不可逆的惨重损失」',
        !opts('failureConsequence').includes('不可逆的惨重损失'), opts('failureConsequence').join(','));
    check('失败后果改用「无法挽回的损失」',
        opts('failureConsequence').includes('无法挽回的损失'));

    check('超时后果不再含「角色死亡」',
        !opts('timeoutConsequence').some(o => o.includes('死亡')), opts('timeoutConsequence').join(','));
    check('超时后果改用「局势不可逆转」',
        opts('timeoutConsequence').includes('局势不可逆转'));

    check('容错率带次数说明，与后果轻重解耦',
        opts('tolerance').every(o => o.includes('（')), opts('tolerance').join(','));

    // 三项都要有语义边界说明
    check('致死性有边界说明', !!byKey.lethality.desc);
    check('失败后果有边界说明', !!byKey.failureConsequence.desc);
    check('容错率有边界说明', !!byKey.tolerance.desc);
    check('超时后果有边界说明', !!byKey.timeoutConsequence.desc);

    // prompt 里要明确禁止叠加
    check('prompt 含语义边界声明', src.includes('语义边界（重要）'));
    check('prompt 要求不要叠加', src.includes('不要叠加理解'));
}

// ---- 18. 旧子项取值迁移 ----
{
    const normSrc = (() => {
        const s = src.indexOf('function normalizePrefs');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const mapSrc = src.match(/const LEGACY_LEVEL_MAP = \{[\s\S]*?\};/)[0];
    const box = {};
    new Function('exports', `
const PREF_GROUPS = [];
const debug = () => {};
${mapSrc}
${normSrc}
exports.n = normalizePrefs;
`)(box);

    const old = { tolerance: '低', failureConsequence: '不可逆的惨重损失', timeoutConsequence: '角色死亡或不可逆损失', lethality: '高' };
    box.n(old);
    check('容错率旧值是「低」', old.tolerance === '低（一次即定局）', old.tolerance);
    check('失败后果旧值迁移', old.failureConsequence === '无法挽回的损失', old.failureConsequence);
    check('超时后果旧值迁移', old.timeoutConsequence === '局势不可逆转', old.timeoutConsequence);
    check('致死性「高」不被误迁移', old.lethality === '高', old.lethality);
}

// ---- 19. 时长与倒计时语义分离 + 新增形态项 ----
{
    const groupsSrc = (() => {
        const s = src.indexOf('const PREF_GROUPS = [');
        let i = src.indexOf('[', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '[') d++;
            else if (src[i] === ']') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const subAuto = src.match(/const SUB_AUTO = '[^']*';/)[0];
    const box = {};
    new Function('exports', `${subAuto}\n${groupsSrc}\nexports.g = PREF_GROUPS;`)(box);
    const byKey = {};
    for (const g of box.g) byKey[g.key] = g;
    const opts = (k) => (byKey[k].options || []).filter(o => o !== '__eo_sub_auto__');

    // 倒计时 = 玩家知不知道有期限；时长 = 紧迫感。两者不许混
    check('倒计时选项表达「知不知道期限」',
        opts('timePressure').join('|').includes('不知道'), opts('timePressure').join('|'));
    check('倒计时不再用 隐藏/可见 这类含糊词',
        !opts('timePressure').includes('隐藏') && !opts('timePressure').includes('可见'));
    check('时长选项表达紧迫感', opts('timeDuration').join(',') === '宽松,适中,紧张', opts('timeDuration').join(','));
    check('倒计时有边界说明指向时长', (byKey.timePressure.desc || '').includes('时长'));
    check('时长有边界说明指向倒计时', (byKey.timeDuration.desc || '').includes('倒计时'));

    // 四项新增形态配置
    for (const k of ['nodeCount', 'castScale', 'pacingStructure', 'linkPrevious']) {
        check(`新增项存在：${k}`, !!byKey[k], k);
        check(`新增项有选项：${k}`, opts(k).length >= 3, String(opts(k).length));
        check(`新增项不归入旧的三组：${k}`, !byKey[k].group, String(byKey[k].group));
    }

    check('节点数量给出具体区间', opts('nodeCount').some(o => /\d+-\d+/.test(o)), opts('nodeCount').join(','));
    check('与前事关联可选独立/承接/留伏笔',
        opts('linkPrevious').join(',') === '完全独立,承接已有线索,主动留下后续伏笔', opts('linkPrevious').join(','));

    // prompt 要把这四项当硬性的结构约束
    check('prompt 含事件形态段落', src.includes('事件形态（已在界面选定'));
    check('prompt 约束节点数量落区间', src.includes('输出的 nodes 数组长度要落在这个区间'));
}

// ---- 20. 每个偏好项都要有说明（小问号内容） ----
{
    const groupsSrc = (() => {
        const s = src.indexOf('const PREF_GROUPS = [');
        let i = src.indexOf('[', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '[') d++;
            else if (src[i] === ']') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const subAuto = src.match(/const SUB_AUTO = '[^']*';/)[0];
    const box = {};
    new Function('exports', `${subAuto}\n${groupsSrc}\nexports.g = PREF_GROUPS;`)(box);

    const missing = box.g.filter(g => !g.desc || !String(g.desc).trim()).map(g => g.label);
    check('所有偏好项都有说明文字', missing.length === 0, missing.join('、') || '共 ' + box.g.length + ' 项');

    // 说明不能只是把选项名重复一遍
    const tooShort = box.g.filter(g => g.desc && String(g.desc).trim().length < 10).map(g => g.label);
    check('说明文字不是敷衍的短语', tooShort.length === 0, tooShort.join('、'));

    // 渲染层要真的把 desc 传给 makeSelect
    check('独立项传入 desc', /if \(g\.key === 'difficultyLevel'\) repaintAllGroups\(\);[\s\S]{0,120}?g\.desc\)/.test(src));
    check('子项渲染传入 desc', /prefs\[g\.key\] = v;\s*\},\s*g\.desc\)/.test(src));
    check('粗档位也有说明', src.includes('选一个粗档位，把本组'));
}

// ---- 21. 说明气泡点外部可关闭 ----
{
    check('存在统一的关闭函数', src.includes('function closeAllTips'));
    check('点外部关闭：捕获阶段监听 document', src.includes("document.addEventListener('click', onDocClickClose, true)"));
    check('点问号本身不被关闭逻辑拦截', src.includes("ev.target.closest('.eo-help')"));
    check('关闭时摘掉监听，避免累积',
        src.includes("document.removeEventListener('click', onDocClickClose, true)"));
    check('支持 Esc 关闭', src.includes("document.addEventListener('keydown', onEscClose, true)"));

    // 三处问号都必须走同一个实现，不许再各写一套
    check('打勾模式用统一实现', /attachHelp\(trSec,/.test(src));
    check('历史保留用统一实现', /attachHelp\(retSec,/.test(src));
    check('偏好项用统一实现', /attachHelp\(lab, desc, true\)/.test(src));

    const manual = (src.match(/const (trHelp|retHelp) = el\('span', 'eo-help', '\?'\)/g) || []).length;
    check('不再有手写的问号实现', manual === 0, String(manual));

    // attachHelp 必须在模块级（两个页面函数之外），否则设置页调不到
    const genIdx = src.indexOf('function renderGenPage');
    const setIdx = src.indexOf('function renderSetPage');
    const helpIdx = src.indexOf('function attachHelp');
    check('attachHelp 在模块级', helpIdx < genIdx && helpIdx < setIdx, `help@${helpIdx} gen@${genIdx} set@${setIdx}`);
}

// ---- 22. 占位符不许漏到界面 ----
// SUB_AUTO 是内部标记，渲染时必须换成「自行设定」文案。
// 独立项曾经直接拿 g.options 用，导致下拉框显示成 __eo_sub_auto__
{
    check('独立项会把 SUB_AUTO 换成文案', src.includes('o === SUB_AUTO ? autoByText(prefs) : o'));
    check('不再直接透传 g.options 到界面', !/[:?]\s*g\.options;\s*\n\s*const row = el/.test(src));

    // 逐个独立项实测：渲染后不许含下划线占位符
    const groupsSrc = (() => {
        const s = src.indexOf('const PREF_GROUPS = [');
        let i = src.indexOf('[', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '[') d++;
            else if (src[i] === ']') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const subAuto = src.match(/const SUB_AUTO = '[^']*';/)[0];
    const box = {};
    new Function('exports', `${subAuto}\n${groupsSrc}\nexports.g = PREF_GROUPS;`)(box);

    const prefs = {};
    for (const g of box.g) prefs[g.key] = '__eo_sub_auto__';

    const leaks = [];
    for (const g of box.g) {
        if (g.group) continue;
        const opts = g.dynamic === 'difficulty'
            ? ['根据当前情况自行设定']
            : (g.options || []).map(o => (o === '__eo_sub_auto__' ? '根据当前情况自行设定' : o));
        if (opts.some(o => String(o).includes('__eo_sub_auto__'))) leaks.push(g.label);
    }
    check('所有独立项渲染后无占位符', leaks.length === 0, leaks.join('、'));

    // 组内子项本来就做了替换，再确认一次没有漏网的
    const groupedLeak = box.g.filter(g => g.group).filter(g =>
        (g.options || []).some(o => String(o).includes('__eo_sub_auto__') && o !== '__eo_sub_auto__'));
    check('组内子项无异常占位符', groupedLeak.length === 0, groupedLeak.map(g => g.label).join('、'));
}

// ---- 23. 生成与写入世界书分离（待选机制） ----
{
    check('存在待选上限常量', /const MAX_DRAFTS = 3;/.test(src));
    check('新事件默认落成草稿', /status: 'draft'/.test(src));
    check('存在采用函数', src.includes('async function commitDraft'));
    check('存在丢弃函数', src.includes('function discardDraft'));

    // createEvent 里不许再直接写世界书
    const ceStart = src.indexOf('async function createEvent');
    const ceEnd = src.indexOf('async function commitDraft');
    const ceBody = src.slice(ceStart, ceEnd);
    check('createEvent 不再写世界书', !ceBody.includes('upsertEventEntry'), '仍包含 upsertEventEntry');
    check('createEvent 不再设为当前事件', !ceBody.includes('meta.currentEventId = id'));

    // commitDraft 才写世界书、才设为当前
    const cdEnd = src.indexOf('function discardDraft');
    const cdBody = src.slice(ceEnd, cdEnd);
    check('commitDraft 写世界书', cdBody.includes('upsertEventEntry'));
    check('commitDraft 设为当前事件', cdBody.includes('meta.currentEventId = id'));
    check('commitDraft 置为 active', cdBody.includes("event.status = 'active'"));
    check('有进行中事件时不许采用', cdBody.includes('还在进行中'));

    // 草稿不写世界书，丢弃就是纯本地删除
    check('discardDraft 不碰世界书', !src.slice(cdEnd, cdEnd + 700).includes('upsertEventEntry'));

    // 界面要有待选列表与三个按钮
    check('生成页渲染待选列表', src.includes('待选事件（'));
    check('有待选区样式', src.includes('.eo-drafts{'));
    check('待选项有采用按钮', src.includes("'采用'"));
    check('待选项有丢弃按钮', src.includes("'丢弃'"));
    check('待选项有展示大纲按钮', src.includes("'展示大纲'"));
}

// ---- 23.1 待选草稿可编辑（2026-11-01 追加） ----
{
    check('存在保存草稿编辑函数', src.includes('function saveDraftEdit('));
    check('存在大纲引用自检函数', src.includes('function checkOutlineRefs('));
    check('存在结构转 YAML 函数', src.includes('function outlineToYaml('));
    // 2026-11-01 改版：编辑 = 直接改大纲原文，保存时校验格式，不再走表单
    check('编辑框是可改的文本框', src.includes('eo-outline-editor'));
    check('编辑框行数字数实时显示', src.includes('eo-editor-stat'));
    check('有格式检查按钮', src.includes("'检查格式'"));
    check('表单那套已移除', !src.includes('function outlineToForm(') && !src.includes('function formToOutline('));

    const saveStart = src.indexOf('function saveDraftEdit(');
    const saveBody = src.slice(saveStart, saveStart + 3000);
    // 只能编草稿：已采用的大纲写进了世界书，中途改口径不可追溯
    check('只允许编辑 draft', saveBody.includes("event.status !== 'draft'"));
    // 只吃原文，不再接受结构对象（表单已删）
    check('保存只收原文', saveBody.includes('p.raw') && !saveBody.includes('p.outline'));
    check('保存后重新解析原文', saveBody.includes('parseOutline(rawText)'));
    check('解析结果整体替换 outline', saveBody.includes('event.outline = r.parsed'));
    check('保存不写世界书', !saveBody.includes('upsertEventEntry'));
    // 硬错（解析不出结构）必须拒绝保存，不能把坏内容落盘
    check('格式硬错拒绝保存', saveBody.includes('throw new Error') && saveBody.includes('fatal'));
    // 软错（编号跳号/引用对不上）只警告不拦
    check('引用问题只警告', saveBody.includes('checkOutlineRefs') && !/issues\.length\)?\s*throw/.test(saveBody));

    // ---- 硬错/软错的真实判定：抽 checkEditedRaw 跑一遍 ----
    const grabRaw = (() => {
        const s = src.indexOf('function checkEditedRaw(');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const box2 = {};
    new Function('exports', `
function log(){} function warn(){} function error(){} function debug(){}
function parseOutline(raw){ try { return { parsed: JSON.parse(raw) }; } catch (e) { return { parsed: {} }; } }
function checkOutlineRefs(){ return []; }
${grabRaw}
exports.f = checkEditedRaw;
`)(box2);
    const chk = box2.f;
    check('空内容判硬错', chk('').ok === false && chk('   ').ok === false);
    check('非 YAML 判硬错', chk('这不是 YAML').ok === false && chk('这不是 YAML').fatal.length > 0);
    check('没有信息节点判硬错', chk('{"event_name":"x"}').ok === false);
    check('合法结构不判硬错', chk('{"nodes":[{"id":1}]}').ok === true);
    check('硬错时没有软错列表', chk('坏内容').issues.length === 0);
    // 2026-11-01 实测踩到：编辑框里还套着 ```yaml 围栏，看着像英文；底色是浏览器默认深灰
    check('编辑框剥掉代码围栏', src.includes('function stripCodeFence('));
    check('保存时围栏包回去', src.includes('wrapCodeFence(keysToEnglish(buf.text, buf.backMap), buf.fenced)'));
    check('编辑框显示中文键', src.includes('function keysToChinese(') && src.includes('keysToChinese(stripped.text)'));
    check('保存前换回英文键', src.includes('function keysToEnglish(') && src.includes('keysToEnglish(buf.text, buf.backMap)'));
    // ---- 结构规范化：模型把键写成中文时，解析结果统一成英文 ----
    check('有规范化函数', src.includes('function normalizeOutline(') && src.includes('function normalizeKeys('));
    check('解析时就走规范化', src.includes('normalizeOutline(parseSimpleYaml(block))'));
    check('中文键表有主要字段', /事件名: 'event_name'/.test(src) && /信息节点: 'nodes'/.test(src) && /推进路径: 'paths'/.test(src));

    check('中文键表覆盖常用键', /event_name: '事件名'/.test(src) && /nodes: '信息节点'/.test(src) && /paths: '推进路径'/.test(src));
    check('编辑框有底色样式', /\.eo-outline-editor\{[^}]*background:#fffdf7/.test(src));
    check('编辑框用等宽字', /\.eo-outline-editor\{[^}]*monospace/.test(src));

    // ---- 面板页面不出滑动条（2026-11-02 危晓定）：整页只由浏览器窗口滚动 ----
    check('面板高度随内容生长', /#eo_panel\{[^}]*height:auto/.test(src));
    check('面板不裁剪溢出', /#eo_panel\{[^}]*overflow:visible/.test(src));
    check('正文区不自己滚动', /#eo_panel \.eo-body\{[^}]*overflow:visible/.test(src));
    check('内容框无高度上限', /\.eo-box\{[^}]*max-height:none/.test(src));
    check('面板页面里没有内嵌滚动条', !/\.eo-(body|box|logbox|draft-yaml|outline-editor)\{[^}]*overflow(-y)?:(auto|scroll|hidden)/.test(src));

    // ---- 待选事件按钮的文案与高亮（2026-11-02 危晓定）----
    check('看大纲改名为展示大纲', src.includes("'eo-btn' + (previewDraftId === d.id ? ' eo-on' : ''), '展示大纲'") && !src.includes("'看大纲'"));
    check('编辑按钮不再改名收起编辑', src.includes(", '编辑')") && !src.includes('收起编辑'));
    check('采用不高亮、按住才亮', src.includes("'eo-btn eo-press', '采用'") && /\n\.eo-btn\.eo-press:active\{[^}]*background/.test(src));
    check('丢弃同采用，按住才亮', src.includes("'eo-btn eo-press', '丢弃'"));
    check('展示大纲开着高亮', /previewDraftId === d\.id \? ' eo-on' : ''/.test(src) && /\.eo-btn\.eo-on\{[^}]*background/.test(src));

    // ---- 围栏剥离的真实往返 ----
    const grabFence = (n) => {
        const st = src.indexOf('function ' + n + '(');
        let i = src.indexOf('{', st), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(st, e);
    };
    const fbox = {};
    new Function('exports', grabFence('stripCodeFence') + grabFence('wrapCodeFence')
        + 'exports.s=stripCodeFence; exports.w=wrapCodeFence;')(fbox);
    const fencedRaw = ['```yaml', 'nodes:', '  - id: 1', '    info: A', '```', ''].join(String.fromCharCode(10));
    const st1 = fbox.s(fencedRaw);
    check('围栏被剥掉', st1.fenced === true && !st1.text.includes('```'));
    check('剥掉后首行是正文', st1.text.split(String.fromCharCode(10))[0] === 'nodes:');
    check('包回去与原文一致', fbox.w(st1.text, st1.fenced).trim() === fencedRaw.trim());
    const plainRaw = 'nodes:' + String.fromCharCode(10) + '  - id: 1';
    const st2 = fbox.s(plainRaw);
    check('无围栏时原样不动', st2.fenced === false && st2.text === plainRaw);

    // 缩进改乱时解析器很宽容，节点认不出来就必须拦，不能存成空壳
    check('保存也拦没有节点的内容', /一个信息节点都没有解析出来/.test(saveBody));
}

// ---- 24. 推进路径的字段名容错 ----
// 模型给的是 {step, node, route, must, risk, fail}，
// 早期渲染只认 desc/detail + failure，导致正文和失败后果都显示不出来
{
    const renderSrc = (() => {
        const s = src.indexOf('function renderOutlineText');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const box = {};
    new Function('exports', `
function log(){} function warn(){} function error(){} function debug(){}
${renderSrc}
exports.r = renderOutlineText;
`)(box);

    const out = box.r({
        paths: [
            { step: 1, node: 1, route: '千夏带路进教室', must: '必经', risk: '低', fail: '出门收证件 → 被当外人' },
            { step: '【大纲外】', route: '借口去盥洗室', why: '身体状态不稳允许离队', risk: '高', fail: '被发现落单' },
        ],
    });

    check('路径显示路线正文', out.includes('路线：千夏带路进教室'), '');
    check('路径显示必经过', out.includes('必经'), '');
    check('路径显示节点号', out.includes('节点 1'), '');
    check('路径显示失败后果（fail 键）', out.includes('失败后果：出门收证件'), '');
    check('大纲外分支显示存在理由', out.includes('存在理由：身体状态不稳'), '');
    check('数字 step 不当标题', !out.includes('1.（节点 1'), '');
    check('无独立标题时用路线首句兜底', out.includes('1. 千夏带路进教室'), '');

    // 老字段名仍要能用
    const out2 = box.r({ paths: [{ step: '开局', detail: '从门口开始', risk: '中', failure: '被抓' }] });
    check('旧字段 detail 仍可用', out2.includes('路线：从门口开始'), '');
    check('旧字段 failure 仍可用', out2.includes('失败后果：被抓'), '');
    check('字符串 step 当标题', out2.includes('开局'), '');
}

// ---- 25. 重置按钮 / 生成后保留选项 / 移除上下文统计 ----
{
    check('有重置为默认按钮', src.includes("'重置为默认'"));
    check('重置会清空草稿', /function resetDraftPrefs\(\)[\s\S]{0,200}draftPrefs = null/.test(src));
    check('重置会清空事件名', /function resetDraftPrefs\(\)[\s\S]{0,220}draftName = ''/.test(src));
    check('事件名存进草稿', src.includes('draftName = nameInput.value'));
    check('事件名从草稿回填', src.includes("nameInput.value = draftName || ''"));

    // 生成成功后不许重置：选项要停在生成时的那份
    const goStart = src.indexOf("btnGo.addEventListener");
    const goBody = src.slice(goStart, goStart + 2000);
    check('生成成功后不重置选项', !goBody.includes('resetDraftPrefs()'),
        '生成回调里仍有 resetDraftPrefs');

    // 上下文统计那块已经移除
    check('不再渲染上下文预览框', !src.includes('正在统计上下文'));
    check('不再有 refreshCtxPreview', !src.includes('refreshCtxPreview'));
    check('不再有记忆来源统计行', !src.includes('`记忆来源：${resolved.adapter.describe()}'),
        '仍存在该统计行');
    check('不再有 eo-ctx-preview 样式', !src.includes('.eo-ctx-preview{'));
}

// ---- 25.1 生成页表单落盘（2026-11-01 危晓要求）----
// 规矩：填好的配置在两项动作之外不能丢 —— 刷新、切页、关浏览器都要还在
{
    check('有表单落盘函数', src.includes('function persistGenForm('));
    check('有表单读回函数', src.includes('function loadGenForm('));
    check('有清空落盘函数', src.includes('function clearGenForm('));
    check('表单存进扩展设置', /genForm\s*=/.test(src));
    check('事件名变化即落盘', src.includes('draftName = nameInput.value; persistGenForm();'));
    check('事件目的变化即落盘', src.includes('prefs.goal = goalInput.value; persistGenForm();'));
    check('框架提示变化即落盘', src.includes('prefs.promptHint = hintInput.value; persistGenForm();'));
    check('额外要求变化即落盘', src.includes('prefs.extra = extraInput.value; persistGenForm();'));
    check('主类型变化即落盘', src.includes('prefs.eventMainType = mainSel.value; persistGenForm();'));
    check('次类型变化即落盘', /prefs\.eventSubTypes = Array\.from\(selSet\);[\s\S]{0,80}persistGenForm\(\)/.test(src));
    check('粗细模式变化即落盘', /groupMode\[g\.group\] = mk;[\s\S]{0,40}persistGenForm\(\)/.test(src));
    // 读回：模块变量为空时从存盘恢复
    const loadBody = src.slice(src.indexOf('function getDraftPrefs('), src.indexOf('function getDraftPrefs(') + 400);
    check('空表单时从存盘恢复', loadBody.includes('loadGenForm()'));
    const modeBody = src.slice(src.indexOf('function getGroupModes('), src.indexOf('function getGroupModes(') + 600);
    check('粗细模式从存盘恢复', modeBody.includes('saved.groupModes'));
    // 只有两个出口会清
    check('重置时清掉落盘', /function resetDraftPrefs\(\)[\s\S]{0,240}clearGenForm\(\)/.test(src));
    check('采用时清掉落盘', src.includes('clearGenFormOnAdopt()'));
    const commitBody = src.slice(src.indexOf('async function commitDraft('), src.indexOf('async function commitDraft(') + 2000);
    check('采用成功后清空表单', commitBody.includes('clearGenFormOnAdopt()'));

    // 重置按钮的问号移到按钮外面（危晓 2026-11-01 要求）
    const resetIdx = src.indexOf("const btnReset = el('button', 'eo-btn', '重置为默认')");
    const resetChunk = src.slice(resetIdx, resetIdx + 900);
    check('重置按钮里不再嵌问号', !resetChunk.includes('attachHelp(btnReset'),
        '问号仍挂在按钮上');
    check('问号挂在按钮外的行容器上', resetChunk.includes('attachHelp(rstRow'),
        'reset 行里没有 attachHelp(rstRow)');
}

// ---- 25.2 打勾模式说明不再标「当前」（2026-11-01 危晓要求）----
{
    check('说明里不再有「当前」标记', !src.includes("'eo-mode-cur'"),
        '仍会给当前档位挂标记');
    check('当前标记样式已删除', !src.includes('.eo-mode-cur{'));
    const modeIdx = src.indexOf('const modeList = el');
    const modeChunk = src.slice(modeIdx, modeIdx + 700);
    check('三档说明都会渲染', ["['auto', 'semi', 'manual']"].every(x => modeChunk.includes(x)),
        '循环明细变了，核对一下');
    check('下拉框仍显示当前档位', src.includes('trSel.value = s.tracker.mode'));
}

// ---- 26. 大纲正文的换行与排版 ----
// 大纲是 \n 拼出来的纯文本，容器必须有 white-space:pre-wrap，否则全挤成一行
{
    check('大纲样式存在', src.includes('.eo-outline-text{'));
    const styleChunk = src.slice(src.indexOf('.eo-outline-text{'), src.indexOf('.eo-outline-text{') + 300);
    check('大纲保留换行', styleChunk.includes('white-space:pre-wrap'), styleChunk.slice(0, 60));
    check('大纲保留缩进（pre-wrap 同时管缩进空格）', !styleChunk.includes('white-space:collapse'));
    check('大纲不再用限高的 eo-box', !/el\('div', 'eo-box'\)[\s\S]{0,60}outlineText/.test(src));

    // 两处渲染（待选预览、当前事件大纲）都用同一个样式类
    const usingOutlineText = (src.match(/el\('div', 'eo-outline-text'\)/g) || []).length;
    check('两处大纲渲染都用该样式', usingOutlineText >= 2, String(usingOutlineText));
}

// ---- 27. 中文字段名的容错 ----
// 模型有时整套换成中文键：角色用 名称/身份/动机，路径用 内容/节点/风险。
// 只认英文时角色全变「未命名」、路径全空
{
    const renderSrc = (() => {
        const s = src.indexOf('function renderOutlineText');
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    })();
    const box = {};
    new Function('exports', `
function log(){} function warn(){} function error(){} function debug(){}
function labelOf(k){ return k; }
${renderSrc}
exports.r = renderOutlineText;
`)(box);

    const out = box.r({
        characters: {
            '助力者': [{ '名称': '千夏', '身份': '2班班长', '动机': '职责与脸面', '条件或代价': '要跟着她走' }],
            '幕后方': [{ '名称': '这所学校', '掌握信息': '入校办理流程' }],
        },
        paths: [
            { step: 1, '内容': '千夏核对卡片，宣布带绫香走一圈。', '节点': '必经', '风险': '无' },
        ],
    });

    check('中文名可识别', out.includes('千夏') && !out.includes('未命名'), '');
    check('中文身份可识别', out.includes('（2班班长）'), '');
    check('中文动机可识别', out.includes('动机：职责与脸面'), '');
    check('条件或代价可识别', out.includes('条件或代价：要跟着她走'), '');
    check('中文掌握信息可识别', out.includes('掌握信息：入校办理流程'), '');
    check('中文内容当路线', out.includes('路线：千夏核对卡片'), '');
    check('中文节点里的「必经」当标记', out.includes('（必经）') && !out.includes('节点 必经'), '');
    check('中文路径不再出现空标题', !/^\s+1\. $/m.test(out), '');

    // 英文老键名仍要能用
    const out2 = box.r({
        characters: { '助力者': [{ name: '千夏', role: '班长', motive: '职责' }] },
        paths: [{ step: 1, route: '走廊', must: '必经', risk: '低', fail: '被抓' }],
    });
    check('英文字段仍然可用', out2.includes('千夏（班长）') && out2.includes('（必经）'), '');
    check('英文失败后果仍可用', out2.includes('失败后果：被抓'), '');
}

// ---- 28. prompt 里给出固定字段骨架 ----
{
    const s = src.indexOf('function buildOutlinePrompt');
    let i = src.indexOf('{', s), d = 0, e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    const body = src.slice(s, e);

    check('prompt 含 yaml 骨架', body.includes('```yaml'));
    check('骨架要求逐字照用', body.includes('字段名必须逐字照用'));
    check('骨架禁止改成中文键', body.includes('不许改写成中文'));
    check('骨架含角色 name', /-\s*name:\s*<角色名>/.test(body));
    check('骨架含角色 identity', /identity:\s*<身份>/.test(body));
    check('骨架含路径 route', /route:\s*<这一步发生什么>/.test(body));
    check('骨架含路径 must', /must:\s*<必经\|可跳过>/.test(body));
    check('骨架含时间压力', body.includes('time_pressure:'));
    check('骨架含危险程度', body.includes('danger:'));
    check('骨架说明大纲外写法', body.includes('step 填 "【大纲外】"'));
    check('骨架要求节点连续编号', body.includes('从 1 连续编号'));
}

// ---- 29. 字段名漂移检查 ----
{
    const s = src.indexOf('function checkOutlineQuality');
    let i = src.indexOf('{', s), d = 0, e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    const qSrc = src.slice(s, e);
    const box = {};
    new Function('exports', `
function log(){} function warn(){} function error(){} function debug(){}
const NODE_TEXT_KEYS = ['info','desc','content','points_to','detail','description','reveal'];
function nodeText(n){ for(const k of NODE_TEXT_KEYS){ if(n&&n[k]) return String(n[k]); } return ''; }
function nodeId(n){ return n && n.id != null ? Number(n.id) : null; }
${qSrc}
exports.q = checkOutlineQuality;
`)(box);

    // 按骨架写：无漂移
    const good = box.q({
        nodes: [{ id: 1, info: '内容' }],
        min_nodes_for_deduction: [1],
        event_brief: 'b', core_truth: 'c',
        characters: { '助力者': [{ name: '千夏', identity: '班长' }] },
        paths: [{ step: 1, node: 1, route: '走', must: '必经' }],
    });
    check('骨架写法无漂移', good.drift.length === 0, good.drift.join('；'));

    // 中文键：应报漂移
    const bad = box.q({
        nodes: [{ id: 1, info: '内容' }],
        min_nodes_for_deduction: [1],
        event_brief: 'b', core_truth: 'c',
        characters: { '助力者': [{ '名称': '千夏' }] },
        paths: [{ step: 1, '内容': '走', '节点': '必经' }],
    });
    check('中文角色名报漂移', bad.drift.some(x => x.includes('角色名')), bad.drift.join('；'));
    check('中文路径正文报漂移', bad.drift.some(x => x.includes('路径正文')), bad.drift.join('；'));
    check('缺 must 报漂移', bad.drift.some(x => x.includes('必经标记')), bad.drift.join('；'));

    // 漂移不影响 ok：渲染有容错，不该因此判失败
    check('漂移不判为失败', bad.ok === good.ok, '');
}

// ---- 30. 新键名在渲染层可读 ----
{
    const cut = (name) => {
        const s = src.indexOf('function ' + name);
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    };
    const box = {};
    new Function('exports', `
function log(){} function warn(){} function error(){} function debug(){}
function labelOf(k){ return k; }
const EVENT_TYPE_LABEL = {};
const NODE_TYPE_LABEL = {};
const NODE_TEXT_KEYS = ['info','desc','content','points_to','detail','description','reveal'];
const NODE_TRIGGER_KEYS = ['trigger'];
${cut('nodeId')}${cut('nodeText')}${cut('nodeTrigger')}${cut('renderOutlineText')}
exports.r = renderOutlineText;
`)(box);

    const out = box.r({
        event_brief: 'b',
        event_type: { '主类型': '探险探索', '次类型': ['社交博弈'] },
        nodes: [{ id: 1, type: '环境', trigger: '走出门', info: '内容' }],
        min_nodes_for_deduction: [1],
        characters: { '助力者': [{ name: '千夏', identity: '2班班长', motive: '职责', cost: '跟着走' }] },
        paths: [{ step: 1, node: 1, route: '走廊', must: '必经', risk: '低', fail: '被当外人' }],
        time_pressure: { '倒计时': '傍晚前', '超时后果': '挂账' },
        danger: { '致死性': '低' },
        forbidden: ['不得透露'],
    });

    check('事件类型中文键可读', out.includes('探险探索（兼 社交博弈）'), '');
    check('角色 identity 可读', out.includes('千夏（2班班长）'), '');
    check('时间压力会显示', out.includes('时间压力：') && out.includes('倒计时：傍晚前'), '');
    check('危险程度会显示', out.includes('危险程度：') && out.includes('致死性：低'), '');
}

// ---- 31. 条目位置定位（世界书被重排后仍能找到） ----
{
    const cut = (name) => {
        const s = src.indexOf('function ' + name);
        let i = src.indexOf('{', s), d = 0, e = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
        }
        return src.slice(s, e);
    };
    const box = {};
    new Function('exports', 'ENTRY_PREFIX',
        `${cut('commentNameOf')}${cut('commentMatchesEvent')}${cut('findEventEntryUid')}
exports.find = findEventEntryUid;
exports.match = commentMatchesEvent;
exports.nameOf = commentNameOf;
`)(box, '▸事件｜');

    const CHAT = '七情蛛网 - 2026-10-31';
    const makeBook = (entries) => ({ entries });

    // 记录 uid 正确时直接命中
    {
        const data = makeBook({
            49: { comment: `▸事件｜末潮回抽｜chatId=${CHAT}` },
        });
        const ev = { name: '末潮回抽', chatId: CHAT, entryUid: 49 };
        check('31.1 记录 uid 正确时直接命中', box.find(data, ev) === '49', box.find(data, ev));
    }

    // 记录 uid 被别人占了（真实事故：49 变成 shujuku 纪要，事件挪到 51）
    {
        const data = makeBook({
            49: { comment: 'TavernDB-ACU-CustomExport-纪要-包裹-下' },
            50: { comment: '▸事件｜测试条目（可删）' },
            51: { comment: `▸事件｜末潮回抽｜chatId=${CHAT}` },
        });
        const ev = { name: '末潮回抽', chatId: CHAT, entryUid: 49 };
        check('31.2 uid 被占时按 chatId+名字找到真实条目', box.find(data, ev) === '51', box.find(data, ev));
    }

    // 事件改过名，只能靠 chatId 认
    {
        const data = makeBook({
            51: { comment: `▸事件｜旧名字｜chatId=${CHAT}` },
        });
        const ev = { name: '新名字', chatId: CHAT, entryUid: 49 };
        check('31.3 改名后按 chatId 找到', box.find(data, ev) === '51', box.find(data, ev));
    }

    // 两个事件同 chatId 时不猜，避免删错别人的条目
    {
        const data = makeBook({
            51: { comment: `▸事件｜甲｜chatId=${CHAT}` },
            52: { comment: `▸事件｜乙｜chatId=${CHAT}` },
        });
        const ev = { name: '丙', chatId: CHAT, entryUid: 99 };
        check('31.4 同 chatId 多条时不乱猜', box.find(data, ev) === null, box.find(data, ev));
    }

    // 同名的另一个 chat 不能被我方抢走
    {
        const data = makeBook({
            51: { comment: '▸事件｜末潮回抽｜chatId=别人的对话' },
        });
        const ev = { name: '末潮回抽', chatId: CHAT, entryUid: 49 };
        check('31.5 不认别的对话下的同名事件', box.find(data, ev) === null, box.find(data, ev));
    }

    // 什么都没有时返回 null
    {
        const data = makeBook({ 1: { comment: '无关条目' } });
        const ev = { name: '末潮回抽', chatId: CHAT, entryUid: 49 };
        check('31.6 找不到时返回 null', box.find(data, ev) === null, box.find(data, ev));
    }

    // commentMatchesEvent：前缀、名字、chatId 三者都要对
    {
        check('31.7 前缀不符判否',
            box.match('普通条目｜chatId=' + CHAT, '末潮回抽', CHAT) === false, '');
        check('31.8 名字不符判否',
            box.match('▸事件｜别的名字｜chatId=' + CHAT, '末潮回抽', CHAT) === false, '');
        check('31.9 chatId 不符判否',
            box.match('▸事件｜末潮回抽｜chatId=别的', '末潮回抽', CHAT) === false, '');
        check('31.10 三者都对判真',
            box.match(`▸事件｜末潮回抽｜chatId=${CHAT}`, '末潮回抽', CHAT) === true, '');
    }

    // 老条目没写 chatId 时退回名字匹配，但必须唯一
    {
        const data = makeBook({
            51: { comment: '▸事件｜老事件' },
        });
        const ev = { name: '老事件', chatId: '新对话', entryUid: 99 };
        check('31.11 旧条目无 chatId 时按唯一名字找到', box.find(data, ev) === '51', box.find(data, ev));
    }
    {
        const data = makeBook({
            51: { comment: '▸事件｜老事件' },
            52: { comment: '▸事件｜老事件' },
        });
        const ev = { name: '老事件', chatId: '新对话', entryUid: 99 };
        check('31.12 同名两条时不按名字乱选', box.find(data, ev) === null, box.find(data, ev));
    }
}

console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
