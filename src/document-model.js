// @ts-check
/* global main_canvas, main_ctx */
import { $G, make_canvas } from "./helpers.js";

/**
 * The document's layer model.
 *
 * The picture is a tree of layers and groups. `main_canvas` is only ever a *view* of the document:
 * it is written exclusively by `render_to()`/`invalidate()`, and is never used as scratch space by
 * tools or commands. Tools paint into the active layer's own canvas (see `get_active_layer_ctx()`),
 * and the model re-composites the affected region afterwards. That means the visible canvas always
 * shows the document, and there is no "in-flight edit" window in which edits can be silently
 * discarded or read inconsistently.
 *
 * ## Ordering
 *
 * A group's `children` are ordered bottom-to-top: the **last** child is drawn on top. The layer
 * panel renders the same order reversed, so the topmost row is the topmost layer. Only this module
 * decides order (see `flatten_bottom_to_top()` / `flatten_top_to_bottom()`), so the panel and the
 * compositor can't disagree.
 *
 * ## History
 *
 * History snapshots are structural: they copy the tree's small node records, sharing canvas
 * references with the live tree. Pixels are copied at most once per stroke/undoable, by
 * `begin_edit()` (copy-on-write), so older snapshots keep the pixels they were taken with, and
 * undo/redo is a pointer swap rather than re-materializing every layer from image data.
 *
 * @typedef {object} LayerNode
 * @property {number} id
 * @property {"layer" | "group"} type
 * @property {string} name
 * @property {boolean} visible
 * @property {number} opacity
 * @property {boolean} expanded
 * @property {PixelCanvas=} canvas - only meaningful for layers
 * @property {LayerNode[]=} children - only meaningful for groups
 *
 * @typedef {object} LayerSnapshot
 * @property {number} next_id
 * @property {number} active_layer_id
 * @property {number} selected_node_id
 * @property {number} width
 * @property {number} height
 * @property {LayerNode} root
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 *
 * Serialization types (see `serialize()`/`load_serialized()`):
 *
 * @typedef {object} SerializedLayerNode
 * @property {number} id
 * @property {"layer" | "group"} type
 * @property {string} name
 * @property {boolean} visible
 * @property {number} opacity
 * @property {boolean} expanded
 * @property {SerializedLayerNode[]=} children - only meaningful for groups
 * @property {string=} canvas_data_url - only meaningful for layers
 *
 * @typedef {object} SerializedDocument
 * @property {number} version
 * @property {number} width
 * @property {number} height
 * @property {number} next_id
 * @property {number} active_layer_id
 * @property {number} selected_node_id
 * @property {SerializedLayerNode} root
 */

/** @type {number} */
let next_id = 1;
/** @type {LayerNode} */
let root = { id: next_id++, type: "group", name: "Document", visible: true, opacity: 1, expanded: true, children: [] };
/** @type {number} */
let active_layer_id = 0;
/** @type {number} */
let selected_node_id = 0;
/**
 * Canvases that a history snapshot refers to. A canvas is never un-adopted: once it belongs to a
 * snapshot, it must not be painted into directly, or that history state would change retroactively.
 * `begin_edit()` clones the active layer's canvas when it's one of these (copy-on-write), at most
 * once per stroke/edit, so undo/redo stays exact without copying pixels per history step.
 * @type {WeakSet<PixelCanvas>}
 */
const adopted_canvases = new WeakSet();
/**
 * Canvases for rendering groups with opacity, one per nesting depth, resized to the document.
 * @type {PixelCanvas[]}
 */
const scratch_canvases = [];
/**
 * Layer canvases that have been painted into since the last `serialize()`, so that saving doesn't
 * have to re-encode every layer every time (encoding a PNG per layer is the expensive part of
 * saving a document with layers, and autosave runs after every edit).
 *
 * This relies on the same invariant as copy-on-write for undo: a layer canvas is only ever painted
 * into by an edit that called `begin_edit()`/`begin_stroke()` first (or is replaced with a brand
 * new canvas, which can't be in the cache yet).
 * @type {WeakSet<PixelCanvas>}
 */
const edited_canvases = new WeakSet();
/** @type {Map<PixelCanvas, string>} the PNG data URL last encoded for each canvas */
const canvas_data_urls = new Map();

// #region Nodes

/**
 * @param {string} name
 * @param {PixelCanvas} canvas
 * @returns {LayerNode}
 */
function make_layer_node(name, canvas) {
	return {
		id: next_id++,
		type: "layer",
		name,
		visible: true,
		opacity: 1,
		expanded: true,
		canvas,
	};
}

/**
 * @param {string} name
 * @returns {LayerNode}
 */
function make_group_node(name) {
	return {
		id: next_id++,
		type: "group",
		name,
		visible: true,
		opacity: 1,
		expanded: true,
		children: [],
	};
}

/**
 * @param {number} id
 * @param {LayerNode} [from]
 * @returns {LayerNode[]} the path from `from` down to the node (inclusive), or [] if not found
 */
function find_path(id, from = root) {
	if (from.id === id) { return [from]; }
	for (const child of from.children || []) {
		const path = find_path(id, child);
		if (path.length > 0) { return [from, ...path]; }
	}
	return [];
}

/**
 * @param {number} id
 * @returns {LayerNode | null}
 */
function find_node(id) {
	const path = find_path(id);
	return path.length > 0 ? path[path.length - 1] : null;
}

/**
 * @param {LayerNode} node
 * @returns {number} the id of the node's parent (the root's id for top-level nodes)
 */
function find_parent_id(node) {
	const path = find_path(node.id);
	return path.length >= 2 ? path[path.length - 2].id : root.id;
}

/**
 * @param {LayerNode} node
 * @param {number} ancestor_id
 * @returns {boolean} whether the node is nested inside the node with the given id
 */
function is_descendant_of(node, ancestor_id) {
	return find_path(node.id).some((ancestor) => ancestor.id === ancestor_id);
}

/**
 * Applies a function to every node, rebuilding only the parts of the tree that changed.
 * @param {LayerNode} node
 * @param {(node: LayerNode) => LayerNode} fn
 * @returns {LayerNode}
 */
