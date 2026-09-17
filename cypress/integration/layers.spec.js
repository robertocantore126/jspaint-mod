/// <reference types="Cypress" />

/**
 * Tests for the layer system: the document model (src/document-model.js), the Layers panel, and the
 * way layers are saved in and restored from a session.
 *
 * These assert on pixel counts read back from the layer canvases and the composited canvas, rather
 * than comparing screenshots, so they don't need image snapshots to be regenerated whenever the
 * panel's styling changes.
 */

/**
 * Draws a straight stroke with the current tool, from one point to another.
 * Points are fractions of the visible canvas: { x: 0, y: 0 } is its top-left corner.
 * @param {any} win
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} end
 */
const stroke = (win, start, end) => {
	const $ = win.api_for_cypress_tests.$;
	const target = $(".main-canvas")[0];
	const canvas_rect = target.getBoundingClientRect();
	const area_rect = $(".canvas-area")[0].getBoundingClientRect();
	const min_x = Math.max(canvas_rect.left, area_rect.left);
	const max_x = Math.min(canvas_rect.right, area_rect.right);
	const min_y = Math.max(canvas_rect.top, area_rect.top);
	const max_y = Math.min(canvas_rect.bottom, area_rect.bottom);
	const point_at = (t) => ({
		x: min_x + (start.x + (end.x - start.x) * t) * (max_x - min_x),
		y: min_y + (start.y + (end.y - start.y) * t) * (max_y - min_y),
	});
	const trigger = (type, point) => {
		$(target).trigger($.Event(type, {
			view: win,
			bubbles: true,
			cancelable: true,
			clientX: point.x,
			clientY: point.y,
			button: 0,
			buttons: 1,
		}));
	};
	trigger("pointerenter", point_at(0));
	trigger("pointerdown", point_at(0));
	for (const t of [0.34, 0.67, 1]) {
		trigger("pointermove", point_at(t));
	}
	trigger("pointerup", point_at(1));
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {[number, number, number]} rgb
 */
const count_pixels_of_color = (canvas, rgb) => {
	const image_data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
	let count = 0;
	for (let i = 0; i < image_data.length; i += 4) {
		if (
			Math.abs(image_data[i + 0] - rgb[0]) <= 1 &&
			Math.abs(image_data[i + 1] - rgb[1]) <= 1 &&
			Math.abs(image_data[i + 2] - rgb[2]) <= 1 &&
			image_data[i + 3] > 200
		) {
			count++;
		}
	}
	return count;
};

/**
 * The bounding box of the pixels of a given color (within a tolerance of 1 per channel).
 * @param {HTMLCanvasElement} canvas
 * @param {[number, number, number]} rgb
 */
const bounds_of_color = (canvas, rgb) => {
	const image_data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
	let min_x = Infinity;
	let max_x = -Infinity;
	let min_y = Infinity;
	let max_y = -Infinity;
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			const i = (y * canvas.width + x) * 4;
			if (Math.abs(image_data[i] - rgb[0]) <= 1 && Math.abs(image_data[i + 1] - rgb[1]) <= 1 && Math.abs(image_data[i + 2] - rgb[2]) <= 1) {
				min_x = Math.min(min_x, x);
				max_x = Math.max(max_x, x);
				min_y = Math.min(min_y, y);
				max_y = Math.max(max_y, y);
			}
		}
	}
	return { min_x, max_x, min_y, max_y };
};

/** @param {any} win */
const layer_names = (win) => win.api_for_cypress_tests.document_model.flatten_bottom_to_top().map((layer) => layer.name);
/** @param {any} win */
const row_names = (win) => win.api_for_cypress_tests.$(".layers-list .layer-row .layer-name").toArray().map((el) => el.textContent);

/**
 * The session id is in the URL hash; the storage keys are prefixed with it.
 * @param {any} win
 */
