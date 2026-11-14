/* 事件大纲 / 状态盘点 扩展
 * 单文件，按分区组织。无构建步骤，不使用 import。
 * 分区按实际顺序编号，连续无跳号（check-source 会校验）：
 *   0 常量   1 状态   2 上下文   3 存储   4 世界书   5 记忆适配器
 *   6 表单 helper   7 OOC 词与偏好   8 上下文拼装   9 生成与解析   10 事件流程
 *   11 界面   12 设置入口   13 入口
 */
(function () {
    'use strict';

    const MODULE = 'event_outline';
    const VERSION = '0.1.8';
    const ENTRY_PREFIX = '▸事件｜';
    // 待选事件最多留几个：生成不再直接写世界书，草稿得有个上限。
    // 2026-11-10 危晓定：改成可配置，默认 5。上限放在设置页「待选上限」里。
    // 这里只留默认值与合法区间，实际取值走 draftCap()。
    const MAX_DRAFTS_DEFAULT = 5;
    // 链单独计数（2026-11-09 危晓定）。一条链不管几个节点都只算 1 条，
    // 不和单事件抢名额，否则 4 节点链会把别的待选全挤掉。
    // 2026-11-10 起同样可配置，默认 5，两条各算各的。
    const MAX_CHAIN_DRAFTS_DEFAULT = 5;
    // 上限的合法区间：0 会让生成完立刻被自己挤掉，所以最小 1；上限太高没必要，封顶 20
    const DRAFT_CAP_MIN = 1;
    const DRAFT_CAP_MAX = 20;
    const LOG_PREFIX = '[事件大纲]';
    // 换行符常量：正则里的字面换行在编辑路径里容易被吃掉，统一走这个
    const NL = String.fromCharCode(10);