function map_tree(node, fn) {
	const mapped = fn(node);
	if (mapped.type === "group" && mapped.children) {
		const children = mapped.children.map((child) => map_tree(child, fn));
		if (children.some((child, i) => child !== mapped.children[i])) {
			return { ...mapped, children };
		}
	}
	return mapped;
}

/**
 * Replaces one node, leaving the rest of the tree structurally shared.
 * @param {LayerNode} node
 * @param {number} id
 * @param {LayerNode} new_node
 * @returns {LayerNode}
 */
function replace_node(node, id, new_node) {
	return map_tree(node, (candidate) => (candidate.id === id ? new_node : candidate));
}

/**
 * Removes a node from the tree.
 * @param {LayerNode} node
 * @param {number} id
 * @returns {LayerNode}
 */
function remove_node(node, id) {
	if (node.type !== "group" || !node.children) { return node; }
	const index = node.children.findIndex((child) => child.id === id);
	if (index !== -1) {
		return { ...node, children: [...node.children.slice(0, index), ...node.children.slice(index + 1)] };
	}
	const children = node.children.map((child) => remove_node(child, id));
	return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

/**
 * Inserts a node into a group.
 * @param {LayerNode} node
 * @param {number} parent_id
 * @param {LayerNode} child
 * @param {number} index
 * @returns {LayerNode}
 */
function insert_node(node, parent_id, child, index) {
	return map_tree(node, (candidate) => {
		if (candidate.id !== parent_id || candidate.type !== "group") { return candidate; }
		const children = [...(candidate.children || [])];
		children.splice(Math.max(0, Math.min(index, children.length)), 0, child);
		return { ...candidate, children };
	});
}

/**
 * @param {LayerNode} [node]
 * @returns {LayerNode[]} every layer in the subtree, in draw order (bottom-to-top)
 */
function flatten_bottom_to_top(node = root) {
	/** @type {LayerNode[]} */
	const result = [];
	const walk = (candidate) => {
		for (const child of candidate.children || []) {
			if (child.type === "layer") {
				result.push(child);
			} else {
				walk(child);
			}
		}
	};
	walk(node);
	return result;
}

/**
 * @returns {LayerNode[]} every layer, in panel order (top-to-bottom)
 */
function flatten_top_to_bottom() {
	return flatten_bottom_to_top().reverse();
}

/**
 * @param {LayerNode} node
 * @returns {LayerNode[]} the layers in the node's subtree, in draw order
 */
function flatten_subtree_bottom_to_top(node) {
	return node.type === "layer" ? [node] : flatten_bottom_to_top(node);
}

/**
 * @param {LayerNode[]} nodes
 * @returns {LayerNode | null} the topmost layer within the given nodes
 */
function topmost_layer_of(nodes) {
	for (const node of [...nodes].reverse()) {
		const layers = flatten_subtree_bottom_to_top(node);
		if (layers.length > 0) { return layers[layers.length - 1]; }
	}
	return null;
}

/**
 * Creates a layer, for a document that somehow has none. A document always has at least one layer;
 * this is a safety net so that tools always have something to draw into.
 * @returns {LayerNode}
 */
function ensure_a_layer() {
	const layers = flatten_bottom_to_top();
	if (layers.length > 0) { return layers[0]; }
	const layer = make_layer_node("Layer 1", make_canvas(main_canvas.width, main_canvas.height));
	root = insert_node(root, root.id, layer, 0);
	notify_tree_changed();
	return layer;
}

/** @returns {LayerNode} the layer that tools draw into */
function get_active_layer() {
	const node = find_node(active_layer_id);
	if (!node || node.type !== "layer") {
		const layer = ensure_a_layer();
		active_layer_id = layer.id;
		return layer;
	}
	if (!node.canvas) {
		const with_canvas = { ...node, canvas: make_canvas(main_canvas.width, main_canvas.height) };
		root = replace_node(root, node.id, with_canvas);
		return with_canvas;
	}
	return node;
}

/** @returns {PixelCanvas} */
function get_active_layer_canvas() {
	return /** @type {PixelCanvas} */ (get_active_layer().canvas);
}

/** @returns {CanvasRenderingContext2D} the context tools should draw into */
function get_active_layer_ctx() {
	return /** @type {CanvasRenderingContext2D} */ (get_active_layer_canvas().ctx);
}

/**
 * Replaces the active layer's pixels with the given image, optionally resizing the document to
 * match (used by transformations that change the document's dimensions, like rotate and stretch).
 * @param {PixelCanvas | HTMLImageElement | ImageData} canvas_or_image
 * @param {boolean} [resize_document]
 */
function set_active_layer_canvas(canvas_or_image, resize_document = false) {
	const node = get_active_layer();
	const image = /** @type {HTMLImageElement | ImageData} */ (canvas_or_image);
	const width = /** @type {any} */ (image).naturalWidth || image.width;
	const height = /** @type {any} */ (image).naturalHeight || image.height;
	if (resize_document && (width !== main_canvas.width || height !== main_canvas.height)) {
		set_document_size(width, height);
	}
	const canvas = make_canvas(canvas_or_image);
	root = replace_node(root, node.id, { ...node, canvas });
	invalidate();
	notify_thumbnails_changed();
}

// #endregion

// #region Notifications

function notify_tree_changed() {
	$G.triggerHandler("document-update");
}


/** @returns {LayerNode} the root group. It isn't shown in the layer panel; it holds top-level nodes. */
function get_root() {
	return root;
}

/** @returns {number} the id of the selected row (which may be a group) */
function get_selected_node_id() {
	return selected_node_id;
}

function notify_thumbnails_changed() {
	$G.triggerHandler("layer-thumbnails-update");
}

// #endregion

// #region Structure changes

/**
 * @param {number} id
 */
function activate_layer(id) {
	const node = find_node(id);
	if (!node || node.type !== "layer") { return; }
	active_layer_id = node.id;
	selected_node_id = node.id;
	notify_tree_changed();
}

/**
 * Selects a row (which may be a group), making it the target of delete/duplicate/reorder and of the
 * place new layers and groups go (see insertion_point).
 *
 * Selecting a layer also makes it the layer that tools draw into. Selecting a group keeps drawing
 * in the active layer when it's inside that group, and otherwise switches to the group's top layer,
 * so that selecting a set lets you draw inside it without hunting for the right layer.
 *
 * @param {number} id
 */
function select_node(id) {
	const node = find_node(id);
	if (!node) { return; }
	selected_node_id = node.id;
	if (node.type === "layer") {
		active_layer_id = node.id;
	} else {
		const active = find_node(active_layer_id);
		const active_is_inside = !!active && active.type === "layer" && is_descendant_of(active, node.id);
		if (!active_is_inside) {
			const layers = flatten_subtree_bottom_to_top(node);
			const top = layers[layers.length - 1];
			if (top) { active_layer_id = top.id; }
		}
	}
	notify_tree_changed();
}

/**
 * @param {string} prefix
 * @returns {string} a name like "Layer 3", avoiding names that are already in use
 */
function next_name(prefix) {
	const names = new Set();
	const collect = (node) => {
		names.add(node.name);
		for (const child of node.children || []) { collect(child); }
	};
	collect(root);
	for (let n = 1; ; n++) {
		if (!names.has(`${prefix} ${n}`)) { return `${prefix} ${n}`; }
	}
}

/**
 * Where a new layer belongs, based on what's selected: the top of the selected group, or directly
 * above the selected layer (falling back to the active layer).
 * @returns {{ parent_id: number, index: number }}
 */
function insertion_point() {
	const selected = find_node(selected_node_id);
	if (selected && selected.type === "group") {
		return { parent_id: selected.id, index: (selected.children || []).length };
	}
	const reference = selected && selected.type === "layer" ? selected : get_active_layer();
	const parent_id = find_parent_id(reference);
	const siblings = find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === reference.id);
	return { parent_id, index: index === -1 ? siblings.length : index + 1 };
}

