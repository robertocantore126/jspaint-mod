// @ts-check
/* global $left, $right, get_direction */
import { document_model } from "./document-model.js";
import { make_or_update_undoable, undoable } from "./functions.js";
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

/** @type {JQuery<HTMLDivElement>} */
let $layer_list;
/** @type {Map<number, { $row: JQuery<HTMLDivElement>, $thumbnail: JQuery<HTMLCanvasElement> }>} */
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

/**
 * Reads the drag data from an event, whether it's a native drag event or a synthetic one.
 * @param {JQuery.Event} event
 * @returns {DataTransfer | undefined}
 */
function get_data_transfer(event) {
	return /** @type {any} */ (event).originalEvent?.dataTransfer || /** @type {any} */ (event).dataTransfer;
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
}

function refresh_thumbnails() {
	for (const [id, { $thumbnail }] of row_elements) {
		const node = document_model.find_node(id);
		if (node) { draw_thumbnail($thumbnail[0], node); }
	}
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import("./document-model.js").LayerNode} node
 */
function draw_thumbnail(canvas, node) {
	const ctx = canvas.getContext("2d");
	if (!ctx) { return; }
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
	const layers = node.type === "layer" ? [node] : document_model.flatten_bottom_to_top(node);
	const reference = node.type === "layer" ? node.canvas : layers[0]?.canvas;
	if (!reference) { return; }
	const scale = Math.min(THUMBNAIL_SIZE / reference.width, THUMBNAIL_SIZE / reference.height);
	const width = Math.max(1, Math.round(reference.width * scale));
	const height = Math.max(1, Math.round(reference.height * scale));
	const x = Math.round((THUMBNAIL_SIZE - width) / 2);
	const y = Math.round((THUMBNAIL_SIZE - height) / 2);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "medium";
	const group_opacity = node.type === "group" ? node.opacity : 1;
	for (const layer of layers) {
		if (!layer.visible || !layer.canvas) { continue; }
		ctx.globalAlpha = layer.opacity * group_opacity;
		ctx.drawImage(layer.canvas, x, y, width, height);
	}
	ctx.globalAlpha = 1;
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
		draggable: "true",
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
	const $thumbnail = $(E("canvas")).addClass("layer-thumbnail").attr({
		width: THUMBNAIL_SIZE,
		height: THUMBNAIL_SIZE,
	});
	const $name = $(E("span")).addClass("layer-name").text(node.name).attr("title", node.name);
	const $opacity = $(E("input")).attr({
		type: "range",
		min: "0",
		max: "100",
		value: String(Math.round(node.opacity * 100)),
		title: "Layer opacity",
		"aria-label": "Layer opacity",
	}).addClass("layer-opacity");
	$row.append($visibility, $expand, $thumbnail, $name, $opacity);
	draw_thumbnail(/** @type {HTMLCanvasElement} */ ($thumbnail[0]), node);
	row_elements.set(node.id, { $row, $thumbnail });

	$row.on("click", (event) => {
		if ($(event.target).is("button, input")) { return; }
		document_model.select_node(node.id);
	});
	$row.on("dblclick", (event) => {
		if ($(event.target).is("button, input")) { return; }
		begin_rename(node.id, $row, $name);
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
	$row.on("dragstart", (event) => {
		get_data_transfer(event)?.setData("text/plain", node.id.toString());
	});
	$row.on("dragover", (event) => {
		event.preventDefault();
		$row.addClass("drop-target");
	});
	$row.on("dragleave", () => $row.removeClass("drop-target"));
	$row.on("drop", (event) => {
		event.preventDefault();
		event.stopPropagation();
		$row.removeClass("drop-target");
		drag_and_drop_node(event, node);
	});
	return $row;
}

/**
 * @param {JQuery.Event} event
 * @param {import("./document-model.js").LayerNode} target
 */
function drag_and_drop_node(event, target) {
	const data_transfer = get_data_transfer(event);
	const dragged_id = Number(data_transfer?.getData("text/plain"));
	const dragged = document_model.find_node(dragged_id);
	const current_target = document_model.find_node(target.id);
	if (!dragged || !current_target || dragged.id === current_target.id) { return; }
	if (current_target.type === "group") {
		// Dropping on a group puts the layer inside it, on top.
		undoable_layer_op("Move Layer", () => document_model.move_node(dragged.id, current_target.id, (current_target.children || []).length));
		return;
	}
	// Dropping on a layer puts it directly above that layer.
	const parent_id = document_model.find_parent_id(current_target);
	const siblings = document_model.find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === current_target.id);
	undoable_layer_op("Move Layer", () => document_model.move_node(dragged.id, parent_id, index + 1));
}

/**
 * @param {number} id
 * @param {JQuery<HTMLDivElement>} $row
 * @param {JQuery<HTMLSpanElement>} $name
 */
function begin_rename(id, $row, $name) {
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
		$row.attr("draggable", "true");
	});
	// don't let the row's click/drag handlers interfere with text editing
	$input.on("click dblclick", (event) => event.stopPropagation());
	$row.attr("draggable", "false");
}

/**
 * @param {JQuery<HTMLDivElement>} $content
 */
function make_panel($content) {
	const $toolbar = $(E("div")).addClass("layers-toolbar");
	/** @type {[string, string, () => void][]} */
	const buttons = [
		["+", "New layer", () => undoable_layer_op("New Layer", () => { document_model.add_layer(); return true; })],
		["▰", "New group", () => undoable_layer_op("New Group", () => { document_model.add_group(); return true; })],
		["×", "Delete layer or group", () => {
			const id = document_model.get_selected_node_id();
			undoable_layer_op("Delete Layer", () => document_model.delete_node(id));
		}],
	];
	for (const [label, title, callback] of buttons) {
		$(E("button")).attr({ type: "button", title, "aria-label": title }).text(label).on("click", callback).appendTo($toolbar);
	}
	$layer_list = $(E("div")).addClass("layers-list").on("dragover", (event) => event.preventDefault()).on("drop", (event) => {
		event.preventDefault();
		// Dropped on empty space: move the node to the top of the document's root.
		const data_transfer = get_data_transfer(event);
		const dragged_id = Number(data_transfer?.getData("text/plain"));
		const dragged = document_model.find_node(dragged_id);
		if (!dragged) { return; }
		const root = document_model.get_root();
		undoable_layer_op("Move Layer", () => document_model.move_node(dragged.id, root.id, (root.children || []).length));
	});
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
