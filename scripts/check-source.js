// 源码检查：版本号两处一致、OOC 词完整、渲染函数无残引用、渲染循环无裸 return。
// 跑法：在仓库根执行 node scripts/check-source.js
//
// 2026-11-02 拆仓：原 check-docs.js 里与文档有关的部分搬到了文档仓库（docs-repo/scripts/check-docs.js）。
// 留在本仓库的是「只看代码」的检查，外加一项跨仓库可选检查：
// 比对文档头部版本行与 manifest.version——EO_DOCS_DIR 指向文档仓库根目录时用该路径，
// 未设置则自动探测兄弟目录 ../docs-repo；两处都找不到就跳过并提示，不算失败
// （单独 clone 源码仓库时文档仓库不在手边，属正常）。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const idxPath = path.join(root, 'src', 'event-outline', 'index.js');
const mfPath = path.join(root, 'src', 'event-outline', 'manifest.json');

let problems = 0;
function fail(msg) { console.log('[问题] ' + msg); problems++; }
function ok(msg) { console.log('[ok]   ' + msg); }

// ---- 1. 关键文件在 ----
for (const f of ['src/event-outline/manifest.json', 'src/event-outline/index.js', 'scripts/deploy.sh', 'scripts/remote-sync.sh']) {
    if (fs.existsSync(path.join(root, f))) ok('存在 ' + f);
    else fail('缺失 ' + f);
}

const idx = fs.readFileSync(idxPath, 'utf8');

// ---- 2. 版本号两处一致 ----
let mv = '';
try {
    mv = String(JSON.parse(fs.readFileSync(mfPath, 'utf8')).version || '').trim();
} catch (e) {
    fail('manifest.json 读不出 version：' + e.message);
}
const verInCode = idx.match(/const VERSION = '([^']+)'/);
if (mv && verInCode && verInCode[1] === mv) ok(`版本一致 manifest=${mv} code=${verInCode[1]}`);
else fail(`版本不一致 manifest=${mv} code=${verInCode && verInCode[1]}`);

// ---- 3. 代码里 OOC 词的关键段落是否完整（防截断）----
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

// ---- 4. 渲染函数里引用了未定义的局部变量（防「按钮不出现」这类运行时崩溃）----
// 2026-10-30 实测踩到：改「偏好不折叠」时留下 page.appendChild(det)，det 在那个分支不存在，
// 整个 renderGenPage 抛 ReferenceError，生成按钮永远渲染不出来，而单元测试抓不到。
// 这里对每个 render* / build* 函数做一次粗略的「使用前是否在当前函数内声明」检查。
{
    const lines = idx.split(/\r?\n/);
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

// ---- 5. 渲染循环里不许裸 return（2026-11-01 实测：点编辑整页空白）----
// return 会跳出整个 for/forEach 回调，后面的事件全不渲染；
// 想跳过当前项只能用 continue。只有字符串里的 return 和真正的 return false/值 才放过。
{
    const idxSrc = idx.split(/\r?\n/);
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

// ---- 6. 与文档仓库的版本行比对（EO_DOCS_DIR 优先，否则探测兄弟目录 ../docs-repo）----
{
    const docsDir = process.env.EO_DOCS_DIR
        ? path.resolve(process.env.EO_DOCS_DIR)
        : path.resolve(root, '..', 'docs-repo');
    if (!fs.existsSync(docsDir)) {
        ok(`跳过文档版本比对（既未设置 EO_DOCS_DIR，兄弟目录也没有 docs-repo：${docsDir}）`);
    } else if (!mv) {
        // manifest 版本都没读到，前面已经报错，这里不再重复
        ok('跳过文档版本比对（manifest 版本未知）');
    } else {
        const docs = ['需求.md', '设计.md', '决策记录.md', '设计-记忆插件适配-shujuku.md', '规范.md', 'README.md'];
        let bad = 0;
        for (const f of docs) {
            const p = path.join(docsDir, f);
            if (!fs.existsSync(p)) { fail('文档仓库缺 ' + f); bad++; continue; }
            const head = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 8).join('\n');
            const m = head.match(/版本[:：]\s*([0-9]+\.[0-9]+\.[0-9]+)/);
            if (!m) { fail(`${f} 头部没有「版本：x.y.z」行`); bad++; }
            else if (m[1] !== mv) { fail(`${f} 版本 ${m[1]} 与 manifest ${mv} 不一致`); bad++; }
        }
        if (!bad) ok(`${docs.length} 份文档版本号与 manifest ${mv} 一致`);
    }
}

console.log('');
console.log(problems === 0 ? '源码检查全部通过' : problems + ' 处问题');
process.exit(problems === 0 ? 0 : 1);