/**
 * Adds a layer: inside the selected group, or directly above the selected layer.
 * @returns {LayerNode}
 */
function add_layer() {
	const { parent_id, index } = insertion_point();
	const layer = make_layer_node(next_name("Layer"), make_canvas(main_canvas.width, main_canvas.height));
	root = insert_node(root, parent_id, layer, index);
	active_layer_id = layer.id;
	selected_node_id = layer.id;
	notify_tree_changed();
	return layer;
}

/**
 * Adds a group containing a new layer.
 *
 * A new set goes inside the selected set. Otherwise it's created at the top level, above the
 * selected layer's top-level ancestor, so that clicking "New set" repeatedly makes sibling sets
 * instead of burying each new one inside the last one.
 *
 * @returns {LayerNode}
 */
function add_group() {
	const selected = find_node(selected_node_id);
	let parent_id = root.id;
	let index = (root.children || []).length;
	if (selected && selected.type === "group") {
		parent_id = selected.id;
		index = (selected.children || []).length;
	} else {
		const reference = selected && selected.type === "layer" ? selected : get_active_layer();
		const top_level_index = (root.children || []).findIndex((child) => is_descendant_of(reference, child.id));
		if (top_level_index !== -1) { index = top_level_index + 1; }
	}
	const layer = make_layer_node(next_name("Layer"), make_canvas(main_canvas.width, main_canvas.height));
	const group = /** @type {LayerNode} */ ({ ...make_group_node(next_name("Set")), children: [layer] });
	root = insert_node(root, parent_id, group, index);
	active_layer_id = layer.id;
	selected_node_id = layer.id;
	notify_tree_changed();
	return group;
}

/**
 * Whether a node can be deleted: the last layer can't, since deleting it would throw away the whole
 * picture, and a document with no layers couldn't be drawn in.
 * @param {number} id
 * @returns {boolean}
 */
function can_delete(id) {
	const node = find_node(id);
	if (!node || node.id === root.id) { return false; }
	const deleted_ids = new Set([
		node.id,
		...flatten_subtree_bottom_to_top(node).map((layer) => layer.id),
	]);
	return flatten_bottom_to_top().some((layer) => !deleted_ids.has(layer.id));
}

/**
 * Deletes a node (a layer, or a whole group and its layers).
 *
 * The last layer can't be deleted: deleting it would throw away the whole picture, and a document
 * with no layers couldn't be drawn in.
 *
 * @param {number} id
 * @returns {boolean} whether anything was deleted
 */
function delete_node(id) {
	if (!can_delete(id)) { return false; }
	const node = /** @type {LayerNode} */ (find_node(id));
	const parent_id = find_parent_id(node);
	const siblings = find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === node.id);
	const deleted_ids = new Set([
		node.id,
		...flatten_subtree_bottom_to_top(node).map((layer) => layer.id),
	]);

	root = remove_node(root, node.id);

	if (deleted_ids.has(active_layer_id) || deleted_ids.has(selected_node_id)) {
		const new_siblings = find_node(parent_id)?.children || [];
		// Prefer whatever slid into the deleted node's place (and its topmost layer), else the
		// node before it, else anything that's left.
		const candidates = index > 0 ?
			[new_siblings[index - 1], new_siblings[index]] :
			[new_siblings[index], new_siblings[index - 1]];
		const replacement = topmost_layer_of(candidates.filter(Boolean)) || topmost_layer_of(new_siblings);
		selected_node_id = replacement ? replacement.id : (new_siblings[index - 1] || new_siblings[index] || root).id;
		active_layer_id = replacement ? replacement.id : 0;
	}

	if (flatten_bottom_to_top().length === 0) {
		// Safety net: this shouldn't be reachable, since the last layer can't be deleted.
		const layer = make_layer_node("Layer 1", make_canvas(main_canvas.width, main_canvas.height));
		root = insert_node(root, root.id, layer, 0);
		active_layer_id = layer.id;
		selected_node_id = layer.id;
	}
	invalidate();
	notify_tree_changed();
	return true;
}

