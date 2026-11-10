/**
 * dsh-btw — settings card chunk (zero-build: hand-maintained source AND
 * shipped artifact, in the window.__ModuleLoader__ handoff format).
 *
 * The polish surface for the official plugin-settings slots: outline-style
 * grouped rows (label + quiet one-line hint on the left, control on the
 * right) over the exact existing field set — no new settings, no new writes.
 * Everything dynamic arrives through createSettings({ … }) from the chunk
 * that lazy-loads this one (the integrator): stores, savers and the scope
 * probe from the entry module; ModelSelect / choiceSelect / modelValue and
 * the option lists from the views module; optional host primitives. CSS is
 * exported as one string for the integrator to inject, so this factory
 * performs no synchronous require of any sibling or shared module.
 *
 * Native/fallback contracts (inspected in client.views.js, not invented):
 *   - Button (size:"sm") and Tooltip ({label, side, delayMs}) are public,
 *     but this card has no button and no control that needs a tooltip —
 *     every write is instant on change, so neither is forced in.
 *   - No public Switch primitive is verified in this repo pair, so the
 *     toggle is the blessed fallback: a real <input type="checkbox"
 *     role="switch"> styled as track + knob (focusable, keyboard-native).
 */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.settings.js",
	factory: (require) => {
		// `require` is intentionally untouched: cross-chunk loads stay async
		// and owned by the integrating chunk.
		const CSS = `
		/* ── settings card: outline-style grouped rows on dsw tokens ── */
		.dsh-btw-settings{box-sizing:border-box;container-type:inline-size;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-3,var(--dsw-specific-input-major,#fff));padding:2px 0 10px;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-set-group{display:block;}
		.dsh-btw-set-group + .dsh-btw-set-group{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,rgba(0,0,0,.08)));padding-top:2px;}
		.dsh-btw-set-groupTitle{padding:10px 16px 4px;font-size:12px;font-weight:600;letter-spacing:.02em;line-height:16px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-set-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 16px;padding:10px 16px;}
		.dsh-btw-set-row + .dsh-btw-set-row{border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,rgba(0,0,0,.06)));}
		.dsh-btw-set-rowToggle{cursor:pointer;flex-wrap:nowrap;}
		.dsh-btw-set-rowToggle:has(.dsh-btw-set-toggle:disabled){cursor:default;}
		.dsh-btw-set-text{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:2px;}
		.dsh-btw-set-label{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-set-hint{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-set-ctrl{flex:none;max-width:100%;min-width:0;display:flex;align-items:center;justify-content:flex-end;}
		/* Styled-switch fallback: one real checkbox paints track + knob; the
		   checked/knob/focus/disabled states all stay on the native input. */
		.dsh-btw-set-toggle{appearance:none;-webkit-appearance:none;flex:none;display:inline-block;box-sizing:border-box;width:34px;height:20px;margin:0;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.16));position:relative;cursor:pointer;transition:background .16s;}
		.dsh-btw-set-toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s;}
		.dsh-btw-set-toggle:checked{background:var(--dsw-alias-brand-text,var(--dsw-alias-brand-primary,#3964fe));}
		.dsh-btw-set-toggle:checked::after{transform:translateX(14px);}
		.dsh-btw-set-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:2px;}
		.dsh-btw-set-toggle:disabled{opacity:.45;cursor:default;}
		.dsh-btw-set-status{margin:6px 16px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-set-error{color:var(--dsw-alias-state-error-primary,#e5484d);}
		/* Narrow containers (bundle modal sidebar, split pane) stack the
		   control under its label; flex-wrap already covers hosts without
		   container-query support. */
		@container (max-width:520px){.dsh-btw-set-row:not(.dsh-btw-set-rowToggle)>.dsh-btw-set-ctrl{flex-basis:100%;justify-content:flex-start;}}
		@media (prefers-reduced-motion:reduce){.dsh-btw-set-toggle,.dsh-btw-set-toggle::after{transition:none;}}
		`;

		/**
		 * Build the BtwSettings component. The integrator supplies React, the
		 * entry's stores/savers (prefs, settingsErrors, getSettingsScope,
		 * saveSetting, saveModel), the views module's control helpers
		 * (ModelSelect, choiceSelect, modelValue, CONTEXT_OPTIONS,
		 * PRESENTATIONS) and the resolved host primitives, if any.
		 */
		function createSettings({ React, prefs, settingsErrors, getSettingsScope, saveSetting, saveModel, ModelSelect, choiceSelect, modelValue, CONTEXT_OPTIONS, PRESENTATIONS, primitives }) {
			const h = React.createElement;
			// `primitives` is accepted for contract parity and deliberately
			// unused — see the header note on Button/Tooltip/Switch.

			// Left column: label + quiet one-line description.
			const rowText = (label, hint) => h("span", { className: "dsh-btw-set-text" },
				h("span", { className: "dsh-btw-set-label" }, label),
				hint ? h("span", { className: "dsh-btw-set-hint" }, hint) : null);

			// A choice row is a plain div: clicking the copy must not poke the
			// menu. `text` is the visible copy — one btw product, 输入框旁 / 独立
			// qualify the seat, never a second product name — while `label` is
			// the stable accessible name the supplied picker reuses (old names
			// stay for host/test compatibility).
			const choiceRow = ({ text, label = text, hint, value, options, disabled, onChange }) => h("div", { className: "dsh-btw-set-row" },
				rowText(text, hint),
				h("span", { className: "dsh-btw-set-ctrl" },
					choiceSelect({ label, value, disabled, onChange }, options)));

			const modelRow = ({ text, hint, prefix, value, disabled }) => h("div", { className: "dsh-btw-set-row" },
				rowText(text, hint),
				h("span", { className: "dsh-btw-set-ctrl" },
					h(ModelSelect, { value, disabled, onChange: (next) => { if (!disabled) saveModel(prefix, next); } })));

			// The whole row is one label: clicking anywhere toggles the switch.
			const switchRow = ({ key, text, label = text, hint, checked, disabled }) => h("label", { className: "dsh-btw-set-row dsh-btw-set-rowToggle" },
				rowText(text, hint),
				h("span", { className: "dsh-btw-set-ctrl" },
					h("input", { type: "checkbox", role: "switch", className: "dsh-btw-set-toggle", "aria-label": label,
						checked: !!checked, disabled,
						onChange: (e) => { if (!disabled) saveSetting(key, e.target.checked); } })));

			const group = (name, ...rows) => h("section", { className: "dsh-btw-set-group", "aria-label": name },
				h("div", { className: "dsh-btw-set-groupTitle" }, name), ...rows);

			function BtwSettings() {
				const p = prefs.use(), errors = settingsErrors.use() || {};
				const snap = typeof getSettingsScope === "function" ? getSettingsScope()?.getSnapshot?.() : null;
				// Same gate as every other write path: ready + writable. Values
				// themselves come from the entry-projected prefs store; this
				// card never reads or mutates the host form scope directly.
				const disabled = !snap || snap.status !== "ready" || snap.writable === false;
				const save = (key) => (value) => { if (!disabled) saveSetting(key, value); };
				return h("div", { className: "dsh-btw-settings" },
				// One product in the visible copy: ask* seats read 输入框旁的
				// btw, temp* seats read 独立 btw; the underlying keys and writes
				// are unchanged.
					group("聊天默认",
						choiceRow({ text: "输入框旁的 btw 默认上下文", label: "侧问默认上下文", hint: "开启面板时携带的对话范围", value: p.askContextMode, options: CONTEXT_OPTIONS, disabled, onChange: save("askContextMode") }),
						modelRow({ text: "输入框旁的 btw 默认模型", hint: "有来源时跟随会话，否则使用 DSH 默认模型", prefix: "ask", value: modelValue(p.askModelMode, p.askProvider, p.askModel), disabled }),
						choiceRow({ text: "独立 btw 默认上下文", label: "临时聊天默认上下文", hint: "按需模式只使用授权的近期文本快照，不是完整历史", value: p.tempContextMode, options: CONTEXT_OPTIONS, disabled, onChange: save("tempContextMode") }),
						modelRow({ text: "独立 btw 默认模型", hint: "有来源时跟随会话，否则使用 DSH 默认模型", prefix: "temp", value: modelValue(p.tempModelMode, p.tempProvider, p.tempModel), disabled }),
					),
					group("窗口行为",
						choiceRow({ text: "默认显示模式", hint: "打开时优先使用的显示方式", value: p.tempPresentation, options: PRESENTATIONS, disabled, onChange: save("tempPresentation") }),
						switchRow({ key: "tempWindowPinned", text: "小窗默认固定", hint: "固定后小窗不可拖动，取消固定可自由移动", checked: p.tempWindowPinned, disabled }),
						switchRow({ key: "tempRememberPosition", text: "记忆项目内的小窗位置和大小（仅数值）", hint: "只记住数值，不保存对话内容", checked: p.tempRememberPosition, disabled }),
					),
					group("入口",
						switchRow({ key: "showAskChip", text: "显示输入框旁的 btw 按钮", label: "显示侧问按钮", checked: p.showAskChip, disabled }),
						switchRow({ key: "enableSlash", text: "启用 /btw", hint: "输入 /btw 加问题，直接从输入框发起", checked: p.enableSlash, disabled }),
						switchRow({ key: "showTempEntry", text: "显示独立 btw 入口", label: "显示临时聊天入口", hint: "在会话标题栏提供开启入口", checked: p.showTempEntry, disabled }),
					),
					disabled ? h("div", { className: "dsh-btw-set-status", role: "status" }, "设置不可写或尚未加载") : null,
					errors.error ? h("div", { className: "dsh-btw-set-status dsh-btw-set-error", role: "status" }, errors.error) : null,
				);
			}
			return BtwSettings;
		}
		return { createSettings, CSS };
	},
});