const session_id = (win) => String(win.location.hash).replace(/^#/, "").replace(/^(local|firebase):/, "");
/** @param {any} win */
const image_key = (win) => `image#${session_id(win)}`;
/** @param {any} win */
const layers_key = (win) => `layers#${session_id(win)}`;
/**
 * Reads the saved layer tree for the current session, or null if there isn't one.
 * (Sessions save through storage.js, which JSON-encodes whatever it's given.)
 * @param {any} win
 */
const saved_layers = (win) => {
	const raw = win.localStorage.getItem(layers_key(win));
	if (!raw) { return null; }
	try { return JSON.parse(JSON.parse(raw)); } catch { return null; }
};

context("layers", () => {
	before(() => {
		cy.visit("/");
		cy.setResolution([800, 500]);
		cy.window().should("have.property", "api_for_cypress_tests"); // wait for app to be loaded
	});
	beforeEach(() => {
		// eslint-disable-next-line require-await
		cy.window().then({ timeout: 60000 }, async (win) => {
			win.api_for_cypress_tests.reset_for_next_test();
		});
	});

	it("starts with a single layer and paints into it", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			expect(layer_names(win)).to.deep.equal(["Layer 1"]);
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 });
			const layer = document_model.get_active_layer();
			// The stroke is in the active layer, and in the visible (composited) canvas.
			expect(count_pixels_of_color(layer.canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color($(".main-canvas")[0], [255, 0, 0])).to.be.greaterThan(0);
		});
	});

	it("paints the selected color, not black (pencil regression)", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#00ffff";
			stroke(win, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 });
			const layer = document_model.get_active_layer();
			expect(count_pixels_of_color(layer.canvas, [0, 255, 255])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layer.canvas, [0, 0, 0])).to.equal(0);
		});
	});

	it("keeps layers independent, and lists them top-first", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 });

			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 });

			expect(layer_names(win)).to.deep.equal(["Layer 1", "Layer 2"]);
			// The panel shows the topmost layer first.
			expect(row_names(win)).to.deep.equal(["Layer 2", "Layer 1"]);

			const [layer_1, layer_2] = document_model.flatten_bottom_to_top();
			expect(count_pixels_of_color(layer_1.canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layer_1.canvas, [0, 0, 255])).to.equal(0);
			expect(count_pixels_of_color(layer_2.canvas, [0, 0, 255])).to.be.greaterThan(0);

			// Both layers show through in the composite.
			const composite = $(".main-canvas")[0];
			expect(count_pixels_of_color(composite, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(composite, [0, 0, 255])).to.be.greaterThan(0);
		});
	});

	it("hides and shows a layer", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.2, y: 0.6 }, { x: 0.5, y: 0.8 });

			const composite = $(".main-canvas")[0];
			expect(count_pixels_of_color(composite, [0, 0, 255])).to.be.greaterThan(0);

			const layer_2 = document_model.get_active_layer();
			$(`.layers-list .layer-row[data-layer-id='${layer_2.id}'] .layer-visibility`).click();

			expect(document_model.find_node(layer_2.id).visible).to.equal(false);
			expect(count_pixels_of_color(composite, [0, 0, 255])).to.equal(0);
			expect(count_pixels_of_color(composite, [255, 0, 0])).to.be.greaterThan(0);
			// Hiding a layer doesn't throw away its pixels.
			expect(count_pixels_of_color(document_model.find_node(layer_2.id).canvas, [0, 0, 255])).to.be.greaterThan(0);
		});
	});

	it("applies layer opacity", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#000000";
			stroke(win, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 });
			const layer_id = document_model.get_active_layer().id;
			$(`.layers-list .layer-row[data-layer-id='${layer_id}'] .layer-opacity`).val(50).trigger("input");
			expect(document_model.find_node(layer_id).opacity).to.equal(0.5);
			// Black at 50% over white is a mid gray.
			expect(count_pixels_of_color($(".main-canvas")[0], [128, 128, 128])).to.be.greaterThan(0);
		});
	});

	it("deletes a layer, keeps it undoable, and never leaves zero layers", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, undo } = win.api_for_cypress_tests;
			$(".layers-toolbar button[title='New layer']").click();
			expect(layer_names(win)).to.deep.equal(["Layer 1", "Layer 2"]);
			$(".layers-toolbar button[title='Delete layer or group']").click();
			expect(layer_names(win)).to.deep.equal(["Layer 1"]);
			// Undo brings the layer back.
			undo();
			expect(layer_names(win)).to.deep.equal(["Layer 1", "Layer 2"]);
			// The last layer can't be deleted (that would throw the picture away).
			$(".layers-toolbar button[title='Delete layer or group']").click();
			$(".layers-toolbar button[title='Delete layer or group']").click();
			expect(layer_names(win).length).to.equal(1);
			const layer = document_model.get_active_layer();
			expect(!!layer.canvas).to.equal(true);
			expect(document_model.find_node(layer.id)).to.equal(layer);
		});
	});

	it("resizing the canvas doesn't hide the layers below", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors, resize_canvas_and_save_dimensions } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.2 }, { x: 0.2, y: 0.7 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.4, y: 0.2 }, { x: 0.5, y: 0.7 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#00ff00";
			stroke(win, { x: 0.7, y: 0.2 }, { x: 0.8, y: 0.7 });

			/** @param {HTMLCanvasElement} canvas */
			const transparent_pixels = (canvas) => {
				const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
				let count = 0;
				for (let i = 3; i < data.length; i += 4) {
					if (data[i] === 0) { count++; }
				}
				return count;
			};
			const composite = $(".main-canvas")[0];
			expect(count_pixels_of_color(composite, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(composite, [0, 0, 255])).to.be.greaterThan(0);
			expect(count_pixels_of_color(composite, [0, 255, 0])).to.be.greaterThan(0);

			resize_canvas_and_save_dimensions(document_model.to_canvas().width + 60, document_model.to_canvas().height + 40, {}, 0, 0);

			// Every layer is padded/cropped, and every layer is still visible in the composite. (The
			// padding is filled with the background color in the bottom layer only, so the layers
			// above it must not become opaque, or they'd cover the ones below them.)
			const layers = document_model.flatten_bottom_to_top();
			expect(layers.length).to.equal(3);
			for (const layer of layers) {
				expect(layer.canvas.width).to.equal(document_model.to_canvas().width);
				expect(layer.canvas.height).to.equal(document_model.to_canvas().height);
			}
			expect(count_pixels_of_color(composite, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(composite, [0, 0, 255])).to.be.greaterThan(0);
			expect(count_pixels_of_color(composite, [0, 255, 0])).to.be.greaterThan(0);
			expect(transparent_pixels(layers[0].canvas)).to.equal(0);
			expect(transparent_pixels(layers[1].canvas)).to.be.greaterThan(0);
			expect(transparent_pixels(layers[2].canvas)).to.be.greaterThan(0);
		});
	});

	it("transforms every layer together (Rotate 90)", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors, rotate } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.5, y: 0.6 }, { x: 0.8, y: 0.6 });

			const [layer_1, layer_2] = document_model.flatten_bottom_to_top();
			const before = document_model.to_canvas();
			const width = before.width;
			const height = before.height;
			// (Horizontal strokes, so rotating clockwise turns each one into a vertical line whose
			// y range is the stroke's old x range.)
			const before_1 = bounds_of_color(layer_1.canvas, [255, 0, 0]);
			const before_2 = bounds_of_color(layer_2.canvas, [0, 0, 255]);

			rotate(Math.PI / 2);

			// Rotating by 90° swaps the document's dimensions, and every layer is rotated to match,
			// so the layers stay aligned with each other.
			const after = document_model.to_canvas();
			expect(after.width).to.equal(height);
			expect(after.height).to.equal(width);
			const [rotated_1, rotated_2] = document_model.flatten_bottom_to_top();
			expect(rotated_1.canvas.width).to.equal(after.width);
			expect(rotated_1.canvas.height).to.equal(after.height);
			expect(rotated_2.canvas.width).to.equal(after.width);
			expect(rotated_2.canvas.height).to.equal(after.height);
			const after_1 = bounds_of_color(rotated_1.canvas, [255, 0, 0]);
			const after_2 = bounds_of_color(rotated_2.canvas, [0, 0, 255]);
			expect(after_1.min_y).to.equal(before_1.min_x);
			expect(after_1.max_y).to.equal(before_1.max_x);
			expect(after_2.min_y).to.equal(before_2.min_x);
			expect(after_2.max_y).to.equal(before_2.max_x);
		});
	});

	it("transforms every layer together (Flip horizontal)", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.1, y: 0.4 }, { x: 0.2, y: 0.5 });

			const [layer_1, layer_2] = document_model.flatten_bottom_to_top();
			const document_canvas = document_model.to_canvas();
			const width = document_canvas.width;
			const height = document_canvas.height;
			const before_1 = bounds_of_color(layer_1.canvas, [255, 0, 0]);
			const before_2 = bounds_of_color(layer_2.canvas, [0, 0, 255]);

			// (Image > Flip/Rotate is a dialog, so this calls the operation the dialog calls.)
			win.api_for_cypress_tests.flip_horizontal();

			expect(document_model.to_canvas().width).to.equal(width);
			expect(document_model.to_canvas().height).to.equal(height);
			const [flipped_1, flipped_2] = document_model.flatten_bottom_to_top();
			const after_1 = bounds_of_color(flipped_1.canvas, [255, 0, 0]);
			const after_2 = bounds_of_color(flipped_2.canvas, [0, 0, 255]);
			// Each layer's pixels are mirrored horizontally, so the layers stay aligned.
			expect(after_1.min_x).to.equal(width - 1 - before_1.max_x);
			expect(after_2.min_x).to.equal(width - 1 - before_2.max_x);
		});
	});
});

