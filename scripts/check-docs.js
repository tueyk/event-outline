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
    'docs/需求.md',
    'docs/设计.md',
    'docs/决策记录.md',
    'docs/设计-记忆插件适配-shujuku.md',
    'docs/规范.md',
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
checkSections('docs/需求.md');
checkSections('docs/设计.md');
checkSections('docs/决策记录.md');
checkSections('docs/设计-记忆插件适配-shujuku.md');
checkSections('docs/规范.md');

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

// ---- 7. 渲染函数里引用了未定义的局部变量（防「按钮不出现」这类运行时崩溃）----
// 2026-10-30 实测踩到：改「偏好不折叠」时留下 page.appendChild(det)，det 在那个分支不存在，
// 整个 renderGenPage 抛 ReferenceError，生成按钮永远渲染不出来，而单元测试抓不到。
// 这里对每个 render* / build* 函数做一次粗略的「使用前是否在当前函数内声明」检查。
{
    const lines = idx.split('\n');
    // 收集所有函数体范围（简单括号配平，够用）
    const funcs = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s{0,8}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
        if (!m) continue;
        let depth = 0, started = false, end = i;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') depth--;
            }
            if (started && depth === 0) { end = j; break; }
        }
        funcs.push({ name: m[1], start: i, end });
    }
    const watched = funcs.filter(f => /^(render|build|draw|mount)/.test(f.name));
    let reported = 0;
    for (const f of watched) {
        const body = lines.slice(f.start, f.end + 1).join('\n');
        // 收集本函数内声明过的名字：const/let/var 声明、参数、for-of 循环变量、catch 参数
        const declared = new Set();
        const addAll = (str) => {
            const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
            let m;
            while ((m = re.exec(str))) declared.add(m[1]);
            const re2 = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
            while ((m = re2.exec(str))) declared.add(m[1]);
            const re3 = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
            while ((m = re3.exec(str))) declared.add(m[1]);
        };
        addAll(body);
        // 函数参数
        const head = lines[f.start];
        const pm = head.match(/\(([^)]*)\)/);
        if (pm) for (const p of pm[1].split(',')) {
            const n = p.trim().split(/[=\s]/)[0];
            if (n && /^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
        }
        // 找本函数里对形如 xxx.appendChild / xxx.textContent 的调用，取 xxx
        const used = new Set();
        const reUse = /\b([a-z][\w$]*)\.(?:appendChild|addEventListener|textContent|className|classList|style|value)\b/g;
        let m;
        while ((m = reUse.exec(body))) used.add(m[1]);
        for (const u of used) {
            if (declared.has(u)) continue;
            // 排除模块级与全局常见对象
            if (/^(document|window|console|Math|JSON|Object|Array|String|Number|Promise|Date|Set|Map|localStorage|sessionStorage|element|this|context|globalThis|navigator|location|setTimeout|clearTimeout|alert|confirm|prompt|encodeURIComponent|decodeURIComponent)$/.test(u)) continue;
            // 模块级声明（在函数外的 const/let/var/function）
            const moduleLevel = new RegExp(`^(?:\\s*)(?:const|let|var|function)\\s+${u}\\b`, 'm');
            const outside = lines.slice(0, f.start).join('\n') + '\n' + lines.slice(f.end + 1).join('\n');
            if (moduleLevel.test(outside)) continue;
            fail(`${f.name}() 里用了未声明的局部变量 ${u}（疑似删掉分支后留下的残引用，运行时会让整个页面渲染崩溃）`);
            reported++;
        }
    }
    if (!reported) ok(`渲染函数未发现未声明局部变量（检查 ${watched.length} 个）`);
}

// ---- 8. 文档规模合理性（防截断）----
for (const f of mdFiles) {
    const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length;
    if (n < 15) fail(`${f} 只有 ${n} 行，疑似被截断`);
    else ok(`${f} ${n} 行`);
}

console.log('');
console.log(problems === 0 ? '文档完整性检查全部通过' : problems + ' 处问题');
process.exit(problems === 0 ? 0 : 1);
