import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** /theme: preview with Theme objects; persist only with a confirmed theme name. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("theme", {
    description: "实时预览颜色主题，Enter 保存为全局默认主题，Esc 取消",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/theme 需要在 Pi 交互式终端中使用。", "warning");
        return;
      }

      const original = ctx.ui.theme;
      let committed = false;
      try {
        const items = ctx.ui.getAllThemes().map(({ name, path }) => ({
          value: name,
          label: name,
          description: `${name === original.name ? "当前 · " : ""}${path ? "自定义" : "内置"}`,
        }));
        if (!items.length) {
          ctx.ui.notify("没有可用主题。", "warning");
          return;
        }

        const selected = await ctx.ui.custom<string | null>((tui, _theme, kb, done) => {
          let error = "";
          const list = new SelectList(items, Math.min(items.length, 8), {
            selectedPrefix: (s) => ctx.ui.theme.fg("accent", s),
            selectedText: (s) => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", s)),
            description: (s) => ctx.ui.theme.fg("muted", s),
            scrollInfo: (s) => ctx.ui.theme.fg("dim", s),
            noMatch: (s) => ctx.ui.theme.fg("warning", s),
          });
          list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === original.name)));

          const preview = (name: string): boolean => {
            try {
              const candidate = ctx.ui.getTheme(name);
              if (!candidate) throw new Error(`无法加载主题：${name}`);
              // Passing an object updates the UI without modifying settings.json.
              const result = ctx.ui.setTheme(candidate);
              if (!result.success) throw new Error(result.error ?? "预览失败");
              error = "";
              return true;
            } catch (cause) {
              error = cause instanceof Error ? cause.message : String(cause);
              return false;
            } finally {
              tui.requestRender();
            }
          };
          list.onSelectionChange = (item) => { preview(item.value); };
          list.onSelect = (item) => { if (preview(item.value)) done(item.value); };
          list.onCancel = () => done(null);

          return {
            render(width) {
              // Read the live theme every render, never cache old ANSI colors.
              const theme = ctx.ui.theme;
              const lines = [
                theme.fg("borderAccent", "─".repeat(Math.max(0, width))),
                theme.bold(theme.fg("accent", " 颜色主题 · 实时预览")),
                ...list.render(width),
                "",
                theme.bg("userMessageBg", theme.fg("userMessageText", " 用户消息预览 ")),
                theme.bg("toolSuccessBg", theme.fg("toolTitle", " 工具执行成功 ")),
                theme.fg("success", " 成功 ") + theme.fg("warning", " 警告 ") + theme.fg("error", " 错误 "),
                theme.fg("toolDiffAdded", " + 新增内容 ") + theme.fg("toolDiffRemoved", " - 删除内容 "),
                theme.fg(error ? "error" : "dim", error || " ↑↓ 预览 · Enter 保存默认 · Esc 取消"),
                theme.fg("borderAccent", "─".repeat(Math.max(0, width))),
              ];
              return lines.map((line) => truncateToWidth(line, width));
            },
            invalidate() { list.invalidate(); },
            handleInput(data) {
              if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
                done(null);
              } else if (kb.matches(data, "tui.select.confirm")) {
                const item = list.getSelectedItem();
                if (item) list.onSelect?.(item);
              } else {
                list.handleInput(data);
              }
              tui.requestRender();
            },
          };
        });

        if (selected) {
          // Pi's string overload also saves the global theme through SettingsManager.
          const result = ctx.ui.setTheme(selected);
          if (!result.success) throw new Error(result.error ?? "主题切换失败");
          committed = true;
          ctx.ui.notify(`默认主题已设为 ${selected}`, "info");
        }
      } catch (cause) {
        ctx.ui.notify(`主题切换失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
      } finally {
        // Cancellation and failures must not leave a preview applied or save it.
        if (!committed) ctx.ui.setTheme(original);
      }
    },
  });
}