/**
 * The index a node would end up at, or null if the move isn't possible or wouldn't change anything.
 *
 * `index` is interpreted as a position in the target parent's children *including* the node in its
 * current position, which is what "the index of the row it was dropped on (plus one for above)"
 * gives you; it's adjusted here for the node's own removal.
 *
 * @param {number} id
 * @param {number} parent_id
 * @param {number} index
 * @returns {number | null}
 */
function resolve_move(id, parent_id, index) {
	const node = find_node(id);
	const parent = find_node(parent_id);
	if (!node || !parent || parent.type !== "group" || node.id === root.id) { return null; }
	// A node can't go inside itself or inside anything it contains.
	if (node.id === parent_id || is_descendant_of(parent, node.id)) { return null; }
	const old_parent_id = find_parent_id(node);
	const old_index = (find_node(old_parent_id)?.children || []).findIndex((child) => child.id === node.id);
	const target_index = (old_parent_id === parent_id && old_index !== -1 && old_index < index) ? index - 1 : index;
	if (old_parent_id === parent_id && old_index === target_index) {
		return null; // it's already there; this way, a drop that changes nothing isn't undoable
	}
	return target_index;
}

/**
 * Whether `move_node` would actually move anything.
 *
 * The panel uses this to decide whether to show where a drag would land: showing a drop line over a
 * spot the model refuses looks like a bug from the outside.
 *
 * @param {number} id
 * @param {number} parent_id
 * @param {number} index
 * @returns {boolean}
 */
function can_move_node(id, parent_id, index) {
	return resolve_move(id, parent_id, index) !== null;
}

/**
 * Moves a node to a new position (see `resolve_move` for how `index` is read).
 * @param {number} id
 * @param {number} parent_id
 * @param {number} index
 * @returns {boolean}
 */
function move_node(id, parent_id, index) {
	const node = find_node(id);
	const target_index = resolve_move(id, parent_id, index);
	if (!node || target_index === null) { return false; }

	root = remove_node(root, node.id);
	root = insert_node(root, parent_id, node, target_index);
	invalidate();
	notify_tree_changed();
	return true;
}

/**
 * @param {number} id
 * @param {boolean} visible
 */
function set_visible(id, visible) {
	const node = find_node(id);
	if (!node) { return; }
	root = replace_node(root, id, { ...node, visible });
	invalidate();
	notify_tree_changed();
}

/**
 * @param {number} id
 * @param {number} opacity
 */
function set_opacity(id, opacity) {
	const node = find_node(id);
	if (!node) { return; }
	root = replace_node(root, id, { ...node, opacity: Math.max(0, Math.min(1, opacity)) });
	invalidate();
	notify_thumbnails_changed();
}

/**
 * @param {number} id
 * @param {boolean} expanded
 */
function set_expanded(id, expanded) {
	const node = find_node(id);
	if (!node) { return; }
	root = replace_node(root, id, { ...node, expanded });
	notify_tree_changed();
}

/**
 * @param {number} id
 * @param {string} name
 */
function rename_node(id, name) {
	const node = find_node(id);
	if (!node || !name) { return; }
	root = replace_node(root, id, { ...node, name });
	notify_tree_changed();
}

/**
 * @param {string} name
 * @returns {boolean} whether any node in the document is already called that
 */
function name_exists(name) {
	let found = false;
	const walk = (node) => {
		if (node.name === name) { found = true; }
		for (const child of node.children || []) { walk(child); }
	};
	walk(root);
	return found;
}

/**
 * The name for a copy of a node: "X copy", or "X copy 2" if that's taken. Duplicating a duplicate
 * counts up ("X copy" → "X copy 2") rather than stacking up "copy copy".
 * @param {string} base_name
 * @returns {string}
 */
function duplicate_name(base_name) {
	const match = /^(.*?) copy(?: (\d+))?$/.exec(base_name);
	const base = match ? match[1] : base_name;
	const start = match ? (match[2] ? Number(match[2]) + 1 : 2) : 1;
	for (let n = start; ; n++) {
		const candidate = n === 1 ? `${base} copy` : `${base} copy ${n}`;
		if (!name_exists(candidate)) { return candidate; }
	}
}

/**
 * @param {LayerNode} node
 * @returns {LayerNode} a deep copy with fresh ids and private copies of the canvases
 */
function copy_node_for_duplicate(node) {
	/** @type {LayerNode} */
	const copy = { ...node, id: next_id++ };
	if (node.type === "group") {
		copy.children = (node.children || []).map(copy_node_for_duplicate);
	} else if (node.canvas) {
		copy.canvas = make_canvas(node.canvas);
	}
	return copy;
}

/**
 * Duplicates a layer or group, placing the copy directly above the original in its group.
 *
 * The copy's canvases are new objects, so the copy can be painted into without touching the
 * original (and without needing copy-on-write for history).
 *
 * @param {number} id
 * @returns {boolean} whether anything was duplicated
 */
function duplicate_node(id) {
	const node = find_node(id);
	if (!node || node.id === root.id) { return false; }
	const parent_id = find_parent_id(node);
	const siblings = find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === node.id);
	if (index === -1) { return false; }

	const copy = copy_node_for_duplicate(node);
	copy.name = duplicate_name(node.name);
	root = insert_node(root, parent_id, copy, index + 1);
	const copied_layer = topmost_layer_of([copy]);
	if (copied_layer) { active_layer_id = copied_layer.id; }
	selected_node_id = copy.id;

	// Duplicating changes the composite when the original isn't fully opaque, so the visible canvas
	// has to be redrawn, not just the panel.
	invalidate();
	notify_thumbnails_changed();
	notify_tree_changed();
	return true;
}

/**
 * Whether a layer can be merged into the layer directly below it (they have to be layers in the
 * same group; merging across a group boundary would change what the group's opacity applies to).
 * @param {number} id
 * @returns {boolean}
 */
function can_merge_down(id) {
	const node = find_node(id);
	if (!node || node.type !== "layer") { return false; }
	const siblings = find_node(find_parent_id(node))?.children || [];
	const index = siblings.findIndex((child) => child.id === node.id);
	const below = siblings[index - 1];
	return !!below && below.type === "layer" && !!below.canvas;
}

