// @ts-check
/* global $left, $right, get_direction */
import { document_model } from "./document-model.js";
import { load_node_as_selection, make_or_update_undoable, undoable } from "./functions.js";
import { $Component } from "./$Component.js";
import { $G, E } from "./helpers.js";

/**
 * The Layers panel: a view of the document's layer tree (see document-model.js).
 *
 * Rows are listed top-to-bottom, topmost layer first, matching the document's stacking order. The
 * panel never decides that order itself: it renders the model's tree, and the model composites it.
 *
 * Every document change goes through `undoable()`, so structural changes (add, delete, reorder,
 * rename, visibility, opacity) are undoable steps.
 */

const THUMBNAIL_SIZE = 30;

/**
 * Where a row was dropped: next to the row it was dropped on, or into it (sets only).
 * @typedef {"above" | "below" | "into"} DropPosition
 */

/**
 * What the panel is telling the user about where a drag would land.
 * @typedef {DropPosition | "end"} DropIndicator
 */

/** @type {JQuery<HTMLDivElement>} */
let $layer_list;
/** @type {Map<string, JQuery<HTMLButtonElement>>} the toolbar buttons, so their disabled state can be kept up to date */
const toolbar_buttons = new Map();
/** @type {Map<number, { $row: JQuery<HTMLDivElement>, $thumbnail: JQuery<HTMLCanvasElement> | null }>} */
const row_elements = new Map();
/** @type {JQuery<HTMLDivElement> | null} */
let $panel = null;

/**
 * Runs a change to the layer tree as an undoable step.
 *
 * `action` reports whether it changed anything; if it didn't, no history step is recorded, so that
 * undo can't appear to do nothing.
 *
 * @param {string} name
 * @param {() => boolean} action
 */
function undoable_layer_op(name, action) {
	// Structural changes don't touch layer pixels, so it's safe to find out whether there's anything
	// to record before making a history step for it.
	if (!action()) { return; }
	undoable({ name }, () => { });
}

function render_layer_list() {
	if (!$layer_list) { return; }
	const previous_scroll_top = $layer_list[0] ? $layer_list[0].scrollTop : 0;
	$layer_list.empty();
	row_elements.clear();
	const render_children = (parent, depth) => {
		// children are ordered bottom-to-top, and the list is top-to-bottom, so render in reverse
		const children = parent.children || [];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			$layer_list.append(create_row(child, depth));
			if (child.type === "group" && child.expanded) {
				render_children(child, depth + 1);
			}
		}
	};
	render_children(document_model.get_root(), 0);
	if ($layer_list[0]) { $layer_list[0].scrollTop = previous_scroll_top; }
	update_toolbar_state();
}

/**
 * Enables/disables the toolbar buttons for the current selection and document, so an operation that
 * would do nothing can't be clicked.
 */
function update_toolbar_state() {
	if (toolbar_buttons.size === 0) { return; }
	const selected_id = document_model.get_selected_node_id();
	const selected = document_model.find_node(selected_id);
	const set_enabled = (key, enabled) => {
		const $button = toolbar_buttons.get(key);
		if ($button) { $button.prop("disabled", !enabled); }
	};
	set_enabled("duplicate", !!selected);
	set_enabled("merge", document_model.can_merge_down(selected_id));
	set_enabled("flatten", document_model.can_flatten());
	set_enabled("load-selection", !!selected);
	set_enabled("delete", document_model.can_delete(selected_id));
}

function refresh_thumbnails() {
	for (const [id, { $thumbnail }] of row_elements) {
		const node = document_model.find_node(id);
		if (node && $thumbnail) { draw_thumbnail($thumbnail[0], node); }
	}
}

/**
 * Draws a layer's pixels, scaled to fit the thumbnail. (Groups show a folder icon instead, so that
 * a set is distinguishable from a blank layer at a glance -- and from its own contents.)
 * @param {HTMLCanvasElement} canvas
 * @param {import("./document-model.js").LayerNode} node
 */
