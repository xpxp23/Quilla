import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ---------- 墨观 · 共享结构层 ---------- */
import inkstoneCore from "./inkstone/core.css?raw";
/* ---------- 墨观 · 六个变体 ---------- */
import xuanmoCss from "./inkstone/xuanmo.css?raw";
import xuanmoDimCss from "./inkstone/xuanmo-dim.css?raw";
import xuanzhiCss from "./inkstone/xuanzhi.css?raw";
import xuanzhiDimCss from "./inkstone/xuanzhi-dim.css?raw";
import canghaiCss from "./inkstone/canghai.css?raw";
import qingciCss from "./inkstone/qingci.css?raw";
/* ---------- 经典系列 ---------- */
import githubCss from "./github.css?raw";
import nightCss from "./night.css?raw";
import newsprintCss from "./newsprint.css?raw";
import clearCss from "./clear.css?raw";
import whiteyCss from "./whitey.css?raw";

export type ThemeSeries = "inkstone" | "classic";
export type ThemeMode = "manual" | "system";
export type SystemPair = "ink-paper" | "sea-celadon";

export interface ThemeMeta {
  id: string;
  /** 选择器与底栏上显示的短名 */
  label: string;
  /** 完整名（含英文原名） */
  fullLabel: string;
  /** 一句话气质说明 */
  tagline: string;
  css: string;
  isDark: boolean;
  series: ThemeSeries;
  /** 卡片色点：关键字 / 字符串 / 类型 / 动作 */
  swatches: [string, string, string, string];
  canvas: string;
  ink: string;
  /** 跟随系统时的配对主题 */
  pair: string;
}

export const THEME_SERIES_META: Record<ThemeSeries, { title: string; subtitle: string }> = {
  inkstone: { title: "中国风", subtitle: "墨观 · 中国传统色" },
  classic: { title: "经典", subtitle: "Typora 同款" },
};

/** 墨观变体 = 共享结构层 + 变体调色板 */
const ink = (css: string) => `${inkstoneCore}\n${css}`;

export const BUILTIN_THEMES: Record<string, ThemeMeta> = {
  /* ---------------- 中国风 · 墨观 ---------------- */
  "inkstone-xuanmo": {
    id: "inkstone-xuanmo",
    label: "玄墨",
    fullLabel: "墨观 · 玄墨",
    tagline: "松烟墨底，朱砂批注",
    css: ink(xuanmoCss),
    isDark: true,
    series: "inkstone",
    swatches: ["#d8574a", "#2bae85", "#c08eaf", "#619ac3"],
    canvas: "#14131a",
    ink: "#d4cec4",
    pair: "inkstone-xuanzhi",
  },
  "inkstone-xuanmo-dim": {
    id: "inkstone-xuanmo-dim",
    label: "玄墨 Dimmed",
    fullLabel: "墨观 · 玄墨 Dimmed",
    tagline: "深墨夜色，矿物色低一度",
    css: ink(xuanmoDimCss),
    isDark: true,
    series: "inkstone",
    swatches: ["#c57f73", "#69a794", "#d6a01d", "#66a9c9"],
    canvas: "#19181e",
    ink: "#d8d2c6",
    pair: "inkstone-xuanzhi-dim",
  },
  "inkstone-xuanzhi": {
    id: "inkstone-xuanzhi",
    label: "宣纸",
    fullLabel: "墨观 · 宣纸",
    tagline: "生宣暖白，青绿设色",
    css: ink(xuanzhiCss),
    isDark: false,
    series: "inkstone",
    swatches: ["#c34435", "#1a6840", "#813c85", "#0f59a4"],
    canvas: "#f7f4ed",
    ink: "#35322d",
    pair: "inkstone-xuanmo",
  },
  "inkstone-xuanzhi-dim": {
    id: "inkstone-xuanzhi-dim",
    label: "宣纸 Dimmed",
    fullLabel: "墨观 · 宣纸 Dimmed",
    tagline: "陈纸暖灰，深墨旧色",
    css: ink(xuanzhiDimCss),
    isDark: false,
    series: "inkstone",
    swatches: ["#894e54", "#1a6840", "#525288", "#144a74"],
    canvas: "#e9e2d4",
    ink: "#2f2b25",
    pair: "inkstone-xuanmo-dim",
  },
  "inkstone-canghai": {
    id: "inkstone-canghai",
    label: "沧海",
    fullLabel: "墨观 · 沧海",
    tagline: "深海暮色，青绿矿物",
    css: ink(canghaiCss),
    isDark: true,
    series: "inkstone",
    swatches: ["#dc5e41", "#1ba784", "#c08eaf", "#63bbd0"],
    canvas: "#0d1822",
    ink: "#c8d4dd",
    pair: "inkstone-qingci",
  },
  "inkstone-qingci": {
    id: "inkstone-qingci",
    label: "青瓷",
    fullLabel: "墨观 · 青瓷",
    tagline: "月白釉底，青灰题字",
    css: ink(qingciCss),
    isDark: false,
    series: "inkstone",
    swatches: ["#bc3a46", "#1a6840", "#813c85", "#126e82"],
    canvas: "#e8f0ec",
    ink: "#2b333e",
    pair: "inkstone-canghai",
  },

  /* ---------------- 经典 ---------------- */
  github: {
    id: "github",
    label: "经典浅色",
    fullLabel: "经典浅色 (GitHub)",
    tagline: "GitHub 文档风格",
    css: githubCss,
    isDark: false,
    series: "classic",
    swatches: ["#cf222e", "#0a3069", "#953800", "#0969da"],
    canvas: "#ffffff",
    ink: "#24292f",
    pair: "night",
  },
  night: {
    id: "night",
    label: "经典夜间",
    fullLabel: "经典夜间 (Night)",
    tagline: "VS Code 深色",
    css: nightCss,
    isDark: true,
    series: "classic",
    swatches: ["#c678dd", "#98c379", "#e5c07b", "#4ea1f3"],
    canvas: "#1e1e1e",
    ink: "#d4d4d4",
    pair: "github",
  },
  newsprint: {
    id: "newsprint",
    label: "报刊衬线",
    fullLabel: "报刊衬线 (Newsprint)",
    tagline: "旧报纸的衬线排印",
    css: newsprintCss,
    isDark: false,
    series: "classic",
    swatches: ["#8b0000", "#3f5f4a", "#7a5c3a", "#8b0000"],
    canvas: "#f8f5ee",
    ink: "#2f2f2f",
    pair: "night",
  },
  clear: {
    id: "clear",
    label: "清新商务",
    fullLabel: "清新商务 (Clear)",
    tagline: "克制的商务浅色",
    css: clearCss,
    isDark: false,
    series: "classic",
    swatches: ["#0284c7", "#0f766e", "#334155", "#0284c7"],
    canvas: "#ffffff",
    ink: "#1e293b",
    pair: "night",
  },
  whitey: {
    id: "whitey",
    label: "极简灰阶",
    fullLabel: "极简灰阶 (Whitey)",
    tagline: "只留灰阶的极简",
    css: whiteyCss,
    isDark: false,
    series: "classic",
    swatches: ["#34495e", "#5d6d7e", "#7f8c8d", "#34495e"],
    canvas: "#ffffff",
    ink: "#2c3e50",
    pair: "night",
  },
};

