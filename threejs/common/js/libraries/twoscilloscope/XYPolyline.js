/*
+ + +   three.twoscilloscope   + + +

XYPolyline: a run of THREE.Vector2 points, in place of ofPolyline. To see
them, put them in an XYShapes (or use toLine()).
*/

import { BufferGeometry, Line, LineBasicMaterial, LineLoop, Vector2 } from 'three';
import { px, py } from './XYUtils.js';

// Douglas-Peucker on vt[j..k], marking the points to keep in mk. ofPolyline's
// recursion, with a stack of its own so long strokes can't overflow.
function simplifyDP(tol2, vt, j0, k0, mk) {
    const stack = [j0, k0];
    while (stack.length > 0) {
        const k = stack.pop();
        const j = stack.pop();
        if (k <= j + 1) continue; // there is nothing to simplify

        // check for adequate approximation by segment S from vt[j] to vt[k]
        const p0 = vt[j], p1 = vt[k];
        const ux = p1.x - p0.x, uy = p1.y - p0.y;
        const cu = ux * ux + uy * uy; // segment length squared
        let maxi = j;
        let maxd2 = 0;
        for (let i = j + 1; i < k; i++) {
            const v = vt[i];
            const wx = v.x - p0.x, wy = v.y - p0.y;
            const cw = wx * ux + wy * uy;
            let dv2;
            if (cw <= 0) {
                dv2 = wx * wx + wy * wy;
            } else if (cu <= cw) {
                const dx = v.x - p1.x, dy = v.y - p1.y;
                dv2 = dx * dx + dy * dy;
            } else {
                const b = cw / cu;
                const dx = v.x - (p0.x + ux * b), dy = v.y - (p0.y + uy * b);
                dv2 = dx * dx + dy * dy;
            }
            if (dv2 <= maxd2) continue;
            maxi = i;
            maxd2 = dv2;
        }
        if (maxd2 > tol2) {
            // split at the farthest point and simplify both halves
            mk[maxi] = 1;
            stack.push(j, maxi, maxi, k);
        }
    }
}

export class XYPolyline {

    // points: Vector2, {x, y} or [x, y]
    constructor(points, closed = false) {
        this.points = [];
        this.closed = closed;
        if (points) {
            for (const p of points) this.points.push(new Vector2(px(p), py(p)));
        }
    }

    // An XYPolyline as is, or a new one from an array of points.
    static from(shape) {
        if (shape instanceof XYPolyline) return shape;
        if (shape && Array.isArray(shape.points)) return new XYPolyline(shape.points, !!shape.closed);
        return new XYPolyline(shape || []);
    }

    addVertex(x, y) {
        if (typeof x === 'object') {
            y = py(x);
            x = px(x);
        }
        this.points.push(new Vector2(x, y));
        return this;
    }

    getVertices() { return this.points; }
    size() { return this.points.length; }
    isClosed() { return this.closed; }

    setClosed(closed) {
        this.closed = closed;
        return this;
    }

    clear() {
        this.points = [];
        return this;
    }

    copy() {
        return new XYPolyline(this.points, this.closed);
    }

    // length around the line, including the closing segment if it's closed
    getPerimeter() {
        const pts = this.points;
        if (pts.length < 2) return 0;
        let length = 0;
        for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1]);
        if (this.closed) length += pts[0].distanceTo(pts[pts.length - 1]);
        return length;
    }

    // ofPolyline::simplify(): drops points closer than tolerance to the one
    // before, then Douglas-Peucker with the same tolerance
    simplify(tolerance = 0.3) {
        const pts = this.points;
        const n = pts.length;
        if (n < 2) return this;
        const tol2 = tolerance * tolerance;

        // stage 1: vertex reduction within tolerance of prior vertex cluster
        const vt = [pts[0]];
        let pv = 0;
        for (let i = 1; i < n; i++) {
            if (pts[i].distanceToSquared(pts[pv]) < tol2) continue;
            vt.push(pts[i]);
            pv = i;
        }
        if (pv < n - 1) vt.push(pts[n - 1]);

        // stage 2: Douglas-Peucker polyline simplification
        const mk = new Uint8Array(vt.length);
        mk[0] = mk[vt.length - 1] = 1;
        simplifyDP(tol2, vt, 0, vt.length - 1, mk);
        this.points = vt.filter((p, i) => mk[i] === 1);
        return this;
    }

    // A THREE.Line (a LineLoop if it's closed) of the points, at z = 0.
    // For many polylines that change every frame, an XYShapes is cheaper.
    toLine(material = new LineBasicMaterial()) {
        const geometry = new BufferGeometry().setFromPoints(this.points);
        return this.closed ? new LineLoop(geometry, material) : new Line(geometry, material);
    }

}