function draw_thumbnail(canvas, node) {
	const ctx = canvas.getContext("2d");
	if (!ctx || !node.canvas) { return; }
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
	const scale = Math.min(THUMBNAIL_SIZE / node.canvas.width, THUMBNAIL_SIZE / node.canvas.height);
	const width = Math.max(1, Math.round(node.canvas.width * scale));
	const height = Math.max(1, Math.round(node.canvas.height * scale));
	const x = Math.round((THUMBNAIL_SIZE - width) / 2);
	const y = Math.round((THUMBNAIL_SIZE - height) / 2);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "medium";
	ctx.drawImage(node.canvas, x, y, width, height);
}

/**
 * @param {import("./document-model.js").LayerNode} node
 * @param {number} depth
 * @returns {JQuery<HTMLDivElement>}
 */
function create_row(node, depth) {
	const active_layer = document_model.get_active_layer();
	const selected_id = document_model.get_selected_node_id();
	const $row = $(E("div")).addClass("layer-row").attr({
		tabindex: "0",
		"data-layer-id": node.id.toString(),
		"aria-label": node.name,
	}).css("--layer-depth", depth.toString());
	if (node === active_layer) { $row.addClass("active"); }
	if (node.id === selected_id) { $row.addClass("selected"); }

	const $visibility = $(E("button")).attr({
		type: "button",
		title: node.visible ? "Hide layer" : "Show layer",
		"aria-label": node.visible ? "Hide layer" : "Show layer",
	}).text(node.visible ? "●" : "○").addClass("layer-visibility");
	const $expand = $(E("button")).attr({
		type: "button",
		title: "Expand or collapse group",
		"aria-label": "Expand or collapse group",
	}).text(node.type === "group" ? (node.expanded ? "▼" : "▶") : "").addClass("layer-expand");
	// A set gets a folder icon: its own thumbnail would just be its contents laid out at thumbnail
	// size, which is indistinguishable from a layer's, and blank until the set has content.
	const $thumbnail = node.type === "group" ?
		null :
		/** @type {JQuery<HTMLCanvasElement>} */ ($(E("canvas")).addClass("layer-thumbnail").attr({
			width: THUMBNAIL_SIZE,
			height: THUMBNAIL_SIZE,
		}));
	const $icon = $thumbnail || $(E("span")).addClass("layer-folder-icon").attr("aria-hidden", "true");
	const $name = $(E("span")).addClass("layer-name").text(node.name).attr("title", node.name);
	const $opacity = $(E("input")).attr({
		type: "range",
		min: "0",
		max: "100",
		value: String(Math.round(node.opacity * 100)),
		title: "Layer opacity",
		"aria-label": "Layer opacity",
	}).addClass("layer-opacity");
	$row.append($visibility, $expand, $icon, $name, $opacity);
	if ($thumbnail) { draw_thumbnail($thumbnail[0], node); }
	row_elements.set(node.id, { $row, $thumbnail });

	$row.on("click", (event) => {
		if ($(event.target).is("button, input")) { return; }
		document_model.select_node(node.id);
	});
	$row.on("dblclick", (event) => {
		if ($(event.target).is("button, input")) { return; }
		begin_rename(node.id, $name);
	});
	$visibility.on("click", () => {
		undoable_layer_op(node.visible ? "Hide Layer" : "Show Layer", () => {
			document_model.set_visible(node.id, !node.visible);
			return true;
		});
	});
	$expand.on("click", () => {
		if (node.type !== "group") { return; }
		document_model.set_expanded(node.id, !node.expanded);
	});
	$opacity.on("input", () => {
		const opacity = Number($opacity.val()) / 100;
		node = document_model.find_node(node.id) || node;
		make_or_update_undoable({
			name: "Layer Opacity",
			match: (history_node) => history_node.name === "Layer Opacity",
		}, () => {
			document_model.set_opacity(node.id, opacity);
		});
	});
	$row.on("pointerdown", (event) => {
		// Pressing the opacity slider button is that control's business, not a layer move.
		if (event.button !== 0 || $(event.target).is("button, input, select, a")) { return; }
		// On touch, dragging a row is how the list gets scrolled; leave that gesture alone.
		if (pointer_type_of(event) === "touch") { return; }
		begin_row_drag(node.id, event.clientY);
	});
	return $row;
}