export const THEME_ORDER: string[] = [
  "inkstone-xuanmo",
  "inkstone-xuanmo-dim",
  "inkstone-xuanzhi",
  "inkstone-xuanzhi-dim",
  "inkstone-canghai",
  "inkstone-qingci",
  "github",
  "night",
  "newsprint",
  "clear",
  "whitey",
];

export const DEFAULT_THEME = "inkstone-xuanmo";

const STORAGE_THEME = "typora_theme";
const STORAGE_MODE = "quilla_theme_mode_v1";
const STORAGE_PAIR = "quilla_theme_system_pair_v1";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下静默失败 */
  }
}

const darkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/**
 * 主题加载与热重载管理器
 * - 中国风（墨观 6 变体）+ 经典（Typora 同款 5 套）两个系列
 * - 支持跟随系统深浅色，按配对自动在明暗之间切换
 * - 支持通过 Rust 后端读取外部或工作区内的 base.user.css 实现自定义样式热重载
 */
export class ThemeLoader {
  private manualTheme: string = DEFAULT_THEME;
  private mode: ThemeMode = "manual";
  private systemPair: SystemPair = "ink-paper";
  private resolvedTheme: string = DEFAULT_THEME;

  constructor() {
    this.migrateLegacyKey();

    const savedTheme = readStorage(STORAGE_THEME);
    if (savedTheme && savedTheme in BUILTIN_THEMES) {
      this.manualTheme = savedTheme;
    }
    const savedMode = readStorage(STORAGE_MODE);
    if (savedMode === "system" || savedMode === "manual") {
      this.mode = savedMode;
    }
    const savedPair = readStorage(STORAGE_PAIR);
    if (savedPair === "ink-paper" || savedPair === "sea-celadon") {
      this.systemPair = savedPair;
    }

    this.resolvedTheme = this.resolveTheme();
    this.listenToSystemTheme();
    this.listenToThemeUpdates();
  }

  /** v0.10 之前只有 5 套经典主题；老键值直接沿用，未命中则落到默认墨观主题 */
  private migrateLegacyKey() {
    const legacy = readStorage(STORAGE_THEME);
    if (legacy && !(legacy in BUILTIN_THEMES)) {
      writeStorage(STORAGE_THEME, DEFAULT_THEME);
    }
  }

  private pairing(): { light: string; dark: string } {
    if (this.systemPair === "sea-celadon") {
      return { light: "inkstone-qingci", dark: "inkstone-canghai" };
    }
    return { light: "inkstone-xuanzhi", dark: "inkstone-xuanmo" };
  }

  private systemPrefersDark(): boolean {
    return darkQuery ? darkQuery.matches : false;
  }

