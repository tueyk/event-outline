// 测试 YAML 解析与盘点 JSON 解析
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'event-outline', 'index.js'), 'utf8');

let fail = 0;
function check(name, cond, extra) {
    console.log((cond ? '[ok]   ' : '[FAIL] ') + name + (!cond && extra ? ' :: ' + extra : ''));
    if (!cond) fail++;
}

const sandbox = {};
const runner = new Function('exports', `
// 日志函数在扩展里是模块级函数，测试沙箱里补成空实现（这里只测解析逻辑）
function log() {}
function warn() {}
function error() {}
function debug() {}
${src.match(/function extractCodeBlock[\s\S]*?\n    }/)[0]}
${src.match(/function parseSimpleYaml[\s\S]*?\n    }\n\n    function parseOutline/)[0].replace(/\n\n    function parseOutline[\s\S]*$/, '')}
${src.match(/function parseOutline[\s\S]*?\n    }/)[0]}
${src.match(/function parseInventory[\s\S]*?\n    }/)[0]}
exports.extractCodeBlock = extractCodeBlock;
exports.parseSimpleYaml = parseSimpleYaml;
exports.parseOutline = parseOutline;
exports.parseInventory = parseInventory;
`);

try { runner(sandbox); } catch (e) {
    console.log('[FAIL] 提取失败: ' + e.message);
    process.exit(1);
}

// ---- extractCodeBlock ----
check('提取 yaml 块',
    sandbox.extractCodeBlock('前言\n```yaml\nkey: 1\n```\n后记', 'yaml') === 'key: 1');
check('无语言块也能提取',
    sandbox.extractCodeBlock('```\nhello\n```', 'yaml') === 'hello');
check('无块返回 null', sandbox.extractCodeBlock('纯文本', 'yaml') === null);

// ---- YAML 基础 ----
const y1 = sandbox.parseSimpleYaml(`
event_type: 案件
core_truth: 村长是凶手
danger_level: 3
is_hard: true
empty_val: null
`);
check('YAML 字符串', y1.event_type === '案件', JSON.stringify(y1.event_type));
check('YAML 数字', y1.danger_level === 3, String(y1.danger_level));
check('YAML 布尔', y1.is_hard === true, String(y1.is_hard));
check('YAML null', y1.empty_val === null, String(y1.empty_val));

// ---- YAML 列表（对象） ----
const y2 = sandbox.parseSimpleYaml(`
nodes:
  - id: 1
    type: 物证
    keyword: 血迹
  - id: 2
    type: 证言
    keyword: 目击
`);
check('列表是数组', Array.isArray(y2.nodes), typeof y2.nodes);
check('列表长度 2', y2.nodes && y2.nodes.length === 2, y2.nodes && y2.nodes.length);
check('列表首项 id=1', y2.nodes && y2.nodes[0] && y2.nodes[0].id === 1, JSON.stringify(y2.nodes && y2.nodes[0]));
check('列表首项 type', y2.nodes && y2.nodes[0] && y2.nodes[0].type === '物证');
check('列表次项 keyword', y2.nodes && y2.nodes[1] && y2.nodes[1].keyword === '目击');

// ---- YAML 标量列表 ----
const y3 = sandbox.parseSimpleYaml(`
min_nodes: 
paths:
  - 直接质问
  - 暗中调查
`);
check('标量列表', Array.isArray(y3.paths), JSON.stringify(y3.paths));

// ---- YAML 注释 ----
const y4 = sandbox.parseSimpleYaml(`
event_type: 案件  # 这是注释
core_truth: 含#号的真相
`);
check('行尾注释被剥离', y4.event_type === '案件', JSON.stringify(y4.event_type));
check('引号内的#保留', y4.core_truth === '含#号的真相', JSON.stringify(y4.core_truth));

// ---- parseOutline 完整流程 ----
const rawOutline = `好的，这是大纲：

\`\`\`yaml
event_type: 案件
core_truth: 镇长私吞了赈灾粮
nodes:
  - id: 1
    type: 物证
    keyword: 账本
  - id: 2
    type: 证言
    keyword: 码头工人
min_nodes_for_deduction: [1, 2]
\`\`\`

希望对你有帮助。`;
const o = sandbox.parseOutline(rawOutline);
check('outline 解析出 event_type', o.parsed.event_type === '案件', JSON.stringify(o.parsed.event_type));
check('outline 解析出 core_truth', o.parsed.core_truth === '镇长私吞了赈灾粮');
check('outline nodes 数', o.parsed.nodes && o.parsed.nodes.length === 2, o.parsed.nodes && o.parsed.nodes.length);
check('outline 保留 raw', o.raw === rawOutline);
check('outline fromFallback=false', o.fromFallback === false);

// ---- parseOutline 无 fence 降级 ----
const o2 = sandbox.parseOutline('event_type: 谈判\ncore_truth: 对方缺钱');
check('无 fence 仍解析', o2.parsed.event_type === '谈判', JSON.stringify(o2.parsed));
check('无 fence 标记 fallback', o2.fromFallback === true);

// ---- parseInventory ----
const rawInv = `A. 已确认信息：
- 在 12 楼发现账本

\`\`\`json
{"triggeredNodes": [1,2], "refutedMisleads": ["假账本"], "offPathBranches": [{"desc":"夜探码头","reason":"玩家主动提出"}], "summary":"进展顺利"}
\`\`\``;
const inv = sandbox.parseInventory(rawInv);
check('盘点 JSON 解析', inv.structured !== null, 'null');
check('盘点 triggeredNodes', inv.structured && JSON.stringify(inv.structured.triggeredNodes) === '[1,2]',
    inv.structured && JSON.stringify(inv.structured.triggeredNodes));
check('盘点 offPathBranches', inv.structured && inv.structured.offPathBranches && inv.structured.offPathBranches.length === 1);
check('盘点保留原文', typeof inv.raw === 'string' && inv.raw.includes('账本'));

// ---- parseInventory 容错：尾逗号 ----
const invBad = '```json\n{"triggeredNodes": [1,2,],}\n```';
const inv2 = sandbox.parseInventory(invBad);
check('尾逗号容错', inv2.structured !== null && inv2.structured.triggeredNodes.length === 2,
    JSON.stringify(inv2.structured));

// ---- parseInventory 无 JSON ----
const inv3 = sandbox.parseInventory('只有文字报告，没有 JSON');
check('无 JSON 时不崩', inv3.structured === null && typeof inv3.raw === 'string');

console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