/**
 * @param {JQuery.Event} event
 * @param {import("./document-model.js").LayerNode} target
 */
const DROP_INDICATOR_CLASSES = "drop-above drop-below drop-into drop-end";
/** How far the pointer has to move before a press counts as a drag rather than a click. */
const DRAG_START_DISTANCE = 4;
/** How close to the list's top or bottom edge the pointer has to get before the list scrolls itself. */
const DRAG_SCROLL_MARGIN = 18;
/** How many pixels the list scrolls per frame while the pointer is against an edge. */
const DRAG_SCROLL_SPEED = 6;

/** @type {JQuery<HTMLElement> | null} */
let $drop_indicator = null;
/** @type {number | null} the node being dragged, while a drag is in progress */
let dragged_node_id = null;
/**
 * The press being watched, once a drag is under way. `commit` and `abort` are kept so the exact
 * handlers can be unbound again; `one()` would leave the one that didn't fire behind on the window.
 * @type {{ id: number, start_y: number, pointer_y: number, active: boolean, commit: () => void, abort: () => void } | null}
 */
let drag_state = null;
/** @type {JQuery<HTMLDivElement> | null} the row the drag started on, so it can be dimmed */
let $drag_source_row = null;
/** @type {number | null} id of the frame that scrolls the list, while a drag is in progress */
let drag_scroll_frame = null;

function clear_drop_indicator() {
	if ($drop_indicator) {
		$drop_indicator.removeClass(DROP_INDICATOR_CLASSES);
		$drop_indicator = null;
	}
}

/**
 * @param {JQuery<HTMLElement>} $element
 * @param {DropIndicator} position
 */
function set_drop_indicator($element, position) {
	if ($drop_indicator && $drop_indicator[0] !== $element[0]) {
		$drop_indicator.removeClass(DROP_INDICATOR_CLASSES);
	}
	$drop_indicator = $element;
	$element.removeClass(DROP_INDICATOR_CLASSES).addClass("drop-" + position);
}

/**
 * @param {JQuery.TriggeredEvent} event
 * @returns {string} the pointer type, defaulting to "mouse" for events that don't say
 */
function pointer_type_of(event) {
	return /** @type {any} */ (event).originalEvent?.pointerType || /** @type {any} */ (event).pointerType || "mouse";
}

/**
 * Which part of a row a pointer at this height within the row means.
 *
 * A layer row is split in half: top half drops above it, bottom half below it. A set's row also has
 * a middle band that means "into the set", so a set can be filled from above or below as well as
 * from the middle.
 *
 * @param {number} ratio the pointer's height within the row: 0 is its top edge, 1 its bottom edge
 * @param {import("./document-model.js").LayerNode} node
 * @returns {DropPosition}
 */
function drop_position(ratio, node) {
	if (node.type === "group") {
		if (ratio < 0.3) { return "above"; }
		// Just below a set's row: when it's expanded, the rows that follow are its children, so landing
		// at the top of the set is what the pointer implies. When it's collapsed there's nothing in
		// between, so the bottom of the row means "below the whole set" instead.
		if (!node.expanded && ratio > 0.7) { return "below"; }
		return "into";
	}
	return ratio < 0.5 ? "above" : "below";
}

/**
 * Where a node dropped on a row should go in the model.
 *
 * @param {import("./document-model.js").LayerNode} target
 * @param {DropPosition} position
 * @returns {{ parent_id: number, index: number }}
 */