/**
 * Merges a layer into the layer below it, then removes it.
 *
 * The layer below keeps its name and its own opacity; the merged-in layer's pixels are drawn with
 * its opacity, so the result looks like the two did before merging (as far as they were opaque).
 *
 * @param {number} id
 * @returns {boolean} whether anything was merged
 */
function merge_down(id) {
	if (!can_merge_down(id)) { return false; }
	const node = /** @type {LayerNode} */ (find_node(id));
	const parent_id = find_parent_id(node);
	const siblings = find_node(parent_id)?.children || [];
	const index = siblings.findIndex((child) => child.id === node.id);
	const below_id = siblings[index - 1].id;

	// The pixels below are about to change, but an earlier history snapshot may still be holding
	// this canvas, so make it private first (copy-on-write).
	begin_edit(below_id);
	const below = find_node(below_id);
	if (!below || !below.canvas) { return false; }
	const ctx = below.canvas.ctx;
	ctx.save();
	ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity));
	if (node.canvas) { ctx.drawImage(node.canvas, 0, 0); }
	ctx.restore();

	delete_node(node.id);
	// The merged result *is* the layer that was below, so keep that one active and selected.
	active_layer_id = below_id;
	selected_node_id = below_id;

	invalidate();
	notify_thumbnails_changed();
	notify_tree_changed();
	return true;
}

/**
 * @returns {boolean} whether the document is more than a single top-level layer
 */
function can_flatten() {
	const children = root.children || [];
	return children.length > 1 || (children.length === 1 && children[0].type !== "layer");
}

/**
 * Replaces the document with a single layer holding the flattened composite, named after the
 * layer that was at the bottom.
 *
 * Hidden layers and groups are not part of the composite, so (like in other editors) they are
 * dropped; the operation is a single undo step, so it can always be taken back.
 *
 * @returns {boolean} whether anything was flattened
 */
function flatten_document() {
	if (!can_flatten()) { return false; }
	const layers = flatten_bottom_to_top();
	const flattened = to_canvas();
	const layer = make_layer_node((layers[0] && layers[0].name) || "Layer 1", flattened);
	root = { ...make_group_node("Document"), children: [layer] };
	active_layer_id = layer.id;
	selected_node_id = layer.id;

	invalidate();
	notify_thumbnails_changed();
	notify_tree_changed();
	return true;
}

// #endregion

// #region Document size and lifecycle

/**
 * Resizes the visible canvas and the document's dimensions. Layer canvases are resized separately
 * (see `resize_canvas()` and `normalize_layer_sizes()`).
 * @param {number} width
 * @param {number} height
 */
function set_document_size(width, height) {
	if (main_canvas.width === width && main_canvas.height === height) { return; }
	main_canvas.width = width;
	main_canvas.height = height;
	// Resizing a canvas resets its context state, including image smoothing.
	main_ctx.disable_image_smoothing();
}

/**
 * Replaces every layer's canvas with the result of a transformation, and resizes the document to
 * the size the transformation produced.
 *
 * This is for document-level geometry operations (Flip, Rotate, Stretch/Skew): they apply to every
 * layer so the layers stay aligned with each other, and rotating by 90° changes the document's
 * dimensions, which is only coherent if every layer is transformed the same way.
 *
 * @param {(canvas: PixelCanvas, node: LayerNode, info: { is_backdrop: boolean }) => PixelCanvas} transform
 * @param {number} width
 * @param {number} height
 */
function transform_layers(transform, width, height) {
	// (A transformation may fill in area it doesn't cover with the background color; that belongs in
	// the backdrop layer only, so the caller is told which one that is.)
	const backdrop = get_backdrop_layer();
	const backdrop_id = backdrop && backdrop.id;
	root = map_tree(root, (node) => {
		if (node.type !== "layer" || !node.canvas) { return node; }
		return { ...node, canvas: transform(node.canvas, node, { is_backdrop: node.id === backdrop_id }) };
	});
	set_document_size(width, height);
	normalize_layer_sizes();
	invalidate();
	notify_thumbnails_changed();
}

/**
 * Marks every layer's canvas as edited (used when an operation can't say exactly which layers it
 * touched).
 */
function mark_all_canvases_edited() {
	for (const layer of flatten_bottom_to_top()) {
		if (layer.canvas) { edited_canvases.add(layer.canvas); }
	}
}

/**
 * The layer that represents the document's backdrop: the bottom-most visible layer, or the
 * bottom-most layer if none are visible.
 *
 * Operations that fill in empty area (resizing, and rotations that don't keep transparency) fill it
 * in this layer only. Filling in *every* layer would make the upper layers opaque, hiding the
 * layers below them.
 * @returns {LayerNode | null}
 */
function get_backdrop_layer() {
	const layers = flatten_bottom_to_top();
	return layers.find((layer) => layer.visible) || layers[0] || null;
}

/**
 * Resizes the document, cropping/padding every layer by the given offset. (Canvas size is a
 * document-level property, so this necessarily affects all layers.)
 * @param {number} width
 * @param {number} height
 * @param {number} [offset_x]
 * @param {number} [offset_y]
 * @param {string | CanvasPattern | null} [fill_color] - fills the new area with this, if given, in
 *   the backdrop layer only (see get_backdrop_layer)
 */
function resize_canvas(width, height, offset_x = 0, offset_y = 0, fill_color = null) {
	const new_width = Math.max(1, width);
	const new_height = Math.max(1, height);
	if (main_canvas.width === new_width && main_canvas.height === new_height) { return; }
	const backdrop = get_backdrop_layer();
	const backdrop_id = backdrop && backdrop.id;
	root = map_tree(root, (node) => {
		if (node.type !== "layer" || !node.canvas) { return node; }
		const resized = make_canvas(new_width, new_height);
		if (fill_color && node.id === backdrop_id) {
			resized.ctx.fillStyle = fill_color;
			resized.ctx.fillRect(0, 0, new_width, new_height);
		}
		resized.ctx.drawImage(node.canvas, -offset_x, -offset_y);
		return { ...node, canvas: resized };
	});
	set_document_size(new_width, new_height);
	invalidate();
	notify_thumbnails_changed();
}

