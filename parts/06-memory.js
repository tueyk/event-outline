    // ==================== 5. 记忆适配器 ====================

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
                                // 楼层是从新到旧遍历的，第一次遇到即最新快照；
                                // 后面更旧的楼层会带同一张表的旧版本，不能覆盖
                                if (!result.has(op.sheetKey)) result.set(op.sheetKey, op.sheet);
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
        if (!Array.isArray(content) || content.length < 2) {
            debug('纪要表解析：没有表数据或只有表头，跳过');
            return [];
        }
        const header = content[0].map(x => String(x || '').trim());
        const idx = name => header.findIndex(h => h.includes(name));
        const iCode = idx('编码');
        const iSpan = idx('时间跨度');
        const iSum = idx('概览');
        const iText = idx('纪要');

        // 表头认不出来是严重问题：字段会按错误的列取，纪要内容会串行
        if (iCode < 0) {
            error(`纪要表表头里找不到「编码」列，当前表头：${header.join('｜') || '（空）'}。`
                + '列会按位置兜底取，纪要内容可能取错列');
        }
        const missingCols = [];
        if (iSpan < 0) missingCols.push('时间跨度');
        if (iSum < 0) missingCols.push('概览');
        if (iText < 0) missingCols.push('纪要');
        if (missingCols.length) {
            warn(`纪要表缺少列：${missingCols.join('、')}，这些字段会按位置兜底取。表头：${header.join('｜')}`);
        }

        const rows = [];
        let skipped = 0;
        for (let i = 1; i < content.length; i++) {
            const r = content[i];
            if (!Array.isArray(r)) { skipped++; continue; }
            const code = String(r[iCode >= 0 ? iCode : 1] || '').trim();
            if (!code) { skipped++; continue; }
            rows.push({
                code,
                span: String(r[iSpan >= 0 ? iSpan : 2] || '').trim(),
                summary: String(r[iSum >= 0 ? iSum : 3] || '').trim(),
                text: String(r[iText >= 0 ? iText : 4] || '').trim(),
            });
        }
        const emptyText = rows.filter(r => !r.text).length;
        if (emptyText) {
            warn(`纪要表有 ${emptyText} 条记录的「纪要」列是空的，这些条目对生成没有参考价值`);
        }
        debug(`纪要表解析：共 ${content.length - 1} 行数据，采用 ${rows.length} 条，跳过 ${skipped} 行（无编码或不是数组）`);
        return rows;
    }

    /**
     * 读 shujuku 当前填表模式。
     * 实测路径（shujuku 1.3）：
     *   chat_metadata.TavernDB_ACU_ScopedConfig.fillModeByIsolationKey[隔离码].mode
     * 隔离码在未启用数据隔离时是空字符串。
     * 读不到返回 null，由调用方显示「模式未识别」。
     */
    function detectShujukuMode() {
        const context = ctx();
        const meta = (context && context.chatMetadata) || {};
        const scoped = meta.TavernDB_ACU_ScopedConfig;
        if (!scoped || typeof scoped !== 'object') return null;

        const byKey = scoped.fillModeByIsolationKey;
        if (!byKey || typeof byKey !== 'object') return null;

        // 优先空隔离码，否则取记录时间最新的一条
        const empty = byKey[''];
        if (empty && typeof empty === 'object' && empty.mode) return String(empty.mode);

        let best = null;
        for (const rec of Object.values(byKey)) {
            if (!rec || typeof rec !== 'object' || !rec.mode) continue;
            if (!best || (Number(rec.recordedAt) || 0) > (Number(best.recordedAt) || 0)) best = rec;
        }
        return best ? String(best.mode) : null;
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

    /** 分步诊断 shujuku 接入状态，供设置页显示 */
    function diagnoseShujuku() {
        const out = [];
        const mode = detectShujukuMode();
        out.push(mode ? `模式：${MODE_LABEL[mode] || mode}` : '模式：未识别（ScopedConfig 里没有记录）');

        const sheets = collectSheetsFromChat();
        out.push(`从楼层扫到表格：${sheets.size} 张${sheets.size ? '（' + Array.from(sheets.keys()).slice(0, 6).join('、') + '）' : ''}`);

        const sheet = findChronicleSheet(sheets);
        if (!sheet) {
            out.push('纪要表：未找到（按 name「纪要表」和 key sheet_ji_yao_biao 都没匹配到）');
            return out;
        }
        out.push(`纪要表：已找到（key 匹配，${(sheet.content || []).length} 行）`);
        const rows = parseChronicle(sheet);
        out.push(`解析出纪要：${rows.length} 条${rows.length ? '（' + rows[0].code + ' … ' + rows[rows.length - 1].code + '）' : ''}`);
        if (!rows.length && sheet.content && sheet.content.length >= 1) {
            out.push('表头：' + (sheet.content[0] || []).join(' | '));
        }
        return out;
    }

    // 上次判定结果，用于去重：设置页每渲染一次都会探测一次，
    // 结果没变就不该再记一条日志
    let lastAdapterSig = S.lastAdapterSig; // 引用指向 S，值统一存 S

    function resolveAdapter() {
        const s = getSettings();
        const wanted = s.memory.source || 'auto';
        const decided = (() => {
            if (wanted !== 'auto') {
                const a = ADAPTERS.find(x => x.id === wanted);
                if (a && a.detect()) return { adapter: a, degraded: false };
                const fallback = ADAPTERS.find(x => x.id === 'recent-floors');
                return { adapter: fallback, degraded: true, wanted };
            }
            const hits = ADAPTERS.filter(a => a.detect()).sort((x, y) => x.priority - y.priority);
            const picked = hits[0] || ADAPTERS[ADAPTERS.length - 1];
            // shujuku 有数据却选不到时，多半是时序问题：表格写在 AI 回复楼里，
            // 那一轮回复还没落盘就读，自然扫不到。把这点说出来，免得以为是配置错了
            const shujuku = ADAPTERS.find(a => a.id === 'shujuku-jiyao');
            if (picked.id !== 'shujuku-jiyao' && shujuku && !hits.some(a => a.id === 'shujuku-jiyao')) {
                const sheets = collectSheetsFromChat();
                const hint = sheets.size
                    ? `扫到 ${sheets.size} 张表但没有纪要表可用`
                    : '当前楼层里没有任何 shujuku 表格数据';
                warn(`记忆来源：shujuku 纪要本次未检测到（${hint}），已退回最近楼层。`
                    + '如果主对话确实在用 shujuku，可能是那一轮 AI 回复还没把表格写进楼层，等回复完成或硬刷页面后重试');
            }
            return { adapter: picked, degraded: false };
        })();

        // 只有判定结果（适配器 + 是否降级 + 数据量描述）真的变了才记日志
        const sig = decided.adapter.id + '|' + (decided.degraded ? 'degraded' : 'ok') + '|' + decided.adapter.describe();
        if (sig !== S.lastAdapterSig) {
            S.lastAdapterSig = sig;
            if (decided.degraded) {
                warn(`记忆来源：设置要「${ADAPTERS.find(x => x.id === wanted)?.label || wanted}」但检测不到数据，已降级为「${decided.adapter.label}」（${decided.adapter.describe()}）`);
            } else if (wanted === 'auto') {
                log(`记忆来源：自动选择「${decided.adapter.label}」，${decided.adapter.describe()}`);
            } else {
                // 首次判定和之后切换来源、数据量变化都报，方便一进来就确认用的是什么
                log(`记忆来源：按设置使用「${decided.adapter.label}」，${decided.adapter.describe()}`);
            }
        }
        return decided;
    }

