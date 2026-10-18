import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Quilla v0.7 轻量级插件化扩展内核 (Plugin & Extension System)
 * 允许内置模块与用户扩展按生命周期注册：
 * - 自定义 CodeMirror 6 编辑器扩展 (editorExtensions)
 * - 导出 HTML 后处理钩子 (exportHtmlTransformers)
 * - 自定义斜杠命令项 (slashCommands)
 * - 文档保存/切换生命周期钩子 (onDocumentSaved / onActiveDocumentChanged)
 */

export interface QuillaSlashCommandItem {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  iconSvg?: string;
  execute: (view: EditorView, lineFrom: number, cursorPos: number) => void;
}

export interface QuillaPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  editorExtensions?: Extension[];
  slashCommands?: QuillaSlashCommandItem[];
  transformExportHtml?: (html: string, format: "html" | "pdf" | "word" | "wechat" | "poster") => string;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onDocumentSaved?: (filePath: string, content: string) => void;
}

class QuillaPluginRegistry {
  private plugins = new Map<string, QuillaPlugin>();

  public register(plugin: QuillaPlugin): void {
    const enabled = plugin.enabled !== false;
    const entry: QuillaPlugin = { ...plugin, enabled };
    this.plugins.set(plugin.id, entry);
    if (enabled) {
      try {
        entry.onActivate?.();
      } catch (e) {
        console.warn(`[QuillaPlugin] 激活插件 ${plugin.id} 异常:`, e);
      }
    }
  }

  public unregister(pluginId: string): boolean {
    const existing = this.plugins.get(pluginId);
    if (!existing) return false;
    try {
      existing.onDeactivate?.();
    } catch {}
    return this.plugins.delete(pluginId);
  }

  public setPluginEnabled(pluginId: string, enabled: boolean): boolean {
    const p = this.plugins.get(pluginId);
    if (!p) return false;
    if (p.enabled === enabled) return true;
    p.enabled = enabled;
    try {
      if (enabled) p.onActivate?.();
      else p.onDeactivate?.();
    } catch {}
    return true;
  }

  public getPlugins(): QuillaPlugin[] {
    return Array.from(this.plugins.values());
  }

  public getEditorExtensions(): Extension[] {
    const exts: Extension[] = [];
    for (const p of this.plugins.values()) {
      if (p.enabled !== false && p.editorExtensions?.length) {
        exts.push(...p.editorExtensions);
      }
    }
    return exts;
  }

  public getSlashCommands(): QuillaSlashCommandItem[] {
    const cmds: QuillaSlashCommandItem[] = [];
    for (const p of this.plugins.values()) {
      if (p.enabled !== false && p.slashCommands?.length) {
        cmds.push(...p.slashCommands);
      }
    }
    return cmds;
  }

  public runExportHtmlTransformers(
    html: string,
    format: "html" | "pdf" | "word" | "wechat" | "poster"
  ): string {
    let current = html;
    for (const p of this.plugins.values()) {
      if (p.enabled !== false && p.transformExportHtml) {
        try {
          current = p.transformExportHtml(current, format);
        } catch (e) {
          console.warn(`[QuillaPlugin] 导出钩子 ${p.id} 异常:`, e);
        }
      }
    }
    return current;
  }

  public notifyDocumentSaved(filePath: string, content: string): void {
    for (const p of this.plugins.values()) {
      if (p.enabled !== false && p.onDocumentSaved) {
        try {
          p.onDocumentSaved(filePath, content);
        } catch {}
      }
    }
  }
}

export const quillaPluginRegistry = new QuillaPluginRegistry();
