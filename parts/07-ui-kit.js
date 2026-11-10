    // ==================== 6. 通用组件 ====================
    // 表单控件、确认条、轻提示：界面层与设置页共用，放这里免得两边各写一套

    // ---------- 表单控件 helper（2026-11-02 A2） ----------
    // 设置页与偏好区以前每家自己建 input/select、自己挂 change、自己 saveSettings，
    // 光 apiProfiles 的查找就复制了 13 遍。这里收成一组小函数：
    // 建控件、接事件、写回一次做完，调用处只描述「这个格子改什么」。
    // 只做「改完不重绘」这一类，需要整页重绘的少数项仍在调用处显式 renderPanel()。

    /** 输入框。onCommit 在 change（失焦或回车）时调用，返回 false 表示不写回 */
    function inputField(opt) {
        const o = opt || {};
        // 2026-11-10 重做（原改动在 11-09 因反引号事故随回退丢失）：
        // 需要填长文本的框要能自适应行高，否则手机上一屏只看得见开头几个字。
        // 走同一个构造器加个 multi 选项，而不是到处复制一份 textarea 逻辑——
        // 复制出去的每一份以后都要单独维护，这个项目已经吃过「同一份规格写两处然后分叉」的亏。
        const inp = o.multi
            ? el('textarea', 'eo-input eo-auto' + (o.cls ? ' ' + o.cls : ''))
            : el('input', 'eo-input' + (o.cls ? ' ' + o.cls : ''));
        if (!o.multi) inp.type = o.type || 'text';
        if (o.multi) {
            inp.rows = o.rows || 1;
            autoGrow(inp);
        }
        if (o.placeholder) inp.placeholder = o.placeholder;
        if (o.value !== undefined && o.value !== null) inp.value = String(o.value);
        if (o.width) inp.style.maxWidth = o.width;
        if (o.attrs) for (const k of Object.keys(o.attrs)) inp.setAttribute(k, o.attrs[k]);
        if (typeof o.onCommit === 'function') {
            const commit = () => {
                let v = inp.value;
                if (typeof o.normalize === 'function') v = o.normalize(v);
                if (v === false) return;
                o.onCommit(v);
            };
            inp.addEventListener('change', commit);
            if (o.commitOnInput) inp.addEventListener('input', commit);
        }
        return inp;
    }

    /**
     * 数字输入框：失焦时把内容规整到 min/max/step，并把规整后的值写回框里。
     * 空输入按原值处理，不把 0 写进设置——以前直接 Number('') 会得到 0，把用户填过的值抹掉。
     */
    function numberField(opt) {
        const o = opt || {};
        const inp = el('input', 'eo-input' + (o.cls ? ' ' + o.cls : ''));
        inp.type = 'number';
        if (o.placeholder) inp.placeholder = o.placeholder;
        if (o.value !== undefined && o.value !== null) inp.value = String(o.value);
        inp.step = o.step || 1;
        if (o.min !== undefined) inp.min = o.min;
        if (o.max !== undefined) inp.max = o.max;
        if (o.width) inp.style.maxWidth = o.width;
        inp.addEventListener('change', () => {
            const t = String(inp.value || '').trim();
            if (t === '') { inp.value = o.value === undefined ? '' : String(o.value); return; }
            let n = Number(t);
            if (!isFinite(n)) { inp.value = String(o.value === undefined ? '' : o.value); return; }
            if (o.min !== undefined && n < o.min) n = o.min;
            if (o.max !== undefined && n > o.max) n = o.max;
            if (o.step) n = Math.round(n / o.step) * o.step;
            n = Math.round(n);
            inp.value = String(n);
            if (typeof o.onCommit === 'function') o.onCommit(n);
        });
        return inp;
    }

    /** 下拉框。options 为 [[值, 显示文字], ...] */
    function selectField(opt) {
        const o = opt || {};
        const sel = el('select', 'eo-sel' + (o.cls ? ' ' + o.cls : ''));
        for (const [v, label] of (o.options || [])) {
            const op = el('option', null, label);
            op.value = String(v);
            sel.appendChild(op);
        }
        sel.value = o.value === undefined || o.value === null ? '' : String(o.value);
        if (typeof o.onChange === 'function') {
            sel.addEventListener('change', () => o.onChange(sel.value));
        }
        return sel;
    }

    /** 一行：标签 + 控件 + 可选说明（问号气泡或行内小字） */
    function formRow(label, control, opt) {
        const o = opt || {};
        const row = el('div', 'eo-row');
        if (label) row.appendChild(el('label', null, label));
        row.appendChild(control);
        if (o.help) attachHelp(row, o.help);
        if (o.hint) row.appendChild(el('span', 'eo-hint', o.hint));
        return row;
    }

    /** 在 apiProfiles 里按 id 找一套配置并改它。返回 false 表示没找到 */
    function updateProfile(id, mutate) {
        const t = (getSettings().apiProfiles || []).find(x => x.id === id);
        if (!t) return false;
        mutate(t);
        saveSettings();
        return true;
    }

    // ---------- 无障碍：让可点的块也能用键盘 ----------
    // 界面里很多可点的东西是 div（标签页、节点行），鼠标能用、键盘用不了。
    // 这里统一补三件事：可以 Tab 到、有 role、回车和空格等同点击。

    /** 把元素变成键盘可操作的可点块。role 默认 button，列表项可传 "tab" */
    function makeActivatable(node, role) {
        if (!node) return node;
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', role || 'button');
        node.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
                ev.preventDefault();
                ev.stopPropagation();
                node.click();
            }
        });
        return node;
    }

    /** 重画当前页（密钥改动后 p 快照过期，靠重绘重新取） */
    function reloadProfileKey() {
        repaintPage();
    }

    /**
     * 密钥掩码（2026-11-02）：设置页原本把完整密钥回填进密码框，
     * 打开设置页、点一下「显示密码」就能看到整串。这里只露头尾，中间打码。
     * 注意：掩码只用于回显，任何写盘路径都不许写这个值。
     */
    function maskKey(k) {
        const v = String(k || '');
        if (!v) return '';
        if (v.length <= 8) return '••••';
        return v.slice(0, 3) + '••••' + v.slice(-4);
    }

    // ---------- 导出一份文本/JSON 文件（2026-11-02：排障不用再截图手抄） ----------

    /**
     * 复制一段文字到剪贴板（2026-11-02）。
     * 优先 navigator.clipboard，权限被拒或页面不在安全上下文时退回 execCommand，
     * 两条都不成返回 false，由调用方提示用户手动选。
     */
    async function copyText(text) {
        const v = String(text == null ? '' : text);
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(v);
                return true;
            }
        } catch (e) { /* 落到下面的兜底 */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = v;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return !!ok;
        } catch (e) {
            return false;
        }
    }

    /** 文件名里的时间戳：20261102-1219，本地时间，排序即时间顺序 */
    function fileStamp(d) {
        const t = d || new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}`;
    }
    function downloadText(filename, text, mime) {
        try {
            const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
            return true;
        } catch (e) {
            warn('导出失败', e);
            return false;
        }
    }

    // ---------- 确认条与轻提示（2026-11-02 起替代原生 confirm / alert） ----------

    // 正在等的那次模型请求：放弃等待时 abort 掉，并让界面立刻解除忙碌态
    let pendingRequest = S.pendingRequest; // 引用指向 S，值统一存 S

    // 生成页三个偏好折叠组里哪些是展开的（2026-11-02）
    // 以前每组固定 open = false：开新事件要展开三次才能看全，点一下别的又折回去。
    const openPrefGroups = new Set();

    // 设置页各节的折叠状态（2026-11-04 危晓要求：难度档位、事件类型加折叠）
    // 记在模块里而不是 DOM 上，重绘设置页后还能保持用户上次开合的样子。
    // 默认都折起来：这两节的说明文字很长，展开着会把整页撑得像一份说明书
    const openSetSections = new Set();

    /**
     * 把一段设置内容包进可折叠的 details 里。
     * 统一走这里的好处：折叠壳、标题、展开状态三处的写法只有一份，
     * 以后再加可折叠的节不用各抄一遍（抄多了必然出现有的记住状态、有的不记）。
     * @param {HTMLElement} page 目标容器
     * @param {string} name 节名，也是折叠状态的键，必须唯一
     * @param {string} title 折叠条上显示的文字
     * @param {string} [hint] 折叠条右侧的一行小字，用来在折着的时候也能看出里面是什么
     */
    function appendCollapsibleSection(page, name, title, hint) {
        const box = el('details', 'eo-setsec');
        box.open = openSetSections.has(name);
        box.addEventListener('toggle', () => {
            if (box.open) openSetSections.add(name); else openSetSections.delete(name);
        });
        const sum = el('summary', 'eo-setsec-sum');
        sum.appendChild(el('span', 'eo-setsec-title', title));
        if (hint) sum.appendChild(el('span', 'eo-hint eo-setsec-hint', hint));
        box.appendChild(sum);
        page.appendChild(box);
        return box;
    }

    // ---------- 重绘时的滚动与焦点保持（2026-11-02 C1 止血版） ----------
    // 整页重绘会把 #eo_body 整个清空重建，浏览器随之把滚动位置归零、焦点丢到 body。
    // 这里在重绘前记下「滚到哪」「焦点在哪个关键元素、光标在第几个字」，重绘后按稳定 key 找回来。
    // 输入框的值另存一份：重绘后新框是空的，不补回去等于把用户正在打的东西抹了。

    /** 给控件挂一个稳定 key，重绘后靠它认回同一个控件 */
    function markKey(node, key) {
        if (node && key) node.dataset.eoKey = String(key);
        return node;
    }

    /** 记下当前快照：滚动位置、焦点元素、光标位置、各输入框的值、展开着的折叠块 */
    function captureView() {
        const body = S.panelEl && S.panelEl.querySelector('#eo_body');
        if (!body) return null;
        // 滚动的是 #eo_body（面板 fixed 全屏），不是窗口
        const out = { scrollTop: body.scrollTop || 0, scrollY: window.scrollY || window.pageYOffset || 0, focus: null, inputs: {}, details: [] };
        const act = document.activeElement;
        if (act && body.contains(act)) {
            const key = act.dataset && act.dataset.eoKey;
            if (key) {
                out.focus = {
                    key,
                    start: typeof act.selectionStart === 'number' ? act.selectionStart : null,
                    end: typeof act.selectionEnd === 'number' ? act.selectionEnd : null,
                    scrollTop: typeof act.scrollTop === 'number' ? act.scrollTop : 0,
                };
            }
        }
        for (const node of body.querySelectorAll('[data-eo-key]')) {
            const key = node.dataset.eoKey;
            const tag = node.tagName;
            if (tag === 'INPUT') {
                out.inputs[key] = node.type === 'checkbox' ? !!node.checked : node.value;
            } else if (tag === 'SELECT' || tag === 'TEXTAREA') {
                out.inputs[key] = node.value;
            } else if (tag === 'DETAILS') {
                if (node.open) out.details.push(key);
            }
        }
        return out;
    }

    /** 把快照找回来。滚动用两帧：内容刚重建，第一帧的布局还不一定算完 */
    function restoreView(snap) {
        const body = S.panelEl && S.panelEl.querySelector('#eo_body');
        if (!body || !snap) return;
        for (const [key, val] of Object.entries(snap.inputs || {})) {
            const node = body.querySelector('[data-eo-key="' + cssEscape(key) + '"]');
            if (!node) continue;
            if (node.type === 'checkbox') node.checked = !!val;
            else if (node.value !== val) node.value = val;
        }
        for (const key of snap.details || []) {
            const node = body.querySelector('[data-eo-key="' + cssEscape(key) + '"]');
            if (node) node.open = true;
        }
        if (snap.focus) {
            const node = body.querySelector('[data-eo-key="' + cssEscape(snap.focus.key) + '"]');
            if (node) {
                try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (e2) { /* 忽略 */ } }
                try {
                    if (snap.focus.start != null && node.setSelectionRange) {
                        node.setSelectionRange(snap.focus.start, snap.focus.end == null ? snap.focus.start : snap.focus.end);
                    }
                } catch (e) { /* 密码框等不支持，忽略 */ }
                if (node.scrollTop !== undefined && snap.focus.scrollTop) node.scrollTop = snap.focus.scrollTop;
            }
        }
        const st = snap.scrollTop || 0;
        if (st > 0) {
            body.scrollTop = st;
            requestAnimationFrame(() => { if (body.isConnected) body.scrollTop = st; });
        }
    }

    /** CSS 属性选择器里 key 的转义：key 都是我们自己写的字母数字与短横，保险起见转一下引号与反斜杠 */
    function cssEscape(key) {
        return String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    /** 放弃当前这次模型请求（界面上的「放弃等待」按钮调）。没在等就什么也不做 */
    function abortPendingRequest() {
        const p = S.pendingRequest;
        if (!p) return false;
        S.pendingRequest = null;
        try { if (p.controller) p.controller.abort(); } catch (e) { /* 老浏览器没有 abort，忽略 */ }
        p.giveUp();
        return true;
    }

    // 同一时刻只允许一条待确认；新的请求直接把旧的判为取消
    let pendingConfirm = S.pendingConfirm; // 引用指向 S，值统一存 S

    /** 收起确认条。ok 为真表示点了确定，否则按取消处理 */
    function settleConfirm(ok) {
        const p = S.pendingConfirm;
        if (!p) return;
        S.pendingConfirm = null;
        const bar = S.panelEl && S.panelEl.querySelector('#eo_confirmbar');
        if (bar) bar.classList.toggle('eo-confirmbar-open', false);
        document.removeEventListener('keydown', p.onKey, true);
        p.resolve(!!ok);
    }

    /**
     * 面板内确认条，返回 Promise<boolean>。
     * 以前用原生 confirm：手机上阻塞整个页面、样式与面板脱节、长文案会被截断。
     * 现在挂在面板标题栏下方，不阻塞渲染，Enter 确认、Esc 取消。
     */
    function askConfirm(text, opt) {
        const o = opt || {};
        if (S.pendingConfirm) settleConfirm(false);
        const p = ensurePanel();
        const bar = p.querySelector('#eo_confirmbar');
        const txt = p.querySelector('#eo_confirm_text');
        const okBtn = p.querySelector('#eo_confirm_ok');
        const cancelBtn = p.querySelector('#eo_confirm_cancel');
        if (!bar || !txt || !okBtn || !cancelBtn) return Promise.resolve(false);

        txt.textContent = String(text || '确定继续？');
        okBtn.textContent = o.okText || '确定';
        cancelBtn.textContent = o.cancelText || '取消';
        okBtn.className = 'eo-btn ' + (o.danger === false ? 'eo-primary' : 'eo-btn-danger');

        return new Promise((resolve) => {
            const onKey = (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); settleConfirm(true); }
                else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); settleConfirm(false); }
            };
            okBtn.onclick = () => settleConfirm(true);
            cancelBtn.onclick = () => settleConfirm(false);
            S.pendingConfirm = { resolve, onKey };
            // 用捕获阶段拦，避免面板里其他 keydown 监听先吃掉 Esc
            document.addEventListener('keydown', onKey, true);
            bar.classList.add('eo-confirmbar-open');
            // 让用户一眼看到这次要确认什么，不用自己往上翻
            if (bar.scrollIntoView) {
                try { bar.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
            }
            okBtn.focus({ preventScroll: true });
        });
    }

    /** 右下角轻提示，替代原生 alert。bad 为真时红色、停留更久 */
    function toast(msg, opt) {
        const o = opt || {};
        const p = ensurePanel();
        const box = p.querySelector('#eo_toasts');
        if (!box) return;
        const t = el('div', 'eo-toast' + (o.bad ? ' eo-toast-bad' : ''), String(msg || ''));
        box.appendChild(t);
        // 超过 4 条时挤掉最早的，避免堆满屏幕
        while (box.children.length > 4) box.removeChild(box.firstChild);
        requestAnimationFrame(() => t.classList.add('eo-toast-in'));
        // 提示可以指定显示时长（比如首次说明要让人看完），没给就按级别取默认
        const ms = o.ms || (o.bad ? 6000 : 3000);
        setTimeout(() => {
            t.classList.remove('eo-toast-in');
            setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
        }, ms);
    }

