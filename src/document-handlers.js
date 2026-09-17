/* global main_canvas */

// Layered document format (.jjlayers).
//
// The file is a standard ZIP bundle (entries stored uncompressed), OpenRaster-flavoured:
//
//   mimetype          "image/openraster"  (first entry, uncompressed — as the spec requires)
//   stack.xml         the layer tree, top-first, as OpenRaster <layer>/<stack> elements
//   mergedimage.png   the flattened composite
//   data/layer_<n>.png  one PNG per layer
//   jspaint.json      the exact JS Paint layer tree (names, nesting, visibility, opacity,
//                     active layer, expanded state) referencing the data/*.png files
//
// Because the pixels are stored as plain PNG files inside a ZIP, other editors that understand
// OpenRaster can open the result, while `jspaint.json` lets JS Paint round-trip everything
// OpenRaster has no notion of (groups, the active layer, collapsed state).
//
// `read_layered_file` is a pure parser: it never touches the document model. It returns an
// ImageInfo whose `saved_layers` the caller (open_from_image_info) applies, so a canceled Open
// can't half-load a document.

import { document_model } from "./document-model.js";
import { make_canvas } from "./helpers.js";

/** Bumped when the zip layout or jspaint.json shape changes incompatibly. */
const FORMAT_VERSION = 1;

const MIME_TYPE = "application/x-jjlayers";
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

// #region Bytes / base64 helpers

/** @param {Uint8Array} bytes */
function bytes_to_base64(bytes) {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** @param {Uint8Array} bytes */
function bytes_to_data_url(bytes) {
	return `data:image/png;base64,${bytes_to_base64(bytes)}`;
}

/**
 * @param {string | Uint8Array | undefined} value - a data URL, raw base64, or already-decoded bytes
 * @returns {Uint8Array}
 */
function to_bytes(value) {
	if (value instanceof Uint8Array) { return value; }
	if (!value) { return new Uint8Array(); }
	const base64 = String(value).replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
	return bytes;
}

/** @param {string} data_url @returns {Promise<HTMLImageElement | null>} */
function data_url_to_image(data_url) {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = data_url;
	});
}

// #endregion

// #region ZIP (stored entries)

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) { c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
		table[n] = c >>> 0;
	}
	return table;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a ZIP with every entry stored uncompressed.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Blob}
 */
function build_zip(entries) {
	const encoder = new TextEncoder();
	/** @type {Array<Uint8Array | BlobPart>} */
	const parts = [];
	/** @type {Array<{ name_bytes: Uint8Array, crc: number, size: number, offset: number }>} */
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const name_bytes = encoder.encode(entry.name);
		const data = entry.data;
		const crc = crc32(data);

		const local = new Uint8Array(30 + name_bytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, ZIP_LOCAL_HEADER, true);
		lv.setUint16(4, 20, true); // version needed to extract
		lv.setUint16(6, 0, true); // general purpose flags
		lv.setUint16(8, 0, true); // compression: stored
		lv.setUint16(10, 0, true); // modification time
		lv.setUint16(12, 0, true); // modification date
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true); // compressed size
		lv.setUint32(22, data.length, true); // uncompressed size
		lv.setUint16(26, name_bytes.length, true);
		lv.setUint16(28, 0, true); // extra field length
		local.set(name_bytes, 30);

		parts.push(local, data);
		central.push({ name_bytes, crc, size: data.length, offset });
		offset += local.length + data.length;
	}

	const central_parts = [];
	let central_size = 0;
	for (const entry of central) {
		const header = new Uint8Array(46 + entry.name_bytes.length);
		const dv = new DataView(header.buffer);
		dv.setUint32(0, ZIP_CENTRAL_HEADER, true);
		dv.setUint16(4, 20, true); // version made by
		dv.setUint16(6, 20, true); // version needed
		dv.setUint16(8, 0, true);
		dv.setUint16(10, 0, true);
		dv.setUint16(12, 0, true);
		dv.setUint16(14, 0, true);
		dv.setUint32(16, entry.crc, true);
		dv.setUint32(20, entry.size, true);
		dv.setUint32(24, entry.size, true);
		dv.setUint16(28, entry.name_bytes.length, true);
		dv.setUint16(30, 0, true); // extra field length
		dv.setUint16(32, 0, true); // file comment length
		dv.setUint16(34, 0, true); // disk number start
		dv.setUint16(36, 0, true); // internal attributes
		dv.setUint32(38, 0, true); // external attributes
		dv.setUint32(42, entry.offset, true);
		header.set(entry.name_bytes, 46);
		central_parts.push(header);
		central_size += header.length;
	}

	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
	ev.setUint16(4, 0, true); // disk number
	ev.setUint16(6, 0, true); // disk with central directory
	ev.setUint16(8, central.length, true); // entries on this disk
	ev.setUint16(10, central.length, true); // total entries
	ev.setUint32(12, central_size, true);
	ev.setUint32(16, offset, true); // offset of central directory
	ev.setUint16(20, 0, true); // comment length

	return new Blob([...parts, ...central_parts, end], { type: MIME_TYPE });
}

