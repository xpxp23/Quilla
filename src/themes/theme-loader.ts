import { listen } from "@tauri-apps/api/event";
import githubCss from "./github.css?raw";
import nightCss from "./night.css?raw";
import newsprintCss from "./newsprint.css?raw";
import clearCss from "./clear.css?raw";
import whiteyCss from "./whitey.css?raw";

export interface ThemeMeta {
  id: string;
  label: string;
  css: string;
}

export const BUILTIN_THEMES: Record<string, ThemeMeta> = {
  github: { id: "github", label: "经典浅色 (GitHub)", css: githubCss },
  night: { id: "night", label: "经典夜间 (Night)", css: nightCss },
  newsprint: { id: "newsprint", label: "报刊衬线 (Newsprint)", css: newsprintCss },
  clear: { id: "clear", label: "清新商务 (Clear)", css: clearCss },
  whitey: { id: "whitey", label: "极简灰阶 (Whitey)", css: whiteyCss },
};

/**
 * 主题加载与热重载管理器
 * - 内置 5 套 Typora 原生同款主题（直接内联打包注入，0ms 无网络延迟、无 404 路径丢失问题）
 * - 支持工作区/外部 base.user.css 样式热覆盖
 */
export class ThemeLoader {
  private currentTheme: string = "github";

  constructor() {
    const saved = localStorage.getItem("typora_theme");
    this.currentTheme = saved && saved in BUILTIN_THEMES ? saved : "github";
    this.listenToThemeUpdates();
  }

  public init() {
    this.setTheme(this.currentTheme);
  }

  public getTheme(): string {
    return this.currentTheme;
  }

  public getThemeMeta(): ThemeMeta {
    return BUILTIN_THEMES[this.currentTheme] || BUILTIN_THEMES.github;
  }

  public setTheme(themeName: string) {
    if (!BUILTIN_THEMES[themeName]) {
      themeName = "github";
    }
    this.currentTheme = themeName;
    localStorage.setItem("typora_theme", themeName);

    // 1. 动态注入/更新 <style id="app-theme-style">
    let styleEl = document.getElementById("app-theme-style") as HTMLStyleElement;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "app-theme-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = BUILTIN_THEMES[themeName].css;

    // 2. 状态类名切换
    if (themeName === "night") {
      document.body.classList.add("theme-night");
    } else {
      document.body.classList.remove("theme-night");
    }

    // 移除旧主题类并添加新主题类 (如 theme-newsprint)
    Object.keys(BUILTIN_THEMES).forEach((t) => {
      document.body.classList.remove(`theme-${t}`);
    });
    document.body.classList.add(`theme-${themeName}`);

    // 3. 底部状态栏与菜单指示更新
    const themeBtn = document.getElementById("footer-theme-selector");
    if (themeBtn) {
      themeBtn.innerHTML = `🎨 ${BUILTIN_THEMES[themeName].label.split(" ")[0]}`;
      themeBtn.title = `当前主题: ${BUILTIN_THEMES[themeName].label} (点击切换)`;
    }

    window.dispatchEvent(new CustomEvent("app-theme-changed", { detail: { theme: themeName } }));
  }

  public reloadCustomCss() {
    const userCssLink = document.getElementById("base_user_css") as HTMLLinkElement;
    const rawHref = userCssLink?.getAttribute("href");
    if (userCssLink && rawHref && rawHref.trim().length > 0) {
      const url = new URL(rawHref, window.location.href);
      url.searchParams.set("t", Date.now().toString());
      userCssLink.href = url.toString();
    }
  }

  private listenToThemeUpdates() {
    const onThemeUpdate = () => {
      console.log("[Theme] 检测到本地 CSS 样式变更，正在热重载...");
      this.reloadCustomCss();
      this.setTheme(this.currentTheme);
    };
    window.addEventListener("tauri://theme-updated" as any, onThemeUpdate);
    listen("theme-updated", onThemeUpdate).catch(() => {
      // 非 Tauri 容器环境下静默降级
    });
  }
}

export const themeLoader = new ThemeLoader();