/**
 * Whether the node being dragged can land where `destination` says, so that the indicator only
 * appears over spots where a drop would actually do something.
 * @param {{ parent_id: number, index: number }} destination
 * @returns {boolean}
 */
function drop_is_possible(destination) {
	return dragged_node_id !== null && document_model.can_move_node(dragged_node_id, destination.parent_id, destination.index);
}

/**
 * Where a node dropped on a row should go in the model.
 *
 * @param {import("./document-model.js").LayerNode} target
 * @param {DropPosition} position
 * @returns {{ parent_id: number, index: number }}
 */
function drop_destination(target, position) {
	if (position === "into") {
		// Into a set, on top of it (children are stored bottom-to-top).
		return { parent_id: target.id, index: (target.children || []).length };
	}
	const parent_id = document_model.find_parent_id(target);
	const siblings = document_model.find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === target.id);
	if (index === -1) {
		// Shouldn't happen, but refusing beats guessing: the node isn't where the tree says it is.
		return { parent_id, index: 0 };
	}
	return { parent_id, index: position === "above" ? index + 1 : index };
}

/**
 * @param {HTMLDivElement} row
 * @returns {import("./document-model.js").LayerNode | undefined}
 */
function node_of_row(row) {
	return document_model.find_node(Number(row.getAttribute("data-layer-id")));
}

/**
 * What a point in the panel is over: a row and how far down it, or the empty space past the last
 * row, which means the bottom of the document.
 *
 * @param {number} client_y
 * @returns {{ node: import("./document-model.js").LayerNode, ratio: number } | { end: true } | null}
 */
function drop_target_at(client_y) {
	if (!$layer_list[0]) { return null; }
	const rows = /** @type {HTMLDivElement[]} */ ([...$layer_list[0].querySelectorAll(".layer-row")]);
	if (!rows.length) { return null; }
	if (client_y < rows[0].getBoundingClientRect().top) {
		// Above the top row is as good as its top edge.
		const node = node_of_row(rows[0]);
		return node ? { node, ratio: 0 } : null;
	}
	if (client_y > rows[rows.length - 1].getBoundingClientRect().bottom) {
		return { end: true };
	}
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (client_y >= rect.top && client_y <= rect.bottom) {
			const node = node_of_row(row);
			return node ? { node, ratio: rect.height > 0 ? (client_y - rect.top) / rect.height : 0.5 } : null;
		}
	}
	return null;
}

/**
 * Shows where the dragged node would land if it were let go at this height.
 * @param {number} client_y
 */
function update_drag_indicator(client_y) {
	const hit = drop_target_at(client_y);
	if (!hit) { clear_drop_indicator(); return; }
	if ("end" in hit) {
		if (drop_is_possible({ parent_id: document_model.get_root().id, index: 0 })) {
			set_drop_indicator($layer_list, "end");
		} else {
			clear_drop_indicator();
		}
		return;
	}
	const position = drop_position(hit.ratio, hit.node);
	const $row = row_elements.get(hit.node.id)?.$row;
	if ($row && drop_is_possible(drop_destination(hit.node, position))) {
		set_drop_indicator($row, position);
	} else {
		// Don't promise a move the model would refuse: a set dropped into its own contents, or
		// anything dropped back where it already is.
		clear_drop_indicator();
	}
}

/**
 * Watches a press on a row. It only becomes a drag once the pointer moves far enough, so that a
 * plain click still just selects the layer.
 * @param {number} id
 * @param {number} client_y
 */
function begin_row_drag(id, client_y) {
	const commit = () => drag_row_onpointerup(true);
	// A cancelled pointer (a system gesture taking over, say) gives up the drag instead of dropping it.
	const abort = () => drag_row_onpointerup(false);
	drag_state = { id, start_y: client_y, pointer_y: client_y, active: false, commit, abort };
	$G.on("pointermove", drag_row_onpointermove);
	$G.on("pointerup", commit);
	$G.on("pointercancel", abort);
}

