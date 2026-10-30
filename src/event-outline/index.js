/* 事件大纲 / 状态盘点 扩展
 * 单文件，按分区组织。无构建步骤，不使用 import。
 * 分区：0 常量 1 上下文 2 存储 3 世界书 4 适配器 5 界面 6 设置 7 入口
 */
(function () {
    'use strict';

    const MODULE = 'event_outline';
    const VERSION = '0.1.0';
    const ENTRY_PREFIX = '▸事件｜';
    const LOG_PREFIX = '[事件大纲]';

    // ==================== 0. 常量 ====================

    const DEFAULT_SETTINGS = {
        version: 1,
        apiProfiles: [
            { id: 'main', name: '跟随酒馆主连接', mode: 'main' },
        ],
        activeProfileId: 'main',
        ui: {
            floatingEnabled: true,
            floatingPos: { side: 'left', top: 40, collapsed: true },
        },
        tracker: { mode: 'auto' },
        retention: { completed: 20, abandoned: 3 },
        memory: {
            source: 'auto',
            recentFloors: 15,
            jiyaoOverviewMax: 60,
            jiyaoRecentRows: 30,
        },
    };

    const TRACKER_MODES = {
        auto: '自动',
        semi: '半自动',
        manual: '手动',
    };

    const MEMORY_SOURCES = {
        auto: '自动选择（推荐）',
        'shujuku-jiyao': 'shujuku 纪要',
        'recent-floors': '仅最近楼层',
    };

    const SHUJUKU_EXPORT_PREFIX = 'TavernDB-ACU-CustomExport-';
    const CHRONICLE_NAME = '纪要表';

    // ==================== 1. 上下文 ====================

    function ctx() {
        return window.SillyTavern && window.SillyTavern.getContext
            ? window.SillyTavern.getContext()
            : null;
    }

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    // ==================== 2. 存储 ====================

    function getSettings() {
        const context = ctx();
        if (!context) return structuredClone(DEFAULT_SETTINGS);
        if (!context.extensionSettings[MODULE]) {
            context.extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
        }
        const s = context.extensionSettings[MODULE];
        // 补默认值（升级时新字段缺失）
        s.apiProfiles = s.apiProfiles || structuredClone(DEFAULT_SETTINGS.apiProfiles);
        s.ui = Object.assign(structuredClone(DEFAULT_SETTINGS.ui), s.ui || {});
        s.tracker = Object.assign({}, DEFAULT_SETTINGS.tracker, s.tracker || {});
        s.retention = Object.assign({}, DEFAULT_SETTINGS.retention, s.retention || {});
        s.memory = Object.assign({}, DEFAULT_SETTINGS.memory, s.memory || {});
        return s;
    }

    function saveSettings() {
        const context = ctx();
        if (context && context.saveSettingsDebounced) context.saveSettingsDebounced();
    }

    function getMeta() {
        const context = ctx();
        if (!context) return null;
        if (!context.chatMetadata[MODULE]) {
            context.chatMetadata[MODULE] = { version: 1, currentEventId: null, events: {}, snapshots: {} };
        }
        const m = context.chatMetadata[MODULE];
        m.events = m.events || {};
        m.snapshots = m.snapshots || {};
        return m;
    }

    function saveMeta() {
        const context = ctx();
        if (context && context.saveMetadataDebounced) context.saveMetadataDebounced();
    }

    function listEvents() {
        const m = getMeta();
        if (!m) return [];
        return Object.values(m.events).sort((a, b) =>
            String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    function getCurrentEvent() {
        const m = getMeta();
        if (!m || !m.currentEventId) return null;
        return m.events[m.currentEventId] || null;
    }

    // ==================== 3. 世界书 ====================

    let writeChain = Promise.resolve();

    function withWriteLock(fn) {
        const run = writeChain.then(fn, fn);
        writeChain = run.catch(() => { });
        return run;
    }

    function headers() {
        const context = ctx();
        return context && context.getRequestHeaders ? context.getRequestHeaders() : {};
    }

    async function readWorldBook(name) {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`读取世界书失败 HTTP ${res.status}`);
        return await res.json();
    }

    async function writeWorldBook(name, data) {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ name, data }),
        });
        if (!res.ok) throw new Error(`写入世界书失败 HTTP ${res.status}`);
        return await res.json();
    }

    /** 简易稳定哈希，用于内容比对 */
    function hashString(str) {
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = (h1 ^ c) * 0x01000193 >>> 0;
            h2 = (h2 + c * (i + 1)) >>> 0;
        }
        return h1.toString(16) + '-' + h2.toString(16) + '-' + str.length;
    }

    function entryFingerprint(entry) {
        return hashString([
            String(entry.content || ''),
            String(entry.comment || ''),
            entry.constant ? 1 : 0,
            entry.disable ? 1 : 0,
            Array.isArray(entry.key) ? entry.key.join('|') : '',
        ].join('\u0000'));
    }

    /** 该条目是否由 shujuku 动态维护（它会每轮增删，不能纳入比对） */
    function isForeignManagedEntry(entry) {
        return String(entry && entry.comment || '').startsWith(SHUJUKU_EXPORT_PREFIX);
    }

    /**
     * 快照我们需要保护的外部条目。
     * 排除两类：
     *   1. 本扩展自己的 ▸事件｜ 条目
     *   2. shujuku 动态维护的 TavernDB-ACU-CustomExport- 条目
     * 剩下的是用户手写的设定，这些必须逐字节不变。
     */
    function snapshotForeignEntries(data) {
        const map = new Map();
        const entries = (data && data.entries) || {};
        for (const [uid, entry] of Object.entries(entries)) {
            const comment = String(entry && entry.comment || '');
            if (comment.startsWith(ENTRY_PREFIX)) continue;
            if (isForeignManagedEntry(entry)) continue;
            map.set(String(uid), entryFingerprint(entry));
        }
        return map;
    }

    function verifyForeignEntriesUnchanged(before, afterData) {
        const after = snapshotForeignEntries(afterData);
        const problems = [];
        for (const [uid, hash] of before) {
            if (!after.has(uid)) {
                problems.push(`uid=${uid} 消失`);
            } else if (after.get(uid) !== hash) {
                problems.push(`uid=${uid} 内容变化`);
            }
        }
        return problems.length ? { ok: false, reason: problems.slice(0, 3).join('；') } : { ok: true };
    }

    /** 找下一个可用 uid */
    function nextUid(data) {
        let max = -1;
        for (const uid of Object.keys(data.entries || {})) {
            const n = Number(uid);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    function buildEntry(uid, content, comment) {
        return {
            uid,
            key: [],
            keysecondary: [],
            comment,
            content,
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            displayIndex: uid,
        };
    }

    /**
     * 写入或更新事件条目。返回 {uid, snapshotKey}
     * 只在 entries 里新增/更新 ▸事件｜ 前缀条目，其余严格不动。
     */
    async function upsertEventEntry(bookName, content, comment, existingUid) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');

            // 写前快照
            const meta = getMeta();
            const snapshotKey = 'ts' + Date.now();
            if (meta) {
                meta.snapshots[snapshotKey] = { worldBook: bookName, at: new Date().toISOString() };
                try {
                    sessionStorage.setItem(
                        `${MODULE}_snapshot_${snapshotKey}`,
                        JSON.stringify(data),
                    );
                } catch (e) {
                    warn('快照过大，未能保存到 sessionStorage', e);
                }
            }

            const foreignBefore = snapshotForeignEntries(data);
            let uid = existingUid;

            if (uid != null && data.entries[uid] &&
                String(data.entries[uid].comment || '').startsWith(ENTRY_PREFIX)) {
                data.entries[uid].content = content;
                data.entries[uid].comment = comment;
                data.entries[uid].constant = true;
            } else {
                uid = nextUid(data);
                data.entries[uid] = buildEntry(uid, content, comment);
            }

            await writeWorldBook(bookName, data);

            // 回读校验
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                throw new Error(`世界书写后校验失败：${check.reason}`);
            }
            if (!after.entries[uid] || String(after.entries[uid].content || '') !== String(content)) {
                throw new Error('世界书写后回读内容不一致');
            }

            return { uid, snapshotKey };
        });
    }

    async function deleteEventEntry(bookName, uid) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');
            const entry = data.entries[uid];
            if (!entry) return { deleted: false, reason: '条目不存在' };
            if (!String(entry.comment || '').startsWith(ENTRY_PREFIX)) {
                throw new Error('拒绝删除：该条目不是本扩展创建的');
            }
            const foreignBefore = snapshotForeignEntries(data);
            delete data.entries[uid];
            await writeWorldBook(bookName, data);
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) throw new Error(`删除后校验失败：${check.reason}`);
            return { deleted: true };
        });
    }

    /** 列出当前世界书里本扩展的条目 */
    async function listEventEntries(bookName) {
        const data = await readWorldBook(bookName);
        const out = [];
        for (const [uid, entry] of Object.entries((data && data.entries) || {})) {
            const comment = String(entry && entry.comment || '');
            if (comment.startsWith(ENTRY_PREFIX)) {
                out.push({ uid, comment, contentLength: String(entry.content || '').length });
            }
        }
        return out;
    }

    function getCharacterBookName() {
        const context = ctx();
        if (!context) return null;
        const chid = context.characterId;
        const chars = context.characters || [];
        if (chid == null || !chars[chid]) return null;
        const ext = (chars[chid].data && chars[chid].data.extensions) || {};
        return ext.world || null;
    }

    // ==================== 4. 记忆适配器 ====================

    const MODE_LABEL = {
        classic: '经典表格',
        vector: '向量表格',
        llm: 'LLM召回',
        crossfire: '交火',
    };

    /** 从楼层里收集 sheet 数据，返回 Map<sheetKey, sheet> */
    function collectSheetsFromChat() {
        const context = ctx();
        const chat = (context && context.chat) || [];
        const result = new Map();

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const iso = msg.TavernDB_ACU_IsolatedData;
            if (!iso || typeof iso !== 'object') continue;

            for (const key of Object.keys(iso)) {
                const container = iso[key];
                if (!container || typeof container !== 'object') continue;

                // v2: storageFrame.logEntries
                const entries = container.storageFrame && container.storageFrame.logEntries;
                if (Array.isArray(entries)) {
                    const sorted = entries.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
                    for (const e of sorted) {
                        for (const op of (e.operations || [])) {
                            if (op && op.sheetKey && op.sheet && op.sheet.content) {
                                result.set(op.sheetKey, op.sheet);
                            }
                        }
                    }
                }

                // legacy: independentData / 直接 sheet_
                const legacy = container.independentData || container;
                if (legacy && typeof legacy === 'object') {
                    for (const [k, v] of Object.entries(legacy)) {
                        if (k.startsWith('sheet_') && v && typeof v === 'object' && v.content) {
                            if (!result.has(k)) result.set(k, v);
                        }
                    }
                }

                // 老字段兜底：TavernDB_ACU_Data / SummaryData / IndependentData
                for (const legacyKey of ['TavernDB_ACU_IndependentData', 'TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData']) {
                    const box = msg[legacyKey];
                    if (box && typeof box === 'object') {
                        for (const [k, v] of Object.entries(box)) {
                            if (k.startsWith('sheet_') && v && typeof v === 'object' && v.content) {
                                if (!result.has(k)) result.set(k, v);
                            }
                        }
                    }
                }
            }
        }
        return result;
    }

    /** 按名字找纪要表（不按 key，见设计 §4.3） */
    function findChronicleSheet(sheets) {
        for (const sheet of sheets.values()) {
            if (sheet && sheet.name === CHRONICLE_NAME) return sheet;
        }
        // 退回 key 匹配
        for (const [k, sheet] of sheets.entries()) {
            if (k === 'sheet_ji_yao_biao') return sheet;
        }
        return null;
    }

    /** 解析纪要表二维数组 -> [{code, span, summary, text}] */
    function parseChronicle(sheet) {
        const content = sheet && sheet.content;
        if (!Array.isArray(content) || content.length < 2) return [];
        const header = content[0].map(x => String(x || '').trim());
        const idx = name => header.findIndex(h => h.includes(name));
        const iCode = idx('编码');
        const iSpan = idx('时间跨度');
        const iSum = idx('概览');
        const iText = idx('纪要');

        const rows = [];
        for (let i = 1; i < content.length; i++) {
            const r = content[i];
            if (!Array.isArray(r)) continue;
            const code = String(r[iCode >= 0 ? iCode : 1] || '').trim();
            if (!code) continue;
            rows.push({
                code,
                span: String(r[iSpan >= 0 ? iSpan : 2] || '').trim(),
                summary: String(r[iSum >= 0 ? iSum : 3] || '').trim(),
                text: String(r[iText >= 0 ? iText : 4] || '').trim(),
            });
        }
        return rows;
    }

    /** 读 shujuku 当前填表模式，读不到返回 null */
    function detectShujukuMode() {
        try {
            const g = window;
            if (typeof g.getCurrentFillMode === 'function') {
                const m = g.getCurrentFillMode();
                if (m) return String(m);
            }
        } catch (e) { /* 忽略 */ }
        try {
            const stored = window.localStorage.getItem('acu_fill_mode');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.selectedMode) return String(parsed.selectedMode);
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    function shujukuAdapter() {
        return {
            id: 'shujuku-jiyao',
            label: 'shujuku 纪要',
            detect() {
                const sheets = collectSheetsFromChat();
                const sheet = findChronicleSheet(sheets);
                const rows = parseChronicle(sheet);
                return rows.length > 0;
            },
            describe() {
                const sheets = collectSheetsFromChat();
                const sheet = findChronicleSheet(sheets);
                const rows = parseChronicle(sheet);
                if (!rows.length) return '未检测到纪要数据';
                const mode = detectShujukuMode();
                const modeText = mode ? (MODE_LABEL[mode] || mode) : '模式未识别';
                return `shujuku 纪要（${modeText}模式，${rows.length} 条可用）`;
            },
            rows() {
                return parseChronicle(findChronicleSheet(collectSheetsFromChat()));
            },
            mode() {
                return detectShujukuMode();
            },
        };
    }

    function floorsAdapter() {
        return {
            id: 'recent-floors',
            label: '仅最近楼层',
            detect() { return true; },
            describe() {
                const context = ctx();
                const n = ((context && context.chat) || []).length;
                return `仅最近楼层（共 ${n} 楼）`;
            },
        };
    }

    const ADAPTERS = [
        Object.assign(shujukuAdapter(), { priority: 1 }),
        Object.assign(floorsAdapter(), { priority: 99 }),
    ];

    function resolveAdapter() {
        const s = getSettings();
        const wanted = s.memory.source || 'auto';
        if (wanted !== 'auto') {
            const a = ADAPTERS.find(x => x.id === wanted);
            if (a && a.detect()) return { adapter: a, degraded: false };
            const fallback = ADAPTERS.find(x => x.id === 'recent-floors');
            return { adapter: fallback, degraded: true, wanted };
        }
        const hits = ADAPTERS.filter(a => a.detect()).sort((x, y) => x.priority - y.priority);
        return { adapter: hits[0] || ADAPTERS[ADAPTERS.length - 1], degraded: false };
    }

    // ==================== 5. 界面 ====================

    let panelEl = null;
    let fabEl = null;

    function injectStyle() {
        if (document.getElementById('eo_style')) return;
        const style = document.createElement('style');
        style.id = 'eo_style';
        style.textContent = `
#eo_fab{position:fixed;z-index:30000;display:flex;align-items:center;justify-content:center;
  width:44px;height:44px;border-radius:12px;cursor:pointer;user-select:none;
  background:linear-gradient(160deg,#fff3d6,#f5d080);border:1px solid rgba(184,134,11,.55);
  box-shadow:0 2px 10px rgba(0,0,0,.25);color:#5a3e0b;font-size:15px;font-weight:700;
  transition:width .18s ease,height .18s ease,left .18s ease,right .18s ease;}
#eo_fab.eo-collapsed{width:8px;height:56px;border-radius:0 6px 6px 0;font-size:0;overflow:hidden;}
#eo_fab.eo-collapsed.eo-right{border-radius:6px 0 0 6px;}
#eo_panel{position:fixed;z-index:30001;display:none;flex-direction:column;
  width:min(92vw,520px);max-height:76vh;background:#fffdf7;
  border:1px solid rgba(184,134,11,.55);border-radius:14px;
  box-shadow:0 10px 34px rgba(0,0,0,.32);overflow:hidden;
  font-size:13px;color:#3c2f14;}
#eo_panel.eo-open{display:flex;}
.eo-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
  background:linear-gradient(160deg,#fff3d6,#f5d080);border-bottom:1px solid rgba(184,134,11,.4);}
.eo-title{font-weight:700;flex:1;}
.eo-close{cursor:pointer;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.55);}
.eo-close:hover{background:rgba(255,255,255,.85);}
.eo-body{padding:12px;overflow:auto;flex:1;}
.eo-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}
.eo-row>label{min-width:78px;color:#6b5424;}
.eo-btn{padding:5px 12px;border-radius:8px;border:1px solid rgba(184,134,11,.5);
  background:#fff8e6;cursor:pointer;color:#5a3e0b;font-size:13px;}
.eo-btn:hover{background:#fdeec4;}
.eo-btn:disabled{opacity:.5;cursor:not-allowed;}
.eo-btn.eo-primary{background:#f0c464;border-color:#b8860b;font-weight:600;}
.eo-box{border:1px solid rgba(184,134,11,.32);border-radius:9px;padding:9px 10px;
  background:#fffaf0;margin-bottom:9px;white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow:auto;line-height:1.55;}
.eo-hint{color:#8a7333;font-size:12px;line-height:1.5;}
.eo-warn{color:#a35c00;background:#fff3d6;border:1px solid #e6c37a;
  border-radius:8px;padding:7px 9px;margin-bottom:9px;font-size:12px;}
.eo-ok{color:#2c6e2c;}
.eo-bad{color:#a11;font-size:12px;}
select.eo-sel{padding:4px 8px;border-radius:7px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:#3c2f14;font-size:13px;}
.eo-sec{border-top:1px dashed rgba(184,134,11,.35);margin:10px 0 6px;padding-top:8px;
  font-weight:600;color:#6b5424;}
`;
        document.head.appendChild(style);
    }

    function ensureFab() {
        const s = getSettings();
        if (!s.ui.floatingEnabled) {
            if (fabEl) { fabEl.remove(); fabEl = null; }
            return;
        }
        if (fabEl) return;

        fabEl = document.createElement('div');
        fabEl.id = 'eo_fab';
        fabEl.textContent = '事件';
        fabEl.title = '事件大纲';
        document.body.appendChild(fabEl);

        applyFabPos(s.ui.floatingPos);
        makeDraggable(fabEl, s, (pos) => {
            s.ui.floatingPos = pos;
            saveSettings();
            applyFabPos(pos);
        });

        fabEl.addEventListener('click', (e) => {
            if (fabEl.dataset.dragged === '1') { fabEl.dataset.dragged = '0'; return; }
            if (fabEl.classList.contains('eo-collapsed')) {
                s.ui.floatingPos.collapsed = false;
                saveSettings();
                applyFabPos(s.ui.floatingPos);
                return;
            }
            togglePanel();
        });
        fabEl.addEventListener('mouseenter', () => {
            if (fabEl.classList.contains('eo-collapsed')) {
                fabEl.classList.remove('eo-collapsed');
            }
        });
        fabEl.addEventListener('mouseleave', () => {
            const cur = getSettings().ui.floatingPos;
            if (cur.collapsed) fabEl.classList.add('eo-collapsed');
        });
    }

    function applyFabPos(pos) {
        if (!fabEl) return;
        const p = pos || { side: 'left', top: 40, collapsed: true };
        const top = Math.max(0, Math.min(p.top || 40, window.innerHeight - 60));
        fabEl.classList.toggle('eo-collapsed', !!p.collapsed);
        fabEl.classList.toggle('eo-right', p.side === 'right');
        if (p.side === 'right') {
            fabEl.style.right = p.collapsed ? '0px' : '14px';
            fabEl.style.left = 'auto';
        } else {
            fabEl.style.left = p.collapsed ? '0px' : '14px';
            fabEl.style.right = 'auto';
        }
        fabEl.style.top = top + 'px';
    }

    function makeDraggable(el, settings, onDone) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        const onDown = (ev) => {
            const p = ev.touches ? ev.touches[0] : ev;
            dragging = true;
            el.dataset.dragged = '0';
            const rect = el.getBoundingClientRect();
            startX = p.clientX;
            startY = p.clientY;
            originLeft = rect.left;
            originTop = rect.top;
        };

        const onMove = (ev) => {
            if (!dragging) return;
            const p = ev.touches ? ev.touches[0] : ev;
            const dx = p.clientX - startX;
            const dy = p.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) el.dataset.dragged = '1';
            el.style.left = (originLeft + dx) + 'px';
            el.style.right = 'auto';
            el.style.top = (originTop + dy) + 'px';
            if (ev.cancelable) ev.preventDefault();
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            const rect = el.getBoundingClientRect();
            const threshold = 40;
            let side = 'left';
            let collapsed = false;
            if (rect.left < threshold) {
                side = 'left'; collapsed = true;
            } else if (window.innerWidth - rect.right < threshold) {
                side = 'right'; collapsed = true;
            }
            onDone({ side, top: Math.round(rect.top), collapsed });
        };

        el.addEventListener('mousedown', onDown);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        el.addEventListener('touchstart', onDown, { passive: true });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    function ensurePanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        panelEl.id = 'eo_panel';
        panelEl.innerHTML = `
<div class="eo-head">
  <span class="eo-title">事件大纲</span>
  <span class="eo-hint" id="eo_ver">v${VERSION}</span>
  <span class="eo-close" id="eo_close">✕</span>
</div>
<div class="eo-body" id="eo_body"></div>`;
        document.body.appendChild(panelEl);
        panelEl.querySelector('#eo_close').addEventListener('click', () => togglePanel(false));
        return panelEl;
    }

    function togglePanel(force) {
        const p = ensurePanel();
        const open = force === undefined ? !p.classList.contains('eo-open') : force;
        p.classList.toggle('eo-open', open);
        if (open) renderPanel();
    }

    function el(tag, cls, text) {
        const d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text !== undefined) d.textContent = text;
        return d;
    }

    function renderPanel() {
        const body = panelEl && panelEl.querySelector('#eo_body');
        if (!body) return;
        body.innerHTML = '';

        const context = ctx();
        if (!context) {
            body.appendChild(el('div', 'eo-warn', '未取到酒馆上下文，扩展可能未正确加载。'));
            return;
        }

        // --- 环境信息 ---
        const envBox = el('div', 'eo-box');
        const ev = getCurrentEvent();
        const book = ev ? ev.worldBook : getCharacterBookName();
        envBox.textContent = [
            `聊天：${context.chatId || '（未打开）'}`,
            `角色：${(context.characters && context.characters[context.characterId] || {}).name || '（无）'}`,
            `世界书：${book || '（该角色未绑定）'}`,
            `事件：${ev ? `${ev.name}（${ev.status}）` : '（无进行中事件）'}`,
        ].join('\n');
        body.appendChild(envBox);

        // --- 记忆来源 ---
        body.appendChild(el('div', 'eo-sec', '记忆来源'));
        const memRow = el('div', 'eo-row');
        const memSel = el('select', 'eo-sel');
        for (const [k, label] of Object.entries(MEMORY_SOURCES)) {
            const o = el('option', null, label);
            o.value = k;
            memSel.appendChild(o);
        }
        memSel.value = getSettings().memory.source;
        memSel.addEventListener('change', () => {
            getSettings().memory.source = memSel.value;
            saveSettings();
            renderPanel();
        });
        memRow.appendChild(memSel);
        body.appendChild(memRow);

        const resolved = resolveAdapter();
        const memInfo = el('div', resolved.degraded ? 'eo-warn' : 'eo-hint');
        if (resolved.degraded) {
            memInfo.textContent = `已选「${MEMORY_SOURCES[resolved.wanted] || resolved.wanted}」`
                + `，但当前对话没有可用数据，已自动降级为：${resolved.adapter.describe()}`;
        } else {
            memInfo.textContent = `当前使用：${resolved.adapter.describe()}`;
        }
        body.appendChild(memInfo);

        // --- 世界书自检 ---
        body.appendChild(el('div', 'eo-sec', '世界书'));
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
                    `总条目：${total}`,
                    `本扩展条目：${mine.length}`,
                    `shujuku 导出条目：${foreignExport}`,
                    mine.length ? `明细：${mine.map(m => `${m.uid}(${m.contentLength}字)`).join('、')}` : '明细：无',
                ].join('\n');
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '读取失败：' + (e && e.message || e);
            } finally {
                btnCheck.disabled = false;
            }
        });
        bookRow.appendChild(btnCheck);
        body.appendChild(bookRow);
        body.appendChild(checkOut);

        // --- 写入自测 ---
        body.appendChild(el('div', 'eo-sec', '写入自测'));
        const testRow = el('div', 'eo-row');
        const btnTest = el('button', 'eo-btn', '写入测试条目');
        const btnClean = el('button', 'eo-btn', '删除测试条目');
        const testOut = el('div', 'eo-hint');
        const TEST_MARK = '测试条目（可删）';

        btnTest.addEventListener('click', async () => {
            btnTest.disabled = true;
            testOut.className = 'eo-hint';
            testOut.textContent = '写入中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const content = `〔事件大纲｜写入自测｜${new Date().toISOString()}〕\n这是一条测试条目，确认无损写入后请点删除。`;
                const r = await upsertEventEntry(
                    target,
                    content,
                    `${ENTRY_PREFIX}${TEST_MARK}`,
                    null,
                );
                testOut.className = 'eo-ok';
                testOut.textContent = `写入成功，uid=${r.uid}，快照=${r.snapshotKey}。其余条目内容校验通过。`;
            } catch (e) {
                testOut.className = 'eo-bad';
                testOut.textContent = '写入失败：' + (e && e.message || e);
            } finally {
                btnTest.disabled = false;
            }
        });

        btnClean.addEventListener('click', async () => {
            btnClean.disabled = true;
            testOut.className = 'eo-hint';
            testOut.textContent = '删除中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const data = await readWorldBook(target);
                const targets = Object.entries((data && data.entries) || {})
                    .filter(([, e]) => String(e && e.comment || '') === `${ENTRY_PREFIX}${TEST_MARK}`)
                    .map(([uid]) => uid);
                if (!targets.length) {
                    testOut.className = 'eo-hint';
                    testOut.textContent = '没有找到测试条目。';
                    return;
                }
                for (const uid of targets) await deleteEventEntry(target, uid);
                testOut.className = 'eo-ok';
                testOut.textContent = `已删除 ${targets.length} 条测试条目。`;
            } catch (e) {
                testOut.className = 'eo-bad';
                testOut.textContent = '删除失败：' + (e && e.message || e);
            } finally {
                btnClean.disabled = false;
            }
        });

        testRow.appendChild(btnTest);
        testRow.appendChild(btnClean);
        body.appendChild(testRow);
        body.appendChild(testOut);

        // --- 设置 ---
        body.appendChild(el('div', 'eo-sec', '设置'));

        const trackerRow = el('div', 'eo-row');
        trackerRow.appendChild(el('label', null, '打勾模式'));
        const trackerSel = el('select', 'eo-sel');
        for (const [k, label] of Object.entries(TRACKER_MODES)) {
            const o = el('option', null, label);
            o.value = k;
            trackerSel.appendChild(o);
        }
        trackerSel.value = getSettings().tracker.mode;
        trackerSel.addEventListener('change', () => {
            getSettings().tracker.mode = trackerSel.value;
            saveSettings();
        });
        trackerRow.appendChild(trackerSel);
        body.appendChild(trackerRow);

        const retRow = el('div', 'eo-row');
        retRow.appendChild(el('label', null, '保留数量'));
        const inDone = el('input');
        inDone.type = 'number';
        inDone.min = '1';
        inDone.max = '100';
        inDone.value = String(getSettings().retention.completed);
        inDone.style.width = '62px';
        inDone.addEventListener('change', () => {
            const v = Math.max(1, Math.min(100, Number(inDone.value) || 20));
            inDone.value = String(v);
            getSettings().retention.completed = v;
            saveSettings();
        });
        retRow.appendChild(el('span', 'eo-hint', '完结'));
        retRow.appendChild(inDone);

        const inAban = el('input');
        inAban.type = 'number';
        inAban.min = '1';
        inAban.max = '50';
        inAban.value = String(getSettings().retention.abandoned);
        inAban.style.width = '62px';
        inAban.addEventListener('change', () => {
            const v = Math.max(1, Math.min(50, Number(inAban.value) || 3));
            inAban.value = String(v);
            getSettings().retention.abandoned = v;
            saveSettings();
        });
        retRow.appendChild(el('span', 'eo-hint', '废弃'));
        retRow.appendChild(inAban);
        body.appendChild(retRow);

        const fabRow = el('div', 'eo-row');
        fabRow.appendChild(el('label', null, '悬浮窗'));
        const fabChk = el('input');
        fabChk.type = 'checkbox';
        fabChk.checked = !!getSettings().ui.floatingEnabled;
        fabChk.addEventListener('change', () => {
            getSettings().ui.floatingEnabled = fabChk.checked;
            saveSettings();
            ensureFab();
        });
        fabRow.appendChild(fabChk);
        fabRow.appendChild(el('span', 'eo-hint', '关闭后仍可从扩展菜单打开'));
        body.appendChild(fabRow);

        // --- 事件列表 ---
        body.appendChild(el('div', 'eo-sec', '事件（本聊天）'));
        const events = listEvents();
        if (!events.length) {
            body.appendChild(el('div', 'eo-hint', '暂无事件。生成逻辑将在下一版加入。'));
        } else {
            const listBox = el('div', 'eo-box');
            listBox.textContent = events.map(e =>
                `${e.status === 'active' ? '●' : '○'} ${e.name}｜${e.status}｜${String(e.createdAt || '').slice(0, 19)}`
            ).join('\n');
            body.appendChild(listBox);
        }

        const foot = el('div', 'eo-hint', `扩展 v${VERSION}｜按 F12 看日志前缀 ${LOG_PREFIX}`);
        foot.style.marginTop = '10px';
        body.appendChild(foot);
    }

    // ==================== 6. 设置面板入口 ====================

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('eo_menu_item')) return;
        const item = document.createElement('div');
        item.id = 'eo_menu_item';
        item.className = 'extension_container interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" tabindex="0">'
            + '<div class="fa-solid fa-list-check extensionsMenuExtensionButton"></div>'
            + '<span>事件大纲</span></div>';
        item.addEventListener('click', () => togglePanel(true));
        menu.appendChild(item);
    }

    // ==================== 7. 入口 ====================

    function init() {
        const context = ctx();
        if (!context) {
            warn('未取到上下文，扩展未初始化');
            return;
        }
        getSettings();
        injectStyle();

        const start = () => {
            ensureFab();
            ensurePanel();
            addMenuButton();
            log(`v${VERSION} 已加载`);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }

        // 菜单按钮可能晚于本扩展渲染
        const timer = setInterval(() => {
            addMenuButton();
            if (document.getElementById('eo_menu_item')) clearInterval(timer);
        }, 1500);
        setTimeout(() => clearInterval(timer), 30000);

        try {
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
                if (panelEl && panelEl.classList.contains('eo-open')) renderPanel();
            });
        } catch (e) {
            warn('事件绑定失败', e);
        }
    }

    // 暴露少量调试接口
    window.EventOutline = {
        version: VERSION,
        getSettings,
        resolveAdapter,
        detectShujukuMode,
        listEventEntries,
        getCharacterBookName,
        collectSheetsFromChat,
    };

    init();
})();
