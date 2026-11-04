// 在 Node 沙箱里真跑「编辑框改字 → 转回英文键 → 解析」这条保存路径。
// 2026-11-02 加：SIDE_CN is not defined 这个 bug 之所以活下来，是因为原来没有任何测试跑过 keysToEnglish。
// 静态断言只能证明某个名字出现过，证明不了这段代码跑得起来——这里是真执行。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'event-outline', 'index.js'), 'utf8');

let fail = 0;
function check(name, cond, extra) {
    console.log((cond ? '[ok]   ' : '[FAIL] ') + name + (!cond && extra ? ' :: ' + extra : ''));
    if (!cond) fail++;
}

// 取一个「名字 = 开头」到下一个顶层声明之间的块（含 const/let 与 function）
function takeConst(name) {
    const s = src.indexOf('const ' + name);
    if (s < 0) throw new Error('找不到 const ' + name);
    let i = src.indexOf('{', s), d = 0, e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return src.slice(s, e + 1);
}
function takeFunc(name) {
    const s = src.indexOf('function ' + name + '(');
    if (s < 0) throw new Error('找不到 function ' + name);
    let i = src.indexOf('{', s), d = 0, e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return src.slice(s, e + 1);
}

const NL_DECL = 'const NL = String.fromCharCode(10);';
const pieces = [NL_DECL, takeConst('OUTLINE_KEY_LABEL'), takeConst('CN_KEY_TO_EN'), takeConst('KEEP_AS_IS'),
    takeFunc('keysToChinese'), takeFunc('keysToEnglish')];

const sandbox = {};
const runner = new Function('exports', pieces.join('\n') + `
exports.keysToChinese = keysToChinese;
exports.keysToEnglish = keysToEnglish;
`);

try { runner(sandbox); } catch (e) {
    console.log('[FAIL] 提取或执行失败: ' + e.message);
    process.exit(1);
}

const { keysToChinese, keysToEnglish } = sandbox;

// ---- 1. 英文键大纲：转中文显示，改几个字，再转回英文 ----
const EN_YAML = [
    'event_name: 钟楼失窃',
    'event_brief: 圣物在换班时不见了',
    'nodes:',
    '  - id: n1',
    '    type: evidence',
    '    info: 换了封条的箱子',
    'characters:',
    '  helpers:',
    '    - name: 老铁匠',
    '      role: 助力者',
    '  obstructers:',
    '    - name: 税务官',
    '      reason: 不想声张',
].join('\n');

let cn = null;
try {
    cn = keysToChinese(EN_YAML);
    check('keysToChinese 跑得通', true);
} catch (e) {
    check('keysToChinese 跑得通', false, e.message);
}

if (cn) {
    check('英文键显示成中文', cn.text.includes('事件名:'), cn.text.slice(0, 80));
    check('立场键也转中文', cn.text.includes('助力者:'), '助力者没转');

    // 模拟用户在编辑框里改几个字（不动键名、不动缩进）
    const editedCn = cn.text.replace('圣物在换班时不见了', '圣物在换班时不见了，封条是新换的');
    check('改字后仍是中文键', editedCn.includes('事件名:'));

    let back = null;
    try {
        back = keysToEnglish(editedCn, cn.backMap);
        check('keysToEnglish 跑得通（SIDE_CN 类残留会让这里抛错）', true);
    } catch (e) {
        check('keysToEnglish 跑得通（SIDE_CN 类残留会让这里抛错）', false, e.message);
    }

    if (back) {
        check('键名换回英文', back.includes('event_name:'), back.slice(0, 80));
        check('改过的文字保留', back.includes('封条是新换的'), '改动丢了');
        check('缩进没被破坏', back.includes('\n  - id: n1'), '数组缩进坏了');
        check('role/identity 这类多对一的键还原成原稿那个',
            back.includes('role: 助力者'), back.includes('identity: 助力者') ? '被改成 identity 了' : '');
    }
}

// ---- 2. 模型原稿本来就是中文键：保存时必须原样留着，不许翻成英文 ----
const CN_YAML = ['内容: 有人在换班时动了手脚', '风险: 被发现'].join('\n');
const cn2 = keysToChinese(CN_YAML);
const back2 = keysToEnglish(cn2.text, cn2.backMap);
check('原稿的中文键保存后仍是中文', back2.includes('内容:'), back2);

