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
// checkOutlineQuality 里带花括号，用配平扫描取完整函数体，正则截不准
const qualitySrc = (() => {
    const s = src.indexOf('function checkOutlineQuality');
    let i = src.indexOf('{', s), d = 0, e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return src.slice(s, e);
})();

// 节点字段统一读取，checkOutlineQuality 依赖
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

const runner = new Function('exports', `// 日志函数在扩展里是模块级函数，测试沙箱里补成空实现（这里只测解析逻辑）
function log() {}
function warn() {}
function error() {}
function debug() {}
${src.match(/function extractCodeBlock[\s\S]*?\n    }/)[0]}
${src.match(/function parseSimpleYaml[\s\S]*?\n    }\n\n    function parseOutline/)[0].replace(/\n\n    function parseOutline[\s\S]*$/, '')}
${src.match(/function parseOutline[\s\S]*?\n    }/)[0]}
${src.match(/function parseInventory[\s\S]*?\n    }/)[0]}
${qualitySrc}
${nodeHelpersSrc}
exports.extractCodeBlock = extractCodeBlock;
exports.parseSimpleYaml = parseSimpleYaml;
exports.checkOutlineQuality = checkOutlineQuality;
exports.nodeText = nodeText;
exports.nodeTrigger = nodeTrigger;
exports.nodeId = nodeId;
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

// ---- 大纲完整性检查 ----
// 这套检查存在的理由：块标量那个 bug 把 nodes 整块吞掉，当时只落一句 warn，
// 事件卡看起来跟正常的一样，用户以为「就是这么设计的」。现在结构缺陷要能自报。
{
    const good = {
        event_brief: '简介', core_truth: '真相',
        nodes: [{ id: 1, type: '物证', info: '内容' }],
        min_nodes_for_deduction: [1],
        characters: { helpers: [{ name: '甲' }] },
    };
    const q = sandbox.checkOutlineQuality(good);
    check('完整大纲判定通过', q.ok === true, JSON.stringify(q.missing));
    check('完整大纲统计正确', q.summary.includes('节点 1 个'), q.summary);
}
{
    // 块标量 bug 的真实产物：只有 4 个标量键
    const broken = { event_name: 'x', event_brief: '简介', event_type: '案件', core_truth: '真相' };
    const q = sandbox.checkOutlineQuality(broken);
    check('缺节点判定失败', q.ok === false);
    check('缺失项列出节点', q.missing.some(m => m.includes('nodes')), q.missing.join('；'));
    check('缺失项列出角色', q.missing.some(m => m.includes('characters')), q.missing.join('；'));
    check('缺失项列出推理节点', q.missing.some(m => m.includes('min_nodes_for_deduction')), q.missing.join('；'));
}
{
    const q = sandbox.checkOutlineQuality({ nodes: [], characters: {}, min_nodes_for_deduction: [] });
    check('空节点列表判定失败', q.ok === false);
    check('节点没有内容也报出', sandbox.checkOutlineQuality({
        event_brief: 'b', core_truth: 'c', min_nodes_for_deduction: [1], characters: { helpers: [] },
        nodes: [{ id: 1 }],
    }).missing.some(m => m.includes('没有内容')));
}
{
    // 实机回归：「入学首日」那次模型用 points_to 写节点正文，旧规则只认 info/desc/content，
    // 于是 8 个节点全被判成「没有内容」，事件详情页挂着红色警示
    const withPointsTo = {
        event_brief: 'b', core_truth: 'c', min_nodes_for_deduction: [1],
        characters: { helpers: [{ name: '甲' }] },
        nodes: [
            { id: 1, type: '环境', trigger: '走廊', points_to: '校规像普通女校', is_misleading: true, refute_by: [4] },
            { id: 2, type: '物证', trigger: '看证', points_to: '印位全空' },
        ],
    };
    const q = sandbox.checkOutlineQuality(withPointsTo);
    check('points_to 也算有内容', q.ok === true, JSON.stringify(q.missing));
    check('points_to 节点被正确识别', sandbox.nodeText(withPointsTo.nodes[0]) === '校规像普通女校');
}

console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
