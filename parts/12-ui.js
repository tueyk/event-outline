    // ==================== 11. 界面 ====================
    /** 建一个元素：标签、类名、文字。全文件都在用 */
    function el(tag, cls, text) {
        const d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text !== undefined) d.textContent = text;
        return d;
    }

    /**
     * 多行自适应输入框（2026-11-09 危晓：手机上一眼看完文字，不要只看得到开头几个字）。
     *
     * 为什么用 textarea 而不是 input：input 是单行框，内容超出只能横向滚动，
     * 手机上一屏永远只显示开头。textarea 会自动换行，配合下面的高度自适应，
     * 内容有几行就撑到几行。
     *
     * 高度自适应做法：先设 auto（让浏览器按内容算出自然高度）读 scrollHeight，
     * 再写死成 px。输入时重算一次。这个设置在手机浏览器上都支持，
     * 万一某处 height:auto 没生效，也还有 rows 兜底，不会变成一条细缝。
     */
        function autoGrow(ta) {
        const fit = () => {
            try {
                ta.style.height = 'auto';
                const h = ta.scrollHeight;
                if (h) ta.style.height = h + 'px';
                return h;
            } catch (e) {
                // 取不到高度就保持默认，不影响输入
                return 0;
            }
        };
        // 2026-11-10：原来只算一帧。但元素刚创建时还没插进 DOM、或落在收起的折叠块里，
        // 这时 scrollHeight 是 0，高度永远停在默认值，手机上照样只看得到开头几个字。
        // 所以算不出高度就往后补算，最多 10 帧，算到非零为止就收手。
        let tries = 0;
        const fitWhenReady = () => {
            if (fit() > 0) return;
            if (tries++ < 10 && typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(fitWhenReady);
            }
        };
        ta.addEventListener('input', fit);
        // 面板刚插进 DOM 时宽度还没定，算出来的高度不准，等一帧再算
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitWhenReady);
        else setTimeout(fitWhenReady, 0);
        return ta;
    }

    /** 造一个会自适应高度的多行输入框 */
    function elAuto(cls, value, placeholder) {
        const ta = el('textarea', 'eo-auto' + (cls ? ' ' + cls : ''));
        ta.value = String(value == null ? '' : value);
        if (placeholder) ta.placeholder = placeholder;
        ta.rows = 1;
        return autoGrow(ta);
    }

    let activeTab = S.activeTab; // 引用指向 S，值统一存 S
    // 正在编辑的待选事件 id；非空时该草稿展开成原文编辑框
    let editingDraftId = S.editingDraftId; // 引用指向 S，值统一存 S
    // 编辑框里的临时值：展开时从事件卡拷一份，取消或换一个草稿就丢
    let draftEditBuf = S.draftEditBuf; // 引用指向 S，值统一存 S
    // 上一次保存的自检警告（节点编号 / 引用对不上），显示在当前草稿下方
    let draftEditIssues = S.draftEditIssues; // 引用指向 S，值统一存 S

    /** 展开编辑时把大纲原文拷进编辑缓冲，之后只在缓冲上改，取消就不影响事件卡 */
    function makeDraftEditBuf(d) {
        const raw = String((d && d.outlineRaw) || '').trim();
        // 原文丢了（极老的卡）才从结构重建一份，正常永远走上面这条
        const text = raw || outlineToYaml((d && d.outline) || {});
        // 两步预处理，都只为好认好改，不改变落盘内容：
        //   1. 模型给的原文外面套着 yaml 代码围栏，只留里面的正文
        //   2. 英文键换成中文键（event_name → 事件名），缩进不动
        const stripped = stripCodeFence(text);
        const shown = keysToChinese(stripped.text);
        return {
            // 编辑框里显示的中文键版本
            text: shown.text,
            // 每行原本用的英文键，保存时按它还原，避免 role/identity 这类多对一的键被改写
            backMap: shown.backMap,
            // 打开时的样子，用来判断「有没有改过」
            original: shown.text,
            // 打开时有没有围栏，保存时照原样包回去
            fenced: stripped.fenced,
            rebuilt: !raw,
        };
    }

    /**
     * 拆掉 ```yaml 代码围栏，返回 {text, fenced}。
     * 只有整段被一对围栏完整包住才算，中间夹着围栏的（极罕见）原样不动。
     */
    function stripCodeFence(raw) {
        const s = String(raw || '');
        const m = s.match(/^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*\r?\n?[ \t]*$/);
        if (!m) return { text: s, fenced: false };
        return { text: m[1], fenced: true };
    }

    /** 保存时把围栏包回去，保证 outlineRaw 与模型原输出保持同一种形态 */

    // ---------- 键名中英互转 ----------

    /** 中文键 → 英文键。同一中文对应多个英文键时取第一个登记的 */
    const CN_KEY_TO_EN = (() => {
        const m = {};
        for (const [en, cn] of Object.entries(OUTLINE_KEY_LABEL)) {
            if (!m[cn]) m[cn] = en;
        }
        return m;
    })();

    /**
     * 转成正键名后要原样保留、不参与中英互转的键。
     * 现在没有例外项：立场键（助力者/阻碍者/知情者/幕后方）也照常转，
     * 转回时靠 backMap 还原成原稿的写法，不必特意保留英文。
     * 这个集合原名叫 SIDE_CN（2026-11-01 改名），当时 keysToEnglish 里漏改了一处引用，
     * 害得「保存编辑」每次保存都抛 ReferenceError，2026-11-02 才被发现；改名时务必全局搜旧名。
     */
    const KEEP_AS_IS = new Set();

    /**
     * 把大纲文本里的英文键换成中文，给编辑框显示用。
     * 只换行首的「键:」和「- 键:」这种键位，值里的英文（比如节点类型 testimony）不动。
     * 缩进原样保留，所以换键名不影响 YAML 结构。
     *
     * 多个英文键可能共用一个中文名（role / identity 都是「身份」），
     * 为了转回时能对上原稿，这里把每行原来用的英文键记在返回值里。
     */
    function keysToChinese(text) {
        const backMap = [];
        const out = String(text == null ? '' : text).split(NL).map((line) => {
            // 键名可以是英文也可以是中文（模型经常直接写中文键），两种都要认出来
            const m = line.match(/^(\s*(?:-\s+)?)([^\s:][^:]*?)(\s*:)([\s\S]*)$/);
            if (!m) { backMap.push(null); return line; }
            const key = m[2].trim();
            // 本来就是中文键：记下来，保存时原样保留，别翻成英文
            if (!/^[A-Za-z_]/.test(key)) { backMap.push('__CN__'); return line; }
            const cn = OUTLINE_KEY_LABEL[key];
            if (!cn || KEEP_AS_IS.has(key)) { backMap.push(null); return line; }
            backMap.push(key);
            return m[1] + cn + m[3] + m[4];
        }).join(NL);
        return { text: out, backMap };
    }

    /**
     * 保存前把中文键换回英文键，解析器和世界书只认英文。
     * 传了 backMap 就优先还原成该行原本用的英文键，保证多对一的键（role/identity）不被改写。
     */
    function keysToEnglish(text, backMap) {
        const lines = String(text == null ? '' : text).split(NL);
        return lines.map((line, idx) => {
            const m = line.match(/^(\s*(?:-\s+)?)([^\s:][^:]*?)(\s*:)([\s\S]*)$/);
            if (!m) return line;
            const name = m[2].trim();
            // 立场键（助力者/阻碍者/知情者/幕后方）不特殊处理：转成中文后靠 backMap 还原原稿写法。
            // 这里原来写的是 SIDE_CN.has(name)，那个集合在 2026-11-01 就被 KEEP_AS_IS 取代了，
            // 残留的引用让「保存编辑」每次都抛 ReferenceError——改动只走到这里，所以一直没被发现。
            if (KEEP_AS_IS.has(name)) return line;
            // 模型原稿里本来就是中文键，别翻成英文
            if (Array.isArray(backMap) && backMap[idx] === '__CN__') return line;
            // 这一行没改过键名，且原来就有英文键，直接还原成原来那个
            const orig = Array.isArray(backMap) ? backMap[idx] : null;
            if (orig && OUTLINE_KEY_LABEL[orig] === name) {
                return m[1] + orig + m[3] + m[4];
            }
            const en = CN_KEY_TO_EN[name];
            return en ? m[1] + en + m[3] + m[4] : line;
        }).join(NL);
    }
    /** 数一数还剩多少英文开头的键（中文换不回去的那种），保存后提示用 */
    function countEnglishKeys(text) {
        let n = 0;
        for (const line of String(text == null ? '' : text).split(String.fromCharCode(10))) {
            const m = line.match(/^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/);
            if (m) n++;
        }
        return n;
    }
    function wrapCodeFence(text, fenced) {
        const body = String(text == null ? '' : text);
        return fenced ? '```yaml\n' + body.replace(/\s+$/, '') + '\n```' : body;
    }

    /**
     * 草稿编辑框：整份大纲摊成一个可改的文本框，像改文档一样直接编辑。
     *
     * 不再拆成表单逐格填 —— 大纲几百行，按字段拆会拆散编号与引用的上下文，
     * 而改一句话、调一个编号这种动作本来就该在原文上做。
     *
     * 编辑缓冲只在内存里，取消就丢；点保存才写回事件卡，且不碰世界书。
     * 整个函数包一层 try：渲染一旦抛错，不能把整个待选列表拖成空白页。
     */
    function renderDraftEditor(d) {
        try {
            return buildDraftEditor(d);
        } catch (e) {
            error('渲染草稿编辑框失败：', e);
            const box = el('div', 'eo-draft-body eo-draft-edit');
            const bad = el('div', 'eo-bad-box', '⚠ 编辑框没渲染出来：' + (e && e.message || e)
                + '。点「编辑」退出，详情见日志页「错误」档。');
            box.appendChild(bad);
            return box;
        }
    }

    function buildDraftEditor(d) {
        const buf = S.draftEditBuf || makeDraftEditBuf(d);
        S.draftEditBuf = buf;
        const wrap = el('div', 'eo-draft-body eo-draft-edit');

        wrap.appendChild(el('div', 'eo-hint', '直接改下面的文字，像改文档一样。改完点「保存编辑」，'
            + '只作用于这份待选草稿，不碰世界书。格式改坏了会拒绝保存并告诉你哪儿坏了。'));

        if (buf.rebuilt) {
            wrap.appendChild(el('div', 'eo-warn', '这份草稿没存下原文，下面是从结构重建的，可能和当初生成的略有出入。'));
        }

        // ---------- 编辑区 ----------
        const ta = document.createElement('textarea');
        ta.className = 'eo-textarea eo-outline-editor';
        ta.spellcheck = false;
        ta.value = buf.text;
        ta.rows = 24;
        ta.addEventListener('input', () => { buf.text = ta.value; syncDirty(); });
        // Tab 键插两个空格，而不是跳走焦点 —— 大纲是缩进敏感的 YAML
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = ta.selectionStart, t = ta.selectionEnd;
                ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(t);
                ta.selectionStart = ta.selectionEnd = s + 2;
                buf.text = ta.value;
                syncDirty();
            }
        });
        wrap.appendChild(ta);

        // 行数 / 字数 / 是否改过，随时可见
        const stat = el('div', 'eo-hint eo-editor-stat');
        const paintStat = () => {
            const text = buf.text || '';
            const ls = text ? text.split('\n').length : 0;
            const changed = text !== buf.original;
            // 有改动时明确说「下面」——按钮行在编辑框底部，滚下去就有，别让人以为按钮消失了
            stat.textContent = ls + ' 行 · ' + text.length + ' 字'
                + (changed ? ' · 有未保存的改动，点下面的「保存编辑」' : '');
            stat.className = 'eo-hint eo-editor-stat' + (changed ? ' eo-editor-dirty' : '');
        };
        paintStat();
        ta.addEventListener('input', paintStat);        wrap.appendChild(stat);

        // ---------- 工具行 ----------
        // 按钮组按需重画：改了字就把尾部按钮换成提示条，免得「保存编辑」躲在编辑框外面看不见
        const tail = el('div', null);
        let warned = null;

        const btnCheck = el('button', 'eo-btn', '检查格式');
        btnCheck.type = 'button';
        btnCheck.addEventListener('click', () => {
            const r = checkEditedRaw(wrapCodeFence(keysToEnglish(buf.text, buf.backMap), buf.fenced));
            S.draftEditIssues = r.issues.length ? r.issues : null;
            repaintPage();
            if (!r.ok) log('格式检查未通过：' + r.fatal.join('；'));
            else if (!r.issues.length) log('格式检查通过，没有发现问题');
            else log('格式检查通过，但有 ' + r.issues.length + ' 条提醒');
        });

        const btnRebuild = el('button', 'eo-btn', '从结构重建');
        btnRebuild.type = 'button';
        btnRebuild.addEventListener('click', async () => {
            if (!(await askConfirm('用事件卡里已保存的结构重新生成文本？当前框里的改动会丢。'))) return;
            const rebuilt = keysToChinese(stripCodeFence(outlineToYaml(d.outline || {})).text);
            buf.text = rebuilt.text;
            buf.backMap = rebuilt.backMap;
            buf.original = rebuilt.text;
            S.pendingDraftEditDirty = false;
            repaintPage();
            log('已按结构重建编辑框内容');
        });

        const toolRow = el('div', 'eo-row');
        toolRow.appendChild(btnCheck);
        toolRow.appendChild(btnRebuild);
        wrap.appendChild(toolRow);

        const paintWarn = () => {
            if (warned) { warned.remove(); warned = null; }
            if (S.draftEditIssues && S.draftEditIssues.length) {
                warned = el('div', 'eo-warn', '格式提醒：' + S.draftEditIssues.join('；')
                    + '。这类问题不阻断保存，但节点跟踪可能对不上，建议修一下。');
                if (tail.parentNode) tail.parentNode.insertBefore(warned, tail);
                else wrap.appendChild(warned);
            }
        };

        // 底部按钮行常驻（2026-11-02 危晓反馈「有改动后找不到保存按钮」后改）。
        // 原来的做法是「一有未保存改动就把整排按钮撤掉、只留一句提示」，方向反了：
        // 改动那一刻正是最需要保存按钮的时候，撤回按钮等于在关键时刻把入口藏起来。
        // 而且编辑框 min-height 320px，手机上按钮行本就在视野外，一改字按钮又消失，
        // 用户只会看到底部那句「翻到编辑框底部就能保存」，按提示去了还是没有按钮。
        // 现在：按钮行始终在，只调主次——有改动时「保存编辑」是主按钮，没改动时只给「完成」。
        const paintTail = () => {
            tail.textContent = '';
            const btnRow = el('div', 'eo-row');
            const dirty = S.pendingDraftEditDirty;
            const btnSave = el('button', 'eo-btn' + (dirty ? ' eo-primary' : ''), '保存编辑');
            btnSave.type = 'button';
            // 没有改动时保存按钮照样在，但点它不会有任何效果，禁用掉免得误点以为存了什么
            btnSave.disabled = !dirty;
            btnSave.addEventListener('click', () => {
                try {
                    const res = saveDraftEdit(d.id, {
                        // 编辑框里是中文键，落盘前换回英文键——解析器和世界书只认英文
                        raw: wrapCodeFence(keysToEnglish(buf.text, buf.backMap), buf.fenced),
                    });
                    S.draftEditIssues = res.issues && res.issues.length ? res.issues : null;
                    discardPendingEdit();
                    S.previewDraftIds.add(d.id);
                    repaintPage();
                } catch (e) {
                    // 格式硬错：不保存、不退出编辑，把原文留在框里让人接着改
                    error('保存草稿编辑失败：', e);
                    S.draftEditIssues = [String(e && e.message || e)];
                    repaintPage();
                }
            });
            btnRow.appendChild(btnSave);

            const btnCancel = el('button', 'eo-btn', '取消');
            btnCancel.type = 'button';
            btnCancel.addEventListener('click', async () => {
                if (buf.text !== buf.original && !(await askConfirm('放弃这次编辑？改动不会保存。'))) return;
                discardPendingEdit();
                repaintPage();
            });
            btnRow.appendChild(btnCancel);

            // 没改动时额外给一个「完成」：看完了就关，不用翻回去点「编辑」。
            // 它和「取消」在无改动时效果一致，留着是因为「完成」比「取消」读起来更顺
            if (!dirty) {
                const btnDone = el('button', 'eo-btn', '完成');
                btnDone.type = 'button';
                btnDone.addEventListener('click', () => {
                    discardPendingEdit();
                    repaintPage();
                });
                btnRow.appendChild(btnDone);
            }
            tail.appendChild(btnRow);
        };

        // 状态一变就重画尾部，让「保存编辑」的主次跟着变动走（按钮本身始终在位）
        const syncDirty = () => {
            const now = buf.text !== buf.original;
            if (now === S.pendingDraftEditDirty) return;
            S.pendingDraftEditDirty = now;
            paintTail();
            paintStat();
        };
        paintWarn();
        paintTail();
        wrap.appendChild(tail);
        return wrap;
    }

    /**
     * 只检查不保存：返回 { ok, fatal[], issues[] }。
     * fatal 是格式坏到没法解析的硬错，issues 是编号跳号、引用不存在之类可继续的软错。
     */
    function checkEditedRaw(text) {
        const raw = String(text || '');
        if (!raw.trim()) return { ok: false, fatal: ['内容为空'], issues: [] };
        let parsed = null;
        try {
            parsed = parseOutline(raw).parsed;
        } catch (e) {
            return { ok: false, fatal: ['解析时抛出异常：' + (e && e.message || e)], issues: [] };
        }
        if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length) {
            return { ok: false, fatal: ['解析不出任何字段，这份内容不是合法的 YAML'], issues: [] };
        }
        // 与 saveDraftEdit 同一口径：没有信息节点也算硬错，否则存下去是空壳
        // （2026-11-05 M2 评审：nodes 在 structure 里，按顶层读会把每份新草稿都判成空壳）
        const n = innerNodesOf(parsed).length;
        if (!n) {
            return { ok: false, fatal: ['一个信息节点都没有解析出来，多半是 nodes 下面的缩进或破折号被改坏了'], issues: [] };
        }
        return { ok: true, fatal: [], issues: checkOutlineRefs(parsed) };
    }

    const TABS = [
        { key: 'gen', label: '生成事件' },
        { key: 'inv', label: '盘点' },
        { key: 'log', label: '日志' },
        { key: 'set', label: '设置' },
    ];

    /**
     * 页面渲染兜底（2026-11-10）。
     *
     * 起因：单事件页底部的「开始生成大纲」按钮在真机上没有出现，代码路径却是对的。
     * renderPanel 每次先 body.innerHTML = '' 再逐页渲染，中间任何一行抛错，
     * 后面那些元素就一个都不会被造出来，而且界面上一点痕迹都没有——
     * 用户只看到「内容渲染到一半就断了」，没有报错、没有按钮、也没有提示。
     * 那种错误只在控制台里看得到，手机上根本没法看。
     *
     * 所以每页渲染都包一层：真抛了就把它显示在页面上，别再静默断掉。
     */
    function renderPageSafe(page, label, fn) {
        try {
            fn();
        } catch (e) {
            try { error('渲染' + label + '页失败：', e); } catch (e2) { /* 日志本身出错也不影响下面的兜底 */ }
            const box = el('div', 'eo-warn');
            box.textContent = '「' + label + '」页渲染失败：' + (e && e.message || e)
                + '\n这多半是代码 bug，请把这一行连同页面截图一起反馈。';
            page.appendChild(box);
        }
    }


    function renderPanel() {
        const body = S.panelEl && S.panelEl.querySelector('#eo_body');
        if (!body) return;
        // 重建之前先把用户的位置记住：不清掉的话，点一个节点就从头再来一遍（C1 止血版）
        const view = captureView();
        body.innerHTML = '';

        // 面板重建后按钮和提示都是新造的，按当前 busy 状态恢复，否则切页回来就像没在忙。
        // 2026-11-10 修（评审 P1-7）：这里原来只写 textContent，把忙碌条里那个
        // 「放弃等待」按钮一起冲掉了——请求挂住时切个页签，唯一的出路就没了，
        // 只能刷新页面。改成走 setBusy 重建整块（文字 + 按钮），
        // 它本来就是造这块内容的唯一入口，不该在别处按半套逻辑拼一遍。
        // 第二个参数给 true：这次只恢复显示，不要顺带清掉进度列表。
        // 2026-11-10 批 3：重建时沿用原来的持有者，不另立新令牌——否则一重建就易主了
        if (S.busy) setBusy(true, true, null, S.busyOwner || null);

        const context = ctx();
        if (!context) {
            body.appendChild(el('div', 'eo-warn', '未取到酒馆上下文，扩展可能未正确加载。'));
            return;
        }

        // --- 标签栏 ---
        const tabBar = el('div', 'eo-tabs');
        for (const t of TABS) {
            const b = el('div', 'eo-tab' + (S.activeTab === t.key ? ' eo-tab-active' : ''), t.label);
            if (t.key === 'inv') {
                const ev = getCurrentEvent();
                if (ev && ev.status === 'active') {
                    const badge = el('span', 'eo-badge');
                    badge.textContent = String((ev.inventories || []).length);
                    b.appendChild(badge);
                }
            }
            // 日志页出错时挂红点：不能等人自己去翻日志才发现解析失败
            if (t.key === 'log' && S.unreadErrors > 0) {
                const badge = el('span', 'eo-badge eo-badge-err');
                badge.textContent = S.unreadErrors > 99 ? '99+' : String(S.unreadErrors);
                b.appendChild(badge);
            }
            makeActivatable(b, 'tab');
            b.setAttribute('aria-selected', S.activeTab === t.key ? 'true' : 'false');
            b.addEventListener('click', () => {
                S.activeTab = t.key;
                if (t.key === 'log') S.unreadErrors = 0;
                renderPanel();
            });
            tabBar.appendChild(b);
        }
        body.appendChild(tabBar);

        const page = el('div', 'eo-page');
        body.appendChild(page);

        // 2026-11-10：每页渲染都包一层兜底，抛错要显示出来，不能静默断在半截。
        // 起因见 renderPageSafe 的注释。
        if (S.activeTab === 'gen') renderPageSafe(page, '生成事件', () => renderGenPage(page));
        else if (S.activeTab === 'inv') renderPageSafe(page, '盘点', () => renderInvPage(page));
        else if (S.activeTab === 'log') {
            renderPageSafe(page, '日志', () => renderLogPage(page));
            // 切到日志页时再滚一次：此时元素已经挂到文档上，scrollHeight 才是真值
            requestAnimationFrame(() => {
                const lb = page.querySelector('.eo-logbox');
                if (lb) lb.scrollTop = lb.scrollHeight;
            });
        }
        else renderPageSafe(page, '设置', () => renderSetPage(page));


        // 内容重建完把它找回来
        restoreView(view);
    }

    // ---------- 问号说明气泡（生成页与设置页共用） ----------

    /** 关掉当前打开的所有说明气泡，同时摘掉全局监听 */
    function closeAllTips() {
        for (const tip of document.querySelectorAll('.eo-tip')) tip.remove();
        for (const on of document.querySelectorAll('.eo-help-on')) on.classList.remove('eo-help-on');
        document.removeEventListener('click', onDocClickClose, true);
        document.removeEventListener('keydown', onEscClose, true);
    }

    function onDocClickClose(ev) {
        // 点问号本身不在这里处理，交给它自己的 click，
        // 否则同一个点击会先关再开，看起来像没反应
        if (ev.target && ev.target.closest && ev.target.closest('.eo-help')) return;
        closeAllTips();
    }

    function onEscClose(ev) {
        if (ev.key === 'Escape') closeAllTips();
    }

    /**
     * 小问号：点一下展开说明，点别处或按 Esc 收起。
     * 说明文字存在 title 里，方便直接读取。
     */
    function attachHelp(host, text, inline) {
        const h = el('span', inline ? 'eo-help eo-help-inline' : 'eo-help', '?');
        h.title = text;
        h.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOn = h.classList.contains('eo-help-on');
            closeAllTips();
            if (wasOn) return;
            h.classList.add('eo-help-on');
            const tip = el('div', 'eo-tip');
            tip.textContent = text;
            h.appendChild(tip);
            // 延到下一轮再加监听，否则本次点击会立刻把它自己关掉。
            // 捕获阶段挂，点面板任意位置都能收到
            setTimeout(() => {
                document.addEventListener('click', onDocClickClose, true);
                document.addEventListener('keydown', onEscClose, true);
            }, 0);
        });
        host.appendChild(h);
        return h;
    }

    // ---------- 页：生成事件 ----------

    /**
     * 正在展开大纲的待选事件 id（2026-11-02 由单值改成集合）：
     * 待选最多 3 份，来回点只能看一份，比较两份 200 行的大纲得反复开合。
     * 现在可以同时展开，一份关掉只影响它自己。
     */
    let previewDraftIds = S.previewDraftIds; // 引用指向 S，值统一存 S

    /** 兼容旧判断：任意一份是否在预览 */
    function isPreviewing(id) { return S.previewDraftIds.has(id); }

    /* ---------- 草稿编辑框的「正在改」状态（2026-11-02）----------
       「编辑」按钮不随开合改文案，一直是「编辑」，开关只能靠高亮 + 编辑框底部的「完成」。
       所以编辑框一改字就把编辑框下面那组按钮（保存编辑/取消/完成）换成提示条，
       免得保存按钮躲在屏幕外面看不见。这个状态是模块级的：renderPanel 重建 DOM 也不会丢。 */
    let pendingDraftEditDirty = S.pendingDraftEditDirty; // 引用指向 S，值统一存 S

    function discardPendingEdit() {
        S.editingDraftId = null;
        S.draftEditBuf = null;
        S.draftEditIssues = null;
        S.pendingDraftEditDirty = false;
    }

    /** 编辑框开着、但还没改动：直接关，不用问 */
    async function closeDraftEditor() {
        if (S.pendingDraftEditDirty) {
            if (!(await askConfirm('这份草稿还有没保存的改动，关掉就丢了。继续？'))) return;
        }
        discardPendingEdit();
        repaintPage();
    }

    /**
     * 只重画当前页，不重建面板外壳、不动标签栏（2026-11-02 C1）。
     * 点一个节点、切一个日志筛选这类「本页自己的数据变了」的操作走这里：
     * 以前一律调 renderPanel()，等于把状态卡、待选列表、表单全部重建一遍，
     * 滚动和焦点也跟着丢。这里换掉的内容区不动，滚动位置天然保留。
     */
    function repaintPage() {
        const page = S.panelEl && S.panelEl.querySelector('#eo_body .eo-page');
        if (!page || !page.isConnected) { renderPanel(); return; }
        closeAllTips();
        const body = page.parentNode;
        const top = page.getBoundingClientRect().top;
        page.innerHTML = '';
        if (S.activeTab === 'gen') renderGenPage(page);
        else if (S.activeTab === 'inv') renderInvPage(page);
        else if (S.activeTab === 'log') renderLogPage(page);
        else renderSetPage(page);
        // 页面内容变化会让后面的内容整体上下移位，这里把页面顶端拉回原位，视觉上不跳
        const dy = page.getBoundingClientRect().top - top;
        if (dy && body && body.scrollTop != null) body.scrollTop += dy;
    }

    // ---------- M16 链的界面 ----------

    /**
     * 打开链骨架预览。骨架存在 S.chainDraft 里，面板重绘后还在。
     *
     * 每个节点的主类型给下拉可改：模型判断的类型不一定对，
     * 尤其节点 2 到底是战斗冲突还是生存危机，用户可能一眼就知道。
     */
    function openChainPreview(chain, problems, raw) {
        S.chainDraft = {
            chain,
            problems: problems || [],
            // 2026-11-09 危晓：调试模式下要能看链骨架的模型输出原文。
            // createChainSkeleton 本来就返回 raw，之前直接丢了。
            raw: String(raw || ''),
            rawOpen: false,
            chainId: 'chain_' + Date.now().toString(36),
            generated: [],       // 已生成的节点事件
            running: false,
            cur: 0,
        };
        // 2026-11-10 危晓要：新生成的骨架立刻存进对话，刷新页面不会丢。
        // 再次生成会覆盖上一个——只保存当前这一个，不留历史。
        saveChainDraft(S.chainDraft);
        S.activeTab = 'gen';
        renderPanel();
    }

    /**
     * 启动或切页时把存着的骨架读回内存。
     * 只处理「内存里还没有、存档里有」的情况：内存里有就别拿存档覆盖，
     * 那会把用户刚在这次会话里改的内容冲掉。
     */
    function restoreChainDraft() {
        if (S.chainDraft) return;
        const d = loadChainDraft();
        if (!d) return;
        // generated 里存的是 {id, pos} 快照，用的时候要按 id 回查真实事件对象，
        // 否则重做、采用这些操作拿到的是过期的壳子
        const m = getMeta();
        if (m && Array.isArray(d.generated)) {
            d.generated = d.generated
                .map(x => (x && x.id && m.events[x.id]) ? m.events[x.id] : null)
                .filter(Boolean);
        }
        S.chainDraft = d;
    }

    /** 链骨架预览这一块 */
    function renderChainPreview(page) {
        const d = S.chainDraft;
        if (!d) return;
        const chain = d.chain;

        const box = el('div', 'eo-sec eo-chainbox');
        box.appendChild(el('div', 'eo-sec-title', '链骨架预览'));

        // 链名
        const nameRow = el('div', 'eo-row');
        nameRow.appendChild(el('span', null, '链名'));
        const ni = elAuto(null, chain.chain_name, '');
        ni.style.flex = '1';
        ni.addEventListener('input', () => {
            chain.chain_name = ni.value;
            // 2026-11-10：改了立刻存，刷新不丢（原来只改了内存对象）
            saveChainDraft(S.chainDraft);
        });

        nameRow.appendChild(ni);
        box.appendChild(nameRow);

        // 时间压力与基调：链骨架也要能改（2026-11-09 危晓要）。
        // 原来这两行是纯文字，模型写什么就是什么。
        const mkEdit = (labelText, key, placeholder) => {
            const row = el('div', 'eo-row');
            row.appendChild(el('span', null, labelText));
            const inp = elAuto(null, chain[key], placeholder);
            inp.style.flex = '1';
            inp.addEventListener('input', () => {
                chain[key] = inp.value;
                // 2026-11-10：时间压力、基调这些改完立刻存，刷新不丢
                saveChainDraft(S.chainDraft);
            });

            row.appendChild(inp);
            return row;
        };
        box.appendChild(mkEdit('时间压力', 'pressure', '整条链的时间尺度，比如「入夜前必须离开」'));
        box.appendChild(mkEdit('基调', 'tone', '整体氛围，比如「压抑、紧张」'));

        if (d.problems.length) {
            box.appendChild(el('div', 'eo-bad', '要注意：' + d.problems.join('；')));
        }

        // 链骨架的模型原文（2026-11-09 危晓：调试模式下应该能看）。
        // 和待选卡片一个路子：只在调试模式开着时给，点了直接摊开，不再套折叠。
        if (d.raw && debugEnabled()) {
            const rawRow = el('div', 'eo-row');
            const btnRaw = el('button', 'eo-btn eo-btn-toggle' + (d.rawOpen ? ' eo-on' : ''),
                d.rawOpen ? '收起骨架原文' : '展示骨架原文');
            btnRaw.type = 'button';
            btnRaw.addEventListener('click', () => {
                d.rawOpen = !d.rawOpen;
                repaintPage();
            });
            rawRow.appendChild(btnRaw);
            box.appendChild(rawRow);
            if (d.rawOpen) {
                box.appendChild(el('div', 'eo-hint', '模型原始输出（排查用，含英文字段名）'));
                const rawBox = el('div', 'eo-box');
                rawBox.textContent = d.raw;
                box.appendChild(rawBox);
            }
        }

        // 节点表
        const list = el('div', 'eo-chainlist');
        const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
        nodes.forEach((n, i) => {
            const row = el('div', 'eo-chainnode');

            const num = el('span', 'eo-chainnum', String(i + 1));

            // 主类型：只读展示（2026-11-09 危晓：链骨架预览处不能改事件类型，改为只读）。
            // 类型要在「各节点」配置里定（那里生成骨架前就能选，也是对模型的有效输入）；
            // 预览这一屏只负责让你核对模型排出来的结构，不提供第二个改类型的入口，
            // 免得两处都能改、改完不知道哪次生效。
            const typeLabel = document.createElement('span');
            typeLabel.className = 'eo-chaintype-txt';
            typeLabel.textContent = n.primary || '（未定）';
            typeLabel.title = '事件类型在「各节点」配置里改';



            // 2026-11-09 手机端：节点行改上下两行。
            // 原来「编号 + 类型下拉 + 简介」横排，手机上简介只剩两百多像素，
            // 再加 input 单行不换行，一屏只看得见开头几个字。
            // 现在 head 行只放编号和类型，简介换 textarea 独占整行、自动撑高。
            const head = el('div', 'eo-chainnode-head');
            head.appendChild(num);
            head.appendChild(typeLabel);
            row.appendChild(head);

            // 原来这里挂了两次一模一样的 input 监听（同一个 handler 写了两遍），
            // 每敲一个字要跑两遍回调，趁机去掉一个。
            const brief = elAuto(null, n.brief, '这一环要做什么');
            brief.addEventListener('input', () => { n.brief = brief.value; });
            row.appendChild(brief);
            list.appendChild(row);


            // 衔接条件放节点内部（2026-11-09 危晓：应该在上面设置节点时，放在节点内去设置）。
            // 每个节点下面挂它自己的出边：「这一环结束、满足什么条件时，走到哪个节点」。
            // 这样看一个节点就能看完它的去向，不用去下面另一个区块里对照编号。
            const myIdx = (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1);
            const others = nodes
                .map((nn, ii) => (nn && nn.idx != null) ? parseInt(nn.idx, 10) : (ii + 1))
                .filter(ix => ix !== myIdx);

            const edgeBox = el('div', 'eo-chainnode-edge');
            const paintEdges = () => {
                edgeBox.textContent = '';
                const cur = (Array.isArray(chain.triggers) ? chain.triggers : [])
                    .filter(t => parseInt(t.from, 10) === myIdx);

                for (let ei = 0; ei < cur.length; ei++) {
                    const t = cur[ei];
                    // 2026-11-09 手机端：这一行原来塞了五样东西（若 / 条件框 / 则走到节点 / 下拉 / ×），
                    // 手机上两个输入框各被压到几十像素，条件框只剩「幼崽被能」几个字。
                    // 拆成两行：第一行「若 + 条件（占满）」，第二行「则走到节点 + 下拉 + 删」。
                    const er = el('div', 'eo-trig-row');

                    const condLine = el('div', 'eo-trig-line');
                    condLine.appendChild(el('span', 'eo-hint', '若'));
                    const cond = el('textarea', 'eo-auto');
                    cond.rows = 1;
                    cond.value = String(t.condition || '');
                    cond.placeholder = '满足什么条件才往下走（比如「幼崽被击退」），留空就用模型给的那句';
                    autoGrow(cond);
                    cond.addEventListener('input', () => { t.condition = cond.value; });
                    condLine.appendChild(cond);
                    er.appendChild(condLine);

                    const toLine = el('div', 'eo-trig-line');
                    toLine.appendChild(el('span', 'eo-hint', '则走到节点'));
                    // 下拉里只写「节点 N」，完整简介放到下面一行小字，否则手机上下拉框里的文字全被截断
                    const selTo = el('select', 'eo-sel');
                    for (const ix of others) {
                        const o = el('option', null, `节点 ${ix}`);
                        o.value = String(ix);
                        if (String(t.to) === String(ix)) o.selected = true;
                        selTo.appendChild(o);
                    }
                    const preview = el('span', 'eo-hint eo-trig-preview', '');
                    const paintPreview = () => {
                        const tx = parseInt(selTo.value, 10);
                        const nn = nodes[tx - 1] || {};
                        preview.textContent = String(nn.brief || '').slice(0, 40)
                            || (String(nn.brief || '') ? '' : '（这个节点还没写简介）');
                    };
                    selTo.addEventListener('change', () => {
                        t.to = parseInt(selTo.value, 10);
                        paintPreview();
                    });
                    paintPreview();
                    toLine.appendChild(selTo);

                    const del = el('button', 'eo-btn eo-btn-del', '×');
                    del.type = 'button';
                    del.title = '删掉这条衔接';
                    del.addEventListener('click', () => {
                        const realIdx = chain.triggers.indexOf(t);
                        if (realIdx >= 0) chain.triggers.splice(realIdx, 1);
                        paintEdges();
                    });
                    toLine.appendChild(del);
                    er.appendChild(toLine);
                    er.appendChild(preview);

                    edgeBox.appendChild(er);
                }

                if (!cur.length) {
                    edgeBox.appendChild(el('div', 'eo-hint',
                        others.length ? '这一环不再往下走，链到这儿收束。' : '只有一个节点，不设衔接。'));
                }

                if (others.length) {
                    const addRow = el('div', 'eo-row');
                    const add = el('button', 'eo-btn', '＋ 加一条去向');
                    add.type = 'button';
                    add.addEventListener('click', () => {
                        if (!Array.isArray(chain.triggers)) chain.triggers = [];
                        // 默认指向下一个节点，没有下一个就指回第一个别的
                        const nxt = others.includes(myIdx + 1) ? myIdx + 1 : others[0];
                        chain.triggers.push({ from: myIdx, to: nxt, condition: '' });
                        paintEdges();
                    });
                    addRow.appendChild(add);
                    edgeBox.appendChild(addRow);
                }
            };
            paintEdges();
            list.appendChild(edgeBox);
        });
        box.appendChild(list);

        // 生成结果
        if (d.generated.length) {
            const gBox = el('div', 'eo-chaingen');
            gBox.appendChild(el('div', 'eo-hint', `已生成 ${d.generated.length} / ${nodes.length} 个节点：`));
            for (const ev of d.generated) {
                const line = el('div', 'eo-hint',
                    `  第 ${ev.chain.pos} 个：${ev.name}（${(ev.outline && ev.outline.event_type && ev.outline.event_type.primary) || ''}）`);
                gBox.appendChild(line);
            }
            box.appendChild(gBox);
        }

        // 按钮
        const btnRow = el('div', 'eo-row');
        // 2026-11-09 真机：原来只看「有没有生成过」，全部生成完了还写着
        // 「继续生成剩下的」，点了什么也不发生。现在按剩余节点数分三种说法。
        const doneIdx = new Set(d.generated.map(e => e.chain.idx));
        const allIdx = (chain.nodes || []).map((n, i) => (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1));
        const leftCount = allIdx.filter(i => !doneIdx.has(i)).length;
        const btnGen = el('button', 'eo-btn eo-btn-primary',
            leftCount === 0 ? '全部节点已生成'
                : (d.generated.length ? `继续生成剩下的 ${leftCount} 个` : '开始生成节点事件'));
        btnGen.type = 'button';
        btnGen.disabled = !!d.running || leftCount === 0;
        btnGen.addEventListener('click', async () => {
            btnGen.disabled = true;
            await startChainRun(d);
            btnGen.disabled = false;
            repaintPage();
        });
        btnRow.appendChild(btnGen);

        // 重新生成：把已经生成过的节点全部丢掉，按当前骨架重跑一遍。
        // 不重做骨架本身——骨架里你手改过的类型和那句「这一环要做什么」都保留。
        if (d.generated.length) {
            const btnRedo = el('button', 'eo-btn', '重新生成全部节点');
            btnRedo.type = 'button';
            btnRedo.disabled = !!d.running;
            btnRedo.title = '按现在的链骨架把每个节点的事件重新生成一遍，已经生成的会被替换掉';
            btnRedo.addEventListener('click', async () => {
                if (!(await askConfirm('会把已经生成的 ' + d.generated.length
                    + ' 个节点事件全部丢掉重做（链骨架不动）。继续？'))) return;
                await regenChainNodes(d);
                repaintPage();
            });
            btnRow.appendChild(btnRedo);
        }

        const btnDrop = el('button', 'eo-btn', '放弃这条链');
        btnDrop.type = 'button';
        btnDrop.addEventListener('click', () => {
            S.chainDraft = null;
            // 存着的骨架也一起删掉，否则刷新一下它又冒出来
            clearChainDraft();
            repaintPage();
        });

        btnRow.appendChild(btnDrop);
        box.appendChild(btnRow);

        page.appendChild(box);
    }

    /**
     * 重新生成整条链的所有节点事件（2026-11-09 危晓要）。
     *
     * 只重做节点事件，不重做骨架——骨架里的链名、时间压力、基调、
     * 每个节点的类型与「这一环要做什么」都是用户看过、可能手改过的，不能动。
     *
     * 已经生成过的节点事件会被删掉（不是留在待选里占位），
     * 否则重跑一遍就变成两条同名事件，用户分不清哪条是新的。
     */
    async function regenChainNodes(d) {
        if (!d || d.running) return;
        const meta = getMeta();
        for (const ev of d.generated) {
            if (ev && ev.id && meta.events[ev.id]) delete meta.events[ev.id];
            if (ev && ev.id) S.previewDraftIds.delete(ev.id);
        }
        d.generated = [];
        saveMeta();
        log(`链「${(d.chain && d.chain.chain_name) || ''}」的全部节点事件已清空，准备重做`);
        await startChainRun(d);
    }

    /** 逐条生成整条链 */
    async function startChainRun(d) {
        if (!d || d.running) return;
        d.running = true;
        const chain = d.chain;
        // 已经生成过的节点不再重复生成
        const done = new Set(d.generated.map(e => e.chain.idx));
        const all = (chain.nodes || []).map((n, i) => (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1));
        const todo = all.filter(i => !done.has(i));

        const mode = getSettings().chain && getSettings().chain.manual ? 'manual' : 'auto';
        const prefs = Object.assign({}, getDraftPrefs());
        // 链里每个节点各选各的类型，顶层这个主类型不往下传。
        // 必须真的删掉：留着它的话 pickPackFor 会拿顶层类型去挑结构包，
        // 结果「探险探索→战斗冲突→谈判交涉」三段都挂了同一个包。
        delete prefs.eventMainType;
        let prevExit = d.generated.length
            ? d.generated[d.generated.length - 1].exitState
            : null;

        setBusy(true, false, '正在逐条生成事件', 'gen-chain');
        try {
            startProgress('正在生成事件链');
            const made = await runChain(chain, d.chainId, prefs, mode, {
                onNode: async (ev, i, total) => {
                    d.generated.push(ev);
                    S.previewDraftIds.add(ev.id);
                    log(`链节点 ${ev.chain.pos}/${total} 生成完成：${ev.name}`);
                    repaintPage();
                },
                waitNext: async (nextPos, total) => {
                    // 手动模式：等用户点「下一个」。
                    // 注意不要塞进 document.body —— 那会浮在整页外面，看着像整个界面坏了。
                    // 这时 busy 还开着，所以用一个独立的小提示层，点完立刻收掉。
                    return await new Promise((resolve) => {
                        const mask = el('div', 'eo-chainwait');
                        const bar = el('div', 'eo-chainwait-box');
                        bar.appendChild(el('div', 'eo-hint',
                            `已生成 ${nextPos - 1}/${total} 个节点。设置里开的是逐条确认，点「生成下一个」继续。`));
                        const b = el('button', 'eo-btn eo-btn-primary', '生成下一个');
                        b.type = 'button';
                        b.addEventListener('click', () => { mask.remove(); resolve('go'); });
                        bar.appendChild(b);
                        const stop = el('button', 'eo-btn', '停在这里，剩下的先不要');
                        stop.type = 'button';
                        stop.addEventListener('click', () => { mask.remove(); resolve('stop'); });
                        bar.appendChild(stop);
                        mask.appendChild(bar);
                        document.body.appendChild(mask);
                    });
                },
            });
            toast(`事件链生成完成：${made.length} 个事件已放入待选`);
        } catch (e) {
            error('生成事件链失败：', e);
            toast('生成事件链失败：' + (e && e.message || e));
        } finally {
            d.running = false;
            setBusy(false, null, null, 'gen-chain');
            resetProgress();
        }
    }

    function renderGenPage(page) {
        // 生成页最长，拆成三块各管一段：状态卡、待选事件、新建事件表单（2026-11-02）
        // 2026-11-10 危晓：生成模式挪到整页最顶部，放在待选模块上面。
        // 它决定「这次要生成什么」，待选列表也要按它过滤，所以必须先渲染——
        // 原来它藏在表单内部，视觉上排在待选下面，看着像「待选是主题、模式是附属」。
        // 2026-11-10：进来先把存在对话里的链骨架读回内存，刷新后预览还在。
        // 放在最前面：下面的表单渲染要知道链模式有没有正在做的那条链。
        restoreChainDraft();
        const prefs = getDraftPrefs();
        renderGenModeSwitch(page, prefs);
        renderGenStatus(page);
        renderGenDrafts(page, prefs.__genMode || 'single');
        renderGenForm(page, prefs);

    }

    /** 生成页顶部：当前事件状态卡 */
    function renderGenStatus(page) {
        const ev = getCurrentEvent();

        const statusBox = el('div', 'eo-box');
        // 2026-11-10 危晓：页头写「待选事件链（3/5）」，这里却说「上方有 6 个待选事件」。
        // 根因是这里只数 status === 'draft'，把链节点也算进去了——
        // 3 条链各 2 个节点，6 个节点事件被当成 6 个单事件报出来。
        // 链节点在列表里归组显示在各自链下面，不该混进「待选事件」这个说法里。
        const allDrafts = Object.values((getMeta() || {}).events || {}).filter(e => e && e.status === 'draft');
        const singleN = allDrafts.filter(e => !(e.chain && e.chain.id)).length;
        const chainN = new Set(allDrafts.filter(e => e.chain && e.chain.id)
            .map(e => e.chain.id)).size;
        const draftN = singleN + chainN;
        // 2026-11-10 批 3 第 17 项：标出当前事件来自哪个对话。
        // 存档在 chatMetadata 里、跟着对话走，换对话不会串，但面板不写出处时，
        // 从别的对话切回来或同时开两个窗口就看不出手里这个事件是哪段聊天里开的。
        const tag = currentChatTag();
        // 事件记下的 chatId 与当前对话不一致 = 这条记录不是在这里开的（老存档/被手工改过）。
        // 这时要说出来，而不是照样显示得像本地事件。
        const fromElsewhere = ev && ev.chatId != null && tag.id && String(ev.chatId) !== tag.id;
        const chatLine = ev
            ? `\n来自对话：${tag.label}` + (fromElsewhere ? `（注意：该事件记录在对话 ${String(ev.chatId).slice(-6)}，不是当前对话）` : '')
            : '';
        statusBox.textContent = ev
            ? `进行中：${ev.name}\n开始于 ${String(ev.createdAt || '').slice(0, 19)}\n世界书：${ev.worldBook}　条目已同步`
                + chatLine
                + (draftN ? `\n另有 ${draftN} 个待选等你决定` : '')
            : (draftN
                ? `当前没有进行中的事件（对话：${tag.label}）。上方有 ${draftN} 个待选`
                    + '（' + [singleN ? `${singleN} 个单事件` : '', chainN ? `${chainN} 条事件链` : '']
                        .filter(Boolean).join('、') + '）'
                    + '，点「采用」即可开始；也可以继续生成新的来比较。'
                : `当前没有进行中的事件（对话：${tag.label}）。填好下面的事件名和偏好即可开始。生成后先进待选，满意再采用。`);
        page.appendChild(statusBox);

    }

    /** 生成页：待选事件列表（采用 / 丢弃 / 展示大纲 / 编辑） */
    /**
     * 待选事件卡片（2026-11-02 C2）：头、简介、四个操作按钮。
     * 以前这段直接写在生成页的循环里，生成页一拆就跟着长，现在独立成一个组件。
     */
    /**
     * 按顺序采用整条链的所有节点（2026-11-09 危晓要）。
     *
     * 逐条走 commitDraft，因为每个节点是独立的世界书条目，
     * 采用后还会各自成为「当前事件」——链的语义是依次发生，所以最后一个成为当前。
     * 中途失败就停在那一环，已经成功的不回滚（世界书写了一半硬删更危险），
     * 但要在日志和提示里说清楚停在哪。
     *
     * @param {object[]} list 同一条链的待选事件，已按 pos 排好
     */
    async function useChainDrafts(list) {
        const chain = (list[0] && list[0].chain) || {};
        const name = chain.name || '（未命名）';
        let done = 0;
        for (const d of list) {
            step(`采用链「${name}」第 ${d.chain.pos}/${list.length} 个节点`);
            try {
                await commitDraft(d.id, { allowChain: true });
                done++;
            } catch (e) {
                error(`采用链「${name}」第 ${d.chain.pos} 个节点失败：`, e);
                toast(`第 ${d.chain.pos} 个节点采用失败：` + (e && e.message || e)
                    + `\n前面 ${done} 个已经采用成功，剩下的没有动。`, { bad: true });
                return;
            }
        }
        log(`整条链「${name}」已采用，共 ${done} 个节点`);
        toast(`整条链「${name}」已采用（${done} 个节点）`);
    }

    /**
     * @param {object} d 待选事件
     * @param {object} [opts] { chainMember }
     *   chainMember 为真时这张卡属于某条链：不画单节点的「采用」「丢弃」，
     *   因为链要走整条采用/丢弃（2026-11-09 危晓：不支持采用丢弃单个节点事件）。
     *   「展示大纲」「编辑」「展示原文」照旧保留，那是查看和修改，不是生效。
     */
    function renderDraftCard(d, opts) {
                const chainMember = !!(opts && opts.chainMember);
                const item = el('div', 'eo-draft');
                const head = el('div', 'eo-draft-head');
                head.appendChild(el('span', 'eo-draft-name', d.name));
                // 2026-11-09：生成失败的链节点必须一眼看得出是废的，
                // 不能让名字正常的空壳混在正常待选里。
                if (d.genFailed) {
                    const flag = el('span', 'eo-bad-flag', '生成失败·不建议采用');
                    flag.title = (d.genFailReasons || []).join('；') || '模型返回的内容是空的';
                    head.appendChild(flag);
                }

                // 2026-11-05 M2 复核：nodes 与 characters 都在 structure 里，按顶层读恒为 0，
                // 待选卡片会一直显示「0 个节点」。
                // characters 是 {helpers:[…], obstructers:[…]} 这种分组对象，
                // 原来数 Object.keys 得到的是「几组」而不是「几个人」，一并改成数人头。
                const n = innerNodesOf(d.outline).length;
                const charsOf = innerField(d.outline, 'characters');
                const c = (charsOf && typeof charsOf === 'object')
                    ? Object.values(charsOf).reduce((a, v) => a + (Array.isArray(v) ? v.length : (v ? 1 : 0)), 0)
                    : 0;
                const meta = [];
                meta.push(`${n} 个节点`);
                if (c) meta.push(`${c} 类角色`);
                if (d.autoNamed) meta.push('自动命名');
                head.appendChild(el('span', 'eo-draft-meta', meta.join('　')));
                // 2026-11-06 M4.1：没有骨架的类型，字段结构是模型自己发挥的，
                // 与案件/战斗那两套固定骨架对不上。标记出来，采用前提醒一次。
                const draftMain = mainTypeOfOutline(d.outline);
                const isTempStruct = !!(draftMain && !skeletonForType(draftMain));
                if (isTempStruct) {
                    const tag = el('span', 'eo-draft-meta', '（临时结构）');
                    tag.style.color = 'var(--eo-warn, #b8860b)';
                    tag.title = '该类型暂无专用骨架，字段是模型按通用结构自己组织的';
                    head.appendChild(tag);
                }
                item.appendChild(head);

                if (d.brief) item.appendChild(el('div', 'eo-draft-brief', d.brief));

                // 采用/丢弃会真的改状态，和「只是看看」的开关分开摆（2026-11-02）：
                // 以前四个按钮等宽并排，手机上「采用」紧挨「编辑」，误触代价一个是生效一个是展开
                const acts = el('div', 'eo-draft-acts');
                const lookActs = el('div', 'eo-draft-acts-look');
                const useActs = el('div', 'eo-draft-acts-use');
                acts.appendChild(lookActs);
                acts.appendChild(useActs);
                // 2026-11-09 危晓：链不走单节点的采用/丢弃，整条链一个入口
                if (!chainMember) {
                    const btnUse = el('button', 'eo-btn eo-primary eo-press', '采用');
                    btnUse.type = 'button';
                    // 临时结构第一次点「采用」变成「确认采用」，再点一次才真采用。
                    // 项目里没有弹窗组件，都用就地二次确认，跟盘点页「确认/忽略」一个路子。
                    let useArmed = false;
                    if (isTempStruct) {
                        btnUse.textContent = '采用（临时结构）';
                        btnUse.title = '该类型暂无专用骨架，内层字段是模型按通用结构自己组织的';
                    }
                    btnUse.addEventListener('click', async () => {
                        if (isTempStruct && !useArmed) {
                            useArmed = true;
                            btnUse.textContent = '确认采用？';
                            btnUse.title = '采用后盘点页可能列不出进度条目：该类型的字段没有固定骨架，按骨架算的进度项对不上。';
                            return;
                        }
                        btnUse.disabled = true;
                        btnUse.textContent = '正在采用…';
                        try {
                            await commitDraft(d.id);
                            S.activeTab = 'gen';
                            renderPanel();
                        } catch (e) {
                            error('采用待选事件失败：', e);
                            btnUse.disabled = false;
                            btnUse.textContent = '采用';
                            toast('采用失败：' + (e && e.message || e), { bad: true });
                        }
                    });
                    useActs.appendChild(btnUse);

                    const btnDrop = el('button', 'eo-btn eo-press', '丢弃');
                    btnDrop.type = 'button';
                    btnDrop.addEventListener('click', async () => {
                        if (!(await askConfirm(`丢弃待选事件「${d.name}」？它还没写进世界书，丢弃不会留下任何东西。`))) return;
                        discardDraft(d.id);
                        repaintPage();
                    });
                    useActs.appendChild(btnDrop);
                }

                // 「展示原文」只在调试模式开着时给（2026-11-04 危晓要求）：
                // 原来要先点「展示大纲」才能在底下看到原文，想看原文还得先展开几百行大纲。
                // 现在和展示大纲、编辑并排，各管各的。
                const editingMe = S.editingDraftId === d.id;
                if (d.outlineRaw && debugEnabled()) {
                    const rawOn = S.previewRawDraftIds.has(d.id);
                    const btnRaw = el('button', 'eo-btn eo-btn-toggle' + (rawOn && !editingMe ? ' eo-on' : ''),
                        rawOn && !editingMe ? '收起原文' : '展示原文');
                    btnRaw.type = 'button';
                    // 编辑大纲时不给点（2026-11-04 危晓要求）：编辑状态下这张卡只画编辑器，
                    // 点了也看不到原文，按钮就成了骗人的。关掉编辑自然回来。
                    // 也不挂「?」帮助（2026-11-04 危晓要求）：按钮已经灰着，再挂个问号
                    // 反而多一个要点的小玩意。禁用就是禁用，不加解释。
                    if (editingMe) {
                        btnRaw.disabled = true;
                    } else {
                        btnRaw.addEventListener('click', () => {
                            if (rawOn) S.previewRawDraftIds.delete(d.id);
                            else S.previewRawDraftIds.add(d.id);
                            repaintPage();
                        });
                    }
                    lookActs.appendChild(btnRaw);
                }

                // 展示大纲是开关，但开关态靠文案和左侧竖条表达，不靠底色（2026-11-02）：
                // 底色和「采用」的主按钮长得太像，一眼分不清哪个会真生效
                const showing = isPreviewing(d.id);
                const btnLook = el('button', 'eo-btn eo-btn-toggle' + (showing ? ' eo-on' : ''), showing ? '收起大纲' : '展示大纲');
                btnLook.type = 'button';
                btnLook.addEventListener('click', async () => {
                    if (S.pendingDraftEditDirty && S.editingDraftId === d.id) {
                        if (!(await askConfirm('正在编辑的这份还有没保存的改动，收起来会丢掉。继续？'))) return;
                        discardPendingEdit();
                    }
                    if (S.previewDraftIds.has(d.id)) {
                        S.previewDraftIds.delete(d.id);
                        // 收起这一份的预览，如果它正开着编辑器，编辑器也一并退出
                        if (S.editingDraftId === d.id) { S.editingDraftId = null; S.draftEditBuf = null; }
                    } else {
                        S.previewDraftIds.add(d.id);
                    }
                    repaintPage();
                });
                lookActs.appendChild(btnLook);

                const btnEdit = el('button', 'eo-btn eo-btn-toggle' + (S.editingDraftId === d.id ? ' eo-on' : ''),
                    S.editingDraftId === d.id ? '收起编辑' : '编辑');
                btnEdit.type = 'button';
                btnEdit.addEventListener('click', async () => {
                    if (S.editingDraftId === d.id) {
                        await closeDraftEditor();
                        return;
                    } else {
                        // 从别的草稿的编辑框切过来：有未保存改动先问一句，别悄悄丢
                        if (S.pendingDraftEditDirty
                            && !(await askConfirm('另一份草稿还有没保存的改动，切走会丢掉。继续？'))) return;
                        discardPendingEdit();
                        S.editingDraftId = d.id;
                        S.draftEditBuf = makeDraftEditBuf(d);
                        S.draftEditIssues = null;
                        S.previewDraftIds.add(d.id);
                    }
                    repaintPage();
                });
                lookActs.appendChild(btnEdit);
                item.appendChild(acts);

                if (S.editingDraftId === d.id) {
                    item.appendChild(renderDraftEditor(d));
                    // 编辑器开着就直接返回这张卡，不再渲染大纲正文（2026-11-02 抽组件时改：
                    // 以前这里是 continue，跳出循环会把后面的草稿全丢掉，界面一片空白，2026-11-01 踩过）
                    return item;
                }

                // 展开时才渲染大纲正文，避免一屏堆几百行
                if (isPreviewing(d.id)) {
                    const body = el('div', 'eo-draft-body');
                    const q = d.parseQuality;
                    if (q && !q.ok) {
                        const bad = el('div', 'eo-bad-box');
                        bad.textContent = '⚠ 这份大纲结构不完整：' + q.missing.join('；');
                        body.appendChild(bad);
                    }
                    const txt = el('div', 'eo-outline-text');
                    // 2026-11-09 危晓：待选大纲不展示事件类型，类型在卡片头已经写明了
                    txt.textContent = renderOutlineText(d.outline, { hideType: true });
                    body.appendChild(txt);
                    item.appendChild(body);
                }

                // 模型原始输出单独一个开关（2026-11-04 危晓要求），不再跟着大纲一起展开。
                // 仍旧只在调试模式开着时给：它是含英文字段名的技术细节，平时摆着容易误读。
                // 点了「展示原文」就直接摊开正文，不再套一层折叠块（2026-11-04 危晓反馈：
                // 按钮写着展示原文、下面还挂一个要点开才知道是什么的折叠块，等于点了两次），
                // 只在顶上留一行小标题说明这段是什么。
                if (d.outlineRaw && debugEnabled() && S.previewRawDraftIds.has(d.id)
                    && S.editingDraftId !== d.id) {
                    const rawBody = el('div', 'eo-draft-body');
                    rawBody.appendChild(el('div', 'eo-hint', '模型原始输出（排查用，含英文字段名）'));
                    const ob = el('div', 'eo-outline-text');
                    ob.textContent = d.outlineRaw;
                    rawBody.appendChild(ob);
                    item.appendChild(rawBody);
                }
                return item;
        return item;
    }

    function renderGenDrafts(page, mode) {
        // 2026-11-10 危晓：待选按生成模式过滤——单事件只列待选事件，事件链只列待选事件链。
        // 以前两种混在一个列表里，选了链还要在一堆单事件草稿底下才看见自己那条链。
        const wantChain = mode === 'chain';
        // 当前进行中的事件：拆函数时它原本在 renderGenStatus 里，
        // 这里要用到（完结/废弃按钮、大纲、原始输出），所以自己取一次（2026-11-02 回归 bug）
        const ev = getCurrentEvent();

        // --- 当前事件 ---
        // 顺序在 2026-11-04 调换过：以前「待选事件」在上面，当前事件挤在下面，
        // 一进生成页先看到一堆还没生效的草稿，反而看不到正在跑的是哪件事。
        // 现在当前事件在上，跟它的盘点、完结、废弃、大纲、原文一起收成一组子项。
        if (ev) {
            const evHead = el('div', 'eo-sec eo-sec-inline');
            evHead.appendChild(el('span', null, `当前事件 · ${ev.name || '（未命名）'}`));
            attachHelp(evHead, '正在跑的那件事。它已经写进世界书，下面几项都只针对它：'
                + '去盘点这一页改节点进度、完结或废弃把它收掉、事件大纲和模型原始输出看它这次生成的内容。');
            page.appendChild(evHead);

            const opOut = el('div', 'eo-hint');
            const row = el('div', 'eo-row');

            const btnInv = el('button', 'eo-btn eo-primary', '去盘点这一页');
            btnInv.addEventListener('click', () => { S.activeTab = 'inv'; renderPanel(); });
            row.appendChild(btnInv);

            const btnDone = el('button', 'eo-btn', '完结');
            btnDone.addEventListener('click', async () => {
                if (!(await askConfirm(`确认完结「${ev.name}」？世界书条目会被删除，事件卡转为历史。`))) return;
                btnDone.disabled = true;
                opOut.className = 'eo-hint';
                opOut.textContent = '处理中…';
                try {
                    await closeEvent(false);
                    opOut.className = 'eo-ok';
                    opOut.textContent = '已完结。';
                    repaintPage();
                } catch (e) {
                    opOut.className = 'eo-bad';
                    opOut.textContent = '失败：' + (e && e.message || e);
                } finally { btnDone.disabled = false; }
            });
            row.appendChild(btnDone);

            const btnAb = el('button', 'eo-btn', '废弃');
            btnAb.addEventListener('click', async () => {
                if (!(await askConfirm(`确认废弃「${ev.name}」？世界书条目会被删除，事件卡转为历史。`))) return;
                btnAb.disabled = true;
                opOut.className = 'eo-hint';
                opOut.textContent = '处理中…';
                try {
                    await closeEvent(true);
                    opOut.className = 'eo-ok';
                    opOut.textContent = '已废弃。';
                    repaintPage();
                } catch (e) {
                    opOut.className = 'eo-bad';
                    opOut.textContent = '失败：' + (e && e.message || e);
                } finally { btnAb.disabled = false; }
            });
            row.appendChild(btnAb);

            // 大纲与原文各一个开关，和待选卡那边的「展示大纲 / 展示原文」同一套用法（2026-11-04 危晓要求）。
            // 以前这两块是自动展开的折叠块，原始输出还压在大纲底下，想看原文得先展开几百行大纲。
            const hasOutline = !!renderOutlineText(ev.outline);
            const canRaw = !!ev.outlineRaw && debugEnabled();
            if (hasOutline) {
                const btnOutline = el('button', 'eo-btn eo-btn-toggle' + (S.currentShowOutline ? ' eo-on' : ''),
                    S.currentShowOutline ? '收起大纲' : '展示大纲');
                btnOutline.type = 'button';
                btnOutline.addEventListener('click', () => {
                    S.currentShowOutline = !S.currentShowOutline;
                    repaintPage();
                });
                row.appendChild(btnOutline);
            }
            if (canRaw) {
                const btnRaw = el('button', 'eo-btn eo-btn-toggle' + (S.currentShowRaw ? ' eo-on' : ''),
                    S.currentShowRaw ? '收起原文' : '展示原文');
                btnRaw.type = 'button';
                btnRaw.addEventListener('click', () => {
                    S.currentShowRaw = !S.currentShowRaw;
                    repaintPage();
                });
                row.appendChild(btnRaw);
            }
            page.appendChild(row);
            page.appendChild(opOut);

            // 解析质量有问题时，先在顶上摆一条红色警示——不能让残缺的大纲看起来像正常的
            const q = ev.parseQuality;
            if (q && !q.ok) {
                const bad = el('div', 'eo-bad-box');
                bad.textContent = '⚠ 这次生成的大纲结构不完整：' + q.missing.join('；')
                    + '。节点进度将无法正常跟踪。可把当前事件废弃后在生成页重新生成，或到日志页查看模型原始输出。';
                page.appendChild(bad);
            }

            // 点「展示大纲」就直接摊开（2026-11-04 危晓要求）：不再套折叠块，
            // 否则点了按钮还得多点一次才看得到内容，和原文那边一个道理
            if (hasOutline && S.currentShowOutline) {
                page.appendChild(el('div', 'eo-hint', '事件大纲'));
                // 用 outline-text 而不是 eo-box：后者有 220px 高度上限，
                // 大纲几百行会被压在一条小滚动条里，看起来就像没有排版
                const ob = el('div', 'eo-outline-text');
                ob.textContent = renderOutlineText(ev.outline);
                page.appendChild(ob);
            }
            // 模型原始输出只在调试模式开着时给（2026-11-02 危晓要求）：
            // 它是排查用的技术细节，平时摆着只会让人误点或误读，关掉后整块不渲染。
            // 和待选卡一致：点了就摊开，不再套一层折叠块（2026-11-04）
            if (canRaw && S.currentShowRaw) {
                page.appendChild(el('div', 'eo-hint', '模型原始输出（排查用，含英文字段名）'));
                const ob = el('div', 'eo-box');
                ob.textContent = ev.outlineRaw;
                page.appendChild(ob);
            }
        }

        // --- 待选事件 ---
        // 生成只产出待选，不写世界书；点「采用」才真正生效。
        // 这样反复重生成不会来回写删世界书条目。
        // 2026-11-04 起挪到当前事件下面：先看正在跑的，再看攒着的候补。
        // 2026-11-10：按生成模式过滤，单事件只列待选事件、链只列待选事件链。
        const drafts = Object.values((getMeta() || {}).events || {})
            .filter(e => e && e.status === 'draft')
            .filter(e => (e && e.chain && e.chain.id ? wantChain : !wantChain))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        if (drafts.length) {
            // 2026-11-10 危晓：已按模式过滤，标题只说当前这一类，不用再把两类混着报。
            const dSingles = drafts.filter(x => !(x && x.chain && x.chain.id));
            const dChains = new Set(drafts.filter(x => x && x.chain && x.chain.id).map(x => x.chain.id));
            const dHead = el('div', 'eo-sec eo-sec-inline');
            dHead.appendChild(el('span', null, wantChain
                ? `待选事件链（${dChains.size}/${draftCap('chain')}）`
                : `待选事件（${dSingles.length}/${draftCap('single')}）`));

            attachHelp(dHead, '生成后先放在这里，不写世界书、不设为当前事件。看看满意就点「采用」，'
                + '不满意就点「丢弃」，或者调一调偏好再生成一个来比较。\n'
                + `单事件最多同时保留 ${draftCap('single')} 个；链按条数算，最多 ${draftCap('chain')} 条，`
                + '一条链不管几个节点都只占 1 个链名额、也不占单事件的名额。超出时最早的会被挤掉。');
            page.appendChild(dHead);

            // M16：待选里同一条链的事件归组显示。
            // 链的三个事件是各自独立的条目（各自写世界书、各自采用），
            // 但列表上摊平了会看不出它们是一家，所以按 chain.id 分块，
            // 块头写「第 N/M 个节点」。单事件照旧一条一条平铺。
            const draftBox = el('div', 'eo-drafts');
            const chainGroups = new Map();
            const singles = [];
            for (const d of drafts) {
                const cid = d && d.chain && d.chain.id;
                if (cid) {
                    if (!chainGroups.has(cid)) chainGroups.set(cid, []);
                    chainGroups.get(cid).push(d);
                } else {
                    singles.push(d);
                }
            }
            for (const [cid, list] of chainGroups) {
                list.sort((a, b) => (a.chain.pos || 0) - (b.chain.pos || 0));
                const head = list[0].chain;
                // 2026-11-10 危晓：每条待选链要能折叠展开。
                // 一条链好几个节点，展开后占满一屏，几条链一起摆着找起来费劲。
                // 用 details 而不是自己做开关：它自带状态、自带无障碍语义，
                // 折叠状态按 chain.id 记在模块里，重绘后仍开着。
                const g = el('details', 'eo-chaindraft');
                const openKey = 'draftChain/' + cid;
                g.open = openPrefGroups.has(openKey);
                g.addEventListener('toggle', () => {
                    if (g.open) openPrefGroups.add(openKey);
                    else openPrefGroups.delete(openKey);
                });
                // 块头做成 summary：点空白处折叠/展开
                const headRow = el('summary', 'eo-chaindraft-head-row');
                headRow.appendChild(el('div', 'eo-chaindraft-head',
                    `事件链：${head.name || '（未命名）'}`
                    + `（${list.length}/${head.total || list.length} 个节点）`));


                // 整条链的采用 / 丢弃（2026-11-09 危晓：不支持采用丢弃单个节点事件）。
                // 节点的操作按钮在各自卡片上已经隐藏，这里给整条链一个出口。
                const headActs = el('div', 'eo-row');
                const btnUseChain = el('button', 'eo-btn eo-btn-primary', '采用整条链');
                btnUseChain.type = 'button';
                btnUseChain.title = '按节点顺序把这条链的事件依次采用';
                btnUseChain.disabled = !!S.busy;
                btnUseChain.addEventListener('click', async () => {
                    if (!(await askConfirm(`采用整条链「${head.name || '未命名'}」的 ${list.length} 个节点？`
                        + '\n会依次写世界书条目。'))) return;
                    await useChainDrafts(list);
                    repaintPage();
                });
                headActs.appendChild(btnUseChain);

                const btnDropChain = el('button', 'eo-btn', '丢弃整条链');
                btnDropChain.type = 'button';
                btnDropChain.disabled = !!S.busy;
                btnDropChain.addEventListener('click', async () => {
                    if (!(await askConfirm(`丢掉整条链「${head.name || '未命名'}」的 ${list.length} 个节点？\n丢掉就找不回来了。`))) return;
                    for (const dd of list) discardDraft(dd.id);
                    log(`丢弃整条链「${head.name || '未命名'}」，共 ${list.length} 个节点`);
                    repaintPage();
                });
                headActs.appendChild(btnDropChain);
                // 2026-11-10：这两个按钮在 summary 里，点按钮会顺带触发折叠/展开。
                // preventDefault 才是拦 summary 折叠的关键——summary 的折叠是默认行为，
                // 光 stopPropagation 挡不住。这里一并拦掉，让按钮只管按钮的事。
                for (const b of [btnUseChain, btnDropChain]) {
                    b.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                    });
                }
                headRow.appendChild(headActs);
                g.appendChild(headRow);

                g.appendChild(headRow);

                for (const d of list) g.appendChild(renderDraftCard(d, { chainMember: true }));
                draftBox.appendChild(g);
            }
            for (const d of singles) {
                draftBox.appendChild(renderDraftCard(d, { chainMember: false }));
            }
            page.appendChild(draftBox);
        }

        // 不再 return：待选机制允许在事件进行中继续生成新的来比较，
        // 只是「采用」时要先把当前这件事收掉
        if (ev) page.appendChild(el('div', 'eo-sec', '再生成一个待选'));
    }

    /** 生成页：新建事件的表单与事件参数 */
    /**
     * 事件参数区（M16 抽出，2026-11-09）。
     *
     * 原来这段直接写在 renderGenForm 里，靠着页面级的 prefs / groupMode 闭包工作。
     * 事件链要「每个节点各配一份参数」，所以必须能对着一份任意 prefs 渲染一整块——
     * 不抽出来的话，链里三个节点就得把这几百行复制三遍。
     *
     * @param {HTMLElement} page 挂到哪儿
     * @param {object} prefs 这一份参数（链里每个节点各一份，互不干扰）
     * @param {object} opts { groupMode, repaint, title }
     */
    /**
     * 一行「标签 + 下拉」的通用构造（M16 从 renderPrefsBlock 里提出来，2026-11-09）。
     *
     * 这两个原来定义在 renderPrefsBlock 内部。链模式重写时参数区被抽成独立函数，
     * 它们跟着进了那个作用域，而外面的难度等级下拉还在调它们，
     * 于是一调就 ReferenceError，整页渲染到那一行就断了——
     * 表现就是「难度等级的文字描述在，下拉框和下面全都没了」。
     */
    function makeSelect(row, labelText, options, current, onChange, desc) {
        const lab = el('label', null, labelText);
        lab.style.minWidth = '92px';
        row.appendChild(lab);
        // 有说明就挂个问号，跟在标签后头；没说明就什么都不加
        if (desc) {
            attachHelp(lab, desc, true);
            lab.style.display = 'flex';
            lab.style.alignItems = 'center';
            lab.style.gap = '4px';
            // 问号占位置，最小宽度放开，避免标签被挤或被撑宽
            lab.style.minWidth = 'auto';
            lab.style.flex = '0 0 auto';
        }
        const sel = el('select', 'eo-sel');
        sel.style.flex = '1';
        for (const opt of options) {
            const o = el('option', null, opt.label);
            o.value = opt.value;
            sel.appendChild(o);
        }
        sel.value = current;
        sel.addEventListener('change', () => onChange(sel.value));
        row.appendChild(sel);
        return sel;
    }

    function makePrefSelect(pfs, key, labelText, options, desc) {
        const row = el('div', 'eo-row');
        const cur = pfs[key] || (options[0] && options[0].value) || PREF_AUTO_NEW;
        const custom = customValueOf(pfs, key);
        // 当前值不在选项里 = 用户手打过一句，下拉要选中「自定义…」并把那句话回填进输入框
        // 设置页预存的那些手写取值也拼进来，排在「＋ 自定义…」之前，选了就等于选了一句原话
        const preset = getPrefPresetExtra(key).filter(x => !options.some(o => o.value === x));
        const base = options.map(o => ({ value: o.value, label: o.label }))
            .concat(preset.map(x => ({ value: x, label: '倍 · ' + x })));
        const selOpts = base.concat([{ value: PREF_CUSTOM_OPTION, label: '＋ 自定义…' }]);
        const sel = makeSelect(row, labelText,
            selOpts,
            custom ? PREF_CUSTOM_OPTION : (base.some(o => o.value === cur) ? cur : selOpts[0].value),
            (v) => {
                if (v === PREF_CUSTOM_OPTION) {
                    // 从内置切到自定义：先清掉旧值，等用户打字再填
                    pfs[key] = '';
                    paintCustom('');
                    inp.focus();
                } else {
                    pfs[key] = v;
                    inputWrap.style.display = 'none';
                }
                persistGenForm();
            },
            desc);
        row.appendChild(sel);
        
        // 自定义输入区：默认隐藏，只有选中「自定义…」时才出现
        const inputWrap = el('div', 'eo-row eo-customrow');
        const inp = elAuto(null, custom, '直接写你要的内容，例如：只留一处能要人命的地方');
        inp.style.flex = '1';
        const paintCustom = (v) => {
            inp.value = v;
            inputWrap.style.display = '';
        };
        inputWrap.style.display = custom ? '' : 'none';
        inp.addEventListener('input', () => {
            pfs[key] = inp.value;
            persistGenForm();
        });
        // 打完回车收起来，看着像确认过了
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        });
        inputWrap.appendChild(el('span', 'eo-hint', '↳'));
        inputWrap.appendChild(inp);
        row.appendChild(inputWrap);
        return row;
    }

    function renderPrefsBlock(page, prefs, opts) {
        opts = opts || {};
        const groupMode = opts.groupMode || {};
        const PREF_TITLE = opts.title || '事件参数';
        const ATTR = opts.attrPrefix || 'pref';

                // 事件参数标题旁带「沿用上次」（2026-11-02）：上次那套就在 genForm 里，
                // 以前只有「重置为默认」，想回到上次的配置只能一项一项点回来。
                // 问号挂在这一行上、排在按钮右边（2026-11-04 危晓要求）：
                // 以前是挂在按钮内部，看上去像按钮里带了个问号，现在挪到框外
                const prefSec = el('div', 'eo-sec eo-sec-inline');
                prefSec.appendChild(el('span', null, PREF_TITLE));
                const btnLast = el('button', 'eo-btn', '沿用上次');
                // 链里每个节点各有一份参数，「沿用上次」是全局概念，节点里没有意义
                if (opts.showLast === false) btnLast.style.display = 'none';
                btnLast.type = 'button';
                btnLast.addEventListener('click', () => {
                    const last = loadGenForm();
                    if (!last.prefs) { toast('还没有上一次的配置，生成一次之后就有了'); return; }
                    // prefs 与 groupMode 是同一份工作区引用，原地覆盖就够了
                    const fresh = Object.assign(defaultPrefs(), last.prefs);
                    for (const k of Object.keys(prefs)) delete prefs[k];
                    Object.assign(prefs, fresh);
                    if (last.groupModes) Object.assign(groupMode, last.groupModes);
                    persistGenForm();
                    log('事件参数已沿用上次的配置');
                    if (opts.repaint) opts.repaint();
                });
                prefSec.appendChild(btnLast);
                // 2026-11-10 危晓：标题行那个问号原来挂的是「沿用上次」的说明，
                // 点开看到的是按钮怎么用，跟标题对不上（真机截图报的）。
                // 现在各归各位：说明文本挪到按钮的 title 上（悬停可见，不占地方、也不多一个问号），
                // 标题行的问号只解释标题本身。问号仍然挂在标题行上，不在按钮边框里。
                btnLast.title = '把下面这套事件参数恢复成上一次用过的那一套。上次的值一直留着，'
                    + '点「重置为默认」才会清掉。已经在用上次那套时这个按钮不会亮。';
                attachHelp(prefSec, '下面这些是这次事件的参数：写什么、写多少、难到什么程度。'
                    + '它们会原样写进生成大纲的提示词，模型按你的选择来决定结构。');
                page.appendChild(prefSec);
                page.appendChild(el('div', 'eo-hint',
                    '这里是「这次想玩什么样的体验」，会原样写进生成大纲的提示词，模型按你的选择决定难度和危险程度。不确定选哪个的，留着「根据当前情况自行设定」就行，模型会自己配一套合理的。'));
        
                // 单项下拉（大致模式下的档位、详细模式下的子项都用它）
        
                /**
                 * 带「自定义」的偏好下拉（2026-11-04 危晓要求：让用户直接手动输入内容）。
                 * 不做成「再新增一个档位」——档位是设置页里预先编好的成套取值，
                 * 这里给的是「这一项我就要这么写」的一次性输入。
                 * 选中「＋ 自定义…」后旁边就长出一个输入框，边打边同步进 prefs，
                 * 切回任意内置选项时自定义值自动作废，不会留下一条看不见的脏数据。
                 * @param {string} key prefs 里的键
                 * @param {Array<{value:string,label:string}>} options 内置选项（第一项通常是自行设定）
                 * @returns {HTMLElement} 一行，直接 append 到容器
                 */
        
                // 重绘某个分组的内容区（折叠壳与按钮不动）
                function paintGroup(groupName, body, hintSpan) {
                    body.textContent = '';
                    // 2026-11-09 危晓定：默认按档位选。
                    // 以前没设过值时落到 else 分支（逐项调），于是他打开任何折叠项
                    // 默认都是逐项调，想用档位得每组手动切一次。
                    // 现在没设过值就按 rough。已经手动切过的分组它们的值存在
                    // S.draftGroupModes 里，读得到，不受影响。
                    const mode = groupMode[groupName] || 'rough';

                    const def = PREF_PRESETS[groupName];
                    // 2026-11-06 M4.2 真机：这里原来只查 PREF_GROUPS，
                    // 而战斗五项在 PREF_COMBAT_GROUPS 里，于是「战斗要素（0 项）」、
                    // 切「逐项调」一片空白。改成按当前主类型取，两张表都覆盖到。
                    const items = prefsForType(prefs && prefs.eventMainType)
                        .filter(x => x.group === groupName);
        
                    if (hintSpan) {
                        hintSpan.textContent = mode === 'rough'
                            ? `一次把本组 ${items.length} 项定好`
                            : '逐项挑，可以拼出档位覆盖不了的组合';
                    }
        
                    if (mode === 'rough') {
                        const row = el('div', 'eo-row');
                        const all = presetOptions(groupName, prefs);
                        // 全部子项都是默认值时就是「自行设定」；组合拼不出来时也归到这一项
                        const cur = matchPreset(groupName, prefs) || 'auto';
                        makeSelect(row, '档位',
                            all.map(o => ({ value: o.key, label: o.label })),
                            cur,
                            (v) => {
                                const pick = all.find(o => o.key === v);
                                if (!pick) return;
                                for (const k of Object.keys(pick.values)) prefs[k] = pick.values[k];
                                paintGroup(groupName, body, hintSpan);
                            },
                            `选一个粗档位，把本组 ${items.length} 个子项一次定好。各个子项之间是独立的，`
                            + '档位只是替你批量填好，想单独调哪一项切到「详细」就行。');
                        body.appendChild(row);
                        const pick = all.find(o => o.key === cur);
                        if (pick) body.appendChild(el('div', 'eo-hint', pick.desc));
                        return;
                    }
        
                    // 详细模式：逐项列出，每一项都能选「＋ 自定义…」当场手打
                    const autoText = autoByText(prefs);
                    for (const g of items) {
                        const opts = g.options.map(o => (o === SUB_AUTO ? autoText : o));
                        body.appendChild(makePrefSelect(prefs, g.key, g.label,
                            opts.map(o => ({ value: o, label: o })),
                            g.desc));
                    }
                }
        
                let curGroup = null;
                // 结构包（M15，2026-11-09）：挂在参数区最上面。
                //
                // 定稿 §3.3 要求显示「实际挂载：X；作为标签：Y、Z」——因为一个类型可能兼容好几个包，
                // 但只挂顺序最前的那一个，剩下的名字仍然有意义（用户要知道这件事还沾了哪些边）。
                // 光显示不给选不行：用户想换个包挂的时候没处点。所以给一个下拉，
                // 选项就是本类型的全部兼容包，选中的那个就是实际挂载的。
                //
                // 没兼容包的类型（案件、生存、NSFW 等）整块不出现，不占地方。
                {
                    const packMainType = prefs && prefs.eventMainType;
                    const compat = compatiblePacksOf(packMainType);
                    if (compat.length) {
                        const box = el('div', 'eo-prefgroup eo-packbox');
                        const sum = el('div', 'eo-prefgroup-sum');
                        box.appendChild(sum);
        
                        // 默认不挂（2026-11-09 危晓定）。空串 = 不挂，不再回退到第一个。
                        const cur = (prefs.__packPicked && compat.includes(prefs.__packPicked))
                            ? prefs.__packPicked
                            : '';
        
                        const paintPack = () => {
                            const mounted = (prefs.__packPicked && compat.includes(prefs.__packPicked))
                                ? prefs.__packPicked
                                : '';
                            if (!mounted) {
                                // 不挂时也要说清「还能挂哪些」，否则用户以为这类型没有包可用
                                sum.textContent = '结构包：不挂'
                                    + (compat.length ? '（可挂：' + compat.join('、') + '）' : '');
                                return;
                            }
                            const asTags = compat.filter(n => n !== mounted);
                            sum.textContent = '结构包：实际挂载 ' + mounted
                                + (asTags.length ? '；作为标签 ' + asTags.join('、') : '');
                        };
                        paintPack();
        
                        const row = el('div', 'eo-row');
                        makeSelect(row, '挂哪个',
                            [{ value: '', label: '不挂' }]
                                .concat(compat.map(n => ({ value: n, label: n }))),
                            cur,
                            (v) => {
                                prefs.__packPicked = v;
                                persistGenForm();
                                paintPack();
                                paintPackHint();
                            },
                            '同时兼容多个包时只挂一个，按这里的顺序取第一个。'
                            + '换一个就等于换掉这次追加的字段，上面主类型的字段不受影响。');
                        box.appendChild(row);
        
                        // 选中包的说明：告诉用户这个包会追加哪几个字段
                        const hintBox = el('div', 'eo-hint');
                        box.appendChild(hintBox);
                        const paintPackHint = () => {
                            const mounted = (prefs.__packPicked && compat.includes(prefs.__packPicked))
                                ? prefs.__packPicked
                                : '';
                            const def2 = mounted ? OUTLINE_PACK_BY_NAME[mounted] : null;
                            if (!def2) {
                                hintBox.textContent = '这次不挂结构包，只按主类型自己的字段生成。';
                                return;
                            }
                            const keys = Object.keys(def2.fields).map(k => labelOf(k));
                            hintBox.textContent = def2.desc + '（追加：' + keys.join('、') + '）';
                        };
                        paintPackHint();
        
                        page.appendChild(box);
                    }
                }
        
                // 各组内容区的重绘函数，供难度等级变化时统一刷新「自行设定」文案
                const groupPainters = {};
                function repaintAllGroups() {
                    for (const name of Object.keys(groupPainters)) {
                        try { groupPainters[name](); } catch (e) { warn('重绘偏好分组失败：' + name, e); }
                    }
                }
                // 2026-11-06 M4.2：参数区按主类型出。通用 11 项 + 本类型专属项；
                // 战斗五项从 PREF_COMBAT_GROUPS 来，与主表原序拼在一起。
                const shownPrefs = prefsForType(prefs && prefs.eventMainType);
                for (const g of shownPrefs) {
                    const isGrouped = !!g.group && !!PREF_PRESETS[g.group];
        
                    if (!isGrouped) {
                        // 独立项：直接一行（难度等级已单独提到上方，这里只剩节点数量等）
                        // 选项里带 SUB_AUTO 占位的（节点数量等），不换掉的话下拉框会直接显示成 __eo_sub_auto__
                        const opts = (g.options || []).map(o => (o === SUB_AUTO ? autoByText(prefs) : o));
                        // 独立项同样支持当场手打，打的内容原样进提示词
                        const row = makePrefSelect(prefs, g.key, g.label,
                            opts.map(o => ({ value: o, label: o })),
                            g.desc);
                        page.appendChild(row);
                        continue;
                    }
        
                    if (g.group !== curGroup) {
                        curGroup = g.group;
                        const box = el('details', 'eo-prefgroup');
                        // 展开状态记在模块里，切页或重绘后仍然开着
                        // 折叠状态加命名空间：链里每个节点各有一套同名分组，
                        // 不加前缀的话「节点1 展开时间压力」会让「节点2 的时间压力」也跟着展开
                        const gKey = (opts.ns ? opts.ns + '/' : '') + g.group;
                        box.open = openPrefGroups.has(gKey);
                        box.addEventListener('toggle', () => {
                            if (box.open) openPrefGroups.add(gKey); else openPrefGroups.delete(gKey);
                        });
                        const sum = el('summary', 'eo-prefgroup-sum');
                        // 2026-11-06 M4.2 真机：这里原来只数 PREF_GROUPS，战斗要素显示成「0 项」。
                        // 用同一个 shownPrefs 数，标题与内容不会对不上。
                        const count = shownPrefs.filter(x => x.group === g.group).length;
                        sum.textContent = `${g.group}（${count} 项）`;
                        box.appendChild(sum);
        
                        const modeRow = el('div', 'eo-row eo-prefmode');
                        const btns = {};
                        const hintSpan = el('span', 'eo-hint', '');
                        const body = el('div', 'eo-prefgroup-body');
                        const paintModes = () => {
                            for (const mk of ['rough', 'detail']) {
                                btns[mk].className = 'eo-btn eo-modebtn' + (groupMode[g.group] === mk ? ' eo-modebtn-on' : '');
                            }
                        };
                        for (const [mk, ml] of [['rough', '按档位选'], ['detail', '逐项调']]) {
                            const b = el('button', 'eo-btn eo-modebtn', ml);
                            b.type = 'button';
                            b.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (groupMode[g.group] === mk) return;
                                groupMode[g.group] = mk;
                                persistGenForm();
                                paintModes();
                                paintGroup(g.group, body, hintSpan);
                            });
                            btns[mk] = b;
                            modeRow.appendChild(b);
                        }
                        modeRow.appendChild(hintSpan);
                        box.appendChild(modeRow);
                        box.appendChild(body);
                        page.appendChild(box);
        
                        paintModes();
                        paintGroup(g.group, body, hintSpan);
                        // 登记，供难度等级切换时刷新文案（重绘内容区，折叠壳不动）
                        groupPainters[g.group] = () => paintGroup(g.group, body, hintSpan);
                    }
                }
        
                const extraRow = el('div', 'eo-row');
                extraRow.appendChild(el('label', null, '额外要求'));
                const extraInput = elAuto(null, prefs.extra || '无', '');
                extraInput.addEventListener('input', () => { prefs.extra = extraInput.value; persistGenForm(); });
                extraInput.addEventListener('change', persistGenForm);
                extraInput.style.flex = '1';
                extraRow.appendChild(extraInput);
                page.appendChild(extraRow);
        
                // 重置按钮：把上面这一整套选项拨回默认，不动待选区
                // 问号放在按钮外面（2026-11-01 危晓要求）：按钮的点击区只负责重置，
                // 别让「看说明」和「一键清空」挤在一块儿容易误点
                const rstRow = el('div', 'eo-row eo-reset-row');
                const btnReset = el('button', 'eo-btn', '重置为默认');
                btnReset.type = 'button';
                btnReset.addEventListener('click', async () => {
                    if (!(await askConfirm('把上面所有选项重置为默认？已生成的待选事件不受影响。'))) return;
                    resetDraftPrefs();
                    log('生成页选项已重置为默认');
                    if (opts.repaint) opts.repaint();
                });
                rstRow.appendChild(btnReset);
                attachHelp(rstRow, '把事件名、事件目的、框架提示、额外要求和全部事件参数拨回默认值。'
                    + '已经生成的待选事件不受影响，它们各自记着自己生成时的那份设置。', true);
                // 链里每个节点自己的重置由外层提供，这里不重复
                if (opts.showReset === false) rstRow.style.display = 'none';
                page.appendChild(rstRow);

                // 返回内容区重绘函数：外层难度等级下拉改档时靠它刷新各组的「自行设定」文案。
                // 原来两者在同一个函数里，闭包直接可见；抽成独立函数后只能靠返回值传出。
                return repaintAllGroups;
    }

    /**
     * 生成页入口（M16）。按「单个事件 / 事件链」分两条路走。
     *
     * 两套界面差别很大：单事件是一套类型+参数；事件链是一串节点，每个节点各有
     * 自己的类型和整套参数。硬塞进同一个函数里会到处是 if，所以分开写。
     */
    /**
     * 生成模式开关：单事件 / 事件链（M16）。
     *
     * 两个页面各要一份——链页有、单事件页也要有，否则切过去就切不回来了。
     * 之前删旧模式块时连单事件页的开关一起删了，表现就是「切到事件链之后，
     * 切回单个事件的按钮不见了」。所以抽成一个函数，两处都调。
     *
     * 位置：事件名之后、事件类型之前。它决定的是「这次要生成什么」，
     * 比任何一个参数都靠前。
     */
    function renderGenModeSwitch(page, prefs, hint) {
        page.appendChild(el('div', 'eo-sec eo-sec-inline', '生成模式'));
        const row = el('div', 'eo-row eo-chainmode');
        const btns = {};
        const paint = () => {
            for (const mk of ['single', 'chain']) {
                btns[mk].className = 'eo-btn eo-modebtn'
                    + ((prefs.__genMode || 'single') === mk ? ' eo-modebtn-on' : '');
            }
        };
        for (const [mk, ml] of [['single', '单事件'], ['chain', '事件链']]) {
            const b = el('button', 'eo-btn eo-modebtn', ml);
            b.type = 'button';
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if ((prefs.__genMode || 'single') === mk) return;
                prefs.__genMode = mk;
                persistGenForm();
                repaintPage();
            });
            btns[mk] = b;
            row.appendChild(b);
        }
        paint();
        page.appendChild(row);
        if (hint) page.appendChild(el('div', 'eo-hint', hint));
        return row;
    }

    function renderGenForm(page, prefsArg) {
        const prefs = prefsArg || getDraftPrefs();
        // 2026-11-10 危晓：生成模式开关已上移到 renderGenPage 的整页最顶部，
        // 这里不再渲染，避免出现两个开关。
        if ((prefs.__genMode || 'single') === 'chain') {
            renderGenChain(page, prefs);
        } else {
            renderGenSingle(page);
        }
    }

    /**
     * 事件链模式的生成页（M16，2026-11-09）。
     *
     * 与单事件的差别不只是加几个控件：
     *   单事件 = 一个主类型 + 一套参数
     *   事件链 = 一串节点，每个节点各有自己的主类型和**整套参数**
     *
     * 所以这里不复用单事件那套表单，而是重新排：
     *   ① 生成模式（切换）
     *   ② 链级共享设置：链名、节点数、链级难度等级、时间压力
     *      —— 这些不归任何单个节点，所以排在所有节点之上，不塞进节点参数里
     *   ③ 每个节点的折叠块：主类型 + 概要 + 该类型的一整套参数
     *
     * 每个节点的参数存在 prefs.__chainNodePrefs[i].prefs 里，互不干扰；
     * 因为参数本来就有「按主类型各存一份」的机制（byType），
     * 节点选了不同主类型时，各自的参数天然就是分开的。
     */
    function renderGenChain(page, prefs) {
        // 链是一个整体，事件名对外用它，所以这里还是要一个
        page.appendChild(el('div', 'eo-sec', '事件链'));

        // ② 链级共享设置
        // 先把节点拿在手里再挂问号：page.lastChild 在真实 DOM 里可能是空白文本节点，
        // appendChild 到文本节点上会直接抛错，整页就渲染不下去
        const chainSec = el('div', 'eo-sec eo-sec-inline', '链级设置');
        attachHelp(chainSec, '这些是整条链共用的，不属于任何单个节点。');
        page.appendChild(chainSec);

        const n = chainNodeCountOf(prefs.__chainNodes);
        if (!Array.isArray(prefs.__chainNodePrefs)) prefs.__chainNodePrefs = [];
        while (prefs.__chainNodePrefs.length < n) {
            prefs.__chainNodePrefs.push({ primary: '', brief: '', prefs: null });
        }

        const nameRow = el('div', 'eo-row');
        nameRow.appendChild(el('span', null, '链名'));
        const ci = elAuto(null, prefs.__chainName, '可留空，让模型自己起');
        ci.style.flex = '1';
        ci.addEventListener('input', () => {
            prefs.__chainName = ci.value;
            persistGenForm();
        });
        nameRow.appendChild(ci);
        page.appendChild(nameRow);

        const nRow = el('div', 'eo-row');
        makeSelect(nRow, '链节点数',
            CHAIN_NODE_CHOICES.map(c => ({ value: String(c), label: String(c) + ' 个' })),
            String(n),
            (v) => {
                prefs.__chainNodes = chainNodeCountOf(v);
                persistGenForm();
                repaintPage();
            },
            '这条链由几个事件串成。默认 3 个。太长的话世界书条目会变多，模型也容易在后面跑偏。');
        page.appendChild(nRow);

        // 链级难度等级：整条链的强度基准，各节点参数里写「根据难度等级自行设定」的按它推导
        const lvRow = el('div', 'eo-row');
        let repaintGroups = null;
        {
            const lvOpts = [PREF_AUTO_NEW].concat(getDifficultyLevels());
            makeSelect(lvRow, PREF_LEVEL_ITEM.label,
                lvOpts.map(o => ({ value: o, label: o })),
                prefs[PREF_LEVEL_ITEM.key] || PREF_AUTO_NEW,
                (v) => { prefs[PREF_LEVEL_ITEM.key] = v; persistGenForm(); },
                '整条链的强度基准。各节点参数里显示「根据难度等级自行设定」的项都按它推导。');
        }
        page.appendChild(lvRow);

        const pressureRow = el('div', 'eo-row');
        pressureRow.appendChild(el('span', null, '时间压力'));
        const pi = elAuto(null, prefs.__chainPressure, '可留空，例如：入夜前必须结束，天亮后猎户会进山');
        pi.style.flex = '1';
        pi.addEventListener('input', () => {
            prefs.__chainPressure = pi.value;
            persistGenForm();
        });
        pressureRow.appendChild(pi);
        page.appendChild(pressureRow);
        page.appendChild(el('div', 'eo-hint',
            '整条链的时间压力与紧迫感。留空则由模型按剧情自己定。'));

        // ③ 各节点
        page.appendChild(el('div', 'eo-sec eo-sec-inline', '各节点'));
        page.appendChild(el('div', 'eo-hint',
            '每个节点是一个独立事件，各选各的主类型、各配各的事件参数。'
            + '类型留空就由模型按剧情自己排。'));

        const list = el('div', 'eo-chainnodes');
        for (let i = 0; i < n; i++) {
            list.appendChild(renderChainNodeEditor(prefs, i, () => repaintPage()));
        }
        page.appendChild(list);

        // ④ 生成按钮
        const opOut = el('div', 'eo-hint');
        const goRow = el('div', 'eo-row');
        // 2026-11-10 危晓：改叫「生成链骨架」，底色改成跟面板同色系的渐变（原来土黄实心块太跳）
        const btnGo = el('button', 'eo-btn eo-grad', '生成链骨架');
        if (S.busy) {
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
        }
        btnGo.addEventListener('click', async () => {
            if (S.busy) return;
            btnGo.disabled = true;
            btnGo.textContent = '正在生成链骨架…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在设计这条链由哪几个事件串成，请稍候…';
            try {
                startProgress('正在生成链骨架');
                const { chain, raw, problems } = await createChainSkeleton(
                    String(prefs.__chainName || '').trim(), prefs, prefs.__chainNodes,
                    // 2026-11-10 危晓报的两件事，根因都是这一行：
                    // (1) 节点里填的衔接条件不生效——原来只映射 primary/brief，triggers 被丢掉，
                    //     createChainSkeleton 里那段「用户填了用用户的」永远拿不到值，只好用模型的。
                    // (2) 节点里配的事件参数不生效——prefs 也没传。
                    // 改成整份透传，由下游各取所需。
                    prefs.__chainNodePrefs.map(x => ({
                        primary: x.primary,
                        brief: x.brief,
                        triggers: Array.isArray(x.triggers) ? x.triggers : [],
                        prefs: x.prefs || null,
                    })),
                    String(prefs.__chainPressure || '').trim());
                if (problems.length) warn('链骨架有问题：' + problems.join('；'));
                opOut.className = problems.length ? 'eo-bad' : 'eo-ok';
                opOut.textContent = problems.length
                    ? '骨架已生成，但有几处要你看一眼：' + problems.join('；')
                    : '骨架已生成，确认无误就可以逐条生成。';
                openChainPreview(chain, problems, raw);
            } catch (e) {
                error('生成链骨架失败：', e);
                opOut.className = 'eo-bad';
                opOut.textContent = '生成链骨架失败：' + (e && e.message || e);
            } finally {
                btnGo.disabled = false;
                btnGo.textContent = '生成链骨架';
                resetProgress();
            }
        });
        goRow.appendChild(btnGo);
        page.appendChild(goRow);
        page.appendChild(opOut);

        // 已经生成过骨架的，把预览挂出来
        if (S.chainDraft) renderChainPreview(page);
    }

    /**
     * 单个节点的编辑块（M16）。
     *
     * 一个节点的配置 = 主类型 + 一句话概要 + 该主类型的整套事件参数。
     * 参数用 renderPrefsBlock 渲染，与单事件那套是同一个函数，
     * 所以链里的参数和单事件里的参数长得一样、行为一样。
     */
    /**
     * 某个节点的「衔接条件」编辑区（M16，2026-11-09 危晓要）。
     *
     * 放在「各节点」配置里，和该节点的主类型、要做的事摆在一起——
     * 因为填的时候节点数已经定了，知道有哪几个节点可以指向。
     *
     * 数据存在 prefs.__chainNodePrefs[i].triggers，与骨架里模型给的 chain.triggers
     * 是两份，生成骨架时由 createChainSkeleton 合并：用户填了用用户的，没填用模型的。
     * 这样「先填条件再生成骨架」和「生成完再回来改」两条路都成立。
     */
    function renderNodeTriggers(prefs, i, repaint) {
        const cur = prefs.__chainNodePrefs[i] || (prefs.__chainNodePrefs[i] = { primary: '', brief: '', prefs: null });
        if (!Array.isArray(cur.triggers)) cur.triggers = [];

        const n = chainNodeCountOf(prefs.__chainNodes);
        const from = i + 1;
        const others = [];
        for (let k = 1; k <= n; k++) if (k !== from) others.push(k);

        const box = el('div', 'eo-nodetrig');
        box.appendChild(el('div', 'eo-hint', '衔接条件：这一环结束、满足什么条件时，走去哪个节点'));

        if (!others.length) {
            box.appendChild(el('div', 'eo-hint', '只有一个节点，没有可以去的地方。'));
            return box;
        }

        const listBox = el('div', 'eo-nodetrig-list');
        const paint = () => {
            listBox.textContent = '';
            cur.triggers.forEach((t, ti) => {
                const row = el('div', 'eo-nodetrig-row');

                const line1 = el('div', 'eo-trig-line');
                line1.appendChild(el('span', 'eo-hint', '若'));
                const cond = el('textarea', 'eo-auto');
                cond.rows = 1;
                cond.value = String(t.condition || '');
                cond.placeholder = '留空就用模型想的那句';
                autoGrow(cond);
                cond.addEventListener('input', () => {
                    t.condition = cond.value;
                    persistGenForm();
                });
                line1.appendChild(cond);
                row.appendChild(line1);

                const line2 = el('div', 'eo-trig-line');
                line2.appendChild(el('span', 'eo-hint', '则走到节点'));
                const sel = el('select', 'eo-sel');
                for (const ix of others) {
                    const o = el('option', null, `节点 ${ix}`);
                    o.value = String(ix);
                    if (String(t.to) === String(ix)) o.selected = true;
                    sel.appendChild(o);
                }
                sel.addEventListener('change', () => {
                    t.to = parseInt(sel.value, 10);
                    persistGenForm();
                });
                line2.appendChild(sel);

                const del = el('button', 'eo-btn eo-btn-del', '×');
                del.type = 'button';
                del.title = '删掉这条衔接';
                del.addEventListener('click', () => {
                    cur.triggers.splice(ti, 1);
                    persistGenForm();
                    paint();
                });
                line2.appendChild(del);
                row.appendChild(line2);

                listBox.appendChild(row);
            });

            if (!cur.triggers.length) {
                listBox.appendChild(el('div', 'eo-hint', '还没填：留空的话，由模型在骨架里自己想一个过渡条件。'));
            }
        };
        paint();
        box.appendChild(listBox);

        const addRow = el('div', 'eo-row');
        const add = el('button', 'eo-btn', '＋ 加一条去向');
        add.type = 'button';
        add.addEventListener('click', () => {
            const nxt = others.includes(from + 1) ? from + 1 : others[0];
            cur.triggers.push({ to: nxt, condition: '' });
            persistGenForm();
            paint();
        });
        addRow.appendChild(add);
        box.appendChild(addRow);

        return box;
    }

    function renderChainNodeEditor(prefs, i, repaint) {
        const cur = prefs.__chainNodePrefs[i] || (prefs.__chainNodePrefs[i] = { primary: '', brief: '', prefs: null });

        const box = el('details', 'eo-prefgroup eo-chainnode-box');
        box.open = false;

        const sum = el('summary', 'eo-prefgroup-sum');
        const paintSum = () => {
            const ty = cur.primary || '模型自定';
            const br = String(cur.brief || '').trim();
            sum.textContent = `节点 ${i + 1}：${ty}` + (br ? ` · ${br}` : '');
        };
        paintSum();
        box.appendChild(sum);

        const body = el('div', 'eo-prefgroup-body');

        // 主类型
        const tyRow = el('div', 'eo-row');
        tyRow.appendChild(el('span', null, '主类型'));
        const sel = el('select', 'eo-sel');
        sel.style.flex = '1';
        const optAuto = el('option', null, '（模型自定）');
        optAuto.value = '';
        if (!cur.primary) optAuto.selected = true;
        sel.appendChild(optAuto);
        for (const t of getMainTypes()) {
            let label = t;
            if (t === '其他') label = '其他（兜底）';
            else if (!skeletonForType(t)) label = t + '（骨架未完成）';
            const o = el('option', null, label);
            o.value = t;
            if (t === cur.primary) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
            cur.primary = sel.value;
            persistGenForm();
            paintSum();
            // 类型一变，参数区要整个换掉（不同主类型参数不同）
            repaintPage();
        });
        tyRow.appendChild(sel);
        body.appendChild(tyRow);

        // 概要
        const brRow = el('div', 'eo-row');
        brRow.appendChild(el('span', null, '要做的事'));
        const bi = elAuto(null, cur.brief, '一句话说清这一环要做什么（可留空）');
        bi.style.flex = '1';
        bi.addEventListener('input', () => {
            cur.brief = bi.value;
            persistGenForm();
            paintSum();
        });
        brRow.appendChild(bi);
        body.appendChild(brRow);

        // 额外要求 / 事件目的 / 框架提示（2026-11-10 补）
        // 起因：查第 8 项时才发现节点编辑器里根本没有这三项的输入框，
        // 它们只长在单事件页上。而 buildChainNodePrompt 本来就按
        // extra / goal / promptHint 去读节点参数，读的永远是空值。
        // 换句话说链模式下这三项既没有入口、也没有输出，用户想给某一环写点具体剧情没有地方写。
        //
        // 存法：和单事件页一样存在 cur.prefs 上（extra 有默认值「无」，另两项空着就是没填）。
        // 为此这里要先把 cur.prefs 建好——原来它在下面「事件参数」那段里才懒创建，
        // 而那一段要求先选了主类型。这三项不该等主类型，所以在前面就补上。
        if (!cur.prefs) {
            cur.prefs = Object.assign(defaultPrefs(), { eventMainType: cur.primary || '' });
            // 链级难度等级作为这个节点的初值，与下面「事件参数」那段原来的做法一致
            if (prefs[PREF_LEVEL_ITEM.key]) cur.prefs[PREF_LEVEL_ITEM.key] = prefs[PREF_LEVEL_ITEM.key];
        }

        {
            // 注意：「额外要求」这个输入框不用在这里造——renderPrefsBlock 末尾本来就有，
            // 链节点正是调它渲染参数区的，再加一个就会出现两个一模一样的框（真机上撞到过）。
            // 这里只补它没有的两项：事件目的、框架提示。

            const goalLab = el('div', 'eo-hint', '事件目的（这一环最终要达成什么，填了会成为硬约束）');
            body.appendChild(goalLab);
            const goalIn = el('textarea', 'eo-input eo-textarea');
            goalIn.rows = 2;
            goalIn.placeholder = '例如：让玩家在踏查中发现兽崽不是普通野兽，而是被谁放出来的';
            goalIn.value = cur.prefs.goal || '';
            goalIn.addEventListener('input', () => {
                cur.prefs.goal = goalIn.value;
                persistGenForm();
            });
            body.appendChild(goalIn);

            const hintLab = el('div', 'eo-hint', '框架提示（你自己构思的大致框架或想要的桥段）');
            body.appendChild(hintLab);
            const hintIn = el('textarea', 'eo-input eo-textarea');
            hintIn.rows = 2;
            hintIn.placeholder = '例如：先看羊圈，再顺着足迹进林子，中途被扑一次';
            hintIn.value = cur.prefs.promptHint || '';
            hintIn.addEventListener('input', () => {
                cur.prefs.promptHint = hintIn.value;
                persistGenForm();
            });
            body.appendChild(hintIn);
        }

        // 衔接条件（2026-11-09 危晓）：在「各节点」这里填，不用跑去骨架预览里改。
        // 放到这里的原因是节点数在这一屏就能定，填条件时已经知道有几个节点可以指向。
        // 存法：prefs.__chainNodePrefs[i].triggers = [{to, condition}]，
        // 骨架生成后由 createChainSkeleton 合并——用户填了用他的，没填用模型给的。
        body.appendChild(renderNodeTriggers(prefs, i, repaint));


        // 该类型的整套事件参数
        if (cur.primary) {
            // 每个节点一份独立的 prefs（第一次用该节点的类型默认值）
            if (!cur.prefs) {
                cur.prefs = Object.assign(defaultPrefs(), { eventMainType: cur.primary });
                // 链级难度等级作为这个节点的初值
                if (prefs[PREF_LEVEL_ITEM.key]) cur.prefs[PREF_LEVEL_ITEM.key] = prefs[PREF_LEVEL_ITEM.key];
            }
            cur.prefs.eventMainType = cur.primary;
            const pbox = el('div', 'eo-chainnode-prefs');
            renderPrefsBlock(pbox, cur.prefs, {
                groupMode: (cur.groupMode = cur.groupMode || {}),
                // 折叠状态按节点分开，否则节点1 展开哪组，节点2 的同名组也跟着展开
                ns: 'node' + i,
                repaint,
                // 2026-11-10 危晓：改成只写「事件参数」。
                // 节点序号在外层折叠块标题里已经有了，这里再写一遍是重复。
                title: '事件参数',
                showLast: false,
                showReset: false,
            });
            body.appendChild(pbox);
        } else {
            body.appendChild(el('div', 'eo-hint',
                '先选主类型，这里才会出现这一环专属的事件参数。'));
        }

        box.appendChild(body);

        // 展开状态记在模块里，重绘后仍开着
        box.addEventListener('toggle', () => {
            if (box.open) openPrefGroups.add('chainNode' + i);
            else openPrefGroups.delete('chainNode' + i);
        });
        box.open = openPrefGroups.has('chainNode' + i);

        return box;
    }

    function renderGenSingle(page) {
        // --- 新建事件表单 ---
        page.appendChild(el('div', 'eo-sec', '事件'));
        const nameRow = el('div', 'eo-row');
        nameRow.appendChild(el('label', null, '事件名'));
        const nameInput = elAuto(null, S.draftName, '例如：东方快车谋杀案');
        markKey(nameInput, 'gen.name');
        nameInput.addEventListener('input', () => { S.draftName = nameInput.value; persistGenForm(); });
        // 切走或刷新前的最后一道保险：输入法组字中可能没触发 input，失焦时再存一次
        nameInput.addEventListener('change', persistGenForm);
        nameRow.appendChild(nameInput);
        page.appendChild(nameRow);
        page.appendChild(el('div', 'eo-hint',
            '事件名可以留空。留空时模型会读当前剧情，自己起一个 4-12 字的事件名。想自己起就填这里。'));

        // 偏好状态放在闭包里，切换大致/详细或改档位只重绘内容区，
        // 不重建折叠壳，所以不会自己折回去
        const prefs = getDraftPrefs();
        const groupMode = getGroupModes();

        // 生成模式：单事件 / 事件链。切到链就整页换一套界面。
        // --- 事件类型：主类型单选，次类型最多三个 ---
        page.appendChild(el('div', 'eo-sec', '事件类型'));
        page.appendChild(el('div', 'eo-hint',
            `主类型只能选一个，次类型最多选 ${MAX_SUB_TYPES} 个，两个都可以不选，不选就由模型按当前剧情判断。`
            + '末尾的「自定义」可以直接手打一个类型，打了就记住，下次还在列表里。'));

        // 自定义类型（2026-11-04）：选「＋自定义」就地弹输入框，输入的名字存进设置，
        // 写回 mainTypes / subTypes，之后和内置类型一样出现在列表里
        function addCustomType(kind) {
            const isMain = kind === 'main';
            const cur = isMain ? getMainTypes() : getSubTypes();
            const input = window.prompt(
                isMain ? '输入一个主类型名称（会和内置类型一起出现在下拉里）' : '输入一个次类型名称（会加进下面的选项按钮里）',
                '');
            if (input === null) return '';
            const name = String(input).trim();
            if (!name) return '';
            if (cur.includes(name) || name === EVENT_TYPE_DEFAULT) {
                log(`类型「${name}」已经存在，没有重复添加`);
                return name;
            }
            const s = getSettings();
            const key = isMain ? 'mainTypes' : 'subTypes';
            const base = isMain ? EVENT_MAIN_TYPES : EVENT_SUB_TYPES;
            const stored = (s.preset && Array.isArray(s.preset[key])) ? s.preset[key].slice() : [];
            // 第一次改就从内置那套的基础上加，否则用户会发现自己加了一个类型、内置的全没了
            const merged = (stored.length ? stored : base.slice());
            if (!merged.includes(name)) merged.push(name);
            s.preset[key] = merged;
            saveSettings();
            log(`已添加${isMain ? '主' : '次'}类型「${name}」，共 ${merged.length} 个`);
            repaintPage();
            return name;
        }

        const mainRow = el('div', 'eo-row');
        mainRow.appendChild(el('label', null, '主类型'));
        const mainSel = el('select', 'eo-sel');
        mainSel.style.flex = '1';
        // 2026-11-05 M1：主类型改成必选（定稿 1B）。
        // 原来第一项是「根据当前情况自行设定」，等于让模型猜——猜错整个事件就白生成了，
        // 而且八套骨架之后必须知道是哪一类才能挑内层字段，猜不得。
        // 现在第一项是空占位「请选择主类型」，选中它时「开始生成大纲」禁用并提示。
        const MAIN_UNSET = '';
        {
            const o = el('option', null, '请选择主类型');
            o.value = MAIN_UNSET;
            mainSel.appendChild(o);
        }
        for (const t of getMainTypes()) {
            // 2026-11-06 M4.1：没有骨架的类型在后面标出来。
            // 九个主类型里只有案件和战斗有骨架，剩下七个选下去界面毫无反应，
            // 用户要等到拿到生成结果才发现「只有字段清单、没有示例」。
            //
            // M6（2026-11-06）：「其他」是个特例——它有骨架（通用六字段），
            // 但没有专属示例（示例是给具体类型看的）。所以它不该被标成「骨架未完成」，
            // 而该说明「兜底用，只有字段清单」。
            let label = t;
            if (t === '其他') label = '其他（兜底，十三个专用类型都不贴时才选）';
            else if (!skeletonForType(t)) label = t + '（骨架未完成）';
            const o = el('option', null, label);
            o.value = t;
            mainSel.appendChild(o);
        }
        const MAIN_CUSTOM = '__eo_main_custom__';
        const mainCustomOpt = el('option', null, '＋ 自定义…');
        mainCustomOpt.value = MAIN_CUSTOM;
        mainSel.appendChild(mainCustomOpt);
        // 手打过的类型名也记在草稿里，重绘后仍能选中
        // 2026-11-05 M1：旧草稿里可能还存着 EVENT_TYPE_DEFAULT（「根据当前情况自行设定」），
        // 那个值现在不再是合法主类型了，读到时按「未选」处理，逼用户重新选一次。
        const rawMain = String(prefs.eventMainType || '').trim();
        const curMain = (rawMain && rawMain !== EVENT_TYPE_DEFAULT) ? rawMain : MAIN_UNSET;
        if (!Array.from(mainSel.options).some(o => o.value === curMain) && curMain !== MAIN_CUSTOM) {
            const o = el('option', null, curMain);
            o.value = curMain;
            mainSel.appendChild(o);
        }
        mainSel.value = curMain;
        mainSel.addEventListener('change', () => {
            if (mainSel.value === MAIN_CUSTOM) {
                const added = addCustomType('main');
                prefs.eventMainType = added || curMain;
                persistGenForm();
                if (!added) repaintPage();
                return;
            }
            const prevType = prefs.eventMainType;
            prefs.eventMainType = mainSel.value;
            // 2026-11-06 M4.2：切换前先把当前这套值存回它自己的类型名下，
            // 再从新类型名下取。不这么做，切走就丢、切回来是空的。
            // 顺序要紧：先存旧类型，再取新类型，否则刚存的值会被立刻覆盖。
            if (prevType && prevType !== prefs.eventMainType) {
                setTypePrefs(prevType, prefs);
                const restored = getTypePrefs(prefs.eventMainType);
                Object.assign(prefs, restored);
            }
            persistGenForm();
            // 2026-11-06 真机反馈：切主类型后下面的设置项没变化。
            // 原因有两层，这里修的是第一层——change 里只存了草稿、没重绘，
            // 页面还是上一次画的那张，用户改完看不出任何反应。
            // 第二层（下面那批设置项本身与主类型无关）是另一件事，见 renderGenForm 里的说明。
            // 2026-11-06 M4.2：第二层已修，参数区现在按 prefsForType 出，重绘就能跟着变。
            repaintPage();
        });
        mainRow.appendChild(mainSel);
        page.appendChild(mainRow);

        // 主类型列表里已有的自定义类型，给一个删除入口，否则加错了只能去设置里改
        {
            const customMains = getMainTypes().filter(x => !EVENT_MAIN_TYPES.includes(x));
            if (customMains.length) {
                const box = el('div', 'eo-hint');
                box.appendChild(el('span', null, '自定义主类型：'));
                for (const name of customMains) {
                    const del = el('button', 'eo-btn', `✕ ${name}`);
                    del.type = 'button';
                    del.title = '从主类型列表里移除';
                    del.style.marginRight = '6px';
                    del.addEventListener('click', () => {
                        const s = getSettings();
                        const stored = (s.preset && Array.isArray(s.preset.mainTypes) && s.preset.mainTypes.length)
                            ? s.preset.mainTypes.slice() : EVENT_MAIN_TYPES.slice();
                        s.preset.mainTypes = stored.filter(x => x !== name);
                        if (prefs.eventMainType === name) prefs.eventMainType = MAIN_UNSET;
                        saveSettings();
                        persistGenForm();
                        log(`已移除主类型「${name}」`);
                        repaintPage();
                    });
                    box.appendChild(del);
                }
                page.appendChild(box);
            }
        }

        // 次类型：多选按钮，点一下选中/取消，超过上限就拦住
        const subWrap = el('div', 'eo-row eo-subtype-wrap');
        subWrap.appendChild(el('label', null, '次类型'));
        const subBox = el('div', 'eo-subtypes');
        const selSet = new Set(prefs.eventSubTypes || []);
        const counter = el('span', 'eo-hint', '');
        const paintCounter = () => {
            counter.textContent = `已选 ${selSet.size}/${MAX_SUB_TYPES}`;
            counter.className = selSet.size >= MAX_SUB_TYPES ? 'eo-warn' : 'eo-hint';
        };
        // 选中的次类型里可能有已经从列表删掉的，也要显示出来，否则用户看不见自己选了什么
        const subList = getSubTypes().slice();
        for (const t of selSet) if (!subList.includes(t)) subList.push(t);
        for (const t of subList) {
            const b = el('button', 'eo-btn eo-subtype' + (selSet.has(t) ? ' eo-subtype-on' : ''), t);
            b.type = 'button';
            b.addEventListener('click', () => {
                if (selSet.has(t)) {
                    selSet.delete(t);
                } else {
                    if (selSet.size >= MAX_SUB_TYPES) {
                        counter.textContent = `最多选 ${MAX_SUB_TYPES} 个，先取消一个再选`;
                        counter.className = 'eo-bad';
                        return;
                    }
                    selSet.add(t);
                }
                b.className = 'eo-btn eo-subtype' + (selSet.has(t) ? ' eo-subtype-on' : '');
                prefs.eventSubTypes = Array.from(selSet);
                paintCounter();
                persistGenForm();
            });
            subBox.appendChild(b);
        }
        // 自定义次类型入口：加完如果还有名额就顺手选中，省一次点击
        {
            const b = el('button', 'eo-btn eo-subtype', '＋ 自定义');
            b.type = 'button';
            b.addEventListener('click', () => {
                const name = addCustomType('sub');
                if (!name) return;
                if (selSet.size < MAX_SUB_TYPES && !selSet.has(name)) {
                    selSet.add(name);
                    prefs.eventSubTypes = Array.from(selSet);
                    persistGenForm();
                }
                repaintPage();
            });
            subBox.appendChild(b);
        }
        subWrap.appendChild(subBox);
        page.appendChild(subWrap);
        paintCounter();
        page.appendChild(counter);

        // 事件目的与框架提示放在事件参数之前：这两个是「想要什么」，
        // 偏好是「多难多险」，先想清楚要什么再调强度，顺序才对
        page.appendChild(el('div', 'eo-sec eo-sec-inline', '事件目的'));
        page.appendChild(el('div', 'eo-hint',
            '你想让这个事件最终达成什么。留空则由模型按当前剧情自行判断。填了会成为硬约束，大纲会围绕它展开。'));
        const goalInput = el('textarea', 'eo-input eo-textarea');
        goalInput.rows = 3;
        goalInput.placeholder = '例如：让玩家在最终揭开前，逐步发现车上的乘客都与同一桩旧案有关，并理解他们为何共同动手';
        goalInput.value = prefs.goal || '';
        goalInput.addEventListener('input', () => { prefs.goal = goalInput.value; persistGenForm(); });
        goalInput.addEventListener('change', persistGenForm);
        page.appendChild(goalInput);

        page.appendChild(el('div', 'eo-sec eo-sec-inline', '事件框架提示'));
        page.appendChild(el('div', 'eo-hint',
            '你自己构思的大致框架、想要的桥段或细节。留空则完全由模型设计。填了会尽量采纳。'));
        const hintInput = el('textarea', 'eo-input eo-textarea');
        hintInput.rows = 4;
        hintInput.placeholder = '例如：开场列车遭遇暴雪被困，死者身中十二刀；中途每个乘客的证词都互相印证却彼此矛盾；结尾靠一枚被烧焦的信纸残片把所有人的旧案串起来';
        hintInput.value = prefs.promptHint || '';
        hintInput.addEventListener('input', () => { prefs.promptHint = hintInput.value; persistGenForm(); });
        hintInput.addEventListener('change', persistGenForm);
        page.appendChild(hintInput);


        // 难度等级挪到事件参数之上（2026-11-04 危晓要求）：
        // 它定的是整件事的强度档，下面那些子项里写「根据难度等级自行设定」的都按它推导，
        // 所以位置要在事件参数之上，不能埋在参数里面
        page.appendChild(el('div', 'eo-sec eo-sec-inline', PREF_LEVEL_ITEM.label));
        page.appendChild(el('div', 'eo-hint',
            '这次事件整体的强度档位。下面是事件参数，其中凡是显示「根据难度等级自行设定」的项，'
            + '都会按这里选的等级成套推导。档位可以在设置页「难度等级」里按你的角色卡改。'));
        {
            const lvOpts = [PREF_AUTO_NEW].concat(getDifficultyLevels());
            const lvRow = makePrefSelect(prefs, PREF_LEVEL_ITEM.key, PREF_LEVEL_ITEM.label,
                lvOpts.map(o => ({ value: o, label: o })),
                PREF_LEVEL_ITEM.desc);
            page.appendChild(lvRow);
            // 等级变了，下面各组的「自行设定」文案跟着变。
            // 参数区在下面才渲染，它的重绘函数此刻还拿不到，所以先留个盒子，
            // 渲染完再塞进去。原来两者在同一个函数里，闭包直接看得见；
            // 参数区抽成独立函数之后，只能这样传。
            const lvSel = lvRow.querySelector('select');
            if (lvSel) {
                lvSel.addEventListener('change', () => {
                    try { if (repaintGroups) repaintGroups(); } catch (e) { warn('刷新偏好文案失败', e); }
                });
            }
        }


        // 事件参数区（M16 抽成独立函数，链模式里每个节点各渲染一份）
        // 返回的是「重绘各组文案」的函数，难度等级下拉改档时要调它。
        // 2026-11-10 修：这一行原来写成 repaintGroups = renderPrefsBlock(...)，
        // 但单事件页里根本没声明 repaintGroups（那个变量只在链页 renderGenChain 里有过），
        // 于是抛 ReferenceError: repaintGroups is not defined，
        // 后面创建底部「开始生成大纲」按钮的代码全部没执行到——真机上就是按钮凭空消失。
        const repaintGroups = renderPrefsBlock(page, prefs, { groupMode, repaint: repaintPage });

        // 上下文预览
        // 这里原本会列出「记忆来源 / 最近楼层 / 世界书 / 纪要」四行统计，
        // 但生成时真正用了哪些上下文，日志页有更准确的一份，这块只是重复占地方，已移除

        const opOut = el('div', 'eo-hint');
        const goRow = el('div', 'eo-row');
        const btnGo = el('button', 'eo-btn eo-primary', '开始生成大纲');
        // 生成中 / 切页回来后恢复按钮状态：busy 是模块级变量，切换标签页不会丢，
        // 但每次 renderPanel 都会新建按钮，所以要按 busy 重新禁用
        if (S.busy) {
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
        }
        // 主类型必选（2026-11-05 M1，定稿 1B）：没选就禁用生成并提示，不默认任何类型。
        // 2026-11-10 危晓报「单事件下最下面的生成按钮不见了」——实测按钮确实造出来了，
        // 但没选类型时 disabled=true，.eo-btn:disabled 只有 .5 透明度，
        // 又在长表单最底部，手机上几乎看不出那里有个按钮。
        // 所以改成：按钮始终可点，没选类型时点下去在提示行说明缺什么。
        // 门禁本身不放松——点击回调里照样会拦（见下面的 chosenMain 判断）。
        const refreshGoGate = () => {
            if (S.busy) return;
            const chosen = String(mainSel.value || '').trim();
            const unset = !chosen || chosen === MAIN_UNSET;
            btnGo.disabled = false;
            btnGo.title = unset ? '请先选择主类型再生成' : '';
            if (unset) {
                opOut.className = 'eo-hint';
                opOut.textContent = '还没选主类型：选好之后点上面的「开始生成大纲」。';
            } else if (!skeletonForType(chosen)) {
                // 2026-11-06 M4.1：没有骨架的类型要提前说清楚。
                // 这类类型不是不能生成，是 prompt 里没有示例可照抄，
                // 模型自己发挥出来的字段名可能跟别的事件对不上，生成前先提醒一句。
                opOut.className = 'eo-hint';
                opOut.textContent = '该类型暂无专用骨架，将按通用结构生成，字段可能不完整。';
            } else if (opOut.textContent.indexOf('还没选主类型') === 0) {
                // 选上了就把「还没选」那句清掉
                opOut.className = 'eo-hint';
                opOut.textContent = '';
            } else if (opOut.textContent.indexOf('暂无专用骨架') >= 0) {
                // 从无骨架类型切到有骨架类型，把上面那句提示清掉
                opOut.className = 'eo-hint';
                opOut.textContent = '';
            }
        };
        mainSel.addEventListener('change', refreshGoGate);
        refreshGoGate();
        btnGo.addEventListener('click', async () => {
            if (S.busy) return;
            // 主类型必选（2026-11-05 M1）：按钮虽然禁用了，这里再挡一道，
            // 免得别的路径（回车、脚本触发）绕过界面把没有类型的事件生成出去

            const chosenMain = String(mainSel.value || '').trim();
            if (!chosenMain || chosenMain === MAIN_UNSET) {
                opOut.className = 'eo-bad';
                opOut.textContent = '请先选择主类型：不同类型的事件有不同结构，不选无法生成。';
                return;
            }
            prefs.eventMainType = chosenMain;
            const name = String(nameInput.value || '').trim();
            // 事件名可以留空：留空就由模型根据当前剧情自己起名
            // 2026-11-10 修：这一行原来读 extraInput.value，可 extraInput 是
            // renderPrefsBlock 里的局部变量，这里在 renderGenPage，根本够不着。
            // 于是点「开始生成大纲」立刻抛 ReferenceError: extraInput is not defined，
            // 后面的按钮禁用、忙碌态、真正发起请求全都没执行——表现就是「点了没反应」，
            // 控制台却能连点出好几条同样的报错（按钮一直没被禁用）。
            // 那个输入框的 input 事件本来就把值实时写进了 prefs.extra，
            // 所以这里根本不用再读一次 DOM，直接用 prefs 里的现值。
            prefs.extra = String(prefs.extra || '无').trim() || '无';
            prefs.goal = String(goalInput.value || '').trim();
            prefs.promptHint = String(hintInput.value || '').trim();
            if (prefs.promptHint) log(`本次生成带框架提示（${prefs.promptHint.length} 字）`);
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在生成大纲，请稍候…';
            try {
                const event = await createEvent(name, prefs);
                // 2026-11-05 M2 复核：节点在 structure 里，按顶层读会显示「（0 个节点）」
                const nodeN = innerNodesOf(event.outline).length;
                log(`生成大纲成功：${event.name}，节点 ${nodeN} 个，已放入待选，未写世界书`);
                // 刻意不重置偏好：生成出待选之后，下面那套选项要停在刚才用的那份，
                // 方便在此基础上微调后再生成一个来比较。想回默认就点「重置为默认」
                opOut.className = 'eo-ok';
                opOut.textContent = `已生成「${event.name}」（${nodeN} 个节点），已放入上方待选。看看满意就点「采用」写入世界书，不满意可以直接再生成一个。`;
                // 刚生成的那份默认展开，方便马上看效果
                S.previewDraftIds.add(event.id);
                S.activeTab = 'gen';
                renderPanel();
            } catch (e) {
                error('生成大纲失败：', e);
                opOut.className = 'eo-bad';
                opOut.textContent = '生成失败：' + (e && e.message || e);
            } finally {
                btnGo.disabled = false;
                btnGo.textContent = '开始生成大纲';
            }
        });
        goRow.appendChild(btnGo);
        page.appendChild(goRow);
        page.appendChild(opOut);
        // 进度条挂在这里，紧跟按钮下方
        const ph = el('div');
        ph.id = 'eo_progress_host';
        page.appendChild(ph);
        if (S.progress.steps.length) renderProgress();
    }


    // ---------- 页：盘点 ----------

    /**
     * 盘点页的操作行：开始盘点按钮、打勾模式说明、结果提示。
     * 2026-11-02：主操作按钮曾经整段消失（页面上直接跳到「节点进度」），
     * 抽出来以后渲染开头和兜底处都调它，不会再有「按钮不见」这种状态。
     */
    function buildInvActions(page) {
        const box = el('div', 'eo-inv-actions');
        const opOut = el('div', 'eo-hint');
        const row = el('div', 'eo-row');
        const btnInv = el('button', 'eo-btn eo-primary', '开始盘点');
        if (S.busy) { btnInv.disabled = true; btnInv.textContent = '正在盘点…'; }
        btnInv.addEventListener('click', async () => {
            if (S.busy) return;
            btnInv.disabled = true;
            btnInv.textContent = '正在盘点…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在盘点…';
            try {
                const r = await runInventory('inv-manual');
                log(`第 ${r.record.round} 次盘点完成，世界书条目已更新（uid=${r.event.entryUid}）`);
                opOut.className = 'eo-ok';
                opOut.textContent = `第 ${r.record.round} 次盘点完成，世界书已更新`;
                repaintPage();
            } catch (e) {
                error('盘点失败：', e);
                opOut.className = 'eo-bad';
                opOut.textContent = '盘点失败：' + (e && e.message || e);
            } finally {
                btnInv.disabled = false;
                btnInv.textContent = '开始盘点';
            }
        });
        row.appendChild(btnInv);

        const mode = getSettings().tracker.mode;
        row.appendChild(el('span', 'eo-hint', `打勾模式：${TRACKER_MODES[mode] || mode}`));
        box.appendChild(row);
        box.appendChild(opOut);
        return box;
    }

    function renderInvPage(page) {
        const ev = getCurrentEvent();
        if (!ev) {
            page.appendChild(el('div', 'eo-hint', '当前没有进行中的事件。请先到「生成事件」页开一个。'));
            return;
        }

        // 操作行（开始盘点 + 打勾模式 + 输出提示）。
        // 先清掉可能残留的旧操作区再挂新的，保证页面上始终只有一个（2026-11-02）
        for (const old of page.querySelectorAll('.eo-inv-actions')) old.remove();
        page.appendChild(buildInvActions(page));
        const invPh = el('div');
        invPh.id = 'eo_progress_host';
        page.appendChild(invPh);
        if (S.progress.steps.length) renderProgress();

        // 进度条目（2026-11-06）
        // 原来这里是 innerNodesOf + if(nodes.length)：战斗没有节点、多段事件没有节点，
        // 这两个类型从采用那一刻起就勾不了，整块进度区不渲染。
        // 现在统一走 progressItemsOf：案件仍按节点（读写 triggeredNodes，旧数据不动），
        // 战斗按目标、多段按阶段（读写 tracker.progress）。
        const prog = progressItemsOf(ev.outline);
        const nodes = innerNodesOf(ev.outline);
        if (prog.items.length) {
            const isNode = prog.kind === 'node';
            const triggered = new Set(ev.tracker.triggeredNodes || []);
            const pending = new Set(ev.tracker.pendingNodes || []);
            const doneSet = getProgressSet(ev);
            const doneCount = isNode
                ? prog.items.filter(it => triggered.has(it.id)).length
                : prog.items.filter(it => doneSet.has(it.key)).length;
            const mode = getSettings().tracker.mode;

            // 半自动：待确认建议单独列一块，放在进度清单上面。
            // 待确认只对节点有效——战斗目标与阶段没有模型自动判断这条路。
            if (isNode && mode === 'semi' && pending.size) {
                page.appendChild(el('div', 'eo-sec', `待确认的建议（${pending.size} 条，模型认为已达成）`));
                page.appendChild(el('div', 'eo-hint',
                    '这些是模型在这一轮剧情里认为碰到的节点。点「确认」才算真正打勾，点「忽略」就不算；不处理的话，下次盘点会被新建议覆盖。'));
                const pb = el('div', 'eo-box');
                for (const id of Array.from(pending).sort((a, b) => a - b)) {
                    const node = nodes.find(n => nodeId(n) === id);
                    const row = el('div', 'eo-suggest');
                    const txt = el('span', null, `${id}. ${(node && (node.type || '')) || ''} ${(node && nodeText(node)) || '（大纲里找不到这个节点）'}`);
                    row.appendChild(txt);
                    // 模型说「已达成」时，依据往往就在最近一两楼。给个回看入口，
                    // 省得关面板、翻回去、再开面板（2026-11-02）
                    const bLook = el('button', 'eo-btn', '看剧情');
                    bLook.type = 'button';
                    attachHelp(bLook, '收起面板跳到对话最后一楼，看看最近发生了什么再决定。');
                    bLook.addEventListener('click', (e) => {
                        e.stopPropagation();
                        togglePanel(false);
                        const last = document.querySelector('.mes.last_mes')
                            || (document.querySelectorAll('.mes').length
                                ? document.querySelectorAll('.mes')[document.querySelectorAll('.mes').length - 1]
                                : null);
                        if (last && last.scrollIntoView) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    });
                    row.appendChild(bLook);
                    const bOk = el('button', 'eo-btn eo-primary', '确认');
                    bOk.addEventListener('click', (e) => {
                        e.stopPropagation();
                        confirmPending(id);
                        repaintPage();
                    });
                    const bNo = el('button', 'eo-btn', '忽略');
                    bNo.addEventListener('click', (e) => {
                        e.stopPropagation();
                        dismissPending(id);
                        repaintPage();
                    });
                    row.appendChild(bOk);
                    row.appendChild(bNo);
                    pb.appendChild(row);
                }
                page.appendChild(pb);
            }

            const nodeSec = el('div', 'eo-sec eo-sec-inline');
            nodeSec.appendChild(el('span', null,
                `${prog.title}（${doneCount}/${prog.items.length}，点击切换）`));
            const vetoedNow = (ev.tracker && ev.tracker.nodeVetoed) || [];
            if (isNode && vetoedNow.length) {
                const btnUndo = el('button', 'eo-btn', `恢复自动勾选（${vetoedNow.length}）`);
                btnUndo.type = 'button';
                attachHelp(btnUndo, '你手动撤销过的节点会被自动盘点跳过。点这里把它们全部放回去，'
                    + '下次自动盘点会重新判断这些节点是否已达成。已经打勾的节点不受影响。');
                btnUndo.addEventListener('click', () => {
                    const n = restoreVetoedNodes();
                    if (n) { toast(`已恢复 ${n} 个节点的自动判断`); repaintPage(); }
                });
                nodeSec.appendChild(btnUndo);
            }
            page.appendChild(nodeSec);
            const nb = el('div', 'eo-box');
            for (const it of prog.items) {
                const on = isNode ? triggered.has(it.id) : doneSet.has(it.key);
                const isPending = isNode && pending.has(it.id);
                const line = el('div', 'eo-node' + (on ? ' eo-node-on' : '') + (isPending ? ' eo-node-suggest' : ''));
                line.textContent = `${on ? '☑' : (isPending ? '◐' : '☐')} ${it.label}`
                    + (it.trigger ? `（${it.trigger}）` : '')
                    + (isPending ? '　← 模型建议，待确认' : '');
                makeActivatable(line, 'checkbox');
                line.setAttribute('aria-checked', on ? 'true' : 'false');
                line.addEventListener('click', () => {
                    if (isNode) toggleNode(it.id);
                    else toggleProgress(it.key);
                    // 只改这一页的勾选状态，没理由把整个面板重建一遍
                    repaintPage();
                });
                nb.appendChild(line);
                // 战斗目标与阶段带上达成/出入场条件：打勾时得知道「算不算完成」的依据
                if (it.detail) {
                    const d = el('div', 'eo-hint', it.detail);
                    d.style.marginLeft = '1.4em';
                    nb.appendChild(d);
                }
            }
            page.appendChild(nb);

            // 核心真相摊在页面上等于自己把案子剧透了（2026-11-02）。
            // 默认收着，想看的人自己点开；标题里把「剧透」写明白，别让人手滑点开
            // 2026-11-05 M2 复核：core_truth 属内层，按顶层读新事件永远没有这个折叠块
            const core = innerField(ev.outline, 'core_truth') || '';
            if (core) {
                const cd = el('details', 'eo-details');
                cd.appendChild(el('summary', null, '核心真相（剧透，点开前想清楚）'));
                cd.appendChild(el('div', 'eo-hint', `禁止在剧情里透露：${core}`));
                page.appendChild(cd);
            }
        } else {
            page.appendChild(el('div', 'eo-hint',
                '这份大纲里没有可以逐项打勾的进度条目（既没有信息节点，也没有战斗目标或阶段），'
                + '请到「日志」页查看模型原始输出。'));
        }

        // 盘点记录
        const invs = ev.inventories || [];
        page.appendChild(el('div', 'eo-sec', `盘点记录（${invs.length} 次）`));
        if (!invs.length) {
            page.appendChild(el('div', 'eo-hint', '还没有盘点过。'));
        } else {
            for (const rec of invs.slice().reverse()) {
                // 摘要放身上、原文折叠在里：100+ 行的模型原输出不展开就看不见，
                // 但「这次勾了几个、推翻了什么」一眼要知道（2026-11-02）
                const det = el('details', 'eo-details');
                det.appendChild(el('summary', null,
                    `第 ${rec.round} 次｜${String(rec.at || '').slice(0, 19)}`
                    + (rec.committedToBook ? '｜已入库' : '｜未入库')));
                det.appendChild(el('div', 'eo-hint', inventorySummary(rec)));
                const box = el('div', 'eo-box');
                box.textContent = rec.raw;
                det.appendChild(box);
                page.appendChild(det);
            }
        }
    }

    /**
     * 一次盘点的一句话摘要（2026-11-02）：原文 100+ 行折叠在里，
     * 折叠状态下也要能看出这次盘出了什么。
     */
    function inventorySummary(rec) {
        const p = rec && rec.parsed;
        if (!p) return '这次没解析出结构化结果，只有文字报告，展开看原文。';
        const parts = [];
        const hit = Array.isArray(p.triggeredNodes) ? p.triggeredNodes.length : 0;
        if (hit) parts.push(`勾选 ${hit} 个节点`);
        const sug = Array.isArray(rec.suggestedNodes) ? rec.suggestedNodes.length : 0;
        if (sug) parts.push(`建议待确认 ${sug} 个`);
        const ref = Array.isArray(p.refutedMisleads) ? p.refutedMisleads.length : 0;
        if (ref) parts.push(`推翻误导 ${ref} 条`);
        const off = Array.isArray(p.offPathBranches) ? p.offPathBranches.length : 0;
        if (off) parts.push(`大纲外路径 ${off} 条`);
        const veto = Array.isArray(p.nodeVetoed) ? p.nodeVetoed.length : 0;
        if (veto) parts.push(`判定不可能 ${veto} 个`);
        return parts.length ? parts.join('｜') : '这次没有新的判定。';
    }
    // ---------- 页：日志 ----------

    // 日志页的级别筛选：记在模块级，切页签不丢；'all' = 全部
    let logFilter = S.logFilter; // 引用指向 S，值统一存 S
    // 关键词过滤（2026-11-02 4.5）：远程排障时经常要捞某个节点号或某段报错
    let logKeyword = S.logKeyword; // 引用指向 S，值统一存 S

    function renderRuntimeLogSection(page) {
        const head = el('div', 'eo-sec eo-sec-inline');
        head.appendChild(el('span', null, '扩展运行日志'));
        head.appendChild(el('span', 'eo-hint', `（${S.runtimeLog.length} 条，最多保留 ${RUNTIME_LOG_MAX}）`));
        page.appendChild(head);
        page.appendChild(el('div', 'eo-hint',
            '这里记录扩展自己做过的事：挂载、读写世界书、记忆适配器判定、生成与解析、打勾变更、报错。只存在内存里，刷新页面就清空，不会写进聊天记录。'));

        // 级别筛选
        const cnt = { debug: 0, info: 0, warn: 0, error: 0 };
        for (const l of S.runtimeLog) if (cnt[l.level] != null) cnt[l.level]++;
        const fRow = el('div', 'eo-row eo-logfilter');
        const mkBtn = (key, label) => {
            const b = el('button', 'eo-btn eo-filterbtn' + (S.logFilter === key ? ' eo-filterbtn-on' : ''), label);
            b.type = 'button';
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                S.logFilter = key;
                repaintPage();
            });
            fRow.appendChild(b);
        };
        mkBtn('all', `全部 ${S.runtimeLog.length}`);
        for (const lv of LOG_LEVELS) mkBtn(lv, `${LOG_LEVEL_LABEL[lv]} ${cnt[lv]}`);
        page.appendChild(fRow);

        // 关键词过滤：回车或失焦才生效，不然每敲一个字就整页重绘
        const kwRow = el('div', 'eo-row');
        kwRow.appendChild(el('label', null, '筛选'));
        const kwIn = el('input', 'eo-input');
        kwIn.type = 'search';
        kwIn.placeholder = '输入关键词，回车生效（例如节点编号、报错片段）';
        kwIn.value = S.logKeyword || '';
        kwIn.style.flex = '1';
        const applyKw = () => {
            const v = String(kwIn.value || '').trim();
            if (v === S.logKeyword) return;
            S.logKeyword = v;
            repaintPage();
        };
        kwIn.addEventListener('change', applyKw);
        kwIn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); applyKw(); }
            if (e.key === 'Escape' && S.logKeyword) {
                e.preventDefault();
                S.logKeyword = '';
                kwIn.value = '';
                repaintPage();
            }
        });
        kwRow.appendChild(kwIn);
        page.appendChild(kwRow);

        if (!debugEnabled()) {
            const tip = el('div', 'eo-hint');
            tip.textContent = '调试级日志默认不收集。需要看细节时到「设置」页打开「调试模式」，再回来就能看到。';
            page.appendChild(tip);
        }

        // 只收调试级却一条都没有，说明这不只是筛选问题
        const kw = S.logKeyword ? S.logKeyword.toLowerCase() : '';
        const shown = S.runtimeLog
            .filter(l => S.logFilter === 'all' || l.level === S.logFilter)
            .filter(l => {
                if (!kw) return true;
                return String(l.text || '').toLowerCase().includes(kw)
                    || String(l.level || '').toLowerCase().includes(kw);
            });
        if (!shown.length) {
            page.appendChild(el('div', 'eo-hint',
                !S.runtimeLog.length
                    ? '还没有记录。'
                    : (kw
                        ? `没有匹配「${S.logKeyword}」的记录，按 Esc 清掉筛选。`
                        : '这个级别下暂时没有记录，点上面的「全部」看其它级别。')));
            // 早先这里直接 return，一条日志都没有时导出、复制、清空的入口跟着一起消失（2026-11-02 发现）。
            // 按钮行改成无论有没有记录都挂上，没有内容时按钮自己禁用。
        }
        const box = el('div', 'eo-box eo-logbox');
        box.textContent = shown.map(l =>
            `${l.at} ${LOG_LEVEL_LABEL[l.level] || l.level}｜${l.text}`
        ).join(String.fromCharCode(10));
        page.appendChild(box);
        // 日志按时间正序排，最新一条在最下面：渲染完直接滚到底，一进来就看到最新的
        const toBottom = () => { box.scrollTop = box.scrollHeight; };
        toBottom();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(toBottom);
        setTimeout(toBottom, 60);
        // 日志页按钮区（2026-11-02 整理）：先建行，再逐个建按钮，最后统一挂到页面上
        const r = el('div', 'eo-row');

        const btn = el('button', 'eo-btn', '清空运行日志');
        btn.type = 'button';
        btn.disabled = !S.runtimeLog.length;
        btn.addEventListener('click', () => {
            S.runtimeLog.length = 0;
            S.unreadErrors = 0;
            repaintPage();
        });
        r.appendChild(btn);

        // 导出跟着当前筛选走：排障时往往只想给一段，不想把五百条全发出去
        const scopeNote = (S.logFilter === 'all' && !kw) ? '' : '（当前筛选结果）';
        const lineOf = (l) => `[${l.at || ''}] ${String(l.level || 'info').toUpperCase()} ${l.text}`;

        const noRows = !shown.length;

        const btnExportTxt = el('button', 'eo-btn', '导出文本');
        btnExportTxt.type = 'button';
        btnExportTxt.disabled = noRows;
        btnExportTxt.addEventListener('click', () => {
            const name = `事件大纲-运行日志-${fileStamp()}.txt`;
            if (downloadText(name, shown.map(lineOf).join('\n') || '（没有日志）')) toast('已导出 ' + name + scopeNote);
        });
        r.appendChild(btnExportTxt);

        const btnExportJson = el('button', 'eo-btn', '导出 JSON');
        btnExportJson.type = 'button';
        btnExportJson.disabled = noRows;
        btnExportJson.addEventListener('click', () => {
            const name = `事件大纲-运行日志-${fileStamp()}.json`;
            const data = {
                version: VERSION,
                exportedAt: new Date().toISOString(),
                filter: { level: S.logFilter, keyword: S.logKeyword || '' },
                logs: shown,
            };
            if (downloadText(name, JSON.stringify(data, null, 2), 'application/json')) toast('已导出 ' + name + scopeNote);
        });
        r.appendChild(btnExportJson);

        const btnCopyAll = el('button', 'eo-btn', '复制全部');
        btnCopyAll.type = 'button';
        btnCopyAll.disabled = noRows;
        // 这个按钮不再挂问号（2026-11-02 危晓要求）：按钮名已经说清做什么，
        // 剪贴板被拦时的提示在点击后的轻提示里给
        btnCopyAll.addEventListener('click', async () => {
            const ok = await copyText(shown.map(lineOf).join('\n'));
            toast(ok ? `已复制 ${shown.length} 条${scopeNote}` : '浏览器不让我写剪贴板，请手动选中日志复制');
        });
        r.appendChild(btnCopyAll);

        page.appendChild(r);
    }

    function renderLogPage(page) {
        // 运行日志放最上面：它是「扩展是否在正常工作」的全貌，
        // 与下面的事件状态是两件事，没在进行中的事件也要能看到。
        renderRuntimeLogSection(page);

        const ev = getCurrentEvent();
        if (!ev) {
            page.appendChild(el('div', 'eo-sec', '当前事件状态'));
            page.appendChild(el('div', 'eo-hint', '当前没有进行中的事件，没有可观察的事件状态。'));
            const hist = listEvents();
            if (hist.length) {
                page.appendChild(el('div', 'eo-sec', '历史事件'));
                const b = el('div', 'eo-box');
                b.textContent = hist.map(e =>
                    `${e.status === 'active' ? '●' : '○'} ${e.name}｜${e.status}｜${String(e.createdAt || '').slice(0, 19)}`
                ).join('\n');
                page.appendChild(b);
            }
            return;
        }

        const t = ev.tracker || {};
        const lines = [];
        lines.push(`事件：${ev.name}（${ev.status}）`);
        lines.push(`创建：${String(ev.createdAt || '').slice(0, 19)}`);
        lines.push(`已触发节点：${(t.triggeredNodes || []).join('、') || '无'}`);
        // 战斗目标与阶段的完成情况（2026-11-06）：这两类没有节点，不写出来就显示成「无」，看着像没进度
        if (Array.isArray(t.progress) && t.progress.length) {
            lines.push(`已完成进度条目：${t.progress.join('、')}`);
        }
        lines.push(`已推翻误导：${(t.refutedMisleads || []).join('、') || '无'}`);
        lines.push(`人工否决：${(t.nodeVetoed || []).join('、') || '无'}`);
        const pend = t.pendingNodes || [];
        if (pend.length) lines.push(`待确认建议：${pend.join('、')}（半自动模式，等你点确认）`);
        const offPath = t.offPathBranches || [];
        lines.push(`大纲外路径：${offPath.length ? offPath.map(o => `【大纲外】${o.desc}`).join('；') : '无'}`);
        if (offPath.some(o => o.reason)) {
            lines.push('　理由：' + offPath.filter(o => o.reason).map(o => o.reason).join('；'));
        }
        page.appendChild(el('div', 'eo-sec', '当前事件状态'));
        const sb = el('div', 'eo-box');
        sb.textContent = lines.join('\n');
        page.appendChild(sb);

        // 自动打勾记录
        const auto = t.autoCommitted || [];
        page.appendChild(el('div', 'eo-sec', `自动打勾记录（${auto.length} 条）`));
        if (!auto.length) {
            page.appendChild(el('div', 'eo-hint', '暂无自动打勾。切换到自动模式后，模型判定的触发节点会记录在这里。'));
        } else {
            const ab = el('div', 'eo-box');
            ab.textContent = auto.map(a =>
                `第 ${a.round} 次盘点｜节点 ${a.node}｜${String(a.at || '').slice(0, 19)}`
            ).join('\n');
            page.appendChild(ab);
        }

        // 世界书条目内容（2026-11-02）：这段里有核心真相，默认摊开会剧透，
        // 和盘点页的处理保持一致——折叠起来，摘要行先把后果说清楚
        page.appendChild(el('div', 'eo-sec eo-sec-inline', '世界书条目'));
        const entryDet = el('details', 'eo-details');
        entryDet.appendChild(el('summary', null,
            '事件条目全文（剧透，点开前想清楚）'));
        const eb = el('div', 'eo-box');
        eb.textContent = buildEntryContent(ev, (ev.inventories || []).length);
        entryDet.appendChild(eb);
        page.appendChild(entryDet);

        const btn = el('button', 'eo-btn', '刷新');
        btn.addEventListener('click', () => repaintPage());
        const r = el('div', 'eo-row');
        r.appendChild(btn);
        page.appendChild(r);

        // 历史事件
        const hist = listEvents().filter(e => e.id !== ev.id);
        if (hist.length) {
            page.appendChild(el('div', 'eo-sec', '历史事件'));
            const b = el('div', 'eo-box');
            b.textContent = hist.map(e =>
                `${e.status === 'active' ? '●' : '○'} ${e.name}｜${e.status}｜${String(e.createdAt || '').slice(0, 19)}`
            ).join('\n');
            page.appendChild(b);
        }
    }

    // ---------- 页：设置 ----------

    // 设置页里处于展开状态的配置档 id。面板重建会重造 DOM，
    // 放在这里才能跨重渲染保留，不然改个选项就自己折回去
    const openProfiles = new Set();

    function renderSetPage(page) {
        // 2026-11-13：原来这里有一个局部闭包做设置页局部重绘。它只在 renderSetModel 里被引用过，
        // 而那是另一个函数、取不到它，等于摆着一个随时会被复制回去的陷阱，已删除。
        // 设置页要重画就调 repaintPage()——它在页签为设置时分派到本函数，效果等价，且带滚动补偿。
        // 各段单独兜底（2026-11-02）：某一段抛出异常时，以前整页从那里断掉，
        // 下面全是空白，用户完全不知道发生了什么。现在把错误画进页面并写日志，其余段照画
        // 注意：分段以后各段是独立函数，看不到本函数的局部变量，所以 s 要显式传进去
        const setS = getSettings();
        // 顺序按「先配好怎么跑，再调细节，排障开关垫底」排（2026-11-04 危晓定）：
        // 模型与世界书是跑起来的前提，紧接着是素材来源与打勾规则，历史保留与界面属于细枝末节，
        // 调试模式只是排障用，占第一位只会让人以为必须先设置它。
        const sections = [
            ['模型', renderSetModel],
            ['世界书', renderSetBook],
            ['记忆来源', renderSetMemory],
            ['打勾与自动盘点', renderSetTrack],
            ['自动盘点', renderSetAuto],
            // 2026-11-04 顺序对齐生成页：事件类型 → 难度等级 → 事件参数
            ['事件类型', renderSetTypes],
            ['难度等级', renderSetLevels],
            ['参数自定义项', renderSetPrefOptions],
            // M16：事件链的两项设置
            ['事件链', renderSetChain],
            ['历史保留', renderSetRetention],
            ['界面', renderSetUi],
            ['调试模式', renderSetDebug],
        ];
        for (const [name, fn] of sections) {
            try {
                fn(page, setS);
            } catch (e) {
                error('设置页「' + name + '」渲染失败：', e);
                const bad = el('div', 'eo-bad-box');
                bad.textContent = '「' + name + '」这一段没能显示出来：' + ((e && e.message) || e)
                    + '。其余设置项不受影响，日志页有完整报错。';
                page.appendChild(bad);
            }
        }
    }

    /**
     * 取模型清单（2026-11-02）：走 OpenAI 兼容的 GET /models。
     * 只有「扩展自己连」这一档能拉——跟随酒馆时没有地址和密钥可问。
     */
    async function fetchModelList(profile) {
        const base = String(profile.baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('先填接口地址');
        if (!profile.apiKey) throw new Error('先填密钥');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (controller) { try { controller.abort(); } catch (e) { /* 忽略 */ } } }, 20000);
        let resp;
        try {
            resp = await fetch(base + '/models', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + profile.apiKey },
                signal: controller ? controller.signal : undefined,
            });
        } catch (e) {
            throw new Error('连不上：' + (e && e.message || e));
        } finally {
            clearTimeout(timer);
        }
        const text = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('返回的不是 JSON'); }
        const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
        return arr
            .map(x => (x && (x.id || x.name)) || '')
            .filter(Boolean)
            .sort();
    }

    /**
     * 设置页：调试模式（2026-11-02 危晓要求）
     * 原来叫「调试日志」、挂在「界面」段下面，跟悬浮窗开关混在一起不搭。
     * 现在改叫「调试模式」，排障用的总开关，放在设置页最末（2026-11-04 危晓定：
     * 它只在排障时用，占第一位会让人以为必须先设置它）。
     * 打开后除了收 debug 级日志，生成页的「模型原始输出」也跟着出现。
     */
    function renderSetDebug(page, s) {
        page.appendChild(el('div', 'eo-sec', '调试'));
        const dbgRow = el('div', 'eo-row');
        dbgRow.appendChild(el('label', null, '调试模式'));
        const dbgChk = el('input');
        markKey(dbgChk, 'set.debugLog');
        dbgChk.type = 'checkbox';
        dbgChk.checked = !!s.debug;
        dbgChk.addEventListener('change', () => {
            getSettings().debug = dbgChk.checked;
            saveSettings();
            debug(`调试模式已${dbgChk.checked ? '开启' : '关闭'}`);
            repaintPage();
        });
        dbgRow.appendChild(dbgChk);
        dbgRow.appendChild(el('span', 'eo-hint', '开启后记录每一步的细节，并显示模型的原始输出；排障时用，平时建议关掉，免得刷屏'));
        page.appendChild(dbgRow);
    }

    /** 模型清单弹在一处，点一个就选上 */
    function showModelPicker(page, profileId, list, onPick) {
        const old = page.querySelector('#eo_model_picker');
        if (old) old.remove();
        const box = el('div', 'eo-box');
        box.id = 'eo_model_picker';
        box.appendChild(el('div', 'eo-hint', `共 ${list.length} 个模型，点一个填进模型名`));
        const sel = el('select', 'eo-sel');
        sel.style.width = '100%';
        for (const m of list) {
            const o = el('option', null, m);
            o.value = m;
            sel.appendChild(o);
        }
        box.appendChild(sel);
        const row = el('div', 'eo-row');
        const bOk = el('button', 'eo-btn eo-primary', '用这个');
        bOk.type = 'button';
        bOk.addEventListener('click', () => { onPick(sel.value); box.remove(); });
        const bNo = el('button', 'eo-btn', '收起');
        bNo.type = 'button';
        bNo.addEventListener('click', () => box.remove());
        row.appendChild(bOk);
        row.appendChild(bNo);
        box.appendChild(row);
        page.appendChild(box);
    }

    /** 设置页：当前用哪套模型配置（模型段） */
    function renderSetModel(page, s) {
        page.appendChild(el('div', 'eo-sec', '模型'));

        // 使用哪套配置。`main`（跟随酒馆主连接）有两条路可走，所以至少要有它的选项——
        // 2026-11-02 起配置档列表里不再显示它（危晓要求），这里补回来，否则没有独占配置时选不中任何一项
        const apiRow = el('div', 'eo-row');
        apiRow.appendChild(el('label', null, '当前使用'));
        const apiSel = el('select', 'eo-sel');
        apiSel.style.flex = '1';
        for (const p of s.apiProfiles) {
            const o = el('option', null, p.name + (p.mode === 'main' ? '' : p.mode === 'direct' ? '（直连）' : '（酒馆连接源）'));
            o.value = p.id;
            apiSel.appendChild(o);
        }
        if (!s.apiProfiles.some(p => p.id === s.activeProfileId)) {
            const o = el('option', null, '跟随酒馆主连接');
            o.value = 'main';
            apiSel.appendChild(o);
        }
        apiSel.value = s.activeProfileId;
        markKey(apiSel, 'set.profile');
        apiSel.addEventListener('change', () => {
            getSettings().activeProfileId = apiSel.value;
            saveSettings();
            const p = (getSettings().apiProfiles || []).find(x => x.id === apiSel.value);
            log(`模型 API 已切换为「${p ? p.name : apiSel.value}」`);
            // 2026-11-13 修：这里原来调的是 renderSetPage 的局部闭包，那个名字在 renderSetModel 里
            // 根本取不到，运行时抛 ReferenceError（设置已保存、页面不重绘）。改走模块作用域的整页重绘入口。
            repaintPage();
        });
        apiRow.appendChild(apiSel);
        page.appendChild(apiRow);

        const cur = (s.apiProfiles || []).find(p => p.id === s.activeProfileId) || { mode: 'main' };
        page.appendChild(el('div', 'eo-hint',
            cur.mode === 'main'
                ? '跟随酒馆：用酒馆当前选的模型和连接，最省心，一般就用这个。'
                : cur.mode === 'direct'
                    ? '扩展自己连：填服务地址、模型名和密钥，与酒馆用的模型完全分开。'
                    : '用酒馆里的连接：从酒馆已配好的连接里挑一个，可以另外指定模型名。'));

        // 配置档列表：每行一套，可以编辑/删除
        const listHead = el('div', 'eo-sec eo-sec-inline');
        listHead.appendChild(el('span', null, '配置档'));
        page.appendChild(listHead);

        // 这一排只列能编辑的配置档。`main`（跟随酒馆主连接）没有可填的内容，
        // 2026-11-02 危晓要求不再显示，它只在上面「当前使用」里出现
        for (const p of s.apiProfiles) {
            if (p.mode === 'main') continue;
            const box = el('details', 'eo-prefgroup');
            // 重建面板时恢复展开状态：切换方式会触发 renderPanel，
            // 不记住的话刚展开的配置会自己折回去，用户还得再点一次
            box.open = openProfiles.has(p.id);
            box.addEventListener('toggle', () => {
                if (box.open) openProfiles.add(p.id); else openProfiles.delete(p.id);
            });
            const sum = el('summary', 'eo-prefgroup-sum');
            sum.textContent = `${p.name}${p.mode === 'direct' ? '（自己连）' : '（用酒馆连接）'}`;
            box.appendChild(sum);
            const body = el('div', 'eo-prefgroup-body');

            // main 档在这一排里已经跳过了，走不到这里的 main 分支，但保留兜底：
            // 万一以后有人给 main 加上可编辑字段，这里不会因为缺分支画成空白
            if (p.mode === 'main') {
                body.appendChild(el('div', 'eo-hint', '这套配置不需要填写任何东西，永远跟随酒馆当前连接。'));
            } else {
                const nameRow2 = el('div', 'eo-row');
                nameRow2.appendChild(el('label', null, '名称'));
                const nameIn = el('input', 'eo-input');
                markKey(nameIn, 'profile.' + p.id + '.name');
                nameIn.type = 'text';
                nameIn.value = p.name || '';
                nameIn.style.flex = '1';
                // 改完离开输入框就存，不用专门去点按钮（2026-11-02）
                nameIn.addEventListener('change', () => {
                    const nm = String(nameIn.value || '').trim();
                    if (!nm) { nameIn.value = p.name; return; }
                    if (nm === p.name) return;
                    updateProfile(p.id, t => { t.name = nm; });
                    log(`模型配置「${p.name}」已更名为「${nm}」`);
                });
                nameRow2.appendChild(nameIn);
                body.appendChild(nameRow2);

                const uRow = el('div', 'eo-row');
                    uRow.appendChild(el('label', null, '接口地址'));
                    const uIn = el('input', 'eo-input');
                    markKey(uIn, 'profile.' + p.id + '.baseUrl');
                    uIn.type = 'text';
                    uIn.placeholder = 'https://api.example.com/v1';
                    uIn.value = p.baseUrl || '';
                    uIn.style.flex = '1';
                    uIn.addEventListener('change', () => {
                        updateProfile(p.id, t => { t.baseUrl = uIn.value.trim(); });
                    });
                    uRow.appendChild(uIn);
                    body.appendChild(uRow);

                    // 密钥不把原值回填进输入框（2026-11-02）：密码框点一下「显示密码」就露底了。
                    // 有密钥就显示掩码和「已保存」，要改点「重新输入」，要删点「清除」。
                    const kRow = el('div', 'eo-row');
                    kRow.appendChild(el('label', null, '密钥'));
                    const keyState = { editing: !p.apiKey };
                    const kBox = el('div', 'eo-keybox');
                    kBox.style.flex = '1';
                    kRow.appendChild(kBox);
                    const paintKey = () => {
                        kBox.innerHTML = '';
                        if (keyState.editing) {
                            const kIn = el('input', 'eo-input');
                            kIn.type = 'password';
                            kIn.placeholder = 'sk-…';
                            kIn.style.flex = '1';
                            kIn.autocomplete = 'off';
                            // 这里刻意不回填原值：用户不输入就是没改，留空等于不改
                            kIn.addEventListener('change', () => {
                                const v = kIn.value.trim();
                                if (!v) return;
                                updateProfile(p.id, t => { t.apiKey = v; });
                                keyState.editing = false;
                                kIn.value = '';
                                log(`配置「${p.name}」的密钥已更新`);
                                repaintPage();
                            });
                            kBox.appendChild(kIn);
                            const bCancel = el('button', 'eo-btn', '不改了');
                            bCancel.type = 'button';
                            bCancel.addEventListener('click', (e) => {
                                e.preventDefault();
                                keyState.editing = false;
                                reloadProfileKey(p.id);
                                repaintPage();
                            });
                            kBox.appendChild(bCancel);
                        } else {
                            kBox.appendChild(el('span', 'eo-keymask', maskKey(p.apiKey)));
                            const bEdit = el('button', 'eo-btn', '重新输入');
                            bEdit.type = 'button';
                            bEdit.addEventListener('click', (e) => {
                                e.preventDefault();
                                keyState.editing = true;
                                repaintPage();
                            });
                            kBox.appendChild(bEdit);
                            const bClear = el('button', 'eo-btn', '清除');
                            bClear.type = 'button';
                            attachHelp(bClear, '清掉这套配置里存着的密钥。直连模式没有密钥就连不上，清除前想清楚。');
                            bClear.addEventListener('click', async (e) => {
                                e.preventDefault();
                                if (!(await askConfirm('清除这套配置的密钥？清除后直连模式无法请求，需要重新填写。'))) return;
                                updateProfile(p.id, t => { t.apiKey = ''; });
                                log(`配置「${p.name}」的密钥已清除`);
                                repaintPage();
                            });
                            kBox.appendChild(bClear);
                        }
                    };
                    paintKey();
                    body.appendChild(kRow);

                    const mRow2 = el('div', 'eo-row');
                    mRow2.appendChild(el('label', null, '模型名'));
                    const mIn2 = el('input', 'eo-input');
                    markKey(mIn2, 'profile.' + p.id + '.model');
                    mIn2.type = 'text';
                    mIn2.placeholder = '如 deepseek-chat';
                    mIn2.value = p.model || '';
                    mIn2.style.flex = '1';
                    mIn2.addEventListener('change', () => {
                        updateProfile(p.id, t => { t.model = mIn2.value.trim(); });
                    });
                    mRow2.appendChild(mIn2);
                    // 获取模型列表（2026-11-02）：地址和密钥填好后直接问服务端要清单，
                    // 省得手打模型名拼错。拉不到不拦人，手填照样能用
                    const btnModels = el('button', 'eo-btn', '获取模型列表');
                    btnModels.type = 'button';
                    attachHelp(btnModels, '按这套配置里的地址和密钥，向服务端要一份可用模型清单。'
                        + '服务端不提供清单（返回 404 之类）时只能手填，不影响使用。');
                    btnModels.addEventListener('click', async () => {
                        btnModels.disabled = true;
                        const old = btnModels.textContent;
                        btnModels.textContent = '获取中…';
                        try {
                            const list = await fetchModelList(p);
                            if (!list.length) throw new Error('服务端没返回任何模型');
                            showModelPicker(page, p.id, list, (picked) => {
                                updateProfile(p.id, t => { t.model = picked; });
                                mIn2.value = picked;
                                log(`配置「${p.name}」的模型已选为 ${picked}`);
                            });
                        } catch (e) {
                            error('获取模型列表失败：', e);
                            toast('获取模型列表失败：' + (e && e.message || e), { bad: true });
                        } finally {
                            btnModels.disabled = false;
                            btnModels.textContent = old;
                        }
                    });
                    mRow2.appendChild(btnModels);
                    body.appendChild(mRow2);

                    const tRow = el('div', 'eo-row');
                    tRow.appendChild(el('label', null, '温度'));
                    const tIn = el('input', 'eo-input');
                    markKey(tIn, 'profile.' + p.id + '.temperature');
                    tIn.type = 'number';
                    tIn.min = '0';
                    tIn.max = '2';
                    tIn.step = '0.1';
                    tIn.value = String(Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : 0.7);
                    tIn.style.width = '76px';
                    tIn.addEventListener('change', () => {
                        updateProfile(p.id, t => { t.temperature = Number(tIn.value); });
                    });
                    tRow.appendChild(tIn);
                    tRow.appendChild(el('span', 'eo-hint', '0-2，越高越发散；结构化输出建议 0.7 以下'));
                    body.appendChild(tRow);

                    const xRow = el('div', 'eo-row');
                    xRow.appendChild(el('label', null, '输出上限'));
                    const xIn = el('input', 'eo-input');
                    markKey(xIn, 'profile.' + p.id + '.maxTokens');
                    xIn.type = 'number';
                    xIn.min = '0';
                    xIn.step = '100';
                    xIn.placeholder = '0=不限制';
                    xIn.value = String(Number(p.maxTokens) || 0);
                    xIn.style.width = '90px';
                    xIn.addEventListener('change', () => {
                        updateProfile(p.id, t => { t.maxTokens = Number(xIn.value) || 0; });
                    });
                    xRow.appendChild(xIn);
                    body.appendChild(xRow);

                    // 请求体三段（2026-11-02）：意思与酒馆里同名设置一致，
                    // 都是 YAML 文本。留空就等于不加、不删，跟酒馆默认一致
                    const bodySec = el('div', 'eo-sec eo-sec-inline');
                    bodySec.appendChild(el('span', null, '请求体'));
                    bodySec.appendChild(el('span', 'eo-hint',
                        '按需填写，留空等同不设置。这组只对「自己连」生效；每次请求临时生效，不改服务端任何东西。'));
                    body.appendChild(bodySec);

                    const yamlField = (label, key, hint) => {
                        const r = el('div', 'eo-yaml-field');
                        const head = el('div', 'eo-hint');
                        head.textContent = label;
                        r.appendChild(head);
                        const ta = el('textarea', 'eo-input');
                        ta.rows = 3;
                        ta.style.width = '100%';
                        ta.placeholder = hint;
                        ta.value = p[key] || '';
                        markKey(ta, 'profile.' + p.id + '.' + key);
                        // 解析失败只提示，不拦保存：填错不该让整次请求发不出去
                        const chk = el('div', 'eo-hint');
                        const bad = String(p[key] || '').trim() && /^\s*\S+\s*$/.test(String(p[key] || ''));
                        if (bad) chk.textContent = '看不出来是「键: 值」的形状，这项会被忽略';
                        ta.addEventListener('change', () => {
                            updateProfile(p.id, t => { t[key] = ta.value; });
                            const v = String(ta.value || '').trim();
                            chk.textContent = v && !/:/.test(v) ? '看不出来是「键: 值」的形状，这项会被忽略' : '';
                        });
                        r.appendChild(ta);
                        r.appendChild(chk);
                        body.appendChild(r);
                    };

                    yamlField('包含主体参数', 'includeBody',
                        '键: 值\n例如\ntemperature: 0.3\nresponse_format: {"type":"json_object"}');
                    yamlField('排除主体参数', 'excludeBody',
                        '键名，一行一个\n例如\ntop_p\nfrequency_penalty');
                    yamlField('包含请求标头', 'includeHeaders',
                        '键: 值\n例如\nX-Title: 事件大纲');

                // 保存名称按钮 + 测试 + 删除
                const actRow = el('div', 'eo-row');
                const btnSave = el('button', 'eo-btn', '保存配置');
                btnSave.type = 'button';
                btnSave.addEventListener('click', async () => {
                    const nm = String(nameIn.value || '').trim();
                    if (!nm) { nameIn.value = p.name; return; }
                    updateProfile(p.id, t => { t.name = nm; });
                    log(`模型配置「${p.name}」已更名为「${nm}」`);
                    repaintPage();
                });
                actRow.appendChild(btnSave);

                const btnTest = el('button', 'eo-btn', '测试连接');
                btnTest.type = 'button';
                const testOut = el('span', 'eo-hint', '');
                btnTest.addEventListener('click', async () => {
                    btnTest.disabled = true;
                    testOut.className = 'eo-hint';
                    testOut.textContent = '测试中…';
                    try {
                        // 直接把这套配置传进去测，不碰全局当前配置：
                        // 以前是临时改 activeProfileId 再改回来，测试期间点生成就会用错配置
                        const r = await testProfile(p);
                        testOut.className = 'eo-ok';
                        testOut.textContent = `通！${r.ms} 毫秒，返回「${r.sample}」`;
                        updateProfile(p.id, t => { t.lastTest = { ok: true, ms: r.ms, at: Date.now() }; });
                        log(`配置「${p.name}」测试连接通过：${r.ms} 毫秒`);
                    } catch (e) {
                        updateProfile(p.id, t => { t.lastTest = { ok: false, at: Date.now() }; });
                        testOut.className = 'eo-bad';
                        testOut.textContent = '不通：' + (e && e.message || e);
                    } finally {
                        btnTest.disabled = false;
                    }
                });
                // 展开配置块时顺手显示上一次的结果：以前结果只活到下次重绘
                if (p.lastTest) {
                    testOut.className = p.lastTest.ok ? 'eo-ok' : 'eo-bad';
                    testOut.textContent = p.lastTest.ok
                        ? `上次测试：通，${p.lastTest.ms} 毫秒`
                        : '上次测试：不通';
                }
                actRow.appendChild(btnTest);
                actRow.appendChild(testOut);
                body.appendChild(actRow);

                if (p.id !== 'main') {
                    const delRow = el('div', 'eo-row');
                    const btnDel = el('button', 'eo-btn', '删除配置');
                    btnDel.type = 'button';
                    btnDel.addEventListener('click', () => {
                        const st = getSettings();
                        st.apiProfiles = (st.apiProfiles || []).filter(x => x.id !== p.id);
                        if (st.activeProfileId === p.id) st.activeProfileId = 'main';
                        openProfiles.delete(p.id);
                        saveSettings();
                        log(`已删除模型配置「${p.name}」`);
                        repaintPage();
                    });
                    delRow.appendChild(btnDel);
                    body.appendChild(delRow);
                }
            }


            box.appendChild(body);
            page.appendChild(box);
        }

        // 新建
        const addRow = el('div', 'eo-row');
        const btnAdd = el('button', 'eo-btn eo-primary', '新建配置');
        btnAdd.type = 'button';
        btnAdd.addEventListener('click', () => {
            const st = getSettings();
            const n = (st.apiProfiles || []).length;
            const id = 'custom-' + Date.now();
            st.apiProfiles.push({
                id,
                name: `自定义配置 ${n}`,
                mode: 'direct',
                baseUrl: '',
                apiKey: '',
                model: '',
                temperature: 0.7,
                maxTokens: 0,
            });
            saveSettings();
            // 新建即展开，用户点完就能直接填，不用再点一下
            openProfiles.add(id);
            log(`新建了模型配置「自定义配置 ${n}」，请填写地址、密钥和模型名`);
            repaintPage();
        });
        addRow.appendChild(btnAdd);
        page.appendChild(addRow);

        // --- 记忆来源 ---
    }

    /** 设置页：记忆来源与楼层数 */
    function renderSetMemory(page, s) {
        page.appendChild(el('div', 'eo-sec', '记忆来源'));
        const memRow = el('div', 'eo-row');
        memRow.appendChild(el('label', null, '来源'));
        const memSel = el('select', 'eo-sel');
        markKey(memSel, 'set.memorySource');
        for (const [k, label] of Object.entries(MEMORY_SOURCES)) {
            const o = el('option', null, label);
            o.value = k;
            memSel.appendChild(o);
        }
        memSel.value = s.memory.source;
        memSel.addEventListener('change', () => {
            getSettings().memory.source = memSel.value;
            saveSettings();
            log(`记忆来源已切换为「${MEMORY_SOURCES[memSel.value] || memSel.value}」`);
            repaintPage();
        });
        memRow.appendChild(memSel);
        page.appendChild(memRow);

        const resolved = resolveAdapter();
        const memInfo = el('div', resolved.degraded ? 'eo-warn' : 'eo-hint');
        memInfo.textContent = resolved.degraded
            ? `已选「${MEMORY_SOURCES[resolved.wanted] || resolved.wanted}」，但当前对话没有可用数据，已自动降级为：${resolved.adapter.describe()}`
            : `当前使用：${resolved.adapter.describe()}`;
        page.appendChild(memInfo);

        // --- shujuku 接入诊断：2026-11-02 从世界书段末尾挪到「最近楼层」上面。
        // 判定看「实际解析到的适配器」，不是看设置值：
        // 手动选 shujuku → 显示；自动模式下探测到 shujuku → 也显示；
        // 自动模式退到仅最近楼层 → 不显示（那时体检没有意义）
        if (resolved.adapter.id === 'shujuku-jiyao') {
            const sub = el('div', 'eo-sub');
            sub.appendChild(el('div', 'eo-sub-title', '└ shujuku 接入诊断'));
            sub.appendChild(el('div', 'eo-hint',
                s.memory.source === 'auto'
                    ? '自动模式下检测到 shujuku 正在使用，所以这里显示它的体检项：确认它当前用哪种填表模式、纪要表在哪、能不能解析出纪要。哪天自动模式不再命中 shujuku，这一项会自动消失。'
                    : '这段是专门给 shujuku 用的体检：确认它当前用哪种填表模式、纪要表在哪、能不能解析出纪要。它是「记忆来源选 shujuku」时才有的子项，切回别的来源就不显示。'));
            const diagBtn = el('button', 'eo-btn', '体检');
            const diagOut = el('div', 'eo-box');
            diagOut.style.display = 'none';
            diagBtn.addEventListener('click', () => {
                try {
                    diagOut.className = 'eo-box';
                    diagOut.textContent = diagnoseShujuku().join(String.fromCharCode(10));
                    diagOut.style.display = 'block';
                } catch (e) {
                    diagOut.className = 'eo-bad';
                    diagOut.textContent = '诊断失败：' + (e && e.message || e);
                    diagOut.style.display = 'block';
                }
            });
            const diagRow = el('div', 'eo-row');
            diagRow.appendChild(diagBtn);
            sub.appendChild(diagRow);
            sub.appendChild(diagOut);
            page.appendChild(sub);
        }

        const flRow = el('div', 'eo-row');
        flRow.appendChild(el('label', null, '最近楼层'));
        const flIn = el('input', 'eo-input');
        markKey(flIn, 'set.recentFloors');
        flIn.type = 'number';
        flIn.min = String(FLOORS_MIN);
        flIn.max = String(FLOORS_MAX);
        // 显示也走规整：存档里若是手改过 settings.json、留了个 0 或 999，
        // 界面不能跟着显示错的值，否则用户看到 999 以为生效了
        flIn.value = String(clampFloors(s.memory.recentFloors));
        flIn.style.width = '76px';
        flIn.addEventListener('change', () => {
            const v = clampFloors(flIn.value);
            flIn.value = String(v);
            getSettings().memory.recentFloors = v;
            saveSettings();
        });
        flRow.appendChild(flIn);
        flRow.appendChild(el('span', 'eo-hint', '楼'));
        page.appendChild(flRow);

        // --- 转述模式（2026-11-04）---
        // 放在「最近楼层」正下方：它改的正是最近楼层的取法，挨着才找得到
        const narRow = el('div', 'eo-row');
        const narChk = el('input');
        narChk.type = 'checkbox';
        markKey(narChk, 'set.narrationMode');
        narChk.checked = !!(s.memory && s.memory.narrationMode);
        narChk.addEventListener('change', () => {
            const st = getSettings();
            const wasOn = !!st.memory.narrationMode;
            const nowOn = narChk.checked;
            st.memory.narrationMode = nowOn;
            // 只在「真的发生切换」时动，重复点同一个状态不改数。
            // 折算规则见 rebalanceFloorsOnModeChange：最近楼层与自动检测间隔一起折，
            // 两者是同一个口径问题，只折一个会互相打架
            let note = '';
            if (wasOn !== nowOn) {
                const r = rebalanceFloorsOnModeChange(st, nowOn);
                note = `，最近楼层 ${r.before} → ${r.after}`;
                if (r.everyBefore !== null) {
                    note += `，自动检测间隔 ${r.everyBefore} → ${r.everyAfter}`;
                    log(`自动检测间隔按模式折算：${r.everyBefore} → ${r.everyAfter}（切到${nowOn ? '转述' : '非转述'}）`);
                }
                log(`最近楼层按模式折算：${r.before} → ${r.after}（切到${nowOn ? '转述' : '非转述'}）`);
            }
            saveSettings();
            log(`转述模式：${nowOn ? '开（最近楼层只读 AI 楼）' : '关（用户楼与 AI 楼都读）'}${note}`);
            repaintPage();
        });
        narRow.appendChild(narChk);
        const narLab = el('span', null, '转述模式（最近楼层只读 AI 楼）');
        attachHelp(narLab, '有些角色卡里，你的输入只是给 AI 的指令（比如「继续」「去酒馆」），'
            + 'AI 那一楼会把内容转述一遍。这种卡开着本项：读最近楼层时跳过用户楼，只取 AI 楼，'
            + '避免同一段剧情读两遍——既省 token，也免得模型把一件事当成发生了两次。'
            + '如果你的卡是用户楼写场景、AI 楼写回应这种分工，那就保持关闭。', true);
        narRow.appendChild(narLab);
        page.appendChild(narRow);

        // --- 角色世界书 ---
        const wbBox = el('div', 'eo-row');
        const wbChk = el('input');
        wbChk.type = 'checkbox';
        wbChk.checked = !(s.worldbook && s.worldbook.enabled === false);
        wbChk.addEventListener('change', () => {
            getSettings().worldbook.enabled = wbChk.checked;
            saveSettings();
            log(`读取角色世界书：${wbChk.checked ? '开' : '关'}`);
            repaintPage();
        });
        wbBox.appendChild(wbChk);
        wbBox.appendChild(el('span', null, '读取角色世界书'));
        page.appendChild(wbBox);

        // 世界书字数上限：超了会截断后面的条目，用户必须能自己调
        // 2026-11-10 修（评审原第 16 条）：这一项和下面「设定字数上限」绑的是同一个字段 maxChars，
        // 但两处的口径原来相反——这里下限 1000、空值回落 30000，0 会被抬成 1000；
        // 那里写着「0 = 不限」。设成 0 的人在这里一保存就变回 1000，看起来像设置没生效。
        // 统一成 0 = 不限：两处都允许 0，都按 0 表示不截断。
        const wcRow = el('div', 'eo-row');
        wcRow.appendChild(el('label', null, '世界书字数上限'));
        const wcIn = el('input', 'eo-input');
        markKey(wcIn, 'set.worldbookChars');
        wcIn.type = 'number';
        wcIn.min = '0';
        wcIn.step = '1000';
        wcIn.value = String((s.worldbook && s.worldbook.maxChars) || 0);
        wcIn.style.flex = '0 0 110px';
        wcIn.addEventListener('change', () => {
            const n = Math.max(0, Number(wcIn.value) || 0);
            getSettings().worldbook.maxChars = n;
            wcIn.value = String(n);
            saveSettings();
            log(n === 0 ? '世界书字数上限已设为不限' : `世界书字数上限已设为 ${n} 字`);
        });
        wcRow.appendChild(wcIn);
        wcRow.appendChild(el('span', 'eo-hint', '字，0 = 不限。超出会截断后面的条目'));
        page.appendChild(wcRow);

        const wbBook = getCharacterBookName();
        const wbHint = el('div', 'eo-hint');
        if (!wbBook) {
            wbHint.textContent = '当前角色未绑定世界书，此项无效';
        } else if (s.worldbook && s.worldbook.enabled === false) {
            wbHint.textContent = `已关闭，生成时不带「${wbBook}」的任何设定`;
        } else {
            wbHint.textContent = `将带入「${wbBook}」的常驻条目（蓝灯），`
                + '自动剔除 shujuku 导出表、变量格式说明、本扩展事件条目与 EJS 条件模板';
        }
        page.appendChild(wbHint);

        const wbCapRow = el('div', 'eo-row');
        wbCapRow.appendChild(el('label', null, '设定字数上限'));
        const wbCap = el('input', 'eo-input');
        markKey(wbCap, 'set.presetChars');
        wbCap.type = 'number';
        wbCap.min = '0';
        wbCap.value = String((s.worldbook && s.worldbook.maxChars) || 0);
        wbCap.style.width = '86px';
        wbCap.addEventListener('change', () => {
            const v = Math.max(0, Number(wbCap.value) || 0);
            wbCap.value = String(v);
            getSettings().worldbook.maxChars = v;
            saveSettings();
        });
        wbCapRow.appendChild(wbCap);
        wbCapRow.appendChild(el('span', 'eo-hint', '字，0 = 不限'));
        page.appendChild(wbCapRow);
    }

    /** 设置页：打勾模式与自动盘点的楼层阈值 */
    function renderSetTrack(page, s) {
        const trSec = el('div', 'eo-sec eo-sec-inline');
        // 屏幕文案与代码里的段名统一成「打勾与自动盘点」（2026-11-04）
        trSec.appendChild(el('span', null, '打勾与自动盘点'));
        attachHelp(trSec, '「打勾」= 把大纲里的某个节点标成已达成。剧情推进到某个节点时，谁来判断、谁来点，就是这个模式决定的。');
        page.appendChild(trSec);
        const trRow = el('div', 'eo-row');
        const trSel = el('select', 'eo-sel');
        markKey(trSel, 'set.trackerMode');
        for (const [k, label] of Object.entries(TRACKER_MODES)) {
            const o = el('option', null, label);
            o.value = k;
            trSel.appendChild(o);
        }
        trSel.value = s.tracker.mode;
        trSel.addEventListener('change', () => {
            getSettings().tracker.mode = trSel.value;
            saveSettings();
            log(`打勾模式已切换为「${TRACKER_MODES[trSel.value] || trSel.value}」`);
            repaintPage();
        });
        trRow.appendChild(trSel);
        page.appendChild(trRow);

        // 三档各占一行，换行显示，避免糊成一段
        const modeLines = {
            auto: '自动：盘点后模型自己判断碰没碰到节点，碰到就直接打勾。你什么都不用管。想在攒够若干层楼时自动盘点，到下面「自动盘点」那一组里设。勾错了点节点「撤销」即可，撤销过的节点以后不会再被自动勾上。',
            semi: '半自动：盘点后模型只给建议，列在盘点页顶部的「待确认的建议」里，节点标成 ◐。点「确认」才算打勾，点「忽略」就不算。适合想保留决定权、又不想自己逐条比对大纲的时候。',
            manual: '手动：模型完全不插手，节点全由你点。适合心里有数、想严格按自己的理解记录进度。',
        };
        const modeList = el('div', 'eo-modes');
        for (const k of ['auto', 'semi', 'manual']) {
            // 三档只做说明，不标「当前」：上面那个下拉框已经写着当前选的是哪档，
            // 再在说明里标一次等于同一件事说两遍（2026-11-01 危晓要求删掉）
            const item = el('div', 'eo-mode');
            const tag = el('span', 'eo-mode-tag', TRACKER_MODES[k]);
            item.appendChild(tag);
            item.appendChild(el('span', null, modeLines[k].replace(TRACKER_MODES[k] + '：', '')));
            modeList.appendChild(item);
        }
        page.appendChild(modeList);

        page.appendChild(el('div', 'eo-hint',
            '无论哪一档，已触发的节点都会写进世界书条目，供模型下一轮参考。'));

        // --- shujuku 诊断已上移到「记忆来源」子项（见上） ---

    }

    /**
     * 设置页：自动盘点（2026-11-04 从「打勾与自动盘点」里拆出来）。
     * 原来这段挂在打勾模式下面、还是「自动模式才显示」的子项，
     * 想调自动盘点的楼层间隔得先看懂打勾模式那一屏说明，两件事挤在一组里。
     */
    function renderSetAuto(page, s) {
        const auSec = el('div', 'eo-sec eo-sec-inline');
        auSec.appendChild(el('span', null, '自动盘点'));
        attachHelp(auSec, '每收到一条新回复后自动检查一次，攒够设定的楼层数就自己跑一趟盘点。'
            + '填 0 就是关掉自动盘点，只在你自己点「开始盘点」时才跑。');
        page.appendChild(auSec);

        // 打勾模式不是自动时，自动盘点这条链路本身不成立，如实写清楚，别让人以为设了会跑
        const mode = String((s.tracker || {}).mode || 'auto');
        if (mode !== 'auto') {
            page.appendChild(el('div', 'eo-hint',
                '当前打勾模式是「' + (TRACKER_MODES[mode] || mode) + '」，盘点不会自己跑，'
                + '这一组只在「自动」模式下生效。想让它自动跑，就到「打勾与自动盘点」里改成「自动」。'));
        }

        const sub = el('div', 'eo-sub');
        sub.appendChild(el('div', 'eo-sub-title', '└ 自动检测间隔'));
        const afRow = el('div', 'eo-row');
        afRow.appendChild(el('label', null, '每'));
        const afIn = el('input', 'eo-input');
        markKey(afIn, 'set.autoEvery');
        afIn.type = 'number';
        afIn.min = '0';
        afIn.max = String(AUTO_EVERY_MAX);
        afIn.value = String(s.tracker.autoEveryFloors);
        afIn.style.width = '76px';
        afIn.addEventListener('change', () => {
            // 0 单独放行（关闭自动盘点），其余夹到 1..200
            const v = clampAutoEvery(afIn.value, true);
            afIn.value = String(v);
            getSettings().tracker.autoEveryFloors = v;
            saveSettings();
            repaintPage();
        });
        afRow.appendChild(afIn);
        afRow.appendChild(el('span', 'eo-hint', '层楼自动盘点一次'));
        // 奇数提示（2026-11-04）：切转述模式时这个数要折半再翻倍，奇数折半会四舍五入掉 1，
        // 来回切一次就对不上了（15→8→16）。建议偶数，漂移就没了
        const everyVal = Number(s.tracker.autoEveryFloors) || 0;
        if (everyVal > 0 && everyVal % 2 !== 0) {
            afRow.appendChild(el('span', 'eo-hint eo-hint-note', '建议填偶数'));
        }
        sub.appendChild(afRow);

        if (getCurrentEvent()) {
            const cur = countFloors();
            const narration = !!(s.memory && s.memory.narrationMode);
            // 这里也要跟 shouldAutoInventory 一样判模式：口径不同时这个数没有可比性，
            // 直接显示「已过多少层」会得到一个负数或虚高的数，用户看着莫名其妙
            const modeChanged = !!getCurrentEvent().floorBaseNarration !== narration;
            const base = Number(getCurrentEvent().floorBase);
            const since = (Number.isFinite(base) && !modeChanged) ? Math.max(0, cur - base) : 0;
            const every = Math.max(0, Number(s.tracker.autoEveryFloors) || 0);
            const unit = narration ? '层 AI 楼' : '层';
            const line = el('div', 'eo-hint',
                every > 0
                    ? `当前对话共 ${cur} ${unit}，距上次盘点已过 ${since} ${unit}，`
                    + `还差 ${Math.max(0, every - since)} ${unit}触发下一次自动盘点。`
                    // 基线口径换了，这里从 0 重新算，正好跟 shouldAutoInventory 的实际行为对上
                    + (modeChanged ? '（刚切换过转述模式，计数从此刻重新开始）' : '')
                    : `当前对话共 ${cur} ${unit}。填 0 即关闭自动盘点，只在你手动点「开始盘点」时才跑。`);
            sub.appendChild(line);
        }
        sub.appendChild(el('div', 'eo-hint',
            '楼层口径跟着转述模式走：转述模式下只数 AI 楼（用户楼只是给 AI 的指令，内容会在 AI 楼里重述），'
            + '非转述模式下玩家楼也在推进剧情，所以玩家楼 + AI 楼合计。系统消息不算。'
            + '基点在新建事件、每次盘点成功后归零重计；切换转述模式时也会按新口径重挂一次。'
            + '切换转述模式时这个间隔会自动折算（切到转述乘 2，切到非转述除 2），'
            + '跟最近楼层用的是同一套规则，所以建议填偶数——奇数折半会被四舍五入，来回切会对不上。'
            + '触发时机是每收到一条新回复后自动检查，攒够间隔就自己跑一次盘点；填 0 则完全关闭自动盘点。'));

        // 手动触发一次
        const afBtn = el('button', 'eo-btn eo-primary', '现在盘点一次');
        afBtn.addEventListener('click', async () => {
            try {
                afBtn.disabled = true;
                afBtn.textContent = '盘点中…';
                await runInventory();
                repaintPage();
            } catch (e) {
                afBtn.disabled = false;
                afBtn.textContent = '现在盘点一次';
                toast('盘点失败：' + (e && e.message || e), { bad: true });
            }
        });
        const afRow2 = el('div', 'eo-row');
        afRow2.appendChild(afBtn);
        sub.appendChild(afRow2);
        page.appendChild(sub);
    }

    /** 设置页：事件类型自定义（2026-11-04） */
    function renderSetTypes(page, s) {
        const main0 = (s.preset && Array.isArray(s.preset.mainTypes)) ? s.preset.mainTypes : [];
        const sub0 = (s.preset && Array.isArray(s.preset.subTypes)) ? s.preset.subTypes : [];
        // 折叠条上标出当前用的是自定义还是内置，省得展开才知道改没改过
        const sumHint = (main0.length || sub0.length)
            ? `自定义 主 ${main0.length || '内置'} / 次 ${sub0.length || '内置'}`
            : '内置默认';
        const box = appendCollapsibleSection(page, 'types', '事件类型', sumHint);
        box.appendChild(el('div', 'eo-hint',
            '生成页「事件类型」里可选的主类型与次类型。一行一个，按这里写的顺序出现。'
            + '留空则用内置默认：主类型 '
            + EVENT_MAIN_TYPES.join(' / ')
            + '；次类型 '
            + EVENT_SUB_TYPES.join(' / ')
            + '。内置那套里已经有 NSFW。'
            + '在生成页点「＋自定义」也能直接加，加完会回到这里。'));

        const makeBox = (title, key, defaults, previewFn) => {
            box.appendChild(el('div', 'eo-sub-title', '└ ' + title));
            const ta = el('textarea', 'eo-input eo-textarea');
            ta.rows = key === 'mainTypes' ? 5 : 7;
            ta.placeholder = '每行一个。例如：\n' + defaults.slice(0, 3).join('\n');
            const custom = (s.preset && Array.isArray(s.preset[key])) ? s.preset[key] : [];
            ta.value = custom.join('\n');
            box.appendChild(ta);

            const row = el('div', 'eo-row');
            const btnSave = el('button', 'eo-btn eo-primary', '保存');
            const btnFill = el('button', 'eo-btn', '填入内置默认');
            const btnReset = el('button', 'eo-btn', '恢复默认');
            btnFill.type = 'button';
            btnFill.addEventListener('click', () => {
                ta.value = defaults.join('\n');
                out.className = 'eo-hint';
                out.textContent = '已填入内置默认，改完记得点「保存」。';
            });
            const out = el('div', 'eo-hint');
            btnSave.addEventListener('click', () => {
                const list = String(ta.value || '').split('\n').map(x => x.trim()).filter(Boolean);
                const seen = new Set();
                const clean = [];
                for (const x of list) { if (!seen.has(x)) { seen.add(x); clean.push(x); } }
                const st = getSettings();
                st.preset[key] = clean;
                saveSettings();
                out.className = 'eo-ok';
                out.textContent = clean.length
                    ? `已保存 ${clean.length} 个：${clean.join(' / ')}`
                    : '已清空，将使用内置默认';
                log(`${title}已更新：${clean.length ? clean.join(' / ') : '（恢复默认）'}`);
                if (previewFn) previewFn();
            });
            btnReset.addEventListener('click', () => {
                ta.value = '';
                const st = getSettings();
                st.preset[key] = [];
                saveSettings();
                out.className = 'eo-ok';
                out.textContent = '已恢复默认：' + defaults.join(' / ');
                log(`${title}已恢复默认`);
                if (previewFn) previewFn();
            });
            row.appendChild(btnSave);
            row.appendChild(btnFill);
            row.appendChild(btnReset);
            box.appendChild(row);
            box.appendChild(out);
        };

        makeBox('主类型', 'mainTypes', EVENT_MAIN_TYPES);
        makeBox('次类型', 'subTypes', EVENT_SUB_TYPES);

        // ---- M7（2026-11-07）：自定义类型用哪套骨架 ----
        // 在主类型列表里手打过名字的用户，这里能把那个名字挂到某个内置类型的骨架上。
        // 不挂就一律套「其他」通用骨架（复用「其他」的六个字段：目标/障碍/资源/变数/失败代价/相关方）。
        box.appendChild(el('div', 'eo-sub-title', '└ 自定义类型用哪套骨架'));
        box.appendChild(el('div', 'eo-hint',
            '你自己起的类型名（不在上面那批内置类型里的），默认按「其他」的通用骨架生成——'
            + '六个字段：目标、障碍、资源、变数、失败代价、相关方。'
            + '如果你希望它按某个内置类型的方式来生成（比如「盗墓」按探险探索的字段来），就在下面配一条。'
            + '没配的不影响，仍然走通用骨架。'));
        const mapBox = el('div', 'eo-map-list');
        const renderMapRows = () => {
            mapBox.innerHTML = '';
            const st = getSettings();
            const map = (st.preset && st.preset.customSkeletonMap) || {};
            const entries = Object.entries(map);
            if (!entries.length) {
                mapBox.appendChild(el('div', 'eo-hint', '（还没有配置任何映射）'));
            }
            for (const [from, to] of entries) {
                const row = el('div', 'eo-row');
                row.appendChild(el('span', 'eo-map-from', from));
                row.appendChild(el('span', 'eo-hint', ' → '));
                row.appendChild(el('span', 'eo-map-to', to || '（未配，走通用骨架）'));
                const btnDel = el('button', 'eo-btn', '删除');
                btnDel.type = 'button';
                btnDel.addEventListener('click', () => {
                    const s2 = getSettings();
                    if (s2.preset && s2.preset.customSkeletonMap) {
                        delete s2.preset.customSkeletonMap[from];
                        saveSettings();
                        log('已删除骨架映射：' + from);
                        renderMapRows();
                    }
                });
                row.appendChild(btnDel);
                mapBox.appendChild(row);
            }
        };
        renderMapRows();
        box.appendChild(mapBox);

        // 新增一行：输入自定义类型名 + 选一个内置骨架
        const addRow = el('div', 'eo-row');
        const inName = el('input', 'eo-input');
        inName.type = 'text';
        inName.placeholder = '自定义类型名，如 盗墓';
        addRow.appendChild(inName);
        const selSkel = el('select', 'eo-input');
        for (const t of EVENT_MAIN_TYPES) {
            const o = el('option', null, t);
            o.value = t;
            selSkel.appendChild(o);
        }
        // 默认选中「其他」——它就是「不配置」时的行为，放第一个不会让人误以为必须选
        selSkel.value = '其他';
        addRow.appendChild(selSkel);
        const btnAdd = el('button', 'eo-btn eo-primary', '添加映射');
        btnAdd.type = 'button';
        const addOut = el('div', 'eo-hint');
        btnAdd.addEventListener('click', () => {
            const from = String(inName.value || '').trim();
            const to = String(selSkel.value || '').trim();
            if (!from) {
                addOut.className = 'eo-err';
                addOut.textContent = '请先填自定义类型名。';
                return;
            }
            if (EVENT_MAIN_TYPES.includes(from)) {
                addOut.className = 'eo-err';
                addOut.textContent = `「${from}」是内置类型，不需要配映射——内置类型永远用它自己的骨架。`;
                return;
            }
            const st = getSettings();
            if (!st.preset) st.preset = {};
            if (!st.preset.customSkeletonMap) st.preset.customSkeletonMap = {};
            st.preset.customSkeletonMap[from] = to;
            saveSettings();
            inName.value = '';
            addOut.className = 'eo-ok';
            addOut.textContent = `已保存：「${from}」→ ${to}`;
            log(`骨架映射已保存：${from} → ${to}`);
            renderMapRows();
        });
        addRow.appendChild(btnAdd);
        box.appendChild(addRow);
        box.appendChild(addOut);
    }

    /**
     * 设置页：事件参数的自定义选项（2026-11-04 危晓要求）。
     * 他在生成页手打的话是一次性的；要反复用同一句，就在这里预存。
     * 存进 preset.customOptions[key] = ['一句', '两句']，
     * 生成页对应那一项的下拉里就会多出这几项，排在「＋ 自定义…」之前。
     */
    function renderSetPrefOptions(page, s) {
        const box = appendCollapsibleSection(page, 'prefOptions', '参数自定义项', '预存手写取值');
        box.appendChild(el('div', 'eo-hint',
            '这里填的是「以后经常要用到、想让它直接出现在下拉里」的说法。'
            + '只是这一次想换个写法的话，不用来这儿——生成页每一项的下拉里都有「＋ 自定义…」，'
            + '选中后当场打一句就行。'
            + '一行一个，按写的顺序排在下拉里。'));

        const store = () => {
            const st = getSettings();
            if (!st.preset.customOptions) st.preset.customOptions = {};
            return st.preset.customOptions;
        };

        // 只列事件参数里的项。难度等级不在这里：它是独立的「难度等级」节，
        // 档位本身就在那一节编，不该在事件参数里再出现一次（2026-11-04 危晓指出重复）
        // 2026-11-06 M4.2：补上战斗五项，否则它们的预设手写值在这里编不了。
        for (const g of PREF_GROUPS.concat(PREF_COMBAT_GROUPS)) {
            const sub = el('div', 'eo-row eo-prefopt-row');
            const lab = el('label', null, g.group ? `${g.group}·${g.label}` : g.label);
            lab.style.minWidth = '130px';
            sub.appendChild(lab);

            const ta = el('textarea', 'eo-input eo-textarea');
            ta.rows = 2;
            ta.placeholder = '一行一条，例如：只留一处能要人命的地方';
            const saved = store();
            ta.value = (Array.isArray(saved[g.key]) ? saved[g.key] : []).join('\n');
            ta.style.flex = '1';
            sub.appendChild(ta);

            const out = el('div', 'eo-hint');
            let timer = null;
            // 边打边存，但不每敲一个字就写一遍存储：停手 600ms 再落盘
            const commit = () => {
                const list = String(ta.value || '').split('\n').map(x => x.trim()).filter(Boolean);
                const seen = new Set();
                const clean = [];
                for (const x of list) { if (!seen.has(x)) { seen.add(x); clean.push(x); } }
                const all = store();
                if (clean.length) all[g.key] = clean;
                else delete all[g.key];
                saveSettings();
                out.textContent = clean.length ? `已存 ${clean.length} 条` : '已清空';
                out.className = 'eo-hint';
            };
            ta.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(commit, 600);
            });

            const btn = el('button', 'eo-btn', '清空');
            btn.type = 'button';
            btn.addEventListener('click', () => {
                ta.value = '';
                commit();
            });
            sub.appendChild(btn);
            sub.appendChild(out);
            box.appendChild(sub);
        }
    }

    /** 设置页：历史事件保留数量 */
    function renderSetRetention(page, s) {
        const retSec = el('div', 'eo-sec eo-sec-inline');
        retSec.appendChild(el('span', null, '历史保留'));
        attachHelp(retSec, '事件完结或废弃后，事件卡不会立刻消失，而是留在这里当历史。这两个数字是分别保留多少条：超出上限时按结束时间从旧到新删掉最老的。进行中的事件永远不会被清掉。');
        page.appendChild(retSec);
        const retRow = el('div', 'eo-row');
        retRow.appendChild(el('label', null, '完结'));
        const inDone = el('input', 'eo-input');
        markKey(inDone, 'set.retainDone');
        inDone.type = 'number';
        inDone.min = '1';
        inDone.max = '100';
        inDone.value = String(s.retention.completed);
        inDone.style.width = '76px';
        inDone.addEventListener('change', () => {
            const v = Math.max(1, Math.min(100, Number(inDone.value) || 20));
            inDone.value = String(v);
            getSettings().retention.completed = v;
            saveSettings();
        });
        retRow.appendChild(inDone);
        retRow.appendChild(el('span', 'eo-hint', '废弃'));
        const inAban = el('input', 'eo-input');
        markKey(inAban, 'set.retainAbandoned');
        inAban.type = 'number';
        inAban.min = '1';
        inAban.max = '50';
        inAban.value = String(s.retention.abandoned);
        inAban.style.width = '76px';
        inAban.addEventListener('change', () => {
            const v = Math.max(1, Math.min(50, Number(inAban.value) || 3));
            inAban.value = String(v);
            getSettings().retention.abandoned = v;
            saveSettings();
        });
        retRow.appendChild(inAban);
        page.appendChild(retRow);

        // --- 待选上限（2026-11-10 危晓定）---
        // 单事件与链各算各的，默认都是 5。改完立刻生效，不用重开面板。
        const capSec = el('div', 'eo-sec eo-sec-inline');
        capSec.appendChild(el('span', null, '待选上限'));
        attachHelp(capSec, '生成出来的事件先放进「待选」，不写世界书。这里是两类各留几个：'
            + `单事件最多留 ${DRAFT_CAP_MAX} 个，链按条数算、一条链不管几个节点都只占 1 个名额，两类互不占位。`
            + '超出上限时最早的那个会被挤掉。');
        page.appendChild(capSec);
        const capRow = el('div', 'eo-row');
        const mkCapInput = (key, label) => {
            capRow.appendChild(el('label', null, label));
            const inp = el('input', 'eo-input');
            inp.type = 'number';
            inp.min = String(DRAFT_CAP_MIN);
            inp.max = String(DRAFT_CAP_MAX);
            inp.value = String(draftCap(key === 'draftCapChain' ? 'chain' : 'single'));
            inp.style.width = '76px';
            inp.addEventListener('change', () => {
                let v = Math.floor(Number(inp.value));
                if (!Number.isFinite(v)) v = key === 'draftCapChain' ? MAX_CHAIN_DRAFTS_DEFAULT : MAX_DRAFTS_DEFAULT;
                v = Math.max(DRAFT_CAP_MIN, Math.min(DRAFT_CAP_MAX, v));
                inp.value = String(v);
                getSettings()[key] = v;
                saveSettings();
                log(`待选上限已改为：${key === 'draftCapChain' ? '链' : '单事件'} ${v} 个`);
            });
            markKey(inp, key === 'draftCapChain' ? 'set.draftCapChain' : 'set.draftCapSingle');
            capRow.appendChild(inp);
        };
        mkCapInput('draftCapSingle', '待选事件');
        mkCapInput('draftCapChain', '待选事件链');
        page.appendChild(capRow);

        // --- 界面 ---
    }

    /**
     * 设置页「事件链」一节（M16）。
     *
     * 目前只有一项：逐条生成模式。默认自动——三四个节点逐个点击太繁琐，
     * 真跑偏了从下游的 exit_state 也看得出来。想稳一点的自己打开。
     */
    function renderSetChain(page, s) {
        const st = getSettings();
        if (!st.chain) st.chain = { manual: false };

        page.appendChild(el('div', 'eo-hint',
            '生成事件链时，每一步是否要你确认。'));

        const row = el('div', 'eo-row');
        const chk = el('input');
        chk.type = 'checkbox';
        markKey(chk, 'set.chainManual');
        chk.checked = !!st.chain.manual;
        chk.addEventListener('change', () => {
            const cur = getSettings();
            if (!cur.chain) cur.chain = { manual: false };
            cur.chain.manual = chk.checked;
            saveSettings();
            log('事件链逐条生成模式：' + (chk.checked ? '手动确认' : '自动'));
        });
        row.appendChild(chk);
        row.appendChild(el('span', null, '逐条生成时，每条生成完都停下来等我确认'));
        page.appendChild(row);

        page.appendChild(el('div', 'eo-hint',
            '不勾（默认）：生成完一条自动往下，整条链一次跑完，中途可以随时中断。'
            + '勾上：每生成一条就停下，你看过之后再点「生成下一个」。'));
    }

    /** 设置页：界面（悬浮球开关） */
    function renderSetUi(page, s) {
        page.appendChild(el('div', 'eo-sec', '界面'));
        const fabRow = el('div', 'eo-row');
        fabRow.appendChild(el('label', null, '悬浮窗'));
        const fabChk = el('input');
        fabChk.type = 'checkbox';
        fabChk.checked = !!s.ui.floatingEnabled;
        fabChk.addEventListener('change', () => {
            getSettings().ui.floatingEnabled = fabChk.checked;
            saveSettings();
            ensureFab();
        });
        fabRow.appendChild(fabChk);
        fabRow.appendChild(el('span', 'eo-hint', '关闭后仍可从扩展菜单打开'));
        page.appendChild(fabRow);

        // --- 世界书自检 ---
    }

    /** 设置页：世界书（打勾范围、自检、写入测试） */
    function renderSetBook(page, s) {
        page.appendChild(el('div', 'eo-sec', '世界书'));
        const bookRow = el('div', 'eo-row');
        const btnCheck = el('button', 'eo-btn', '自检世界书');
        const checkOut = el('div', 'eo-hint');
        btnCheck.addEventListener('click', async () => {
            btnCheck.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '读取中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const mine = await listEventEntries(target);
                const data = await readWorldBook(target);
                const total = Object.keys((data && data.entries) || {}).length;
                let foreignExport = 0;
                for (const entry of Object.values((data && data.entries) || {})) {
                    if (String(entry && entry.comment || '').startsWith(SHUJUKU_EXPORT_PREFIX)) foreignExport++;
                }
                checkOut.className = 'eo-ok';
                checkOut.textContent = [
                    `世界书：${target}`,
                    `总条目：${total}`,
                    `本扩展条目：${mine.length}`,
                    `shujuku 导出条目：${foreignExport}`,
                    mine.length ? `明细：${mine.map(m => `${m.uid}(${m.contentLength}字)`).join('、')}` : '明细：无',
                ].join('\n');
                log(`世界书自检：${target}，总条目 ${total}，本扩展 ${mine.length} 条，shujuku 导出 ${foreignExport} 条`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '读取失败：' + (e && e.message || e);
                error('世界书自检失败：', e);
            } finally { btnCheck.disabled = false; }
        });

        // 写入测试与删除测试只给开发排障用（2026-11-04 危晓定），平时不该出现在界面上：
        // 它们会真的往世界书里写一条、再删掉，对普通使用者是纯粹的风险。
        // 只在设置里开着「调试模式」时才渲染这两个按钮，连事件监听一起不挂，不留死代码。
        const btnTest = el('button', 'eo-btn', '写入测试');
        const TEST_MARK = '测试条目（可删）';
        const btnClean = el('button', 'eo-btn', '删除测试');

        btnTest.addEventListener('click', async () => {
            btnTest.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '写入中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const content = `〔事件大纲｜写入自测｜${new Date().toISOString()}〕\n测试条目，确认无损写入后请点删除。`;
                const r = await upsertEventEntry(target, content, `${ENTRY_PREFIX}${TEST_MARK}`, null);
                checkOut.className = 'eo-ok';
                checkOut.textContent = '写入成功，其余条目内容校验通过。';
                log(`世界书写入测试成功：${target}，uid=${r.uid}`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '写入失败：' + (e && e.message || e);
                error('世界书写入测试失败：', e);
            } finally { btnTest.disabled = false; }
        });

        btnClean.addEventListener('click', async () => {
            btnClean.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '删除中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const data = await readWorldBook(target);
                const targets = Object.entries((data && data.entries) || {})
                    .filter(([, e]) => String(e && e.comment || '') === `${ENTRY_PREFIX}${TEST_MARK}`)
                    .map(([uid]) => uid);
                if (!targets.length) {
                    checkOut.className = 'eo-hint';
                    checkOut.textContent = '没有找到测试条目。';
                    log(`删除测试条目：${target} 里没有找到测试条目`);
                    return;
                }
                for (const uid of targets) await deleteEventEntry(target, uid);
                checkOut.className = 'eo-ok';
                checkOut.textContent = `已删除 ${targets.length} 条测试条目。`;
                log(`已删除世界书测试条目 ${targets.length} 条：${targets.join('、')}`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '删除失败：' + (e && e.message || e);
                error('删除世界书测试条目失败：', e);
            } finally { btnClean.disabled = false; }
        });

        bookRow.appendChild(btnCheck);
        if (s && s.debug) {
            bookRow.appendChild(btnTest);
            bookRow.appendChild(btnClean);
        }
        page.appendChild(bookRow);

        // --- 条目顺序（2026-11-04 危晓要求：事件条目在世界书里往前挪） ---
        // order 一个数管两件事：世界书列表里排第几、↑Char 那一组里谁先拼进提示词。
        // 列表是降序显示，数越大越靠前；提示词那侧同样是数大的先写。
        page.appendChild(el('div', 'eo-hint',
            '事件条目写进世界书时的顺序值。世界书列表按它从大到小排，模型读到的顺序也按它，'
            + '数越大越靠前。改动后，已有的事件条目会在下一次盘点写回时一并改成这个数；'
            + '位置、深度、触发概率不受影响，你在酒馆界面里手动调过的这几项不会被改回去。'));
        const ordRow = el('div', 'eo-row');
        ordRow.appendChild(el('label', null, '条目顺序'));
        const ordIn = el('input', 'eo-input');
        ordIn.type = 'number';
        ordIn.min = '0';
        ordIn.max = String(MAX_ENTRY_ORDER);
        ordIn.step = '1';
        ordIn.style.width = '90px';
        ordIn.value = String(eventOrderValue());
        markKey(ordIn, 'set.entryOrder');
        const ordOut = el('div', 'eo-hint');
        const commitOrder = () => {
            const raw = String(ordIn.value || '').trim();
            const n = Number(raw);
            if (!raw || !Number.isFinite(n)) {
                ordOut.className = 'eo-bad';
                ordOut.textContent = '请填一个 0 到 ' + MAX_ENTRY_ORDER + ' 之间的整数，已退回当前值 ' + eventOrderValue();
                ordIn.value = String(eventOrderValue());
                return;
            }
            const v = Math.min(MAX_ENTRY_ORDER, Math.max(0, Math.round(n)));
            getSettings().worldbook.entryOrder = v;
            saveSettings();
            ordIn.value = String(v);
            ordOut.className = 'eo-ok';
            ordOut.textContent = '已保存：' + v + '（默认 ' + DEFAULT_ENTRY_ORDER + '）';
            log(`事件条目的世界书顺序值改为 ${v}`);
        };
        ordIn.addEventListener('change', commitOrder);
        ordIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitOrder(); });
        const btnOrdDefault = el('button', 'eo-btn', '恢复默认');
        btnOrdDefault.type = 'button';
        btnOrdDefault.addEventListener('click', () => {
            ordIn.value = String(DEFAULT_ENTRY_ORDER);
            commitOrder();
        });
        ordRow.appendChild(ordIn);
        ordRow.appendChild(btnOrdDefault);
        page.appendChild(ordRow);
        page.appendChild(ordOut);

        // --- 难度等级 ---
    }

    /** 设置页：难度等级自定义（可折叠，2026-11-04）。叫法跟生成页统一，不再叫「难度档位」 */
    function renderSetLevels(page, s) {
        const custom0 = (s.preset && Array.isArray(s.preset.difficultyLevels)) ? s.preset.difficultyLevels : [];
        // 折叠条上直接把当前有几档写出来，折着也知道里面是什么状态，不用展开一个个数
        const sumHint = custom0.length
            ? `自定义 ${custom0.length} 档`
            : `内置默认 ${DEFAULT_DIFFICULTY_LEVELS.length} 档`;
        const box = appendCollapsibleSection(page, 'levels', PREF_LEVEL_ITEM.label, sumHint);
        box.appendChild(el('div', 'eo-hint',
            '生成事件时「难度等级」下拉里可选的档位。一行一个，从低到高排，下拉里就按这个顺序出现。'
            + '留空则使用内置默认档：'
            + DEFAULT_DIFFICULTY_LEVELS.join(' / ')
            + '。如果你的角色卡自带一套分级（比如从 F 到 SSS、或「见习/正式/精英」），在这里整组填成你卡里的说法即可。'));
        const lvInput = el('textarea', 'eo-input eo-textarea');
        lvInput.rows = 5;
        lvInput.placeholder = '每行一个档位，从低到高。例如：\nF 级\nE 级\nD 级\nC 级\nB 级';
        const custom = (s.preset && Array.isArray(s.preset.difficultyLevels)) ? s.preset.difficultyLevels : [];
        lvInput.value = custom.join('\n');
        box.appendChild(lvInput);

        const lvRow = el('div', 'eo-row');
        const btnLvSave = el('button', 'eo-btn eo-primary', '保存档位');
        const btnLvReset = el('button', 'eo-btn', '恢复默认');
        const btnLvFill = el('button', 'eo-btn', '填入内置五档');
        btnLvFill.type = 'button';
        attachHelp(btnLvFill, '把内置那五档填进上面的框，方便在它们基础上改一两档。'
            + '只填不保存，改完还要点「保存档位」。');
        btnLvFill.addEventListener('click', () => {
            lvInput.value = DEFAULT_DIFFICULTY_LEVELS.join('\n');
            lvOut.className = 'eo-hint';
            lvOut.textContent = '已填入内置五档，改完记得点「保存档位」。';
        });
        const lvOut = el('div', 'eo-hint');
        btnLvSave.addEventListener('click', () => {
            const list = String(lvInput.value || '').split('\n')
                .map(x => x.trim()).filter(Boolean);
            // 去重但保留顺序
            const seen = new Set();
            const clean = [];
            for (const x of list) { if (!seen.has(x)) { seen.add(x); clean.push(x); } }
            getSettings().preset.difficultyLevels = clean;
            saveSettings();
            lvOut.className = 'eo-ok';
            lvOut.textContent = clean.length
                ? `已保存 ${clean.length} 个档位：${clean.join(' / ')}`
                : '已清空，将使用内置默认档位';
            log(`难度等级已更新：${clean.length ? clean.join(' / ') : '（恢复默认）'}`);
        });
        btnLvReset.addEventListener('click', () => {
            lvInput.value = '';
            getSettings().preset.difficultyLevels = [];
            saveSettings();
            lvOut.className = 'eo-ok';
            lvOut.textContent = '已恢复默认档位：' + DEFAULT_DIFFICULTY_LEVELS.join(' / ');
            log('难度等级已恢复默认');
        });
        lvRow.appendChild(btnLvSave);
        lvRow.appendChild(btnLvFill);
        lvRow.appendChild(btnLvReset);
        box.appendChild(lvRow);
        box.appendChild(lvOut);

    }