context("layers: saving in a session", () => {
	// A fixed session id in the URL hash, so a reload comes back to the same session.
	const test_session = "layers-persistence";

	before(() => {
		cy.setResolution([800, 500]);
	});
	beforeEach(() => {
		cy.visit(`/#local:${test_session}`);
		cy.window().should("have.property", "api_for_cypress_tests");
		// eslint-disable-next-line require-await
		cy.window().then({ timeout: 60000 }, async (win) => {
			win.api_for_cypress_tests.reset_for_next_test();
			// (Resetting to a single layer also drops the saved layer tree, but the flattened image
			// save is debounced, so wait for the session to settle before the test proper.)
			cy.wrap(new Promise((resolve) => win.setTimeout(resolve, 800)));
		});
	});
	afterEach(() => {
		cy.window().then((win) => {
			for (const key of Object.keys(win.localStorage)) {
				if (/^(image|layers)#layers-(persistence|legacy|broken)$/.test(key)) {
					win.localStorage.removeItem(key);
				}
			}
		});
	});

	it("saves the layer tree, and restores it when the session is loaded again", () => {
		cy.get(".tool[title='Pencil']").click();
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors } = win.api_for_cypress_tests;
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.7 });
			const layer_2 = document_model.get_active_layer();
			$(`.layers-list .layer-row[data-layer-id='${layer_2.id}'] .layer-opacity`).val(60).trigger("input");
		});
		// The save is debounced, so wait for it rather than for a fixed time.
		cy.window({ timeout: 20000 }).should((win) => {
			expect(saved_layers(win), "saved layer tree").to.not.equal(null);
		});

		cy.reload();
		cy.window().should("have.property", "api_for_cypress_tests");
		cy.window().then({ timeout: 60000 }, (win) => {
			const { document_model } = win.api_for_cypress_tests;
			const layers = document_model.flatten_bottom_to_top();
			expect(layers.length).to.equal(2);
			expect(layers[0].opacity).to.equal(1);
			expect(layers[1].opacity).to.equal(0.6);
			// Each layer's pixels came back in that layer, not merged into one.
			expect(count_pixels_of_color(layers[0].canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layers[0].canvas, [0, 0, 255])).to.equal(0);
			expect(count_pixels_of_color(layers[1].canvas, [0, 0, 255])).to.be.greaterThan(0);
			// The panel lists them, and the restored document is ready to be painted into.
			expect(row_names(win).length).to.equal(2);
			const active = document_model.get_active_layer();
			expect(active.canvas.width).to.equal(document_model.to_canvas().width);
			expect(active.canvas.height).to.equal(document_model.to_canvas().height);
		});
	});

	it("keeps the layer tree when undoing back to the state the session was loaded in", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, selected_colors } = win.api_for_cypress_tests;
			$(".tool[title='Pencil']").click();
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.7 });
		});
		cy.window({ timeout: 20000 }).should((win) => {
			expect(saved_layers(win), "saved layer tree").to.not.equal(null);
		});

		cy.reload();
		cy.window().should("have.property", "api_for_cypress_tests");
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model, selected_colors, undo } = win.api_for_cypress_tests;
			expect(layer_names(win)).to.deep.equal(["Layer 1", "Layer 2"]);
			$(".tool[title='Pencil']").click();
			selected_colors.foreground = "#00ff00";
			stroke(win, { x: 0.2, y: 0.8 }, { x: 0.4, y: 0.9 });
			undo();
			// Undoing back to the loaded state must restore that layer tree, not collapse it into a
			// single flattened layer.
			expect(layer_names(win)).to.deep.equal(["Layer 1", "Layer 2"]);
			const [layer_1, layer_2] = document_model.flatten_bottom_to_top();
			expect(count_pixels_of_color(layer_1.canvas, [0, 255, 0])).to.equal(0);
			expect(count_pixels_of_color(layer_2.canvas, [0, 0, 255])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layer_1.canvas, [255, 0, 0])).to.be.greaterThan(0);
		});
	});

	it("drops the saved layer tree once the document is back to a single layer", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $ } = win.api_for_cypress_tests;
			$(".layers-toolbar button[title='New layer']").click();
		});
		cy.window({ timeout: 20000 }).should((win) => {
			expect(saved_layers(win), "saved layer tree").to.not.equal(null);
		});
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, document_model } = win.api_for_cypress_tests;
			$(".layers-toolbar button[title='Delete layer or group']").click();
			expect(document_model.flatten_bottom_to_top().length).to.equal(1);
		});
		// A single layer is fully described by the flattened image, so the layer tree must not
		// linger and bring back a deleted layer.
		cy.window({ timeout: 20000 }).should((win) => {
			expect(saved_layers(win), "saved layer tree").to.equal(null);
		});
	});

	it("restores the layer tree on its own if the flattened image is missing", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			const { $, selected_colors } = win.api_for_cypress_tests;
			$(".tool[title='Pencil']").click();
			selected_colors.foreground = "#ff0000";
			stroke(win, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 });
			$(".layers-toolbar button[title='New layer']").click();
			selected_colors.foreground = "#0000ff";
			stroke(win, { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.7 });
		});
		cy.window({ timeout: 20000 }).should((win) => {
			expect(saved_layers(win), "saved layer tree").to.not.equal(null);
		});
		cy.window().then((win) => {
			win.localStorage.removeItem(image_key(win));
		});

		cy.reload();
		cy.window().should("have.property", "api_for_cypress_tests");
		cy.window().then({ timeout: 60000 }, (win) => {
			const { document_model } = win.api_for_cypress_tests;
			const layers = document_model.flatten_bottom_to_top();
			expect(layers.length).to.equal(2);
			expect(count_pixels_of_color(layers[0].canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layers[1].canvas, [0, 0, 255])).to.be.greaterThan(0);
		});
		// Restoring the layers starts the session autosaving again, flattened image included.
		cy.window({ timeout: 20000 }).should((win) => {
			expect(!!win.localStorage.getItem(image_key(win)), "flattened image").to.equal(true);
		});
	});

	it("loads a session saved before layers existed as a single layer", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			// A flattened image, stored the way sessions stored them before there were layers.
			const data_url = win.api_for_cypress_tests.document_model.get_active_layer().canvas.toDataURL("image/png");
			win.localStorage.setItem("image#layers-legacy", JSON.stringify(data_url));
		});
		cy.visit("/#local:layers-legacy");
		cy.window().should("have.property", "api_for_cypress_tests");
		cy.window().then({ timeout: 60000 }, (win) => {
			const { document_model } = win.api_for_cypress_tests;
			expect(layer_names(win).length).to.equal(1);
			expect(document_model.get_active_layer().canvas.width).to.equal(document_model.to_canvas().width);
			expect(document_model.get_active_layer().canvas.height).to.equal(document_model.to_canvas().height);
			// Nothing writes a layer tree for a single-layer document.
			expect(saved_layers(win)).to.equal(null);
		});
	});

	it("falls back to the flattened image when the saved layer tree can't be read", () => {
		cy.window().then({ timeout: 60000 }, (win) => {
			const { document_model } = win.api_for_cypress_tests;
			const data_url = document_model.get_active_layer().canvas.toDataURL("image/png");
			win.localStorage.setItem("image#layers-broken", JSON.stringify(data_url));
			// Corruption, or a layer tree saved by another version of the app.
			win.localStorage.setItem("layers#layers-broken", JSON.stringify("{ not a layer tree"));
		});
		cy.visit("/#local:layers-broken");
		cy.window().should("have.property", "api_for_cypress_tests");
		cy.window().then({ timeout: 60000 }, (win) => {
			expect(layer_names(win).length).to.equal(1);
			// An unreadable tree can never be useful, so it's dropped rather than left to be read
			// (and fail) on every reload.
			expect(win.localStorage.getItem("layers#layers-broken")).to.equal(null);
		});
	});
});