/**
 * Ensures every layer canvas matches the document size, cropping anything larger. (Restoring an old
 * snapshot can bring back canvases from a different document size, if a resize happened since.)
 */
function normalize_layer_sizes() {
	const width = main_canvas.width;
	const height = main_canvas.height;
	root = map_tree(root, (node) => {
		if (node.type !== "layer" || !node.canvas) { return node; }
		if (node.canvas.width === width && node.canvas.height === height) { return node; }
		const resized = make_canvas(width, height);
		resized.ctx.drawImage(node.canvas, 0, 0);
		return { ...node, canvas: resized };
	});
}

/**
 * Replaces the document with a blank single-layer document of the given size.
 * @param {number} width
 * @param {number} height
 * @param {string | CanvasPattern | null} [fill_color]
 * @returns {LayerNode}
 */
function reset_document(width, height, fill_color = null) {
	next_id = 1;
	root = { ...make_group_node("Document"), children: [] };
	const layer = make_layer_node("Layer 1", make_canvas(Math.max(1, width), Math.max(1, height)));
	root = insert_node(root, root.id, layer, 0);
	active_layer_id = layer.id;
	selected_node_id = layer.id;
	set_document_size(layer.canvas.width, layer.canvas.height);
	if (fill_color) {
		layer.canvas.ctx.fillStyle = fill_color;
		layer.canvas.ctx.fillRect(0, 0, main_canvas.width, main_canvas.height);
	}
	invalidate();
	notify_tree_changed();
	return layer;
}

/**
 * Replaces the document with a single layer containing the given image.
 * @param {HTMLImageElement | HTMLCanvasElement | ImageData} image
 * @returns {LayerNode}
 */
function load_image(image) {
	const width = /** @type {any} */ (image).naturalWidth || image.width;
	const height = /** @type {any} */ (image).naturalHeight || image.height;
	const layer = reset_document(width, height, null);
	const ctx = /** @type {CanvasRenderingContext2D} */ (layer.canvas?.ctx);
	if (image instanceof ImageData) {
		ctx.putImageData(image, 0, 0);
	} else {
		ctx.drawImage(image, 0, 0);
	}
	invalidate();
	notify_thumbnails_changed();
	return layer;
}

// #endregion

// #region Rendering

/**
 * @param {number} depth
 * @returns {PixelCanvas} a scratch canvas for rendering a group with opacity
 */
function get_scratch_canvas(depth) {
	const width = main_canvas.width;
	const height = main_canvas.height;
	let scratch = scratch_canvases[depth];
	if (!scratch) {
		scratch = scratch_canvases[depth] = make_canvas(width, height);
	} else if (scratch.width !== width || scratch.height !== height) {
		scratch.width = width;
		scratch.height = height;
		scratch.ctx.disable_image_smoothing();
	}
	return scratch;
}

/**
 * Draws a node (and its subtree) into a context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {LayerNode} node
 * @param {Rect} source - region of the document to draw (in document coordinates)
 * @param {Rect} dest - where to draw it (in the target context's coordinates)
 * @param {number} depth
 */
function render_node(ctx, node, source, dest, depth) {
	if (!node.visible) { return; }
	if (node.type === "layer") {
		if (!node.canvas) { return; }
		ctx.save();
		ctx.globalAlpha = node.opacity;
		ctx.drawImage(node.canvas, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
		ctx.restore();
		return;
	}
	const children = node.children || [];
	if (node.opacity >= 1) {
		for (const child of children) {
			render_node(ctx, child, source, dest, depth);
		}
		return;
	}
	// Isolated group rendering: composite the subtree at document scale, then draw the result with
	// the group's opacity. (Multiplying the opacity into each child instead would darken the areas
	// where children overlap, which is not what group opacity means.)
	const scratch = get_scratch_canvas(depth);
	const scratch_ctx = scratch.ctx;
	scratch_ctx.save();
	scratch_ctx.clearRect(source.x, source.y, source.width, source.height);
	scratch_ctx.beginPath();
	scratch_ctx.rect(source.x, source.y, source.width, source.height);
	scratch_ctx.clip();
	const identity = { x: source.x, y: source.y, width: source.width, height: source.height };
	for (const child of children) {
		render_node(scratch_ctx, child, identity, identity, depth + 1);
	}
	scratch_ctx.restore();
	ctx.save();
	ctx.globalAlpha = node.opacity;
	ctx.drawImage(scratch, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
	ctx.restore();
}

/**
 * Draws the document (or a region of it) into a context, through a source→destination transform.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} source_x
 * @param {number} source_y
 * @param {number} source_width
 * @param {number} source_height
 * @param {number} dest_x
 * @param {number} dest_y
 * @param {number} dest_width
 * @param {number} dest_height
 */
function render_to(ctx, source_x, source_y, source_width, source_height, dest_x, dest_y, dest_width, dest_height) {
	if (source_width <= 0 || source_height <= 0 || dest_width <= 0 || dest_height <= 0) { return; }
	ctx.save();
	ctx.clearRect(dest_x, dest_y, dest_width, dest_height);
	ctx.beginPath();
	ctx.rect(dest_x, dest_y, dest_width, dest_height);
	ctx.clip();
	render_node(
		ctx,
		root,
		{ x: source_x, y: source_y, width: source_width, height: source_height },
		{ x: dest_x, y: dest_y, width: dest_width, height: dest_height },
		0,
	);
	ctx.restore();
}

/**
 * Composites the document into the visible canvas. Pass a region (in document coordinates) to
 * redraw only part of it, which is what keeps drawing responsive on large documents.
 * @param {Rect} [region]
 */
function invalidate(region) {
	if (!region) {
		render_to(main_ctx, 0, 0, main_canvas.width, main_canvas.height, 0, 0, main_canvas.width, main_canvas.height);
		return;
	}
	const x = Math.max(0, Math.floor(region.x));
	const y = Math.max(0, Math.floor(region.y));
	const x2 = Math.min(main_canvas.width, Math.ceil(region.x + region.width));
	const y2 = Math.min(main_canvas.height, Math.ceil(region.y + region.height));
	if (x2 <= x || y2 <= y) { return; }
	render_to(main_ctx, x, y, x2 - x, y2 - y, x, y, x2 - x, y2 - y);
}

/**
 * @returns {PixelCanvas} a new canvas containing the flattened document
 */
function to_canvas() {
	const canvas = make_canvas(main_canvas.width, main_canvas.height);
	render_to(canvas.ctx, 0, 0, main_canvas.width, main_canvas.height, 0, 0, main_canvas.width, main_canvas.height);
	return canvas;
}

/**
 * A node's subtree as it would look if the node itself were shown, cropped to the bounding box of
 * its non-transparent pixels. Used to load a layer or set as a selection.
 *
 * The node's own visibility is ignored (loading a hidden set as a selection is still meaningful),
 * but its children's visibility is respected, since that's what "the set's contents" means. The
 * node's own opacity is applied, so the selection holds the pixels as they appear.
 *
 * @param {number} id
 * @returns {{ canvas: PixelCanvas, x: number, y: number } | null} null if there's nothing to select
 */
function to_node_canvas(id) {
	const node = find_node(id);
	if (!node) { return null; }
	const width = main_canvas.width;
	const height = main_canvas.height;
	const full = make_canvas(width, height);
	const whole = { x: 0, y: 0, width, height };
	render_node(full.ctx, { ...node, visible: true }, whole, whole, 0);

	const data = full.ctx.getImageData(0, 0, width, height).data;
	let min_x = width;
	let min_y = height;
	let max_x = -1;
	let max_y = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] > 0) {
				if (x < min_x) { min_x = x; }
				if (x > max_x) { max_x = x; }
				if (y < min_y) { min_y = y; }
				if (y > max_y) { max_y = y; }
			}
		}
	}
	if (max_x < min_x || max_y < min_y) { return null; }

	const cropped = make_canvas(max_x - min_x + 1, max_y - min_y + 1);
	cropped.ctx.drawImage(full, min_x, min_y, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
	return { canvas: cropped, x: min_x, y: min_y };
}