/**
 * Reads a ZIP's entries. Tolerates architectures/compression only insofar as the central directory
 * is well-formed; entry data is returned as-is (JS Paint only ever writes stored entries).
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array> | null}
 */
function read_zip(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let end_of_central_directory = -1;
	const earliest = Math.max(0, bytes.length - 22 - 65535);
	for (let i = bytes.length - 22; i >= earliest; i--) {
		if (dv.getUint32(i, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
			end_of_central_directory = i;
			break;
		}
	}
	if (end_of_central_directory < 0) { return null; }

	const count = dv.getUint16(end_of_central_directory + 10, true);
	let p = dv.getUint32(end_of_central_directory + 16, true);
	const decoder = new TextDecoder();
	/** @type {Map<string, Uint8Array>} */
	const files = new Map();

	for (let n = 0; n < count; n++) {
		if (p + 46 > bytes.length || dv.getUint32(p, true) !== ZIP_CENTRAL_HEADER) { return null; }
		const size = dv.getUint32(p + 24, true);
		const name_length = dv.getUint16(p + 28, true);
		const extra_length = dv.getUint16(p + 30, true);
		const comment_length = dv.getUint16(p + 32, true);
		const local_offset = dv.getUint32(p + 42, true);
		const name = decoder.decode(bytes.subarray(p + 46, p + 46 + name_length));
		p += 46 + name_length + extra_length + comment_length;

		if (local_offset + 30 > bytes.length || dv.getUint32(local_offset, true) !== ZIP_LOCAL_HEADER) { return null; }
		const local_name_length = dv.getUint16(local_offset + 26, true);
		const local_extra_length = dv.getUint16(local_offset + 28, true);
		const data_start = local_offset + 30 + local_name_length + local_extra_length;
		if (data_start + size > bytes.length) { return null; }
		files.set(name, bytes.subarray(data_start, data_start + size));
	}
	return files;
}

// #endregion

// #region OpenRaster stack.xml

/** @param {string} text */
function escape_xml(text) {
	return String(text).replace(/[&<>"']/g, (character) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[character]
	));
}

/** @param {unknown} value */
function clamp_opacity(value) {
	const n = parseFloat(String(value));
	return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

/**
 * @param {any} node
 * @returns {string}
 */
function node_to_stack_xml(node) {
	const visibility = node.visible === false ? "hidden" : "visible";
	const opacity = Number.isFinite(node.opacity) ? node.opacity : 1;
	if (node.type === "group") {
		const children = (node.children || []).map(node_to_stack_xml).join("");
		return `<stack name="${escape_xml(node.name)}" opacity="${opacity}" visibility="${visibility}">${children}</stack>`;
	}
	return `<layer name="${escape_xml(node.name)}" src="${escape_xml(node.canvas_path)}" opacity="${opacity}" visibility="${visibility}"/>`;
}

/**
 * @param {any} root
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function to_stack_xml(root, width, height) {
	const children = (root.children || []).map(node_to_stack_xml).join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${width}" h="${height}">\n<stack>${children}</stack>\n</image>\n`;
}

/**
 * Rebuilds a serialized-document shape from an OpenRaster `stack.xml` (used when a .jjlayers
 * file has no `jspaint.json`, e.g. one written by another editor).
 * @param {Map<string, Uint8Array>} files
 * @returns {any}
 */
function read_openraster_stack(files) {
	const xml_bytes = files.get("stack.xml");
	if (!xml_bytes) { return null; }

	let doc;
	try {
		doc = new DOMParser().parseFromString(new TextDecoder().decode(xml_bytes), "application/xml");
	} catch (_error) {
		return null;
	}
	if (!doc || doc.getElementsByTagName("parsererror").length > 0) { return null; }

	const image_element = doc.documentElement;
	if (!image_element) { return null; }
	const width = Math.max(1, parseInt(image_element.getAttribute("w") || "", 10) || 1);
	const height = Math.max(1, parseInt(image_element.getAttribute("h") || "", 10) || 1);

	let next_id = 1;
	let first_layer_id = 0;
	/** @param {Element} element @returns {any} */
	const convert = (element) => {
		if (element.tagName === "layer") {
			const src = element.getAttribute("src");
			const data = src ? files.get(src) : undefined;
			const id = next_id++;
			if (!first_layer_id) { first_layer_id = id; }
			return {
				id,
				type: "layer",
				name: element.getAttribute("name") || "Layer",
				visible: element.getAttribute("visibility") !== "hidden",
				opacity: clamp_opacity(element.getAttribute("opacity")),
				expanded: true,
				canvas_data_url: data ? bytes_to_data_url(data) : undefined,
			};
		}
		if (element.tagName === "stack") {
			const children = Array.from(element.children).map(convert).filter(Boolean);
			if (children.length === 0) { return null; }
			return {
				id: next_id++,
				type: "group",
				name: element.getAttribute("name") || "Set",
				visible: element.getAttribute("visibility") !== "hidden",
				opacity: clamp_opacity(element.getAttribute("opacity")),
				expanded: true,
				children,
			};
		}
		return null;
	};

	const root_stack = Array.from(image_element.children).find((child) => child.tagName === "stack");
	if (!root_stack) { return null; }
	const children = Array.from(root_stack.children).map(convert).filter(Boolean);
	if (children.length === 0) { return null; }

	return {
		version: document_model.serialization_version,
		width,
		height,
		next_id,
		active_layer_id: first_layer_id,
		selected_node_id: first_layer_id,
		root: { id: 0, type: "group", name: "Document", visible: true, opacity: 1, expanded: true, children },
	};
}

// #endregion

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Uint8Array>}
 */
function canvas_to_png_bytes(canvas) {
	return new Promise((resolve) => {
		canvas.toBlob(async (blob) => {
			if (!blob) { resolve(new Uint8Array()); return; }
			resolve(new Uint8Array(await blob.arrayBuffer()));
		}, "image/png");
	});
}

/**
 * Writes the current document as a layered .jjlayers bundle.
 * @returns {Promise<Blob>}
 */
export async function write_layered_file() {
	const state = document_model.serialize();

	/** @type {Array<{ path: string, data_url: string | undefined }>} */
	const layer_files = [];
	/** @param {any} node */
	const assign_paths = (node) => {
		if (node.type === "layer") {
			const data_url = node.canvas_data_url;
			delete node.canvas_data_url;
			const path = `data/layer_${layer_files.length}.png`;
			node.canvas_path = path;
			layer_files.push({ path, data_url });
		}
		for (const child of node.children || []) { assign_paths(child); }
	};
	assign_paths(state.root);

	const encoder = new TextEncoder();
	const entries = [
		{ name: "mimetype", data: encoder.encode("image/openraster") },
		{ name: "stack.xml", data: encoder.encode(to_stack_xml(state.root, state.width, state.height)) },
		{ name: "mergedimage.png", data: await canvas_to_png_bytes(main_canvas) },
	];
	for (const layer of layer_files) {
		entries.push({ name: layer.path, data: to_bytes(layer.data_url) });
	}
	entries.push({
		name: "jspaint.json",
		data: encoder.encode(JSON.stringify({
			format: "jjlayers",
			format_version: FORMAT_VERSION,
			document: state,
		}, null, "\t")),
	});

	return build_zip(entries);
}

/**
 * Cheap check for whether a blob might be a layered document, used to decide whether it's worth
 * attempting to parse it. Falls back to the ZIP magic bytes for files that have no extension (the
 * File System Access API doesn't append one).
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
export async function is_layered_file(blob) {
	if (!(blob instanceof Blob)) { return false; }
	const name = blob instanceof File ? blob.name : "";
	if (/\.(jjlayers|ora)$/i.test(name)) { return true; }
	const type = blob.type || "";
	if (type === MIME_TYPE || type === "image/openraster" || type === "application/zip" || type === "application/x-zip-compressed") {
		return true;
	}
	try {
		const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
		return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b &&
			((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06) || (head[2] === 0x07 && head[3] === 0x08));
	} catch (_error) {
		return false;
	}
}

/**
 * Parses a layered document without touching the document model. Returns an ImageInfo with
 * `saved_layers` for the caller to apply, or null if the blob isn't a readable layered file.
 * @param {Blob} blob
 * @returns {Promise<(ImageInfo & { saved_layers: any }) | null>}
 */
export async function read_layered_file(blob) {
	let bytes;
	try {
		bytes = new Uint8Array(await blob.arrayBuffer());
	} catch (_error) {
		return null;
	}
	const files = read_zip(bytes);
	if (!files) { return null; }

	/** @type {any} */
	let state = null;

	const json_bytes = files.get("jspaint.json");
	if (json_bytes) {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(json_bytes));
			const document = parsed && parsed.format === "jjlayers" ? parsed.document : null;
			if (document && document.root && document.root.type === "group") { state = document; }
		} catch (_error) {
			state = null;
		}
	}

	if (state) {
		let found_any_pixels = false;
		/** @param {any} node */
		const attach_pixels = (node) => {
			if (node.type === "layer") {
				const data = node.canvas_path ? files.get(node.canvas_path) : undefined;
				if (data) {
					node.canvas_data_url = bytes_to_data_url(data);
					found_any_pixels = true;
				}
				delete node.canvas_path;
			}
			for (const child of node.children || []) { attach_pixels(child); }
		};
		attach_pixels(state.root);
		if (!found_any_pixels) { state = null; }
	}

	if (!state) {
		state = read_openraster_stack(files);
	}
	if (!state) { return null; }

	const width = Math.max(1, Math.floor(Number(state.width)) || 1);
	const height = Math.max(1, Math.floor(Number(state.height)) || 1);

	// The flattened preview is only a first paint: `load_serialized` recomposes from the layers.
	const merged_bytes = files.get("mergedimage.png");
	let image = merged_bytes ? await data_url_to_image(bytes_to_data_url(merged_bytes)) : null;
	if (!image) {
		const blank = make_canvas(width, height);
		image = await data_url_to_image(blank.toDataURL("image/png"));
	}
	if (!image) { return null; }

	return {
		file_format: MIME_TYPE,
		monochrome: false,
		width,
		height,
		image,
		source_blob: blob,
		saved_layers: state,
	};
}
