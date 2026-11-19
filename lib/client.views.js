/** First-use views. Stores, resource ownership and transport stay in the entry. */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.views.js",
	factory: (require) => {
		// Optional browser shared module, not an npm/runtime service dependency.
		let SharedMenu = null, SharedChevron = null, SharedMarkdown = null, SharedButton = null, SharedTooltip = null, SharedSegmentedControl = null;
		let SharedDisclosureRow = null, SharedThinkIcon = null, SharedTextShimmer = null, SharedModal = null;
		const nativeIcons = {};
		const renderable = (value) => typeof value === "function" || (value && typeof value === "object" && [Symbol.for("react.memo"), Symbol.for("react.forward_ref")].includes(value.$$typeof));
		try {
			const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			if (typeof primitives?.Menu === "function") SharedMenu = primitives.Menu;
			if (typeof primitives?.IconChevronDownOutlineRegular === "function") SharedChevron = primitives.IconChevronDownOutlineRegular;
			if (renderable(primitives?.MarkdownText)) SharedMarkdown = primitives.MarkdownText;
			if (renderable(primitives?.Button)) SharedButton = primitives.Button;
			if (renderable(primitives?.Modal)) SharedModal = primitives.Modal;
			if (renderable(primitives?.Tooltip)) SharedTooltip = primitives.Tooltip;
			if (renderable(primitives?.SegmentedControl)) SharedSegmentedControl = primitives.SegmentedControl;
			if (renderable(primitives?.DisclosureRow)) SharedDisclosureRow = primitives.DisclosureRow;
			if (renderable(primitives?.IconThinkOutlineRegular)) SharedThinkIcon = primitives.IconThinkOutlineRegular;
			if (renderable(primitives?.TextShimmer)) SharedTextShimmer = primitives.TextShimmer;
			for (const name of ["FullscreenOutline", "PanelLeftOutline", "PinFill", "PinOutline", "PlusOutline", "CheckSquareOutline", "CheckboxCheckedOutline", "MicrophoneOutline", "ThinkOutline", "DataOutline", "ChevronRightOutline", "ChevronLeftOutline"]) {
				const icon = primitives?.["Icon" + name + "Regular"] || primitives?.["Icon" + name + "Medium"];
				if (renderable(icon)) nativeIcons[name] = icon;
			}
		} catch { /* older hosts keep the native select */ }

		const CSS = `
		/* Shared small window; the dock only supplies its bounds and folding. */
		.dsh-btw-dock-stage{position:relative;width:100%;min-width:0;}
		.dsh-btw-dock-panel{position:relative;max-height:min(50dvh,var(--btw-dock-max-height,480px));}
		.dsh-btw-modal[data-small=true]{background:var(--dsw-specific-input-major,#fff);container-type:inline-size;border-radius:var(--dsw-radius-lg,16px);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.16));}
		/* Paint the perimeter above the opaque composer and its expanded overlay. */
		.dsh-btw-modal[data-small=true]::after{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;border-radius:inherit;corner-shape:inherit;box-shadow:inset 0 0 0 1px var(--btw-soft-edge);}
		.dsh-btw-modal[data-small=true] .dsh-btw-mbody{margin-right:8px;padding:8px 14px;overscroll-behavior:contain;}
		.dsh-btw-modal[data-small=true]>.dsh-btw-mfoot{position:relative;padding:0;border-top:1px solid transparent;}
		.dsh-btw-composer-divider{position:absolute;inset-inline:0;top:-6px;height:12px;z-index:3;cursor:ns-resize;touch-action:none;}
		.dsh-btw-composer-divider::before{content:"";position:absolute;inset-inline:0;top:5px;height:1px;background:var(--btw-soft-edge);opacity:.48;}
		.dsh-btw-composer-divider:is(:hover,:focus-visible,:active)::before{opacity:.85;}
		.dsh-btw-composer-divider:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:1px;}
		.dsh-btw-modal[data-small=true] .dsh-btw-mta[data-manual=true]{field-sizing:fixed;height:var(--btw-composer-height);}
		.dsh-btw-modal[data-small=true] .dsh-btw-mta:focus::placeholder{color:var(--dsw-alias-label-tertiary,#81858c);}
		.dsh-btw-modal[data-small=true] .dsh-btw-mcard{gap:4px;border:0;padding:4px 10px 6px;}
		.dsh-btw-modal[data-small=true] .dsh-btw-mta{min-height:24px;line-height:20px;padding:2px 6px;}
		.dsh-btw-modal[data-small=true] .dsh-btw-select{padding:4px 6px;}
		/* After a reply neither the fold control nor the reopened composer may own
		   a flow row of panel height: the toggle floats at the panel bottom and the
		   expanded editor overlays the transcript (measured via --btw-editor-h). */
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-mfoot{position:absolute;left:0;right:0;bottom:0;z-index:3;background:var(--dsw-specific-input-major,#fff);box-shadow:0 -6px 16px rgba(0,0,0,.06);}
		.dsh-btw-dock-panel[data-editor=collapsed]>.dsh-btw-mbody{padding-bottom:34px;}
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-mbody{padding-bottom:calc(var(--btw-editor-h,88px) + 14px);}
		.dsh-btw-dock-panel[data-editor]>.dsh-btw-tools,.dsh-btw-dock-panel[data-editor]>.dsh-btw-status{margin-bottom:34px;}
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-tools,.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-status{margin-bottom:calc(var(--btw-editor-h,88px) + 14px);}
		.dsh-btw-editor-toggle{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);z-index:4;display:grid;place-items:center;width:24px;height:24px;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:50%;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;box-shadow:var(--dsw-shadow-lv2,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02));}
		.dsh-btw-mfoot>.dsh-btw-editor-toggle{bottom:auto;top:-12px;left:auto;right:12px;transform:none;}
		.dsh-btw-editor-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-editor-toggle[aria-expanded=false] svg{transform:rotate(180deg);}
		.dsh-btw-editor-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:1px;}
		/* Both small windows use a single-line header inset from the frame. */
		.dsh-btw-modal[data-small=true]>.dsh-btw-mhead{flex-wrap:nowrap;gap:4px;padding:8px 14px 6px;min-width:0;}
		.dsh-btw-modal[data-small=true] .dsh-btw-mtitle{font-size:13px;}
		.dsh-btw-modal[data-small=true] .dsh-btw-window-control{min-width:26px;min-height:26px;padding:4px;}
		.dsh-btw-mhead .dsh-btw-mtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		@container (max-width:360px){.dsh-btw-modal[data-small=true]>.dsh-btw-mhead{gap:2px;padding-inline:10px}.dsh-btw-mhead .dsh-btw-window-controls{gap:0}.dsh-btw-modal[data-small=true] .dsh-btw-mhead .dsh-btw-window-control{min-width:24px;min-height:24px;padding:3px}}
		@container (max-width:250px){.dsh-btw-mhead .dsh-btw-mtitles{display:none}}
		.dsh-btw-caret{display:inline-block;width:7px;height:14px;background:var(--dsw-alias-brand-text,#3964fe);vertical-align:-2px;margin-left:2px;animation:dsh-btw-caret .8s steps(2) infinite;}
		@keyframes dsh-btw-caret{0%,100%{opacity:1}50%{opacity:0}}
		.dsh-btw-status{padding:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-pick{width:14px;height:14px;margin:2px 4px;cursor:pointer;accent-color:var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-err{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-go{flex:none;display:grid;place-items:center;width:34px;height:34px;padding:0;background:var(--dsw-alias-button-info-fill,#3964fe);color:var(--dsw-alias-label-on-color,#fff);cursor:pointer;border:none;border-radius:50%;}
		.dsh-btw-go:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2b55e0);}
		.dsh-btw-go:disabled{opacity:.4;cursor:default;}
		.dsh-btw-go.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#57585a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}
		.dsh-btw-go.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsh-alias-label-primary,#0f1115);}
		/* ── chip trigger beside the send button ── */
		/* ── temp-chat header entry ── */
		/* ── temp-chat overlay (shell.overlay) ── */
		.dsh-btw-desktop{position:fixed;inset:0;z-index:9000;pointer-events:none;}
		.dsh-btw-veil{position:absolute;inset:0;pointer-events:none;}
		.dsh-btw-veil>.dsh-btw-modal{pointer-events:auto;position:absolute;}
		@keyframes dsh-btw-fade{from{opacity:0}to{opacity:1}}
		.dsh-btw-veil[data-phase=closing]{pointer-events:none;animation:dsh-btw-fade .24s ease-in reverse forwards;}
		.dsh-btw-inline{width:100%;height:100%;min-height:0;}
		.dsh-btw-modal,.dsh-btw-mcard,.dsh-btw-bubble,.dsh-btw-entry{corner-shape:superellipse(1.5);}
		.dsh-btw-modal{box-sizing:border-box;min-width:0;min-height:0;width:min(var(--btw-width,740px),calc(100vw - 32px));max-width:100%;height:min(640px,calc(100dvh - 48px));background:var(--dsw-alias-bg-base,#fff);border:0;border-radius:var(--dsw-radius-panel,24px);display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-modal[data-phase=closing]{animation:dsh-btw-shrink .24s ease-in forwards;}
		@keyframes dsh-btw-shrink{to{opacity:0;transform:scale(.97) translateY(8px)}}
		.dsh-btw-mhead{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));}
		.dsh-btw-mtitles{flex:1;min-width:0;}
		.dsh-btw-mtitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;}
		.dsh-btw-msub{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-mbody{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
		.dsh-btw-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-tertiary,#81858c);font-size:13px;line-height:22px;max-width:400px;padding:0 16px;}
		.dsh-btw-empty b{color:var(--dsw-alias-label-secondary,#57585a);font-weight:600;}
		.dsh-btw-msg{display:flex;flex-direction:column;}
		.dsh-btw-msg.user{align-items:flex-end;}
		.dsh-btw-msg.agent{align-items:stretch;}
		.dsh-btw-reasoning{margin:0 0 8px;color:var(--dsw-alias-label-secondary,#57585a);font-size:13px;line-height:1.6;overflow-wrap:anywhere;}
		.dsh-btw-reasoning>summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#81858c);}
		.dsh-btw-reasoning[open]>summary{margin-bottom:6px;}
		.dsh-btw-think-body{min-width:0;padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));}
		.dsh-btw-think-separator{width:1px;height:10px;flex:none;margin-inline:4px;background:var(--dsw-alias-border-l2,currentColor);}
		.dsh-btw-think-preview{min-width:0;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-bubble{max-width:85%;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px;padding:8px 12px;border-radius:12px;}
		.dsh-btw-msg.user .dsh-btw-bubble{background:var(--dsw-specific-selector,#e8e8e8);color:var(--dsw-alias-label-primary,#0f1115);border-bottom-right-radius:4px;}
		/* Assistant正文 is unboxed, unlike the right-aligned user bubble. */
		.dsh-btw-prose{min-width:0;width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere;}
		.dsh-btw-plain{white-space:pre-wrap;}
		.dsh-btw-prose pre{max-width:100%;overflow:auto;white-space:pre;}
		.dsh-btw-prose img,.dsh-btw-prose video{max-width:100%;}
		.dsh-btw-prose table{display:block;max-width:100%;overflow-x:auto;}
		.dsh-btw-msg.error .dsh-btw-prose{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-mfoot{flex:none;padding:10px 12px 12px;}
		.dsh-btw-mcard{--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border:0;background:var(--dsw-specific-input-major,#fff);border-radius:var(--dsw-radius-panel,24px);box-shadow:var(--dsw-elevation-soft,inset 0 0 0 1px var(--btw-soft-edge));padding:8px 0 0;display:flex;flex-direction:column;gap:12px;min-width:0;}
		.dsh-btw-modal[data-small=true] .dsh-btw-mcard{box-shadow:none;}
		.dsh-btw-mta{display:block;resize:none;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));padding:0 14px;max-height:140px;field-sizing:content;}
		.dsh-btw-mcard>.dsh-btw-tools{flex-wrap:nowrap;padding:2px 8px 6px;gap:4px;}
		.dsh-btw-modal[data-small=true] .dsh-btw-mcard>.dsh-btw-tools{padding:0;}
		.dsh-btw-mcard>.dsh-btw-tools>label:first-child{margin-inline-end:auto;}
		.dsh-btw-mcard>.dsh-btw-tools .dsh-btw-select{padding:4px 6px;}
		.dsh-btw-voice{display:inline-flex;flex:none;}
		.dsh-btw-voice-spinner{width:14px;height:14px;border:2px solid var(--btw-soft-edge);border-top-color:currentColor;border-radius:50%;animation:dsh-btw-voice-spin .8s linear infinite;}
		@keyframes dsh-btw-voice-spin{to{transform:rotate(360deg)}}
		.dsh-btw-voice-error{position:absolute;inset-inline:12px;bottom:100%;z-index:4;padding:6px 8px;border-radius:8px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;box-shadow:var(--dsw-shadow-lv2,0 1px 4px #0002);}
		.dsh-btw-mcard{position:relative;}
		.dsh-btw-model-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:360px;height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-secondary,#57585a);font:inherit;font-size:13px;line-height:20px;cursor:pointer;}
		.dsh-btw-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-model-trigger:disabled{opacity:.45;cursor:default;}
		.dsh-btw-model-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-model-menu-row{display:flex;align-items:center;gap:6px;width:100%;min-width:0;font-size:13px;line-height:20px;}
		.dsh-btw-model-label,.dsh-btw-model-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-model-detail{color:var(--dsw-alias-label-caption,#81858c);}
		.dsh-btw-model-menu-row .dsh-btw-model-detail{margin-inline-start:auto;}
		.dsh-btw-model-icon{display:var(--dsh-composer-model-icon-display,none);flex:none;}
		.dsh-btw-model-trigger>.dsh-btw-model-detail{display:var(--dsh-composer-model-text-display,block);flex-shrink:1000;}
		.dsh-btw-effort{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-option-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);}
		.dsh-btw-mta::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-control,.dsh-btw-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#57585a);border:0;background:transparent;border-radius:var(--dsw-radius-md,8px);padding:8px;cursor:pointer;corner-shape:superellipse(1.5);}
		.dsh-btw-control:hover,.dsh-btw-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-control:disabled,.dsh-btw-select:disabled{opacity:.45;cursor:default;}
		.dsh-btw-select{max-width:100%;min-width:0;}
		.dsh-btw-picker{max-width:100%;min-width:0;display:inline-flex;}
		.dsh-btw-picker-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;text-align:start;}
		.dsh-btw-picker-trigger>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-picker-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:2px;}
		/* Native Menu portals escape card clipping; its default z-index is below our veil. */
		.dsh-btw-picker-menu[data-menu-material]{z-index:9010;max-width:min(360px,calc(100vw - 24px),var(--dsh-anchored-max-width,100vw));font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-picker-menu [role=menuitem]{scroll-margin-block:4px;}
		.dsh-btw-picker-label{white-space:normal;overflow-wrap:anywhere;}
		.dsh-btw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;}
		.dsh-btw-tools{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;}
		.dsh-btw-tools>label,.dsh-btw-tools>span{min-width:0;max-width:100%;}
		.dsh-btw-tools .dsh-btw-err{overflow-wrap:anywhere;}
		.dsh-btw-mta{width:100%;box-sizing:border-box;min-height:24px;}
		.dsh-btw-standalone{width:100%;height:100%;min-height:0;}
		.dsh-btw-standalone [data-global=true] .dsh-btw-mcard::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;corner-shape:inherit;border:2px dashed var(--btw-temp-composer-stroke);}
		.dsh-btw-standalone [data-global=true] .dsh-btw-msg.user .dsh-btw-bubble{box-shadow:inset 0 0 0 1px var(--btw-soft-edge);}
		.dsh-btw-standalone .dsh-btw-mhead{min-height:64px;padding:10px 34px;}
		.dsh-btw-standalone .dsh-btw-mfoot{box-sizing:border-box;width:min(var(--btw-width,740px),calc(100% - 32px));margin:0 auto;padding:10px 0 24px;}
		.dsh-btw-standalone .dsh-btw-mbody>.dsh-btw-msg{box-sizing:border-box;width:100%;max-width:var(--btw-width,740px);margin-inline:auto;}
		.dsh-btw-resize{position:absolute;border:0;padding:0;background:transparent;touch-action:none;z-index:2;}
		.dsh-btw-resize:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:-3px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-resize[data-edge=n],.dsh-btw-resize[data-edge=s]{left:16px;right:16px;height:8px;cursor:ns-resize;}
		.dsh-btw-resize[data-edge=n]{top:0}.dsh-btw-resize[data-edge=s]{bottom:0}
		.dsh-btw-resize[data-edge=e],.dsh-btw-resize[data-edge=w]{top:16px;bottom:16px;width:8px;cursor:ew-resize;}
		.dsh-btw-resize[data-edge=e]{right:0}.dsh-btw-resize[data-edge=w]{left:0}
		.dsh-btw-resize[data-edge=ne],.dsh-btw-resize[data-edge=nw],.dsh-btw-resize[data-edge=se],.dsh-btw-resize[data-edge=sw]{width:16px;height:16px;}
		.dsh-btw-resize[data-edge=ne]{top:0;right:0;cursor:nesw-resize}.dsh-btw-resize[data-edge=sw]{bottom:0;left:0;cursor:nesw-resize}
		.dsh-btw-resize[data-edge=nw]{top:0;left:0;cursor:nwse-resize}.dsh-btw-resize[data-edge=se]{bottom:0;right:0;cursor:nwse-resize}
		.dsh-btw-inline .dsh-btw-modal{max-width:100%;container-type:inline-size;}
		/* Same base inset, dock clearance and trailing group as DSH InputBar. */
		.dsh-btw-inline .dsh-btw-mfoot{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,952px) + 2 * var(--dsh-composer-side-clearance,16px));margin-inline:auto;padding:0 var(--dsh-composer-side-clearance,16px) var(--btw-source-bottom,calc(26px + var(--dsh-content-font-delta-secondary,0px)));}
		.dsh-btw-inline .dsh-btw-mcard{box-sizing:border-box;min-height:var(--btw-source-card-min,0px);}
		.dsh-btw-inline .dsh-btw-mta{min-height:var(--btw-source-editor-min,36px);max-height:var(--dsh-composer-text-max-height,336px);padding:4px 12px 0 14px;}
		.dsh-btw-inline .dsh-btw-mcard>.dsh-btw-tools{justify-content:space-between;gap:8px;flex-wrap:wrap;}
		.dsh-btw-composer-leading,.dsh-btw-composer-trailing{display:flex;align-items:center;min-width:0;}
		.dsh-btw-composer-trailing{gap:8px;margin-inline-start:auto;}
		.dsh-btw-composer-leading>label,.dsh-btw-composer-trailing>span{min-width:0;}
		.dsh-btw-inline .dsh-btw-go{transform:translateY(-2px);}
		.dsh-btw-sidebar-glyph{display:inline-flex;transform:scaleX(-1);}
		.dsh-btw-window-controls{display:inline-flex;align-items:center;gap:2px;flex:none;}
		.dsh-btw-window-control{display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;padding:5px;}
		.dsh-btw-window-control[aria-pressed=true]{background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-window-control:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:1px;}
		.dsh-btw-window-control:disabled{opacity:.4;cursor:default;}
		.dsh-btw-window-tooltip{display:inline-flex;}
		.dsh-btw-mhead[data-draggable=true]{cursor:move;touch-action:none;user-select:none;}
		`;
		function createViews({ React, geometry, messageView, modelKey, modelValue, parseModel, catalog, loadModels, loadModelOptions, speech, minimizeTemp, getSidebar, getLayout, getComposerBridge, controllers, tempRegistry, focusTemp, updateGeometry, setWindowPinned, openTemp, presentTemp, registerEscapeSurface }) {
			const { useEffect, useLayoutEffect, useRef, useState } = React;
			const h = React.createElement;
			const { geometryKey, clampGeometry, resizeHandles, storedGeometry, persistGeometry, dockBounds, clampDockGeometry } = geometry;
			// Only public primitives. No native pop-out/window glyph is exported:
			// that one uses a small semantic SVG, not Pin or a text-arrow substitute.
			function windowGlyph(mode) {
				const Icon = nativeIcons[mode === "global" ? "FullscreenOutline" : mode === "sidebar" ? "PanelLeftOutline" : ""];
				if (Icon) {
					const glyph = h(Icon, { size: 16, "aria-hidden": true });
					// DSH mirrors PanelLeft via CSS in the right sidebar. Apply it
					// to our wrapper so the primitive need not forward inline styles.
					return mode === "sidebar" ? h("span", { className: "dsh-btw-sidebar-glyph", "aria-hidden": true }, glyph) : glyph;
				}
				return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.25, "aria-hidden": true },
					mode === "overlay" ? [h("rect", { key: "back", x: 2, y: 2, width: 8, height: 7, rx: 1 }), h("rect", { key: "front", x: 6, y: 6, width: 8, height: 8, rx: 1 })]
						: mode === "sidebar" || mode === "dock" ? [h("rect", { key: "frame", x: 2, y: 2, width: 12, height: 12, rx: 1 }), h("path", { key: "seat", d: mode === "dock" ? "M2 10h12" : "M10 2v12" })]
							: h("path", { d: "M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" }));
			}
			function iconButton({ label, tooltip = label, pressed, disabled, onClick, mode, icon }) {
				const button = h(SharedButton || "button", { type: "button", ...(SharedButton ? { size: "sm" } : {}), className: "dsh-btw-control dsh-btw-window-control",
					"aria-label": label, "aria-pressed": pressed, "data-btw-mode": mode, title: tooltip, disabled,
					onClick: () => { if (!disabled) onClick(); } }, icon || windowGlyph(mode));
				return SharedTooltip ? h(SharedTooltip, { label: tooltip, side: "bottom", delayMs: 500, portal: true }, h("span", { className: "dsh-btw-window-tooltip" }, button)) : button;
			}
			const WINDOW_LABELS = { dock: "返回输入框上方", overlay: "浮动小窗", sidebar: "停靠侧边栏", global: "全屏" };
			function actionGlyph(kind) {
				const Icon = kind === "new" ? nativeIcons.PlusOutline : nativeIcons.CheckSquareOutline || nativeIcons.CheckboxCheckedOutline;
				if (Icon) return h(Icon, { size: 16, "aria-hidden": true });
				return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
					kind === "new" ? h("path", { d: "M8 3v10M3 8h10" }) : h("path", { d: "M13.5 8v4a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h6M6 7.5l2.25 2.25L13.5 4.5" }));
			}
			function windowControls({ presentation, sourceId, disabled, onChange }) {
				const right = getSidebar(), layout = getLayout();
				const sourceMounted = !!sourceId && (right?.mounted?.getSnapshot() === sourceId || getComposerBridge?.()?.sessionId === sourceId);
				const sidebarAvailable = !!right && !!sourceId && (presentation === "global" || right.mounted?.getSnapshot() === sourceId);
				const modes = presentation === "sidebar" ? [sourceMounted ? "dock" : null, "overlay"] : [
					presentation !== "overlay" ? "overlay" : sourceMounted ? "dock" : null,
					sidebarAvailable ? "sidebar" : null,
					layout && presentation !== "global" ? "global" : null,
				].filter(Boolean);
				return modes.length ? h("div", { className: "dsh-btw-window-controls", role: "group", "aria-label": "切换窗口" },
					...modes.map(mode => iconButton({ mode, label: WINDOW_LABELS[mode], disabled, onClick: () => onChange(mode) }))) : null;
			}
			/** rc.1 Menu owns positioning, outside dismissal, IME-safe Escape,
			 * arrow/Home/End navigation and focus return. onSelect does NOT close it.
			 * Use its public items contract, never the private session ModelSelect. */
			function ChoiceMenu({ value, options, onChange, disabled, label, title }) {
				const [open, setOpen] = useState(false);
				useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
				const selected = options.find((option) => option.value === value);
				const close = () => setOpen(false);
				return h(SharedMenu, {
					open: open && !disabled, onClose: close,
					portal: true, side: "top", align: "end", autoFocus: true,
					className: "dsh-btw-picker", listClassName: "dsh-btw-picker-menu",
					selectedId: value,
					items: options.map((option) => ({ id: option.value, label: h("span", { className: "dsh-btw-picker-label" }, option.label,
						option.value === value ? h("span", { className: "dsh-btw-sr" }, "（已选择）") : null) })),
					onSelect: (next) => {
						close();
						if (!disabled && options.some((option) => option.value === next)) onChange(next);
					},
					anchor: h("button", {
						type: "button", className: "dsh-btw-select dsh-btw-picker-trigger", disabled, title,
						"aria-label": label + "：" + (selected?.label || value), "aria-haspopup": "menu", "aria-expanded": open && !disabled,
						onClick: () => { if (!disabled) setOpen((wasOpen) => !wasOpen); },
						onKeyDown: (e) => {
							const ime = e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229;
							if (!open && !disabled && !ime && !e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
								e.preventDefault(); e.stopPropagation(); setOpen(true);
							}
						},
					}, h("span", null, selected?.label || value), h(SharedChevron || "svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", "aria-hidden": true, style: { flex: "none", transform: open ? "rotate(180deg)" : undefined } }, SharedChevron ? null : h("path", { d: "m4 6 4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))),
				});
			}
			function choiceSelect(props, options) {
				if (SharedMenu) return h(ChoiceMenu, { ...props, options });
				const { label, value, disabled, title, onChange } = props;
				return h("select", { className: "dsh-btw-select", "aria-label": label, value, disabled, title, onChange: (e) => { if (!disabled) onChange(e.target.value); } },
					...options.map((option) => h("option", { key: option.value, value: option.value }, option.label)));
			}
			const CONTEXT_OPTIONS = [{ value: "none", label: "无上下文" }, { value: "recent", label: "最近对话" }, { value: "on-demand", label: "按需搜索近期快照" }, { value: "all", label: "全部对话" }];
			function ModelSelect({ value, onChange, disabled, tuning }) {
				const models = catalog.use();
				const known = models.providers.some((p) => p.models.some((m) => modelKey(p.id, m.id) === value));
				const options = [
					{ value: "default", label: "默认" },
					...(value !== "default" && !known ? [{ value, label: "已保存模型不可用" }] : []),
					...models.providers.flatMap((p) => p.models.map((m) => ({ value: modelKey(p.id, m.id), label: p.id + " / " + m.name }))),
				];
				return h("span", null, tuning && SharedMenu && loadModelOptions
					? h(ComposerModelMenu, { value, onChange, disabled, ...tuning, models })
					: choiceSelect({ label: "模型", value, disabled, onChange }, options),
					models.status === "error" ? h("span", { className: "dsh-btw-err", role: "status" }, " 模型列表加载失败：" + models.error, " ", h("button", { type: "button", onClick: loadModels }, "重试")) : null);
			}
			function ComposerModelMenu({ value, onChange, disabled, sourceId, effort, onEffortChange, models }) {
				const [open, setOpen] = useState(false), [pane, setPane] = useState("root"), [info, setInfo] = useState(null);
				const request = useRef(null);
				const model = models.providers.flatMap(p => p.models.map(m => ({ ...m, key: modelKey(p.id, m.id), provider: p.id }))).find(m => m.key === value);
				const modelLabel = value === "default" ? "默认" : model?.name || "已保存模型不可用";
				const current = info?.value === value ? info : null;
				const levels = current?.reasoning?.efforts || [];
				const effortLabel = effort ? levels.find(level => level.id === effort)?.name || effort : "";
				const close = () => { setOpen(false); setPane("root"); };
				useEffect(() => () => { request.current = null; }, [value, sourceId]);
				useEffect(() => { if (disabled && open) close(); }, [disabled, open]);
				async function resolveOptions() {
					const token = request.current = {};
					setInfo({ value, loading: true });
					try {
						const result = await loadModelOptions(parseModel(value), sourceId);
						if (request.current === token) setInfo({ value, ...result });
					} catch (error) {
						if (request.current === token) setInfo({ value, error: error.message });
					}
				}
				function show() {
					setPane("root"); setOpen(true);
					if (!current || current.error) void resolveOptions();
				}
				const LabelIcon = nativeIcons.DataOutline;
				const DrillIcon = nativeIcons.ChevronRightOutline;
				const BackIcon = nativeIcons.ChevronLeftOutline;
				const menuRow = (name, detail, Icon, canDrill = true) => h("span", { className: "dsh-btw-model-menu-row" },
					Icon ? h(Icon, { size: 16, "aria-hidden": true }) : null,
					h("span", null, name), h("span", { className: "dsh-btw-model-detail" }, detail),
					canDrill ? DrillIcon ? h(DrillIcon, { size: 12, "aria-hidden": true }) : "›" : null);
				const back = { id: "back", label: h("span", { className: "dsh-btw-model-menu-row" }, BackIcon ? h(BackIcon, { size: 12, "aria-hidden": true }) : "‹", pane === "model" ? "模型" : "推理强度") };
				const items = pane === "root" ? [
					{ id: "model", label: menuRow("模型", modelLabel, LabelIcon) },
					...(current?.loading || current?.error || levels.length ? [{ id: "effort", label: menuRow("推理强度", effortLabel || (current?.loading ? "加载中…" : "默认"), SharedThinkIcon) }] : []),
				] : pane === "model" ? [
					back, { id: "default", label: "默认" },
					...models.providers.flatMap(p => p.models.map(m => ({ id: modelKey(p.id, m.id), label: menuRow(m.name, p.id, null, false) }))),
				] : [
					back,
					...(current?.loading ? [{ id: "loading", label: "正在加载…" }] : current?.error ? [{ id: "retry", label: "重试" }] : [
						{ id: "effort:", label: "默认强度" },
						...levels.map(level => ({ id: "effort:" + level.id, label: level.name || level.id })),
					]),
				];
				return h(SharedMenu, {
					open: open && !disabled, onClose: close, portal: true, side: "top", align: "end", autoFocus: true,
					className: "dsh-btw-picker", listClassName: "dsh-btw-picker-menu dsh-btw-model-menu", items,
					selectedId: pane === "model" ? value : pane === "effort" ? "effort:" + effort : undefined,
					onSelect: id => {
						if (!open || disabled || !items.some(item => item.id === id)) return;
						if (id === "back") { setPane("root"); return; }
						if (pane === "root") { setPane(id); return; }
						if (pane === "model") { onChange(id); close(); return; }
						if (id === "retry") { void resolveOptions(); return; }
						if (id.startsWith("effort:")) {
							onEffortChange(id.slice(7));
							close();
						}
					},
					anchor: h("button", { type: "button", className: "dsh-btw-model-trigger", disabled,
						"aria-label": "模型：" + modelLabel + (effortLabel ? " · " + effortLabel : ""), title: value === "default" ? (sourceId ? "跟随来源会话" : "使用 DSH 默认模型") : modelLabel,
						"aria-haspopup": "menu", "aria-expanded": open && !disabled,
						onClick: () => { if (open) close(); else show(); },
						onKeyDown: e => { if (!open && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !e.nativeEvent?.isComposing && e.keyCode !== 229 && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); e.stopPropagation(); show(); } },
					}, LabelIcon ? h(LabelIcon, { className: "dsh-btw-model-icon", size: 16, "aria-hidden": true }) : null,
						h("span", { className: "dsh-btw-model-label" }, modelLabel), effortLabel ? h("span", { className: "dsh-btw-model-detail" }, effortLabel) : null,
						SharedChevron ? h(SharedChevron, { size: 12, "aria-hidden": true }) : "⌄"),
				});
			}
			function ReasoningSelect({ controller, choice, sourceId, value }) {
				const [info, setInfo] = useState(null);
				const request = useRef(null);
				useEffect(() => () => { request.current = null; }, [choice, sourceId]);
				const current = info?.choice === choice && info.sourceId === sourceId ? info : null;
				if (!current || current.error) return h("button", { type: "button", className: "dsh-btw-select dsh-btw-effort", "aria-label": "推理强度", title: current?.error || "仅调整这条 BTW 的推理强度", disabled: current?.loading,
					onClick: async () => {
						const token = request.current = {};
						setInfo({ choice, sourceId, loading: true });
						try {
							const model = await loadModelOptions(parseModel(choice), sourceId);
							if (request.current === token) setInfo({ choice, sourceId, ...model });
						} catch (error) { if (request.current === token) setInfo({ choice, sourceId, error: error.message }); }
					} }, current?.loading ? "加载中…" : current?.error ? "重试推理强度" : "推理强度");
				const levels = current.reasoning?.efforts?.filter(level => typeof level.id === "string" && level.id);
				if (!levels?.length) return h("span", { className: "dsh-btw-option-note", role: "status" }, "此模型不支持调整推理强度");
				const options = [{ value: "", label: "默认强度" }, ...levels.map(level => ({ value: level.id, label: level.name || level.id }))];
				return choiceSelect({ label: "推理强度", value: value || "", onChange: (next) => {
					const s = controller.store.state;
					if (s.phase === "configuring" && s.modelChoice === choice) controller.store.patch({ reasoningEffort: next });
				} }, options);
			}
			// The host supplies the selected speech provider; capture and draft
			// ownership stay inside this BTW editor, never the parent composer.
			let activeVoice;
			function releaseVoice(run) {
				if (activeVoice === run) activeVoice = null;
				clearTimeout(run.timer);
				if (run.recorder?.state === "recording" || run.recorder?.state === "paused") run.recorder.stop();
				for (const track of run.stream?.getTracks() || []) track.stop();
			}
			async function voiceWav(chunks, mimeType, limit, seconds) {
				const blob = new Blob(chunks, { type: mimeType });
				if (!blob.size || blob.size > limit) throw new Error("录音为空或超过大小限制");
				const decoder = new AudioContext();
				let decoded;
				try { decoded = await decoder.decodeAudioData(await blob.arrayBuffer()); }
				finally { await decoder.close(); }
				const length = Math.max(1, Math.floor(Math.min(decoded.duration, seconds) * 16000));
				if (44 + length * 2 > limit) throw new Error("录音超过大小限制");
				const render = new OfflineAudioContext(1, length, 16000);
				const source = render.createBufferSource();
				source.buffer = decoded;
				source.connect(render.destination);
				source.start();
				const samples = (await render.startRendering()).getChannelData(0);
				const wav = new Uint8Array(44 + samples.length * 2), view = new DataView(wav.buffer);
				for (const [at, word] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]]) for (let i = 0; i < word.length; i++) wav[at + i] = word.charCodeAt(i);
				for (const [at, number] of [[4, wav.length - 8], [16, 16], [24, 16000], [28, 32000], [40, samples.length * 2]]) view.setUint32(at, number, true);
				for (const [at, number] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(at, number, true);
				for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
				const parts = [];
				for (let i = 0; i < wav.length; i += 8192) parts.push(String.fromCharCode(...wav.subarray(i, i + 8192)));
				return btoa(parts.join(""));
			}
			// Mirror the installed VoiceSetupDialog's public Modal/Button contract.
			// Prefer its own live translations when the voice bundle registered them.
			const voiceSetupLabels = {
				zh: { cancel: "取消", "setupPrompt.later": "稍后", "setupPrompt.title": "使用语音输入前需要安装", "setupPrompt.open": "前往安装",
					"setupPrompt.body": "语音输入插件已开启。首次使用需要在本机下载并准备识别模型，请前往插件详情页查看空间、内存和时间说明，再开始安装。",
					"setupPrompt.unavailableTitle": "语音识别尚未就绪", "setupPrompt.details": "前往语音插件设置", "setupPrompt.unavailableBody": "请前往语音插件详情页查看识别服务状态、准备进度或错误信息" },
				en: { cancel: "Cancel", "setupPrompt.later": "Later", "setupPrompt.title": "Set up voice input before recording", "setupPrompt.open": "Go to setup",
					"setupPrompt.body": "Voice input is enabled. First use requires downloading and preparing local recognition models. Open the plugin details to review disk space, memory and time estimates before starting setup.",
					"setupPrompt.unavailableTitle": "Speech recognition is not ready", "setupPrompt.details": "Open voice plugin settings", "setupPrompt.unavailableBody": "Open the voice plugin details to check recognition status, preparation progress, or errors." },
			};
			function voiceSetupCopy(translate, key) {
				try {
					const value = translate?.(key);
					if (value && value !== key && value !== "voice-input:" + key) return value;
				} catch { /* voice locale may be withdrawn independently */ }
				return voiceSetupLabels[/^en(?:-|$)/i.test(document.documentElement?.lang || "") ? "en" : "zh"][key];
			}
			function VoiceInput({ remote, navigation, t, controller, editor, disabled }) {
				const [phase, setPhase] = useState("idle"), [error, setError] = useState(""), [setup, setSetup] = useState(null);
				const current = useRef(null);
				const cancel = () => {
					const run = current.current;
					if (run) { current.current = null; run.abort.abort(); releaseVoice(run); }
				};
				useEffect(() => {
					// Match the official control: Escape cancels capture, not the chat.
					const onKey = event => {
						if (event.key === "Escape" && current.current && !event.defaultPrevented) {
							event.preventDefault(); cancel(); setPhase("idle");
						}
					};
					document.addEventListener("keydown", onKey, true);
					return () => { document.removeEventListener("keydown", onKey, true); cancel(); };
				}, [remote, controller]);
				const fail = (run, failure) => {
					if (current.current !== run) return;
					cancel(); setPhase("idle");
					setError(failure instanceof Error ? failure.message : String(failure));
				};
				const begin = async () => {
					if (current.current || disabled) return;
					if (activeVoice) { setError("请先结束另一条 BTW 的录音"); return; }
					const run = current.current = activeVoice = { abort: new AbortController() };
					const initialDraft = controller.store.state.draft;
					const caret = editor.current?.selectionEnd ?? initialDraft.length;
					setError(""); setSetup(null); setPhase("starting");
					try {
						const result = await remote.catalog();
						if (current.current !== run) return;
						const config = result?.value;
						const provider = config?.providers?.find(p => p.id === config.selection?.providerId);
						if (!result?.ok || !provider || !["ready", "standby", "waking"].includes(provider.preparation?.phase)) {
							cancel(); setPhase("idle");
							setSetup(result?.ok && provider?.location === "host-local" && provider.preparation?.phase === "unprepared" ? "install" : "unavailable");
							return;
						}
						const seconds = Math.min(config.maxDurationSeconds, 180);
						const limit = Math.min(config.maxAudioBytes, 12 * 1024 * 1024);
						if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(limit) || limit <= 44) throw new Error("DSH 返回了无效的录音限制");
						if (current.current !== run) return;
						const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
						run.stream = stream;
						if (current.current !== run) { releaseVoice(run); return; }
						const recorder = run.recorder = new MediaRecorder(stream), chunks = [];
						let bytes = 0;
						recorder.ondataavailable = event => {
							if (current.current !== run || !event.data.size) return;
							bytes += event.data.size;
							if (bytes > limit) { fail(run, "录音超过大小限制"); return; }
							chunks.push(event.data);
						};
						recorder.onerror = () => fail(run, "录音失败，请检查麦克风");
						recorder.onstop = async () => {
							for (const track of stream.getTracks()) track.stop();
							clearTimeout(run.timer);
							if (current.current !== run) return;
							setPhase("transcribing");
							try {
								const audioBase64 = await voiceWav(chunks, recorder.mimeType, limit, seconds);
								if (current.current !== run) return;
								const result = await remote.transcribe({ audioBase64, providerId: config.selection.providerId, language: config.selection.language }, run.abort.signal);
								if (current.current !== run) return;
								const words = result?.value?.text?.trim();
								if (!result?.ok || !words) throw new Error(result?.error?.message || "没有识别到语音");
								const state = controller.store.state;
								if (!["configuring", "active"].includes(state.phase)) { cancel(); setPhase("idle"); return; }
								const position = state.draft === initialDraft ? caret : state.draft.length;
								const left = state.draft.slice(0, position), right = state.draft.slice(position);
								controller.store.patch({ draft: left + (left && !/\s$/u.test(left) ? " " : "") + words + (right && !/^\s/u.test(right) ? " " : "") + right });
								cancel(); setPhase("idle"); editor.current?.focus();
							} catch (error) { fail(run, error); }
						};
						recorder.start(250);
						run.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, seconds * 1000);
						setPhase("recording");
					} catch (error) { fail(run, error); }
				};
				const label = phase === "recording" ? "结束录音并转录" : phase === "starting" || phase === "transcribing" ? "取消语音输入" : "语音输入";
				const Icon = nativeIcons.MicrophoneOutline;
				const dismissSetup = () => setSetup(null);
				const copy = key => voiceSetupCopy(t, key);
				const setupTitle = setup ? copy(setup === "install" ? "setupPrompt.title" : "setupPrompt.unavailableTitle") : "";
				const setupBody = setup ? copy(setup === "install" ? "setupPrompt.body" : "setupPrompt.unavailableBody") : "";
				const footer = setup ? [
					h(SharedButton || "button", { key: "later", type: "button", variant: "ghost", onClick: dismissSetup }, copy("setupPrompt.later")),
					typeof navigation?.openBundle === "function" ? h(SharedButton || "button", { key: "details", type: "button", variant: "primary", "data-modal-autofocus": true, onClick: () => {
						dismissSetup();
						navigation.openBundle("@deepseek-ai/dsh-experimental-voice-input-bundle");
					} }, copy(setup === "install" ? "setupPrompt.open" : "setupPrompt.details")) : null,
				] : null;
				return h("span", { className: "dsh-btw-voice" },
					iconButton({ label, pressed: phase === "recording", disabled: disabled && phase === "idle",
						onClick: () => {
							if (phase === "recording") { if (current.current?.recorder.state === "recording") current.current.recorder.stop(); }
							else if (phase !== "idle") { cancel(); setPhase("idle"); }
							else void begin();
						},
						icon: phase === "starting" || phase === "transcribing" ? h("span", { className: "dsh-btw-voice-spinner", "aria-hidden": true }) : phase === "recording" ? h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true }, h("rect", { x: 4, y: 4, width: 8, height: 8, rx: 2, fill: "currentColor" }))
							: Icon ? h(Icon, { size: 16, "aria-hidden": true }) : h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", "aria-hidden": true }, h("rect", { x: 6, y: 2, width: 4, height: 8, rx: 2 }), h("path", { d: "M4 8a4 4 0 0 0 8 0m-4 4v2m-2 0h4" })) }),
					error ? h("span", { className: "dsh-btw-voice-error", role: "status" }, error) : null,
					setup && SharedModal ? h(SharedModal, { open: true, title: setupTitle, closeLabel: copy("cancel"), onClose: dismissSetup, footer }, h("p", null, setupBody))
						: setup ? h("span", { className: "dsh-btw-voice-error", role: "status" }, h("strong", null, setupTitle), " ", setupBody, " ", footer) : null);
			}
			// Fixed is a layout adapter only. The same controller and shared view
			// own all drafts, messages, sends and cleanup in every presentation.
			function BtwDockView({ controller, renderFactorySlot }) {
				const s = controller.store.state;
				const stageRef = useRef(null), dockResize = useRef(null), dockGeometryRef = useRef(null), dockKeyRef = useRef(null), dockMemory = useRef(null);

				const [dockSize, setDockSize] = useState(null);
				// Reset older width/height records once: the dock now follows the
				// composer width and remembers only explicit height adjustments.
				const dockKey = s.originId && !s.cwd ? "" : geometryKey(s.cwd) + "/dock-v3";
				if (dockMemory.current?.key !== dockKey) {
					const value = storedGeometry(dockKey);
					dockMemory.current = { key: dockKey, manual: !!value, value };
				}
				const clampDock = (value) => clampDockGeometry(value, stageRef.current);
				const dockGeometry = clampDock(dockMemory.current.manual ? dockKeyRef.current === dockKey && dockSize || dockMemory.current.value : {});
				dockGeometryRef.current = dockGeometry;
				const writeDock = (value) => {
					const geometry = clampDock(value);
					dockMemory.current = { key: dockKey, manual: true, value: geometry };
					dockKeyRef.current = dockKey;
					dockGeometryRef.current = geometry; setDockSize(geometry);
					persistGeometry(dockKey, { height: geometry.height });
				};
				useEffect(() => {
					dockKeyRef.current = dockKey;
					// Measurement never turns a default into a saved manual size. In

					// particular, first-paint fallback width must not pin the host column.
					const resize = () => {
						const measured = clampDock(dockMemory.current.manual ? dockGeometryRef.current : {});
						dockGeometryRef.current = measured; setDockSize(measured);
					};
					resize();
					window.addEventListener?.("resize", resize);
					const observer = typeof ResizeObserver === "function" && stageRef.current ? new ResizeObserver(resize) : null;
					if (observer) observer.observe(stageRef.current);
					return () => { observer?.disconnect(); window.removeEventListener?.("resize", resize); dockResize.current = null; };
				}, [dockKey]);

				return h("div", { className: "dsh-btw-dock" }, h("div", { className: "dsh-btw-dock-stage", ref: stageRef },
					h(BtwTempView, { controller, renderFactorySlot, dock: true, dockStyle: { width: "100%", height: dockGeometry.height, "--btw-dock-max-height": dockBounds(stageRef.current).maxHeight + "px" },
						dockHandles: resizeHandles({ gesture: dockResize, label: "侧问小窗", edges: ["n"], bounds: () => dockBounds(stageRef.current),
							read: () => { const g = clampDock(dockGeometryRef.current); return { ...g, y: dockBounds(stageRef.current).maxHeight - g.height }; }, write: writeDock }) })));
			}
			function BtwTempView({ controller, inline = false, standalone = false, dock = false, dockStyle, dockHandles, alignSourceComposer, renderFactorySlot }) {
				const globalLayout = getLayout();
				const speechService = speech?.use(), speechRemote = speechService?.remote;
				const small = dock || !inline && !standalone;
				tempRegistry.use();
				const s = controller.store.use();
				const patch = (fields) => controller?.store.patch(fields);
				const { beginTemp, sendTemp, closeTemp, insertSelected, toggleMessage } = controller;
				const draft = s.draft, setDraft = (value) => patch({ draft: value });
				const bodyRef = useRef(null), taRef = useRef(null), rowRef = useRef(null), composing = useRef(false), modalRef = useRef(null), drag = useRef(null), resizing = useRef(null);
				useLayoutEffect(() => {
					const panel = modalRef.current, id = s.originId;
					if (!inline || !alignSourceComposer || !panel || !id || typeof ResizeObserver !== "function") return;
					const selector = `[data-conversation-session=${JSON.stringify(id)}]`;
					let frame = null, source, editor;
					const set = (name, value) => {
						const next = Number.isFinite(value) ? Math.round(value * 100) / 100 + "px" : "";
						if (panel.style.getPropertyValue(name) === next) return;
						if (next) panel.style.setProperty(name, next);
						else panel.style.removeProperty(name);
					};
					const clear = () => { for (const name of ["--btw-source-bottom", "--btw-source-card-min", "--btw-source-editor-min"]) set(name); };
					const measure = () => {
						const card = document.querySelector(selector)?.querySelector("[data-composer-card]");
						const input = card?.querySelector('[contenteditable][role="textbox"], [contenteditable="true"], textarea');
						if (card !== source || input !== editor) {
							if (source) resize.unobserve(source);
							if (editor) resize.unobserve(editor);
							source = card; editor = input;
							if (source) resize.observe(source);
							if (editor) resize.observe(editor);
						}
						if (!source || !editor) { clear(); return; }
						const base = panel.getBoundingClientRect(), ref = source.getBoundingClientRect();
						// Use the scroll wrapper's allocated space, not the editable's
						// ink box (DSH can put a separate placeholder in that wrapper).
						let field = editor;
						while (field.parentElement && field.parentElement !== source) field = field.parentElement;
						const min = parseFloat(getComputedStyle(editor).minHeight);
						const height = Math.max(0, ref.height - field.getBoundingClientRect().height + min);
						const bottom = base.bottom - ref.bottom;
						// If the host parks the source off-screen or the sidebar is too
						// short, keep a usable composer at the local bottom instead.
						if (!ref.height || !min || bottom < -2 || bottom + height + 72 > base.height) { clear(); return; }
						set("--btw-source-bottom", Math.max(0, bottom));
						set("--btw-source-card-min", height);
						set("--btw-source-editor-min", min);
					};
					const schedule = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); }); };
					const resize = new ResizeObserver(schedule);
					resize.observe(panel);
					const mutations = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
					const root = document.querySelector(selector);
					if (root) mutations?.observe(root, { childList: true, subtree: true });
					window.addEventListener("resize", schedule);
					document.addEventListener("scroll", schedule, true);
					measure();
					return () => {
						if (frame !== null) cancelAnimationFrame(frame);
						resize.disconnect(); mutations?.disconnect();
						window.removeEventListener("resize", schedule);
						document.removeEventListener("scroll", schedule, true);
						clear();
					};
				}, [inline, alignSourceComposer, s.originId]);
				const dividerDrag = useRef(null);
				const minEditor = 24, maxEditor = Math.max(minEditor, Math.min(224, (dock ? dockStyle.height : s.height) - 120));
				const [editorHeight, setEditorHeight] = useState(null);
				const clampEditor = value => Math.round(Math.max(minEditor, Math.min(maxEditor, value)));
				const currentEditorHeight = () => clampEditor(editorHeight ?? taRef.current?.getBoundingClientRect?.().height ?? minEditor);
				const divider = small ? h("div", { className: "dsh-btw-composer-divider", role: "separator", tabIndex: 0, "aria-orientation": "horizontal",
					"aria-label": "调整输入框高度", "aria-valuemin": minEditor, "aria-valuemax": maxEditor, "aria-valuenow": clampEditor(editorHeight ?? minEditor),
					title: "上下拖动或按 ↑ ↓ 调整输入框高度；双击恢复",
					onPointerDown: e => {
						if (e.button !== 0) return;
						dividerDrag.current = { pointer: e.pointerId, y: e.clientY, height: currentEditorHeight() };
						e.currentTarget.setPointerCapture?.(e.pointerId);
						e.preventDefault();
					},
					onPointerMove: e => {
						const from = dividerDrag.current;
						if (from?.pointer === e.pointerId) setEditorHeight(clampEditor(from.height + from.y - e.clientY));
					},
					onPointerUp: () => { dividerDrag.current = null; },
					onPointerCancel: () => { dividerDrag.current = null; },
					onLostPointerCapture: () => { dividerDrag.current = null; },
					onDoubleClick: () => setEditorHeight(null),
					onKeyDown: e => {
						if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
						const step = e.shiftKey ? 24 : 8;
						const next = e.key === "ArrowUp" ? currentEditorHeight() + step : e.key === "ArrowDown" ? currentEditorHeight() - step : e.key === "Home" ? minEditor : e.key === "End" ? maxEditor : null;
						if (next !== null) { e.preventDefault(); e.stopPropagation(); setEditorHeight(clampEditor(next)); }
					},
				}) : null;
				const hasReply = s.messages.some(m => m.role === "agent" && !m.error && m.text);
				const [editorExpanded, setEditorExpanded] = useState(!dock || !hasReply || !!draft);
				const seenReply = useRef(!!hasReply), focusEditor = useRef(false);
				useEffect(() => {
					if (dock && hasReply && !seenReply.current) {
						seenReply.current = true;
						if (!controller.store.state.draft) setEditorExpanded(false);
					}
				}, [dock, hasReply]);
				useLayoutEffect(() => {
					if (!s.editorRequest || controller.handledEditorRequest === s.editorRequest || !["configuring", "active"].includes(s.phase)) return;
					if (dock && !editorExpanded) { setEditorExpanded(true); return; }
					if (taRef.current) {
						controller.handledEditorRequest = s.editorRequest;
						taRef.current.focus?.();
					}
				}, [s.editorRequest, s.phase, dock, editorExpanded]);
				// The reopened composer overlays the transcript; measure it so the body
				// can keep its last line scrolled clear of the overlay. Degrades to the
				// CSS fallback silently when refs or ResizeObserver are unavailable.
				useEffect(() => {
					if (!dock || !editorExpanded || !hasReply) return undefined;
					const panel = modalRef.current, row = rowRef.current;
					if (!panel || !row || typeof ResizeObserver !== "function") return undefined;
					const apply = () => { const height = Number(row.offsetHeight); if (Number.isFinite(height) && height > 0) panel.style.setProperty("--btw-editor-h", Math.ceil(height) + "px"); };
					apply();
					const observer = new ResizeObserver(apply);
					observer.observe(row);
					return () => { observer.disconnect(); panel.style.removeProperty("--btw-editor-h"); };
				}, [dock, editorExpanded, hasReply]);
				useLayoutEffect(() => { if (editorExpanded && focusEditor.current) { focusEditor.current = false; taRef.current?.focus(); } }, [editorExpanded]);
				// No focus effect on phase/focus changes: the clicked control/editor
				// keeps browser focus, including while another chat finishes opening.
				useLayoutEffect(() => { const el = bodyRef.current; if (el !== null) el.scrollTop = el.scrollHeight; }, [controller?.id, s.messages, editorExpanded]);
				// Register this surface with the client's single Esc arbiter. Esc ends the
				// btw the user was last using even when focus sits in the host composer;
				// native menus, listboxes and dialogs keep their own Escape. The native
				// temporary chat page (standalone/global) never registers, so Esc can
				// never destroy it.
				useEffect(() => {
					if (!controller || standalone || s.presentation === "global") return undefined;
					if (!["overlay", "sidebar", "dock"].includes(s.presentation)) return undefined;
					if (!["active", "error", "opening", "configuring"].includes(s.phase)) return undefined;
					return registerEscapeSurface({
						id: controller.id,
						root: () => modalRef.current,
						order: () => controller.focusOrder ?? 0,
						close: () => void closeTemp({ background: true }),
					});
				}, [controller?.id, s.phase, s.presentation, inline, standalone, dock]);
				if (!controller || s.phase === "idle" || (dock ? s.presentation !== "dock" : standalone ? s.presentation !== "global" : inline ? s.presentation !== "sidebar" : s.presentation !== "overlay")) return null;
				const submit = () => {
					const text = draft.trim();
					if (text === "" || controller.store.state.busy) return;
					if (controller.store.state.phase === "configuring") beginTemp(text);
					else if (controller.store.state.phase === "active") { setDraft(""); sendTemp(text); if (dock && hasReply) setEditorExpanded(false); }
				};
				const onKey = (e) => {
					if (e.key !== "Enter" || e.shiftKey) return;
					const ime = composing.current || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229;
					if (!ime) { e.preventDefault(); submit(); }
				};
				const presentation = dock ? "dock" : standalone ? "global" : inline ? "sidebar" : "overlay";
				const ranked = [...controllers.values()].sort((a, b) => a.focusOrder - b.focusOrder);
				// After a reply the fold control floats (absolute) instead of owning a
				// flow row: collapsed it anchors to the panel bottom, expanded to the
				// overlay composer's top edge. The panel carries the state for CSS.
				const editorFoldable = dock && hasReply && s.phase !== "error";
				const editorToggle = editorFoldable ? h("button", { type: "button", className: "dsh-btw-editor-toggle", "aria-label": editorExpanded ? "收起输入框" : "展开输入框", "aria-expanded": editorExpanded, onClick: () => { if (!editorExpanded) focusEditor.current = true; setEditorExpanded(!editorExpanded); } }, h(SharedChevron || "svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", "aria-hidden": true }, SharedChevron ? null : h("path", { d: "m4 6 4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))) : null;
				const chosenModel = s.modelChoice;
				const modelPicker = h(ModelSelect, { tuning: { sourceId: s.originId, effort: s.reasoningEffort || "", onEffortChange: (effort) => {
					const now = controller.store.state;
					if (now.phase === "configuring" && now.modelChoice === chosenModel) patch({ reasoningEffort: effort });
				} }, value: chosenModel, disabled: s.phase !== "configuring", onChange: (value) => { if (controller.store.state.phase === "configuring" && value !== controller.store.state.modelChoice) patch({ modelChoice: value, reasoningEffort: "" }); } });
				const reasoningPicker = !SharedMenu && s.phase === "configuring" && loadModelOptions ? h(ReasoningSelect, { controller, choice: s.modelChoice, sourceId: s.originId, value: s.reasoningEffort }) : null;
				const contextPicker = s.originId ? h("label", null, choiceSelect({ label: dock ? "侧问上下文" : "临时聊天上下文", title: "按需模式授权最近的文本快照，不是完整历史", value: s.contextMode, disabled: s.phase !== "configuring", onChange: (value) => { if (controller.store.state.phase === "configuring") patch({ contextMode: value }); } }, CONTEXT_OPTIONS)) : null;
				const voice = speechRemote && typeof MediaRecorder === "function" && typeof AudioContext === "function" && typeof OfflineAudioContext === "function" && navigator.mediaDevices?.getUserMedia
					? h(VoiceInput, { remote: speechRemote, navigation: speechService.navigation, t: speechService.t, controller, editor: taRef, disabled: !["configuring", "active"].includes(s.phase) }) : null;
				const sendButton = h("button", { type: "button", className: "dsh-btw-go", onMouseDown: e => e.preventDefault(), onClick: submit, disabled: s.busy || draft.trim() === "" || !["active", "configuring"].includes(s.phase), "aria-label": dock ? "提问" : "发送", "aria-busy": s.busy || undefined, title: "发送（Enter）" }, h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: "M8 13V3M3 8l5-5 5 5" })));
				const renderFrame = (card) => dock ? card : h("div", { className: standalone ? "dsh-btw-standalone" : inline ? "dsh-btw-inline" : "dsh-btw-veil", style: { zIndex: !inline && !standalone ? ranked.indexOf(controller) + 1 : undefined }, "data-phase": s.phase, "data-chat-id": controller.id,
					onPointerDownCapture: () => focusTemp(controller.id), onFocusCapture: () => focusTemp(controller.id) }, card);
				return renderFrame(
					h("div", { key: controller.id, ref: modalRef, className: dock ? "dsh-btw-modal dsh-btw-dock-panel" : "dsh-btw-modal", style: dock ? dockStyle : { "--btw-width": s.width + "px", ...(!inline && !standalone ? { left: s.x, top: s.y, width: s.width, height: s.height } : { position: "relative", width: "100%", height: "100%", border: 0, borderRadius: "var(--dsw-radius-panel,24px)", boxShadow: "none" }) }, "data-phase": s.phase, "data-small": small, "data-focused": tempRegistry.state.activeId === controller.id, "data-global": !s.originId, "data-empty": s.messages.length === 0, "data-editor": editorFoldable ? (editorExpanded ? "expanded" : "collapsed") : undefined, role: dock || inline || standalone ? "region" : "dialog", "aria-label": dock ? "btw 侧问小窗" : "临时聊天", "data-chat-id": dock ? controller.id : undefined },
						h("div", { className: "dsh-btw-mhead", "data-draggable": !dock && !inline && !standalone && !s.pinned,
							onPointerDown: (e) => {
								if (dock || inline || standalone || controller.store.state.presentation !== "overlay" || controller.store.state.pinned || e.button !== 0 || e.target.closest?.("button,input,select,textarea,[role=menu]")) return;
								const rect = modalRef.current?.getBoundingClientRect();
								if (!rect) return;
								drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
								e.currentTarget.setPointerCapture?.(e.pointerId); e.preventDefault();
							},
							onPointerMove: (e) => {
								const from = drag.current;
								if (!from || from.pointer !== e.pointerId || controller.store.state.presentation !== "overlay" || controller.store.state.pinned) return;
								updateGeometry(controller, { x: from.left + e.clientX - from.x, y: from.top + e.clientY - from.y });
							},
							onPointerUp: () => { drag.current = null; }, onPointerCancel: () => { drag.current = null; }, onLostPointerCapture: () => { drag.current = null; },
						},
							h("div", { className: "dsh-btw-mtitles" }, h("div", { className: "dsh-btw-mtitle" }, "btw"),
								h("div", { className: "dsh-btw-msub" }, s.phase === "opening" ? "正在开启…" : s.phase === "closing" ? "正在清理…" : s.phase === "error" ? "清理未完成" : "")),
							!dock && !inline && !(standalone && !s.originId) ? iconButton({ label: "新建临时聊天", icon: actionGlyph("new"), disabled: s.phase === "closing", onClick: () => openTemp(s.cwd, s.originId, "overlay") }) : null,
							s.originId && s.messages.some((m) => !m.streaming && !m.error) ? iconButton({ label: "选择消息", pressed: s.selecting, tooltip: s.selecting ? "取消选择消息" : "选择消息", icon: actionGlyph("select"), disabled: s.phase === "closing", onClick: () => patch({ selecting: !s.selecting, selected: [], insertionError: "", insertionNotice: "" }) }) : null,
							!(standalone && !s.originId) ? windowControls({ presentation, sourceId: s.originId, disabled: s.phase === "closing", onChange: (mode) => { drag.current = null; resizing.current = null; presentTemp(controller, mode); } }) : null,
							!dock && !inline && !standalone ? iconButton({ label: "固定小窗", pressed: s.pinned, tooltip: s.pinned ? "已固定，点击允许拖动" : "可拖动，点击固定", onClick: () => { drag.current = null; resizing.current = null; setWindowPinned(controller); },
								icon: nativeIcons[s.pinned ? "PinFill" : "PinOutline"] ? h(nativeIcons[s.pinned ? "PinFill" : "PinOutline"], { width: 16, height: 16, "aria-hidden": true }) : h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: s.pinned ? "currentColor" : "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": true }, h("path", { d: "M5 2h6l-1 4 2 2v1H4V8l2-2-1-4Zm3 7v5" })) }) : null,
							!inline && !(standalone && !s.originId) ? iconButton({ label: "最小化 btw", tooltip: "最小化，保留聊天与草稿", disabled: s.phase === "closing", onClick: () => minimizeTemp(controller), icon: h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true }, h("path", { d: "M3 11h10", stroke: "currentColor", strokeWidth: 1.5 })) }) : null,
							// X ends the chat: the surface leaves immediately and the host cleanup
							// finishes in the background, so no "正在清理" placeholder is shown.
							iconButton({ label: dock ? "关闭侧问面板" : "结束临时聊天", tooltip: "结束并清理当前 btw", disabled: s.phase === "closing",
								onClick: () => { void closeTemp({ background: true }); if (standalone) globalLayout?.selectPanel(null); },
								icon: h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true }, h("path", { d: "m4 4 8 8m0-8-8 8", stroke: "currentColor", strokeWidth: 1.5 })) }),

						),
						dock ? dockHandles : !inline && !standalone ? resizeHandles({ gesture: resizing, read: () => clampGeometry(controller.store.state), write: (geometry) => updateGeometry(controller, geometry), onStart: () => focusTemp(controller.id) }) : null,
						s.phase === "error" ? h("div", { className: "dsh-btw-empty" }, h("div", { className: "dsh-btw-err" }, s.error), h("div", null, "结束失败，请重试。")) : h("div", { className: "dsh-btw-mbody", ref: bodyRef, tabIndex: dock ? 0 : undefined, "aria-label": dock ? "侧问消息" : undefined },
							s.messages.length === 0 ? h("div", { className: "dsh-btw-empty" }, s.cwd ? "比如：这个项目是干什么的？" : "问点什么…") : s.messages.map((m, i) => messageView(m, i,
								s.selecting && !m.streaming && !m.error ? h("input", { className: "dsh-btw-pick", type: "checkbox", checked: s.selected.includes(i), onChange: () => toggleMessage(i), "aria-label": "选择消息 " + (i + 1) }) : null, renderFactorySlot))),
						s.selected.length ? h("div", { className: "dsh-btw-tools" }, h("button", { type: "button", className: "dsh-btw-control", onClick: insertSelected }, "送回来源会话草稿（" + s.selected.length + "）")) : null,
						s.insertionError || s.insertionNotice ? h("div", { className: "dsh-btw-status" + (s.insertionError ? " dsh-btw-err" : ""), role: "status" }, s.insertionError || s.insertionNotice) : null,
						editorToggle && !editorExpanded ? editorToggle : null,
						s.phase !== "error" && (!dock || editorExpanded) ? h("div", { className: "dsh-btw-mfoot", ref: dock ? rowRef : undefined },
						divider, editorToggle,
						h("div", { className: "dsh-btw-mcard" },
							h("textarea", { className: "dsh-btw-mta", ref: taRef, value: draft, rows: 1, "aria-label": "BTW 输入框", "data-manual": small && editorHeight !== null || undefined,
								style: small && editorHeight !== null ? { "--btw-composer-height": clampEditor(editorHeight) + "px", maxHeight: maxEditor } : undefined, disabled: !["active", "configuring"].includes(s.phase), placeholder: small ? "问点什么… Enter 发送，Shift+Enter 换行" : "问点什么…", onChange: (e) => setDraft(e.target.value), onKeyDown: onKey, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); } }),
							h("div", { className: "dsh-btw-tools" }, ...(inline ? [
								h("div", { className: "dsh-btw-composer-leading" }, contextPicker),
								h("div", { className: "dsh-btw-composer-trailing" }, modelPicker, reasoningPicker, voice, sendButton),
							] : [contextPicker, modelPicker, reasoningPicker, voice, sendButton])))) : null,
					),
				);
			}
			// The settings card itself ships as its own sibling chunk
			// (client.settings.js): the entry lazy-loads it on the first real
			// settings visit and passes these closure helpers to its
			// createSettings — native Menu pickers and the configured model
			// list stay owned here, with no synchronous cross-chunk require.
			return { BtwDockView, BtwTempView, settingsHelpers: { ModelSelect, choiceSelect, SegmentedControl: SharedSegmentedControl, modelValue, CONTEXT_OPTIONS } };
		}
		return { createViews, MarkdownText: SharedMarkdown, DisclosureRow: SharedDisclosureRow, ThinkIcon: SharedThinkIcon, TextShimmer: SharedTextShimmer, CSS };
	},
});
