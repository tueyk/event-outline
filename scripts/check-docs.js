// 文档完整性检查：核对文档中引用的路径是否存在、章节编号是否连贯
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const docDir = path.join(root, 'docs');

let problems = 0;
function fail(msg) { console.log('[问题] ' + msg); problems++; }
function ok(msg) { console.log('[ok]   ' + msg); }

// ---- 1. 所有文档存在 ----
const expected = [
    'README.md',
    'docs/需求-事件大纲扩展.md',
    'docs/设计-事件大纲扩展.md',
    'docs/决策记录-事件大纲扩展.md',
    'docs/设计-记忆读取-shujuku纪要.md',
    'docs/需求-OOC词自动化扩展.md',
    'docs/agent-runbook.md',
    'scripts/deploy.sh',
    'scripts/remote-sync.sh',
    'scripts/test-event-outline.js',
    'scripts/test-parser.js',
    'src/event-outline/manifest.json',
    'src/event-outline/index.js',
];
for (const f of expected) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) ok('存在 ' + f);
    else fail('缺失 ' + f);
}

// ---- 2. 文档内提到的 scripts/ 路径是否真实存在 ----
// 只检查指向本仓库的引用；酒馆源码里的路径（如 public/scripts/st-context.js）不算
const mdFiles = expected.filter(f => f.endsWith('.md'));
for (const f of mdFiles) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    // 排除前面带 public/ 或反引号内为酒馆源码的引用
    const refs = (text.match(/(?<!public\/)(?<!\w\/)scripts\/[a-zA-Z0-9_.-]+\.(sh|js)/g) || []);
    for (const ref of new Set(refs)) {
        if (ref === 'scripts/st-context.js') continue;  // 酒馆源码，不在本仓库
        const p = path.join(root, ref);
        if (fs.existsSync(p)) ok(`  ${f} 引用的 ${ref} 存在`);
        else fail(`${f} 引用了不存在的 ${ref}`);
    }
}

// ---- 3. 文档内引用的 docs/xxx.md 是否存在 ----
// 只检查仓库内的 .md 引用；仓库外（如 OOC 词原文）不检查
for (const f of mdFiles) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const refs = text.match(/`([^`]*\.md)`/g) || [];
    for (let ref of new Set(refs)) {
        ref = ref.replace(/`/g, '').trim();
        if (ref.includes('<') || ref.includes('*')) continue;
        // 仓库外路径不检查：以 运维/ 开头的是文档库其它目录
        if (ref.startsWith('运维/') || ref.startsWith('/') || ref.includes(':')) continue;
        const candidates = [
            path.join(root, ref),
            path.join(root, 'docs', ref),
            path.join(docDir, path.basename(ref)),
        ];
        if (candidates.some(c => fs.existsSync(c))) ok(`  ${f} 引用的 ${ref} 存在`);
        else fail(`${f} 引用了不存在的 ${ref}`);
    }
}

// ---- 4. 章节编号连贯性 ----
function checkSections(file) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split('\n');
    let h2 = 0;
    const seen = [];
    for (const line of lines) {
        const m = line.match(/^## (\d+)\./);
        if (m) {
            const n = Number(m[1]);
            seen.push(n);
            if (n !== h2 + 1) fail(`${file} 章节编号跳号：期望 ${h2 + 1}，实际 ${n}`);
            h2 = n;
        }
    }
    if (seen.length) ok(`${file} 章节 ${seen[0]}–${seen[seen.length - 1]} 连贯`);
    return seen;
}
checkSections('docs/需求-事件大纲扩展.md');
checkSections('docs/设计-事件大纲扩展.md');
checkSections('docs/决策记录-事件大纲扩展.md');
checkSections('docs/设计-记忆读取-shujuku纪要.md');

// ---- 5. 版本号一致性 ----
const mf = JSON.parse(fs.readFileSync(path.join(root, 'src/event-outline/manifest.json'), 'utf8'));
const idx = fs.readFileSync(path.join(root, 'src/event-outline/index.js'), 'utf8');
const verInCode = idx.match(/const VERSION = '([^']+)'/);
if (verInCode && verInCode[1] === mf.version) ok(`版本一致 manifest=${mf.version} code=${verInCode[1]}`);
else fail(`版本不一致 manifest=${mf.version} code=${verInCode && verInCode[1]}`);

// ---- 6. 代码里 OOC 词的关键段落是否完整（防截断）----
const needPhrases = [
    '暂停扮演。为即将开始的',
    '推进所需最少信息节点编号',
    'refute_by',
    'reveal: forbidden',
    '大纲外',
    '暂停扮演，做一次状态盘点',
];
for (const ph of needPhrases) {
    if (idx.includes(ph)) ok('OOC 词含「' + ph + '」');
    else fail('OOC 词缺「' + ph + '」');
}

// ---- 7. 文档规模合理性（防截断）----
for (const f of mdFiles) {
    const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length;
    if (n < 15) fail(`${f} 只有 ${n} 行，疑似被截断`);
    else ok(`${f} ${n} 行`);
}

console.log('');
console.log(problems === 0 ? '文档完整性检查全部通过' : problems + ' 处问题');
process.exit(problems === 0 ? 0 : 1);
