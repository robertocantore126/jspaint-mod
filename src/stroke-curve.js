// @ts-check
/**
 * Turns the stream of pointer positions from a freehand stroke into a smooth curve.
 *
 * Freehand strokes are drawn by connecting consecutive pointer positions, so the line is a
 * chain of straight segments, with a kink at every sample. The kinks are most obvious on
 * fast strokes, where the samples are far apart, and they're what makes a line look like a
 * polygon rather than something drawn by hand. Modern MS Paint draws through Windows Ink,
 * which fits a curve through the points instead.
 *
 * This fits a Catmull-Rom spline through the samples. The curve passes exactly through
 * every point the pointer was at, so corners stay where you put them, and the line doesn't
 * lag behind the pointer.
 *
 * Points come out progressively, since a stroke has to be drawn as it's being made.
 * A segment can only be finalized once the sample after next is known, because that's what
 * determines the curve's tangent at the end of the segment, so each segment is emitted one
 * sample late, and the last segment is emitted when the stroke ends.
 *
 * Coordinates are in whatever uniformly-scaled space you feed in (client coordinates, say),
 * and are treated as floats, so keep the fractional part if you have it - it makes for a
 * smoother curve - and round it off when drawing if you need whole pixels.
 */
export class StrokeCurve {
	/**
	 * @param {object} [options]
	 * @param {number} [options.point_spacing] - roughly how many px apart to emit points along the curve; 0 to draw straight segments between samples
	 */
	constructor({ point_spacing = 3 } = {}) {
		this.point_spacing = point_spacing;
		/** @type {{ x: number, y: number }[]} */
		this.points = [];
		this.next_segment = 0;
	}
	/**
	 * Begins a stroke at the given point, before any movement.
	 * @param {{ x: number, y: number }} point
	 */
	reset(point) {
		this.points = [point];
		this.next_segment = 0;
	}
	/**
	 * Adds a pointer position to the stroke.
	 * @param {{ x: number, y: number }} point
	 * @returns {{ x: number, y: number }[]} points to draw to, not including any already returned
	 */
	add(point) {
		this.points.push(point);
		// a segment can be drawn once the sample after next is known,
		// because that's what determines the curve's tangent at the end of the segment
		return this.emit_segments_through(this.points.length - 3);
	}
	/**
	 * Finishes the stroke, optionally at the point where the pointer was released.
	 * @param {{ x: number, y: number } | null} [point]
	 * @returns {{ x: number, y: number }[]} remaining points to draw to
	 */
	end(point) {
		if (point) {
			this.points.push(point);
		}
		return this.emit_segments_through(this.points.length - 2);
	}
	/**
	 * Emits every segment up to and including the given one.
	 * @param {number} last_segment
	 * @returns {{ x: number, y: number }[]}
	 */
	emit_segments_through(last_segment) {
		/** @type {{ x: number, y: number }[]} */
		const emitted_points = [];
		while (this.next_segment <= last_segment) {
			emitted_points.push(...this.emit_segment(this.next_segment));
			this.next_segment++;
		}
		return emitted_points;
	}
	/**
	 * Emits the points along the curve from one sample to the next.
	 * @param {number} index - the index of the sample the segment starts at
	 * @returns {{ x: number, y: number }[]}
	 */
	emit_segment(index) {
		const last_index = this.points.length - 1;
		// neighboring samples, which define the curve's tangents at the ends of the segment;
		// giving up at the ends of the stroke is fine (it just makes the curve straighten out)
		const P0 = this.points[Math.max(0, index - 1)];
		const P1 = this.points[index];
		const P2 = this.points[Math.min(last_index, index + 1)];
		const P3 = this.points[Math.min(last_index, index + 2)];

		const segment_length = Math.hypot(P2.x - P1.x, P2.y - P1.y);
		const subdivisions = this.point_spacing > 0 ?
			Math.max(1, Math.min(12, Math.round(segment_length / this.point_spacing))) :
			0;

		/** @type {{ x: number, y: number }[]} */
		const emitted_points = [];
		for (let i = 1; i <= subdivisions; i++) {
			emitted_points.push(catmull_rom_point(P0, P1, P2, P3, i / subdivisions));
		}
		// the sample itself, so that the curve goes through it (and not just near it)
		emitted_points.push({ x: P2.x, y: P2.y });
		return emitted_points;
	}
}

/**
 * A point along the Catmull-Rom spline from P1 to P2, with P0 and P3 as the neighboring points.
 * @param {{ x: number, y: number }} P0
 * @param {{ x: number, y: number }} P1
 * @param {{ x: number, y: number }} P2
 * @param {{ x: number, y: number }} P3
 * @param {number} t - from 0 (at P1) to 1 (at P2)
 * @returns {{ x: number, y: number }}
 */
function catmull_rom_point(P0, P1, P2, P3, t) {
	const t2 = t * t;
	const t3 = t2 * t;
	return {
		x: 0.5 * ((2 * P1.x) + (-P0.x + P2.x) * t + (2 * P0.x - 5 * P1.x + 4 * P2.x - P3.x) * t2 + (-P0.x + 3 * P1.x - 3 * P2.x + P3.x) * t3),
		y: 0.5 * ((2 * P1.y) + (-P0.y + P2.y) * t + (2 * P0.y - 5 * P1.y + 4 * P2.y - P3.y) * t2 + (-P0.y + 3 * P1.y - 3 * P2.y + P3.y) * t3),
	};
}