/** @param {JQuery.TriggeredEvent} event */
function drag_row_onpointermove(event) {
	if (!drag_state) { return; }
	const client_y = /** @type {any} */ (event).clientY;
	if (typeof client_y !== "number") { return; }
	drag_state.pointer_y = client_y;
	if (!drag_state.active) {
		if (Math.abs(client_y - drag_state.start_y) < DRAG_START_DISTANCE) { return; }
		drag_state.active = true;
		dragged_node_id = drag_state.id;
		$drag_source_row = row_elements.get(drag_state.id)?.$row || null;
		$drag_source_row?.addClass("dragging");
		$("body").addClass("dragging-layer");
	}
	update_drag_indicator(client_y);
	// A mouse sends moves continuously, so this scrolls as the pointer moves; the frame loop below
	// keeps it going while the pointer is held still against an edge.
	if (scroll_list_at_edge(client_y)) { update_drag_indicator(client_y); }
	start_drag_edge_scrolling();
}

/** @param {boolean} commit whether the node should land where it was let go */
function drag_row_onpointerup(commit) {
	const finished = drag_state;
	drag_state = null;
	$G.off("pointermove", drag_row_onpointermove);
	if (finished) {
		$G.off("pointerup", finished.commit);
		$G.off("pointercancel", finished.abort);
	}
	stop_drag_edge_scrolling();
	dragged_node_id = null;
	if ($drag_source_row) { $drag_source_row.removeClass("dragging"); }
	$drag_source_row = null;
	$("body").removeClass("dragging-layer");
	clear_drop_indicator();
	if (!finished || !finished.active || !commit) { return; }
	const hit = drop_target_at(finished.pointer_y);
	if (!hit) { return; }
	if ("end" in hit) {
		// Let go past the last row: out of any set, at the bottom of the document.
		const root = document_model.get_root();
		undoable_layer_op("Move Layer", () => document_model.move_node(finished.id, root.id, 0));
		return;
	}
	drag_and_drop_node(finished.id, hit.node, drop_position(hit.ratio, hit.node));
}

/**
 * Scrolls the list a little when the pointer is against its top or bottom edge, so that the rows
 * outside a long list can be reached while dragging.
 * @param {number} client_y
 * @returns {boolean} whether the list moved
 */
function scroll_list_at_edge(client_y) {
	if (!$layer_list[0]) { return false; }
	const rect = $layer_list[0].getBoundingClientRect();
	let delta = 0;
	if (client_y - rect.top < DRAG_SCROLL_MARGIN) {
		delta = -DRAG_SCROLL_SPEED;
	} else if (rect.bottom - client_y < DRAG_SCROLL_MARGIN) {
		delta = DRAG_SCROLL_SPEED;
	}
	if (!delta) { return false; }
	const before = $layer_list[0].scrollTop;
	$layer_list[0].scrollTop = before + delta;
	return $layer_list[0].scrollTop !== before;
}

/** Keeps the list scrolling while the pointer is held still against an edge. */
function start_drag_edge_scrolling() {
	if (drag_scroll_frame === null) {
		drag_scroll_frame = requestAnimationFrame(drag_edge_scroll_step);
	}
}

function drag_edge_scroll_step() {
	drag_scroll_frame = requestAnimationFrame(drag_edge_scroll_step);
	if (!drag_state?.active) { stop_drag_edge_scrolling(); return; }
	if (scroll_list_at_edge(drag_state.pointer_y)) { update_drag_indicator(drag_state.pointer_y); }
}

function stop_drag_edge_scrolling() {
	if (drag_scroll_frame !== null) {
		cancelAnimationFrame(drag_scroll_frame);
		drag_scroll_frame = null;
	}
}

/**
 * Moves a node to where it was dropped on a row.
 * @param {number} dragged_id
 * @param {import("./document-model.js").LayerNode} target
 * @param {DropPosition} position
 */
