// 文档完整性检查：核对文档中引用的路径是否存在、章节编号是否连贯
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const docDir = path.join(root, 'docs');

let problems = 0;
function fail(msg) { console.log('[问题] ' + msg); problems++; }
function ok(msg) { console.log('[ok]   ' + msg); }

// ---- 1. 所有文档存在 ----
// 协作文档只在本地存在，不入库；缺失不算错，存在就照常检查
const optional = ['docs/协作约定.md'];
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
for (const f of optional) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) ok('存在 ' + f + '（可选，未入库）');
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
        // 仓库外路径不检查：以 事务/运维/ 开头的是文档库其它目录
        if (ref.startsWith('事务/运维/') || ref.startsWith('/') || ref.includes(':')) continue;
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
if (fs.existsSync(path.join(root, 'docs/协作约定.md'))) checkSections('docs/协作约定.md');

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

// ---- 7.5 渲染循环里不许裸 return（2026-11-01 实测：点编辑整页空白）----
// return 会跳出整个 for/forEach 回调，后面的事件全不渲染；
// 想跳过当前项只能用 continue。只有字符串里的 return 和真正的 return false/值 才放过。
{
    const idxSrc = fs.readFileSync(path.join(root, 'src', 'event-outline', 'index.js'), 'utf8').split(/\r?\n/);
    let reported = 0;
    let loops = 0;
    for (let i = 0; i < idxSrc.length; i++) {
        const line = idxSrc[i];
        if (!/for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s/.test(line) && !/\.forEach\s*\(\s*(?:async\s*)?\(/.test(line)) continue;
        // 跳到循环体结束：跟踪花括号深度
        let depth = 0, started = false, end = i;
        for (let j = i; j < idxSrc.length; j++) {
            const l = idxSrc[j];
            for (const ch of l) {
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') { depth--; }
            }
            end = j;
            if (started && depth <= 0) break;
        }
        // 只认渲染列表的循环：循环体后面紧跟着往容器/页面 append
        const after = idxSrc.slice(i, Math.min(end + 3, idxSrc.length)).join('\n');
        if (!/(?:draftBox|page|listBox|container|wrap|body)\.append(?:Child)?\s*\(/.test(after)) { i = end; continue; }
        loops++;
        for (let k = i; k <= end; k++) {
            const cleaned = idxSrc[k].replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''");
            const t = cleaned.trim();
            if (!(/^return\s*;?$/.test(t) || /;\s*return\s*;$/.test(t))) continue;
            // 到这一行为止还没闭合的括号说明身处回调内部，那里的 return 不算
            const seg = idxSrc.slice(i, k).join('\n');
            let paren = 0;
            for (const ch of seg) { if (ch === '(') paren++; else if (ch === ')') paren--; }
            if (paren > 0) continue;
            fail(`index.js:${k + 1} 渲染循环里有裸 return，会用空白顶掉后面的事件（应改 continue）`);
            reported++;
        }
        i = end;
    }
    if (!reported) ok(`渲染循环里没有裸 return（检查 ${loops} 个列表循环）`);
}

// ---- 8.5 文档版本号必须跟 manifest 一致（2026-11-01 统一口径）----
// 以前文档用 v8/v11 自己的编号，代码用 0.1.2，两套号各走各的，对不上就没人发现。
// 现在一律以 src/event-outline/manifest.json 的 version 为准。
{
    const mf = path.join(root, 'src', 'event-outline', 'manifest.json');
    let mv = '';
    try {
        mv = String(JSON.parse(fs.readFileSync(mf, 'utf8')).version || '').trim();
    } catch (e) {
        fail('manifest.json 读不出 version：' + e.message);
    }
    if (mv) {
        let bad = 0;
        for (const f of mdFiles) {
            const head = fs.readFileSync(path.join(root, f), 'utf8').split('\n').slice(0, 8).join('\n');
            const m = head.match(/版本[:：]\s*([0-9]+\.[0-9]+\.[0-9]+)/);
            if (!m) {
                fail(`${f} 头部没有「版本：x.y.z」行`);
                bad++;
            } else if (m[1] !== mv) {
                fail(`${f} 版本 ${m[1]} 与 manifest ${mv} 不一致`);
                bad++;
            }
        }
        if (!bad) ok(`${mdFiles.length} 份文档版本号均为 ${mv}`);
    }
}

// ---- 9. 文档规模合理性（防截断）----
for (const f of mdFiles) {
    const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length;
    if (n < 15) fail(`${f} 只有 ${n} 行，疑似被截断`);
    else ok(`${f} ${n} 行`);
}

console.log('');
console.log(problems === 0 ? '文档完整性检查全部通过' : problems + ' 处问题');
process.exit(problems === 0 ? 0 : 1);
