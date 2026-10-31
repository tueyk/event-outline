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

console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