function drag_and_drop_node(dragged_id, target, position) {
	const dragged = document_model.find_node(dragged_id);
	const current_target = document_model.find_node(target.id);
	if (!dragged || !current_target) { return; }
	const { parent_id, index } = drop_destination(current_target, position);
	// Dropping a node on itself, inside itself, or back where it already is just moves nothing.
	undoable_layer_op("Move Layer", () => document_model.move_node(dragged.id, parent_id, index));
}

/**
 * @param {number} id
 * @param {JQuery<HTMLSpanElement>} $name
 */
function begin_rename(id, $name) {
	const node = document_model.find_node(id);
	if (!node) { return; }
	const $input = $(E("input")).attr({
		type: "text",
		value: node.name,
		"aria-label": "Layer name",
	}).addClass("layer-name-input");
	$name.replaceWith($input);
	$input.trigger("focus").trigger("select");
	let finished = false;
	const finish = (commit) => {
		if (finished) { return; }
		finished = true;
		const name = String($input.val()).trim();
		if (commit && name && name !== node.name) {
			undoable_layer_op("Rename Layer", () => {
				document_model.rename_node(id, name);
				return true;
			});
		} else {
			$input.replaceWith($name);
		}
	};
	$input.on("keydown", (event) => {
		if (event.key === "Enter") { finish(true); }
		if (event.key === "Escape") { finish(false); }
	});
	$input.on("blur", () => {
		finish(true);
	});
	// don't let the row's click handler interfere with text editing
	$input.on("click dblclick", (event) => event.stopPropagation());
}

/**
 * @param {JQuery<HTMLDivElement>} $content
 */
function make_panel($content) {
	const $toolbar = $(E("div")).addClass("layers-toolbar");
	// `history_name` is the undo step the action is recorded under; an empty one means the action
	// records its own history (the selection operations do, since they don't change the layer tree).
	/** @type {[string, string, string, string, () => boolean][]} */
	const buttons = [
		["new-layer", "+", "New layer", "New Layer", () => { document_model.add_layer(); return true; }],
		["new-group", "▰", "New set", "New Set", () => { document_model.add_group(); return true; }],
		["duplicate", "⧉", "Duplicate layer or set", "Duplicate Layer", () => document_model.duplicate_node(document_model.get_selected_node_id())],
		["merge", "⤓", "Merge down", "Merge Down", () => document_model.merge_down(document_model.get_selected_node_id())],
		["flatten", "▤", "Flatten image", "Flatten Image", () => document_model.flatten_document()],
		["load-selection", "⬚", "Load as selection", "", () => load_node_as_selection(document_model.get_selected_node_id())],
		["delete", "×", "Delete layer or set", "Delete Layer", () => document_model.delete_node(document_model.get_selected_node_id())],
	];
	for (const [key, label, title, history_name, action] of buttons) {
		const $button = $(E("button")).attr({ type: "button", title, "aria-label": title }).text(label).on("click", () => {
			if (history_name) {
				undoable_layer_op(history_name, action);
			} else {
				action();
			}
		});
		$button.appendTo($toolbar);
		toolbar_buttons.set(key, $button);
	}
	$layer_list = $(E("div")).addClass("layers-list");
	$content.append($toolbar, $layer_list);
}

function initialize_layers() {
	const $content = $(E("div")).addClass("layers-panel");
	make_panel($content);
	$panel = $Component("Layers", "layers-component", "tall", $content);
	$panel.appendTo(get_direction() === "rtl" ? $right : $left);

	$G.on("document-update", render_layer_list);
	$G.on("layer-thumbnails-update", refresh_thumbnails);
	// Pixel edits (strokes, fills, transformations) also change what the thumbnails should show.
	$G.on("session-update", refresh_thumbnails);

	render_layer_list();
}

export { initialize_layers, refresh_thumbnails, render_layer_list };