// #endregion

// #region History

/**
 * Makes the active layer's canvas safe to paint into, by copying it if it's still shared with the
 * current history snapshot. Repeated calls within the same edit are free.
 * @param {number} [layer_id]
 */
function begin_edit(layer_id = active_layer_id) {
	const node = find_node(layer_id);
	if (!node || node.type !== "layer" || !node.canvas) { return; }
	// This canvas is about to change, so any saved copy of it is out of date.
	edited_canvases.add(node.canvas);
	if (!adopted_canvases.has(node.canvas)) { return; }
	root = replace_node(root, node.id, { ...node, canvas: make_canvas(node.canvas) });
}

/** Begins a drawing gesture: after this, tools can paint into the active layer without copying. */
function begin_stroke() {
	begin_edit(active_layer_id);
}

/** Ends a drawing gesture, making sure the visible canvas and thumbnails are up to date. */
function end_stroke() {
	invalidate();
	notify_thumbnails_changed();
}

/**
 * @returns {LayerSnapshot} a snapshot of the document's structure, sharing canvas references
 */
function snapshot() {
	for (const layer of flatten_bottom_to_top()) {
		if (layer.canvas) { adopted_canvases.add(layer.canvas); }
	}
	return {
		next_id,
		active_layer_id,
		selected_node_id,
		width: main_canvas.width,
		height: main_canvas.height,
		root: copy_tree(root),
	};
}

/**
 * @param {LayerNode} node
 * @returns {LayerNode} a copy of the node's records, sharing canvas references
 */
function copy_tree(node) {
	return node.type === "group" ?
		{ ...node, children: (node.children || []).map(copy_tree) } :
		{ ...node };
}

/**
 * Restores a snapshot taken by `snapshot()`.
 * @param {unknown} state
 * @returns {boolean} whether the state could be restored
 */
function restore(state) {
	const saved = /** @type {LayerSnapshot | null} */ (state);
	if (!saved || !saved.root) { return false; }
	// Restored canvases may be ones that were saved before they were painted into.
	mark_all_canvases_edited();
	next_id = saved.next_id || next_id;
	root = copy_tree(saved.root);
	active_layer_id = saved.active_layer_id;
	selected_node_id = saved.selected_node_id ?? saved.active_layer_id;
	set_document_size(saved.width || main_canvas.width, saved.height || main_canvas.height);
	normalize_layer_sizes();
	const active = find_node(active_layer_id);
	if (!active || active.type !== "layer") {
		active_layer_id = ensure_a_layer().id;
	}
	invalidate();
	notify_tree_changed();
	return true;
}

// #endregion

// #region Persistence

/** Bumped when the serialized format changes in a backwards-incompatible way. */
const SERIALIZATION_VERSION = 1;

/**
 * @returns {string} the PNG data URL for the canvas, reusing the cached one if the canvas hasn't
 * been painted into since it was last encoded
 */
function serialize_canvas(canvas) {
	if (!edited_canvases.has(canvas)) {
		const cached = canvas_data_urls.get(canvas);
		if (cached) { return cached; }
	}
	const data_url = canvas.toDataURL("image/png");
	canvas_data_urls.set(canvas, data_url);
	edited_canvases.delete(canvas);
	return data_url;
}

/**
 * @param {LayerNode} node
 * @returns {SerializedLayerNode}
 */
function serialize_node(node) {
	const { id, type, name, visible, opacity, expanded } = node;
	if (type === "group") {
		return {
			id,
			type,
			name,
			visible,
			opacity,
			expanded,
			children: (node.children || []).map(serialize_node),
		};
	}
	return {
		id,
		type,
		name,
		visible,
		opacity,
		expanded,
		canvas_data_url: node.canvas ? serialize_canvas(node.canvas) : undefined,
	};
}

/**
 * @returns {SerializedDocument} a JSON-serializable copy of the document, including each layer's
 * pixels as a PNG data URL
 */
