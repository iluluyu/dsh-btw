/** Zero-build package-local chunk; see docs/architecture.md. */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.geometry.js",
	factory: (require) => {
		// Pure clamps/edge arithmetic plus DOM gesture adapters. No chat/transport.
		function createGeometry({ h, window, remember }) {
			// Geometry storage is an allowlisted numeric record, never chat state.
			const geometryKey = (cwd) => "dsh-btw/geometry/v1/" + encodeURIComponent(cwd || "host");
			function geometryBounds() {
				const vw = Math.max(1, window.innerWidth || 1024), vh = Math.max(1, window.innerHeight || 768);
				return { vw, vh, maxWidth: Math.max(1, vw - 32), maxHeight: Math.max(1, vh - 48) };
			}
			const bound = (n, min, max) => Math.max(min, Math.min(max, n));
			function clampGeometry(value, bounds = geometryBounds()) {
				value = value && typeof value === "object" ? value : {};
				const { vw, vh, maxWidth, maxHeight, minWidth = 360, minHeight = 320 } = bounds;
				const width = bound(Number.isFinite(value.width) ? value.width : 740, Math.min(minWidth, maxWidth), maxWidth);
				const height = bound(Number.isFinite(value.height) ? value.height : 640, Math.min(minHeight, maxHeight), maxHeight);
				const x = bound(Number.isFinite(value.x) ? value.x : (vw - width) / 2, 0, vw - width);
				const y = bound(Number.isFinite(value.y) ? value.y : (vh - height) / 2, 0, vh - height);
				return { x, y, width, height };
			}
			// Clamp moving edges, not the resulting origin: west/north keep the
			// opposite edge fixed even when hitting the minimum or viewport boundary.
			function resizeGeometry(from, edge, dx, dy, bounds = geometryBounds()) {
				const { vw, vh, maxWidth, maxHeight } = bounds;
				const minWidth = Math.min(bounds.minWidth ?? 360, maxWidth), minHeight = Math.min(bounds.minHeight ?? 320, maxHeight);
				let { x, y, width, height } = from;
				if (edge.includes("w")) { const right = x + width; x = bound(x + dx, Math.max(0, right - maxWidth), right - minWidth); width = right - x; }
				if (edge.includes("e")) width = bound(width + dx, minWidth, Math.min(maxWidth, vw - x));
				if (edge.includes("n")) { const bottom = y + height; y = bound(y + dy, Math.max(0, bottom - maxHeight), bottom - minHeight); height = bottom - y; }
				if (edge.includes("s")) height = bound(height + dy, minHeight, Math.min(maxHeight, vh - y));
				return { x, y, width, height };
			}
			const RESIZE_EDGES = { n: "上", ne: "右上", e: "右", se: "右下", s: "下", sw: "左下", w: "左", nw: "左上" };
			function resizeHandles({ gesture, read, write, bounds = geometryBounds, onStart, label = "小窗", edges = Object.keys(RESIZE_EDGES) }) {
				return edges.map((edge) => h("button", {
					key: edge, type: "button", className: "dsh-btw-resize", "data-edge": edge,
					"aria-label": "调整" + label + "大小：" + RESIZE_EDGES[edge], title: "拖动调整大小；方向键调整，Shift 加速",
					onPointerDown: (e) => {
						if (e.button !== 0) return;
						onStart?.();
						gesture.current = { pointer: e.pointerId, clientX: e.clientX, clientY: e.clientY, from: read(), edge };
						e.currentTarget.setPointerCapture?.(e.pointerId); e.preventDefault(); e.stopPropagation();
					},
					onPointerMove: (e) => {
						const r = gesture.current;
						if (r?.pointer === e.pointerId) write(resizeGeometry(r.from, r.edge, e.clientX - r.clientX, e.clientY - r.clientY, bounds()));
					},
					onPointerUp: (e) => { if (gesture.current?.pointer !== e.pointerId) return; gesture.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); },
					onPointerCancel: () => { gesture.current = null; }, onLostPointerCapture: () => { gesture.current = null; },
					onKeyDown: (e) => {
						if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey) return;
						const step = e.shiftKey ? 40 : 10;
						const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
						if (!delta) return;
						e.preventDefault(); e.stopPropagation(); write(resizeGeometry(read(), edge, ...delta, bounds()));
					},
				}));
			}
			function storedGeometry(key) {
				if (!key || !remember()) return null;
				try {
					const value = JSON.parse(window.localStorage?.getItem(key) || "null");
					if (!value || typeof value !== "object") return null;
					const fields = Object.fromEntries(["x", "y", "width", "height"].filter((key) => Number.isFinite(value[key])).map((key) => [key, value[key]]));
					return Object.keys(fields).length ? fields : null;
				} catch { return null; }
			}
			function savedGeometry(key, clamp = clampGeometry) {
				return clamp(storedGeometry(key) || {});
			}
			function persistGeometry(key, geometry) {
				if (!key || !remember()) return;
				try { window.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(["x", "y", "width", "height"].filter((key) => Number.isFinite(geometry[key])).map((key) => [key, geometry[key]])))); } catch { /* private/quota-restricted browser */ }
			}
			function dockBounds(stage) {
				const { vw, vh } = geometryBounds(), rect = stage?.getBoundingClientRect?.();
				const width = Math.max(1, Math.min(stage?.clientWidth || rect?.width || 720, vw - 32));
				// Normal flow pins the panel above the host composer. At most half a
				// viewport is consumed; the question controls never scroll with answers.
				const height = Math.max(1, Math.min(vh / 2, Number.isFinite(rect?.bottom) ? rect.bottom - 16 : vh / 2));
				return { vw: width, vh: height, maxWidth: width, maxHeight: height, minWidth: 280, minHeight: 180 };
			}
			function clampDockGeometry(value, stage) {
				const bounds = dockBounds(stage);
				const geometry = clampGeometry({ height: Number.isFinite(value?.height) ? value.height : 200, width: bounds.maxWidth, x: 0, y: 0 }, bounds);
				return { ...geometry, y: 0 };
			}

			return { geometryKey, geometryBounds, clampGeometry, resizeGeometry, resizeHandles, storedGeometry, savedGeometry, persistGeometry, dockBounds, clampDockGeometry };
		}
		return { createGeometry };
	},
});