// ---- 3. 没改过任何一个字的往返必须完全一致 ----
const round = keysToEnglish(keysToChinese(EN_YAML).text, keysToChinese(EN_YAML).backMap);
check('一字不改的往返完全一致', round === EN_YAML, '往返不一致');

// ---- 4. 编辑框里不许出现英文键（2026-11-02 危晓贴回的真实输出）----
// 那次的症状：外层「时间压力：」「危险程度：」是中文，里面的 countdown/duration/... 露着英文。
// 根因是中文键映射表收下了这些写法，显示用的 OUTLINE_KEY_LABEL 没跟上。现在整段逐一核对。
{
    const PRESSURE = [
        'time_pressure:',
        '  countdown: 明确。格雷夫当面定下后天出发',
        '  duration: 崖内以风起风歇为节拍',
        '  timeout_result: 天黑未归，按失败论',
        '  delay_cost: 每拖过一个风歇周期风势更满',
        'danger:',
        '  lethality: 高。第一次深入必死一次',
        '  failure: 一次失手便是断骨',
        '  tolerance: 低。权能本次只发动一次',
        '  threat_source: 崖腔深处的风核魔兽',
    ].join('\n');

    const shown = keysToChinese(PRESSURE).text;
    const stillEnglish = shown.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(l));
    check('编辑框里不再露英文键', stillEnglish.length === 0, '还露着：' + stillEnglish.join(' / '));
    check('外层键显示中文', shown.includes('时间压力:') && shown.includes('危险程度:'), shown);
    check('时间压力的子键显示中文',
        ['倒计时:', '时长:', '超时后果:', '拖延代价:'].every((k) => shown.includes(k)), shown);
    check('危险程度的子键显示中文',
        ['致死性:', '失败后果:', '容错率:', '威胁来源:'].every((k) => shown.includes(k)), shown);

    // 显示成中文之后，存回去还得是能解析的英文键
    const back = keysToEnglish(shown, keysToChinese(PRESSURE).backMap);
    check('存回去仍是英文键',
        ['time_pressure:', 'countdown:', 'threat_source:', 'failure:'].every((k) => back.includes(k)), back);
}


// ---- 5. 骨架全英文、显示表全覆盖（2026-11-02 危晓定：骨架英文、存储英文、只有展示中文）----
// 这一条是结构性的：任何人往骨架里塞中文键、或者加了英文键忘了给中文名，都会在这里失败。
{
    const body = src.slice(src.indexOf("const OUTLINE_KEY_LABEL = {"), src.indexOf("const NODE_TYPE_LABEL"));
    const labelKeys = new Set();
    for (const m of body.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'[^']+'/gm)) labelKeys.add(m[1]);

    // 骨架：单一真源 OUTLINE_SKELETON 常量（2026-11-04 A1 起骨架不再抄在 prompt 里）。
    // 以前是从 buildOutlinePrompt 里截 'event_name: <事件名>' 到收尾反引号；
    // 抽成常量后换个地方取，判据不变：骨架里不许有中文键，每个英文键都要有中文显示名。
    const c0 = src.indexOf("const OUTLINE_SKELETON = [");
    if (c0 < 0) { check('找到骨架常量', false, 'OUTLINE_SKELETON 没找到'); }
    const c1 = src.indexOf("].join(", c0);
    const skeleton = c0 >= 0 && c1 > c0 ? src.slice(c0, c1) : '';
    check('找到骨架常量', skeleton.length > 0);
    // 逐行剥掉行首的引号再取「键名:」，别拿整行去匹配——行首那个引号会把正则挡住
    // （第一版就是这么写的，结果把中文键塞进骨架它也不报错，反向验证才发现）
    const CN_CHAR = /[\u4e00-\u9fa5]/;
    const cnKeys = [];
    for (const raw of skeleton.split("\n")) {
        const l = raw.trim().replace(/^'/, '');
        const m = l.match(/^\s*(?:-\s+)?([^\s:][^:]*?)\s*:/);
        if (m && CN_CHAR.test(m[1])) cnKeys.push(m[1].trim());
    }
    check('骨架里没有中文键', cnKeys.length === 0, cnKeys.join(' | '));

    // 骨架里的每个英文键都要有中文显示名，否则编辑框里会露英文
    const skKeys = [...skeleton.matchAll(/^\s*'\s*(?:-\s+)?([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
    const missingLabel = [...new Set(skKeys)].filter((k) => !labelKeys.has(k));
    check('骨架键都有中文显示名', missingLabel.length === 0, '缺：' + missingLabel.join(', '));
}
console.log('');
console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