context("layered document format", () => {
	before(() => {
		cy.visit("/");
		cy.setResolution([800, 500]);
		cy.window().should("have.property", "api_for_cypress_tests");
	});
	beforeEach(() => {
		cy.window().then({ timeout: 60000 }, (win) => {
			win.api_for_cypress_tests.reset_for_next_test();
		});
	});

	/**
	 * Builds a two-layer document: "Red" (opaque) and a group holding "Blue" at 50% opacity.
	 * @param {any} win
	 */
	const build_document = (win) => {
		const { document_model } = win.api_for_cypress_tests;
		document_model.rename_node(document_model.get_active_layer().id, "Red");
		const red_ctx = document_model.get_active_layer_ctx();
		red_ctx.fillStyle = "#ff0000";
		red_ctx.fillRect(0, 0, 20, 20);
		// `add_group` creates a group with a new layer inside it (which becomes active).
		document_model.add_group();
		const blue = document_model.get_active_layer();
		document_model.rename_node(blue.id, "Blue");
		document_model.set_opacity(blue.id, 0.5);
		const blue_ctx = document_model.get_active_layer_ctx();
		blue_ctx.fillStyle = "#0000ff";
		blue_ctx.fillRect(0, 0, 10, 10);
	};

	it("round-trips the whole layer tree through a written file", () => {
		cy.window().then({ timeout: 60000 }, async (win) => {
			const api = win.api_for_cypress_tests;
			build_document(win);
			const blob = await api.write_layered_file();
			expect(blob.size).to.be.greaterThan(0);
			expect(await api.is_layered_file(blob)).to.equal(true);

			api.reset_for_next_test();
			const info = await api.read_layered_file(blob);
			expect(info, "read layered file").to.not.equal(null);
			await api.document_model.load_serialized(info.saved_layers);

			const layers = api.document_model.flatten_bottom_to_top();
			expect(layers.map((layer) => layer.name)).to.deep.equal(["Red", "Blue"]);
			expect(count_pixels_of_color(layers[0].canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layers[1].canvas, [0, 0, 255])).to.be.greaterThan(0);
			expect(layers[1].opacity).to.equal(0.5);
			const group = api.document_model.get_root().children.find((node) => node.type === "group");
			expect(group, "nested group").to.not.equal(undefined);
			expect(group.children.map((node) => node.name)).to.deep.equal(["Blue"]);
		});
	});

	it("opens a .jjlayers file end-to-end", () => {
		cy.window().then({ timeout: 60000 }, async (win) => {
			const api = win.api_for_cypress_tests;
			build_document(win);
			const blob = await api.write_layered_file();
			api.reset_for_next_test();
			const file = new win.File([blob], "roundtrip.jjlayers", { type: "application/x-jjlayers" });
			await api.open_from_file(file);
			const layers = api.document_model.flatten_bottom_to_top();
			expect(layers.map((layer) => layer.name)).to.deep.equal(["Red", "Blue"]);
			expect(count_pixels_of_color(layers[0].canvas, [255, 0, 0])).to.be.greaterThan(0);
			expect(count_pixels_of_color(layers[1].canvas, [0, 0, 255])).to.be.greaterThan(0);
		});
	});

	it("writes an OpenRaster-flavoured ZIP containing each layer", () => {
		cy.window().then({ timeout: 60000 }, async (win) => {
			const api = win.api_for_cypress_tests;
			build_document(win);
			const bytes = new Uint8Array(await (await api.write_layered_file()).arrayBuffer());
			expect(Array.from(bytes.slice(0, 4))).to.deep.equal([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
			const text = new win.TextDecoder("latin1").decode(bytes);
			for (const entry of ["mimetype", "stack.xml", "jspaint.json", "mergedimage.png", "data/layer_0.png", "data/layer_1.png"]) {
				expect(text, `bundle entry ${entry}`).to.contain(entry);
			}
			expect(text).to.contain("image/openraster");
		});
	});

	it("leaves plain images to the image loader", () => {
		cy.window().then({ timeout: 60000 }, async (win) => {
			const api = win.api_for_cypress_tests;
			const canvas = document.createElement("canvas");
			canvas.width = 10;
			canvas.height = 10;
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
			const file = new win.File([blob], "flat.png", { type: "image/png" });
			expect(await api.is_layered_file(file)).to.equal(false);
			expect(await api.read_layered_file(file)).to.equal(null);
		});
	});
});
