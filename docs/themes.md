# Quilla 主题体系（v0.11 墨观）

> 一句话：**经典系列只给颜色，墨观系列给一整套光。**

---

## 1. 三层结构

```
base.css   :root 兼容层（--bg-color / --text-color / --primary-color …）
           └ 语义层（--surface-* / --text-* / --syn-* / --callout-* …）
window.css 全部消费语义层，不含主题色
─────────────────────────────────────────────────────────
themes/inkstone/core.css        墨观共享结构层（朱丝栏、卡片、形状语言）
themes/inkstone/<variant>.css   六个变体的纯调色板 + 排版基线
themes/<classic>.css           经典系列，只覆盖兼容层
```

**兼容承诺**：经典系列不定义语义层时，语义层通过 `var()` 链回落到兼容层，
所以 GitHub / Night / Newsprint / Clear / Whitey 无需任何改动即可继续工作。

**深色承诺**：`body.theme-night` 是全局唯一的"深色"标记，同时承载深色默认值。
墨观深色变体用 `:root, body.theme-<id>` 覆写——同权重但注入更晚，因此永远赢；
它没有覆写的键会自动落回 `body.theme-night` 的深色默认值。

---

## 2. 令牌清单

| 分组 | 令牌 | 说明 |
| :--- | :--- | :--- |
| 表面 | `--surface-canvas` `--surface-panel` `--surface-raised` `--surface-overlay` `--surface-sunken` `--surface-input` `--surface-hover` `--surface-active` | 画布 → 面板 → 浮起 → 浮层 → 深井 → 输入框 → 悬停 → 激活 |
| 文字 | `--text-color` `--text-secondary` `--text-muted` `--text-faint` `--text-on-action` | 正文 / 次要 / 弱化 / 占位 / 反白 |
| 描边 | `--border-color` `--border-hairline` `--border-strong` `--focus-ring` | 常规 / 发丝 / 强调 / 焦点 |
| 动作 | `--primary-color` `--primary-hover` `--primary-rgb` `--primary-bg-subtle` `--action-soft` `--action-border` | 「青做动作」：按钮、链接、双链、焦点 |
| 状态 | `--danger-color` `--success-color` `--warning-color` `--important-color`（各带 `-rgb`） | 「红做记号」：错误、删除、危险 |
| 语法 | `--syn-keyword` `--syn-string` `--syn-comment` `--syn-number` `--syn-type` `--syn-function` `--syn-attr` `--syn-operator` | 对应 `.cm-syn-*` 八个类 |
| 批注 | `--callout-note/-tip/-important/-warning/-caution` 及 `-bg` | Callout 五型 |
| 编辑器 | `--code-bg` `--code-header-bg` `--code-inline-bg` `--mark-bg` `--mark-fg` `--table-header-bg` `--table-stripe-bg` `--quote-bg` `--search-hit-bg/fg` `--search-active-bg/fg` `--search-pulse-bg` `--scrollbar-thumb` | 代码、高亮、表格、引用、查找、滚动条 |
| 标题 | `--heading-rule` `--heading-mark` | 朱丝栏横线 / H2 朱砂短竖 |
| 字体 | `--font-sans` `--font-serif` `--font-quote` `--monospace` `--paragraph-spacing` | 排版基线 |

> 修改强调色时务必同步 `--primary-rgb`，所有 `rgba(var(--primary-rgb), α)` 的浅底都靠它派生。
> Theme Studio 改色时会自动同步这组派生令牌。

---

## 3. 六个变体

| 变体 | id | 光线 | 画布 | 关键字 | 字符串 | 类型 | 动作 | 字体 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 玄墨 | `inkstone-xuanmo` | 暗 | `#14131a` | `#d8574a` 鱼鳃红 | `#2bae85` 铜绿 | `#c08eaf` 萝兰紫 | `#619ac3` 羽扇豆蓝 | 黑体 |
| 玄墨 Dimmed | `inkstone-xuanmo-dim` | 暗 | `#19181e` | `#c57f73` 桂红 | `#69a794` 梧枝绿 | `#d6a01d` 土黄 | `#66a9c9` 涧石蓝 | 黑体 |
| 宣纸 | `inkstone-xuanzhi` | 暖亮 | `#f7f4ed` | `#c34435` 鹤顶红 | `#1a6840` 荷叶绿 | `#813c85` 桔梗紫 | `#0f59a4` 飞燕草蓝 | 宋体 |
| 宣纸 Dimmed | `inkstone-xuanzhi-dim` | 暖亮 | `#e9e2d4` | `#894e54` 烟红 | `#1a6840` 荷叶绿 | `#525288` 野菊紫 | `#144a74` 鷃蓝 | 宋体 |
| 沧海 | `inkstone-canghai` | 暗 | `#0d1822` | `#dc5e41` 银朱 | `#1ba784` 竹绿 | `#c08eaf` 萝兰紫 | `#63bbd0` 霁青 | 黑体 |
| 青瓷 | `inkstone-qingci` | 冷亮 | `#e8f0ec` | `#bc3a46` 尖晶玉红 | `#1a6840` 荷叶绿 | `#813c85` 桔梗紫 | `#126e82` 玉鈫蓝 | 黑体 |

设计约束（与墨观一致）：正文对比度 7–12.5:1（Dimmed ≥ 10.5），语法色 4.5–9:1，
彩度 ≤ 0.175；无渐变、无斜体注释、无玻璃拟态。

### 形状语言

- **方 = 文档链接**（`.cm-wikilink`，3px 圆角 + 描边）
- **圆 = 标签**（`.cm-hashtag`，999px 胶囊）
- **竖线 = 批注**（引用、Callout 左侧 3–4px）
- **横线 = 章节**（H1 朱丝栏 + `hr` 发丝线）

---

## 4. 新增一套主题

1. 复制 `themes/inkstone/xuanzhi.css`，改 `body.theme-<id>` 与全部色值。
2. 在 `theme-loader.ts` 的 `BUILTIN_THEMES` 注册：`css: ink(<variant>)`、`isDark`、`series`、色点、`pair`。
3. 把 id 加进 `THEME_ORDER`。
4. 若为深色变体，`isDark: true` 会自动挂上 `theme-night`，Mermaid / 导出链路无需再改。

---

## 5. 跟随系统

`theme-loader` 读取 `prefers-color-scheme`，按配对切换：

- `ink-paper`：玄墨 ↔ 宣纸
- `sea-celadon`：沧海 ↔ 青瓷

偏好设置「外观模式」与主题选择器顶部的胶囊都能切换。

---

## 6. 色值出处

传统色名与色值来自 [zhongguose.com](https://zhongguose.com/) 整理的 526 个中国传统颜色；
配色体系、对比度区间与"红做记号、青做动作"的分工改编自
[墨观 Inkstone](https://github.com/Konata9/inkstone)（MIT License）。