  private resolveTheme(): string {
    if (this.mode === "manual") return this.manualTheme;
    const pair = this.pairing();
    return this.systemPrefersDark() ? pair.dark : pair.light;
  }

  public init() {
    this.applyTheme(this.resolvedTheme);
    this.reloadCustomCss();
  }

  public getTheme(): string {
    return this.resolvedTheme;
  }

  public getThemeMeta(): ThemeMeta {
    return BUILTIN_THEMES[this.resolvedTheme] || BUILTIN_THEMES[DEFAULT_THEME];
  }

  public getMode(): ThemeMode {
    return this.mode;
  }

  public getSystemPair(): SystemPair {
    return this.systemPair;
  }

  public setMode(mode: ThemeMode) {
    this.mode = mode;
    writeStorage(STORAGE_MODE, mode);
    this.refresh();
  }

  public setSystemPair(pair: SystemPair) {
    this.systemPair = pair;
    writeStorage(STORAGE_PAIR, pair);
    if (this.mode === "system") this.refresh();
  }

  /** 手动选择主题：自动切回 manual 模式 */
  public setTheme(themeName: string) {
    if (!BUILTIN_THEMES[themeName]) {
      themeName = DEFAULT_THEME;
    }
    this.manualTheme = themeName;
    this.mode = "manual";
    writeStorage(STORAGE_THEME, themeName);
    writeStorage(STORAGE_MODE, "manual");
    this.refresh();
  }

  private refresh() {
    const next = this.resolveTheme();
    if (next === this.resolvedTheme) {
      // 主题未变但模式可能变了，仍需同步一次底栏与 body class
      this.applyTheme(next, true);
      return;
    }
    this.resolvedTheme = next;
    this.applyTheme(next);
  }

  private applyTheme(themeName: string, force = false) {
    const meta = BUILTIN_THEMES[themeName] || BUILTIN_THEMES[DEFAULT_THEME];
    const isDark = meta.isDark;

    let styleEl = document.getElementById("app-theme-style") as HTMLStyleElement;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "app-theme-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = meta.css;

    // theme-night 是全局唯一的"深色"标记，被 Mermaid、导出管线与大量样式消费
    document.body.classList.toggle("theme-night", isDark);
    document.body.dataset.themeMode = isDark ? "dark" : "light";
    document.body.dataset.themeSeries = meta.series;
    document.body.dataset.themeId = meta.id;

    Object.keys(BUILTIN_THEMES).forEach((t) => {
      document.body.classList.remove(`theme-${t}`);
    });
    document.body.classList.add(`theme-${meta.id}`);

    this.syncFooterLabel(meta);

    if (!force) {
      window.dispatchEvent(new CustomEvent("app-theme-changed", { detail: { theme: meta.id, meta } }));
    }
    window.dispatchEvent(new CustomEvent("app-theme-refreshed", { detail: { theme: meta.id, meta } }));
  }

  private syncFooterLabel(meta: ThemeMeta) {
    const themeBtn = document.getElementById("footer-theme-selector");
    if (!themeBtn) return;
    const labelSpan = themeBtn.querySelector(".footer-btn-label");
    if (labelSpan) {
      labelSpan.textContent = meta.label;
    } else {
      themeBtn.textContent = meta.label;
    }
    themeBtn.title = `当前主题: ${meta.fullLabel} · ${meta.tagline}（点击切换）`;
    themeBtn.dataset.themeId = meta.id;
  }

  private listenToSystemTheme() {
    if (!darkQuery) return;
    const onChange = () => {
      if (this.mode === "system") this.refresh();
    };
    if (typeof darkQuery.addEventListener === "function") {
      darkQuery.addEventListener("change", onChange);
    } else if (typeof (darkQuery as MediaQueryList).addListener === "function") {
      (darkQuery as MediaQueryList).addListener(onChange);
    }
  }

  public async reloadCustomCss() {
    try {
      const customCss = await invoke<string>("read_custom_theme_css");
      let userStyleEl = document.getElementById("base-user-custom-style") as HTMLStyleElement;
      if (!userStyleEl) {
        userStyleEl = document.createElement("style");
        userStyleEl.id = "base-user-custom-style";
        document.head.appendChild(userStyleEl);
      }
      userStyleEl.textContent = customCss || "";
    } catch {
      const userCssLink = document.getElementById("base_user_css") as HTMLLinkElement;
      const rawHref = userCssLink?.getAttribute("href");
      if (userCssLink && rawHref && rawHref.trim().length > 0) {
        const url = new URL(rawHref, window.location.href);
        url.searchParams.set("t", Date.now().toString());
        userCssLink.href = url.toString();
      }
    }
  }

  private listenToThemeUpdates() {
    const onThemeUpdate = () => {
      this.reloadCustomCss();
      this.applyTheme(this.resolvedTheme, true);
    };
    window.addEventListener("tauri://theme-updated" as any, onThemeUpdate);
    listen("theme-updated", onThemeUpdate).catch(() => {});
  }
}

export const themeLoader = new ThemeLoader();