function serialize() {
	const state = {
		version: SERIALIZATION_VERSION,
		width: main_canvas.width,
		height: main_canvas.height,
		next_id,
		active_layer_id,
		selected_node_id,
		root: serialize_node(root),
	};
	// Drop cached data URLs for canvases that are no longer part of the document, so the cache can't
	// grow to hold a copy of every layer that ever existed.
	const live_canvases = new Set(flatten_bottom_to_top().map((layer) => layer.canvas));
	for (const canvas of Array.from(canvas_data_urls.keys())) {
		if (!live_canvases.has(canvas)) { canvas_data_urls.delete(canvas); }
	}
	return state;
}

/**
 * @param {string} data_url
 * @returns {Promise<HTMLImageElement>}
 */
function load_image_element(data_url) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Failed to load a saved layer's image data."));
		image.src = data_url;
	});
}

/**
 * Builds a layer's canvas for a serialized document, loading its pixels.
 * @param {SerializedLayerNode} saved_node
 * @param {number} width
 * @param {number} height
 * @returns {Promise<PixelCanvas>}
 */
async function load_layer_canvas(saved_node, width, height) {
	const canvas = make_canvas(width, height);
	canvas.ctx.disable_image_smoothing();
	if (saved_node.canvas_data_url) {
		const image = await load_image_element(saved_node.canvas_data_url);
		canvas.ctx.drawImage(image, 0, 0);
	}
	return canvas;
}

/**
 * Replaces the document with a serialized one (see `serialize()`), loading each layer's pixels.
 *
 * Node ids are reassigned, since they're only meaningful within a session. A state that can't be
 * understood (a different version, or malformed data) is rejected, so the caller can fall back to
 * the flattened image.
 *
 * @param {unknown} state
 * @returns {Promise<boolean>} whether the document could be restored
 */
async function load_serialized(state) {
	const saved = /** @type {SerializedDocument | null} */ (state);
	if (!saved || saved.version !== SERIALIZATION_VERSION || !saved.root || saved.root.type !== "group") {
		return false;
	}
	const width = Math.max(1, Math.floor(Number(saved.width)) || main_canvas.width);
	const height = Math.max(1, Math.floor(Number(saved.height)) || main_canvas.height);

	/** @type {Map<number, number>} stored node id -> new node id */
	const id_map = new Map();
	/** @type {Map<number, PixelCanvas>} stored node id -> canvas */
	const canvases = new Map();
	const layers = [];
	const collect = (node) => {
		layers.push(node);
		for (const child of node.children || []) { collect(child); }
	};
	collect(saved.root);
	try {
		const loaded = await Promise.all(layers.map((node) =>
			node.type === "layer" ? load_layer_canvas(node, width, height) : null));
		layers.forEach((node, index) => {
			const canvas = loaded[index];
			if (canvas) { canvases.set(node.id, canvas); }
		});
	} catch (error) {
		window.console?.log("Failed to load saved layers:", error);
		return false;
	}

	/**
	 * @param {SerializedLayerNode} saved_node
	 * @returns {LayerNode | null}
	 */
	const build = (saved_node) => {
		if (saved_node.type !== "layer" && saved_node.type !== "group") { return null; }
		const id = next_id++;
		id_map.set(Number(saved_node.id), id);
		/** @type {LayerNode} */
		const node = {
			id,
			type: saved_node.type,
			name: String(saved_node.name || (saved_node.type === "group" ? "Set" : "Layer")),
			visible: saved_node.visible !== false,
			opacity: Math.max(0, Math.min(1, Number(saved_node.opacity ?? 1))),
			expanded: saved_node.expanded !== false,
		};
		if (saved_node.type === "group") {
			const children = (saved_node.children || []).map(build).filter(/** @returns {node is LayerNode} */ (child) => !!child);
			node.children = children;
			if (children.length === 0) { return null; } // empty groups are dropped
		} else {
			node.canvas = canvases.get(saved_node.id) || make_canvas(width, height);
			node.canvas.ctx.disable_image_smoothing();
		}
		return node;
	};

	const children = (saved.root.children || []).map(build).filter(/** @returns {node is LayerNode} */ (child) => !!child);
	if (children.length === 0) { return false; }

	root = { ...make_group_node("Document"), children };
	set_document_size(width, height);
	active_layer_id = id_map.get(Number(saved.active_layer_id)) || 0;
	selected_node_id = id_map.get(Number(saved.selected_node_id)) || active_layer_id;
	const active = find_node(active_layer_id);
	if (!active || active.type !== "layer") {
		const first_layer = children.map((child) => topmost_layer_of([child])).filter(Boolean)[0];
		active_layer_id = first_layer ? first_layer.id : ensure_a_layer().id;
	}
	const selected = find_node(selected_node_id);
	if (!selected) { selected_node_id = active_layer_id; }
	normalize_layer_sizes();
	invalidate();
	notify_thumbnails_changed();
	notify_tree_changed();
	return true;
}

// #endregion

/**
 * The document model's API.
 * (Also handy for poking at the document from the console during development.)
 */
const document_model = {
	activate_layer,
	add_group,
	add_layer,
	begin_edit,
	begin_stroke,
	can_delete,
	can_flatten,
	can_merge_down,
	delete_node,
	duplicate_node,
	end_stroke,
	find_node,
	find_parent_id,
	flatten_bottom_to_top,
	flatten_document,
	flatten_top_to_bottom,
	get_active_layer,
	get_active_layer_canvas,
	get_active_layer_ctx,
	get_root,
	get_selected_node_id,
	invalidate,
	load_image,
	load_serialized,
	merge_down,
	move_node,
	can_move_node,
	notify_thumbnails_changed,
	notify_tree_changed,
	rename_node,
	render_to,
	reset_document,
	resize_canvas,
	restore,
	select_node,
	serialize,
	// Exposed so that a saved layer tree can be checked before it's loaded, e.g. to drop one that
	// was saved by an older version of the app.
	serialization_version: SERIALIZATION_VERSION,
	set_active_layer_canvas,
	set_expanded,
	set_opacity,
	set_visible,
	snapshot,
	to_canvas,
	to_node_canvas,
	transform_layers,
};

export { document_model };

// Temporary global, for debugging and for tests, until the app is fully converted to ES Modules.
window.document_model = document_model;
