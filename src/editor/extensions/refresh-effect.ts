import { StateEffect } from "@codemirror/state";

/**
 * 强制通知所有 Decoration / StateField 即刻重新计算（用于源码模式无感即时切换）
 */
export const forceRefreshEffect = StateEffect.define<boolean>();
