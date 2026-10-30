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

console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
