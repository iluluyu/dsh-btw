/**
 * dsh-btw — settings card chunk (zero-build: hand-maintained source AND
 * shipped artifact, in the window.__ModuleLoader__ handoff format).
 *
 * Context and model defaults are shared. Each enabled entry displays
 * its own opening position immediately below the switch.
 *
 * Everything dynamic arrives through createSettings({ … }) from the chunk
 * that lazy-loads this one. CSS is one exported string; this factory does
 * no synchronous require. The toggle is a real checkbox role="switch" —
 * no public Switch primitive is verified in this repo pair.
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
		.dsh-btw-set-entry + .dsh-btw-set-entry{border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,rgba(0,0,0,.06)));}
		.dsh-btw-set-entry>.dsh-btw-set-position{border-top:0;padding:0 16px 10px;justify-content:flex-end;}
		.dsh-btw-set-rowToggle{cursor:pointer;flex-wrap:nowrap;}
		.dsh-btw-set-rowToggle:has(.dsh-btw-set-toggle:disabled){cursor:default;}
		.dsh-btw-set-text{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:2px;}
		.dsh-btw-set-label{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);}
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
		@container (max-width:520px){.dsh-btw-set-row:not(.dsh-btw-set-rowToggle,.dsh-btw-set-position)>.dsh-btw-set-ctrl{flex-basis:100%;justify-content:flex-start;}}
		@media (prefers-reduced-motion:reduce){.dsh-btw-set-toggle,.dsh-btw-set-toggle::after{transition:none;}}
		`;

		/**
		 * Build the BtwSettings component. The integrator supplies React, the
		 * entry's stores/savers (prefs, settingsErrors, getSettingsScope,
		 * saveSetting, saveModel), the views module's control helpers
		 * (ModelSelect, choiceSelect, SegmentedControl, modelValue, CONTEXT_OPTIONS).
		 */
		function createSettings({ React, prefs, settingsErrors, getSettingsScope, saveSetting, saveModel, ModelSelect, choiceSelect, SegmentedControl, modelValue, CONTEXT_OPTIONS }) {
			const h = React.createElement;
			const positions = [{ value: "dock", label: "输入框上方" }, { value: "sidebar", label: "右侧栏" }, { value: "overlay", label: "浮动小窗" }];

			const rowText = (label) => h("span", { className: "dsh-btw-set-text" },
				h("span", { className: "dsh-btw-set-label" }, label));

			const choiceRow = ({ text, value, options, disabled, onChange }) => h("div", { className: "dsh-btw-set-row" },
				rowText(text),
				h("span", { className: "dsh-btw-set-ctrl" },
					choiceSelect({ label: text, value, disabled, onChange }, options)));

			const modelRow = ({ text, value, disabled }) => h("div", { className: "dsh-btw-set-row" },
				rowText(text),
				h("span", { className: "dsh-btw-set-ctrl" },
					h(ModelSelect, { value, disabled, onChange: (next) => { if (!disabled) { saveModel("ask", next); saveModel("temp", next); } } })));

			// The whole row is one label: clicking anywhere toggles the switch.
			const switchRow = ({ key, text, label = text, checked, disabled, controls }) => h("label", { className: "dsh-btw-set-row dsh-btw-set-rowToggle" },
				rowText(text),
				h("span", { className: "dsh-btw-set-ctrl" },
					h("input", { type: "checkbox", role: "switch", className: "dsh-btw-set-toggle", "aria-label": label,
						checked: !!checked, disabled, "aria-controls": controls,
						onChange: (e) => { if (!disabled) saveSetting(key, e.target.checked); } })));

			const entryRow = ({ key, positionKey, text, p, disabled, id }) => {
				const position = { id: id && id + "-choice", label: text + "的打开位置", value: p[positionKey], disabled,
					onChange: (value) => { if (!disabled && positions.some(option => option.value === value)) saveSetting(positionKey, value); } };
				return h("div", { className: "dsh-btw-set-entry" },
					switchRow({ key, text, checked: p[key], disabled, controls: p[key] ? id : undefined }),
					p[key] ? h("div", { id, className: "dsh-btw-set-row dsh-btw-set-position" },
						h("span", { className: "dsh-btw-set-ctrl" }, SegmentedControl
							? h(SegmentedControl, { ...position, options: positions })
							: choiceSelect(position, positions))) : null);
			};

			const group = (name, ...rows) => h("section", { className: "dsh-btw-set-group", "aria-label": name },
				h("div", { className: "dsh-btw-set-groupTitle" }, name), ...rows);

			function BtwSettings() {
				const positionId = React.useId?.();
				const p = prefs.use(), errors = settingsErrors.use() || {};
				const snap = typeof getSettingsScope === "function" ? getSettingsScope()?.getSnapshot?.() : null;
				// Same gate as every other write path: ready + writable. Values
				// themselves come from the entry-projected prefs store; this
				// card never reads or mutates the host form scope directly.
				const disabled = !snap || snap.status !== "ready" || snap.writable === false;
				const saveBoth = (askKey, tempKey) => (value) => { if (!disabled) { saveSetting(askKey, value); saveSetting(tempKey, value); } };
				return h("div", { className: "dsh-btw-settings" },
					group("默认",
						switchRow({ key: "showGlobalTempEntry", text: "临时聊天", checked: p.showGlobalTempEntry, disabled }),
						choiceRow({ text: "上下文", value: p.askContextMode, options: CONTEXT_OPTIONS, disabled, onChange: saveBoth("askContextMode", "tempContextMode") }),
						modelRow({ text: "模型", value: modelValue(p.askModelMode, p.askProvider, p.askModel), disabled }),
					),
					group("入口与位置",
						entryRow({ key: "showAskChip", positionKey: "chipPresentation", text: "输入框「顺便问」按钮", p, disabled, id: positionId && positionId + "-chip" }),
						entryRow({ key: "enableSlash", positionKey: "slashPresentation", text: "/btw", p, disabled, id: positionId && positionId + "-slash" }),
						entryRow({ key: "showTempEntry", positionKey: "headerPresentation", text: "右上角入口", p, disabled, id: positionId && positionId + "-header" }),
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
