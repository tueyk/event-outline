    // ==================== 1. 状态 ====================
    // 界面的可变状态只有这一个对象（评审 B2，2026-11-02 收口）。
    // 新增状态一律加在这里，别在文件各处分头 let——分头写过一次就散成十几处，
    // 重绘、切对话、重连之后哪一处忘了重置都查不出来。
    // 只放「会变」的状态；设置、解析出的常量不在这里。
    const S = {
        runtimeLog: [],
        unreadErrors: 0,
        writeChain: Promise.resolve(),
        lastAdapterSig: null,
        pendingRequest: null,
        pendingConfirm: null,
        draftPrefs: null,
        draftGroupModes: null,
        draftName: '',
        busy: false,
        // 2026-11-10 批 3 第 18 项：谁占着这个忙碌状态。
        // 原来只有一个布尔值，任何一条流程跑完都 setBusy(false)，把别人的锁一起放了；
        // 自动盘点和手动操作抢同一把锁时更糟：手动弹「正在盘点」时，
        // 自动盘点跑完一句 setBusy(false) 就把提示条收掉了，而手动那次还在跑。
        // 令牌记的是占用者标识（'gen' / 'inv' / 'inv-auto' / 'adopt' / 'close' …），
        // 只有持有者能解锁，别人要动就被告知「正在做另一件事」。
        busyOwner: null,
        busyText: '处理中…',
        busyText: '处理中…',
        panelEl: null,
        fabEl: null,
        backdropEl: null,
        fabState: { anchor: { x: 14, y: 40 }, dock: 'left' },
        activeTab: 'gen',
        editingDraftId: null,
        draftEditBuf: null,
        draftEditIssues: null,
        pendingDraftEditDirty: false,
        logFilter: 'all',
        logKeyword: '',
    logAtBottom: true,
        autoCheckTimer: null,
        autoRunning: false,
        progress: { steps: [], startedAt: 0, timer: null },
        previewDraftIds: new Set(),
        // 和 previewDraftIds 分开：看原文不必连大纲一起展开（2026-11-04）
        previewRawDraftIds: new Set(),
        // 当前事件的「事件大纲」「模型原始输出」两块由按钮控制显示还是收起（2026-11-04 危晓要求）。
        // 和待选事件一样做成开关，而不是只能靠折叠块自己点：以前原始输出藏在事件大纲下面，
        // 想单独看原文也得先把大纲点开。默认都收着，避免一进生成页就是几百行。
        currentShowOutline: false,
        currentShowRaw: false,
    };

