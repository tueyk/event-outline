    // ==================== 13. 入口 ====================

    function init() {
        const context = ctx();
        if (!context) {
            warn('未取到上下文，扩展未初始化');
            return;
        }
        // M6.2：先把 spec 表自检跑一遍。写错 spec 不该让扩展起不来，
        // 但必须在日志里留痕，免得等到某个类型生成出怪大纲才回头找。
        selfCheckSpecMeta();
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
                healEntryUids().catch(e => warn('校正条目位置失败', e));
                if (S.panelEl && S.panelEl.classList.contains('eo-open')) renderPanel();
            });
        } catch (e) {
            warn('事件绑定失败', e);
        }

        // 每次 AI 回复落地（玩家楼 + AI 楼各算一层）就检查一次自动盘点
        try {
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
                scheduleAutoInventoryCheck();
                // shujuku 把表格写进楼里的时机比 MESSAGE_RECEIVED 晚，
                // 立刻重绘会读到还没有表格的楼层，导致记忆来源判定成「最近楼层」。
                // 延后再绘一次，让判定跑在数据落盘之后
                setTimeout(() => {
                    S.lastAdapterSig = null;  // 强制重判，否则去重会跳过这次变化
                    if (S.panelEl && S.panelEl.classList.contains('eo-open')) renderPanel();
                }, 1500);
            });
            context.eventSource.on(context.eventTypes.GENERATION_ENDED, () => {
                scheduleAutoInventoryCheck();
            });
        } catch (e) {
            warn('自动盘点事件绑定失败', e);
        }
    }

    // 自动盘点：消息事件触发后延迟检查，避免和酒馆自身的渲染抢时序
    let autoCheckTimer = S.autoCheckTimer; // 引用指向 S，值统一存 S
    let autoRunning = S.autoRunning; // 引用指向 S，值统一存 S

    function scheduleAutoInventoryCheck() {
        if (S.autoCheckTimer) clearTimeout(S.autoCheckTimer);
        S.autoCheckTimer = setTimeout(() => {
            S.autoCheckTimer = null;
            checkAutoInventory().catch(e => warn('自动盘点检查失败', e));
        }, 1200);
    }

    async function checkAutoInventory() {
        if (S.autoRunning) return;
        const hit = shouldAutoInventory();
        if (!hit) return;
        S.autoRunning = true;
        try {
            log(`自动盘点触发：距上次盘点已过 ${hit.since} 层（阈值 ${hit.every} 层）`);
            await runInventory();
            log('自动盘点完成');
            if (S.panelEl && S.panelEl.classList.contains('eo-open')) renderPanel();
        } catch (e) {
            error('自动盘点失败：' + (e && e.message || e));
        } finally {
            S.autoRunning = false;
        }
    }

    // 暴露少量调试接口
    window.EventOutline = {
        version: VERSION,
        getSettings,
        resolveAdapter,
        detectShujukuMode,
        listEventEntries,
        findEventEntryUid,
        commentMatchesEvent,
        getCharacterBookName,
        collectSheetsFromChat,
        // 2026-11-10 排障入口（只读，不改任何东西）：
        // __debugState()      看忙碌、待选、进度这些运行状态；
        // __chainPrompt(pos)  打印第 pos 个节点最终发出去的提示词全文，
        //                     用来核对用户填的额外要求 / 目的 / 框架提示是不是各只出现一次。
        __debugState: () => {
            const d = S.chainDraft || null;
            return {
                busy: S.busy,
                busyText: S.busyText,
                pendingRequest: !!S.pendingRequest,
                activeTab: S.activeTab,
                progressSteps: (S.progress && S.progress.steps || []).length,
                hasChainDraft: !!(d && d.chain),
                chainName: (d && d.chain && d.chain.chain_name) || '',
                chainNodes: (d && d.chain && Array.isArray(d.chain.nodes)) ? d.chain.nodes.length : 0,
                nodePrefs: (S.draftPrefs && Array.isArray(S.draftPrefs.__chainNodePrefs))
                    ? S.draftPrefs.__chainNodePrefs.length : 0,
            };
        },
        __chainPrompt: (pos) => {
            const d = S.chainDraft;
            if (!d || !d.chain || !Array.isArray(d.chain.nodes) || !d.chain.nodes.length) {
                return '（当前没有正在编辑的事件链骨架，先在链页生成一条）';
            }
            const n = parseInt(pos, 10) || 1;
            const prefs = S.draftPrefs || {};
            try {
                return buildChainNodePrompt(d.chain, n, prefs, '', '', null);
            } catch (e) {
                return '（生成提示词出错：' + (e && e.message || e) + '）';
            }
        },
    };
    init();
