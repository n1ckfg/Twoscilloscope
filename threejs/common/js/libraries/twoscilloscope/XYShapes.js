/*
+ + +   three.twoscilloscope   + + +

Drawing XYPolylines with three.js, in place of ofPolyline::draw().

XYShapes is a THREE.Group holding one LineSegments for any number of
polylines, each in a colour of its own, and a Points of their vertices
(hidden until showPoints). Call setShapes() whenever the shapes change; for
decoded shapes that's every frame, and the buffers are reused.

    const shapes = new XYShapes();
    scene.add(shapes);
    shapes.setShapes(scope.getShapes(512, 512), (i) => colors[i % colors.length]);

fillGeometry() is how it refills a geometry without making a new one each
time. XYscopeHelper and the examples use it for their lines too.
*/

import {
    BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group,
    LineBasicMaterial, LineSegments, Points, PointsMaterial
} from 'three';
import { XYPolyline } from './XYPolyline.js';

// Refill an object's geometry with count vertices: write(positions, colors)
// fills x, y, z (and r, g, b, when colors is true) for each of them. The
// buffers grow when they have to and are reused otherwise. Only count
// vertices are drawn.
export function fillGeometry(object, count, write, colors = false) {
    let geometry = object.geometry;
    let position = geometry.getAttribute('position');
    if (!position || position.count < count || (colors && !geometry.getAttribute('color'))) {
        let capacity = 64;
        while (capacity < count) capacity *= 2;
        geometry.dispose();
        geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage));
        if (colors) geometry.setAttribute('color', new BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage));
        object.geometry = geometry;
        position = geometry.getAttribute('position');
    }
    const color = colors ? geometry.getAttribute('color') : null;
    write(position.array, color ? color.array : null);
    if (count > 0) {
        for (const attribute of color ? [position, color] : [position]) {
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, count * 3);
            attribute.needsUpdate = true;
        }
    }
    geometry.setDrawRange(0, count);
    object.frustumCulled = false; // the bounds change every time
}

const scratch = new Color();

export class XYShapes extends Group {

    // options: opacity (1), pointSize (3 px)
    constructor(options = {}) {
        super();
        this.type = 'XYShapes';
        const opacity = options.opacity === undefined ? 1 : options.opacity;
        // transparent even when opaque, so lines draw in the order they're added
        // (three draws opaque things first), over any opaque backgrounds
        const transparent = true;
        this.lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent, opacity }));
        this.points = new Points(new BufferGeometry(), new PointsMaterial({
            vertexColors: true, size: options.pointSize || 3, sizeAttenuation: false, transparent, opacity
        }));
        this.lines.frustumCulled = false;
        this.points.frustumCulled = false;
        this.points.visible = false;
        this.add(this.lines, this.points);
    }

    get showPoints() {
        return this.points.visible;
    }

    set showPoints(show) {
        this.points.visible = show;
    }

    // shapes: XYPolylines or arrays of points, in whatever units the group is
    // placed in. color: anything THREE.Color.set() takes, for all of them, or
    // a function (index) => color, for one each.
    setShapes(shapes, color = 0xffffff) {
        const polys = shapes.map((shape) => XYPolyline.from(shape));
        const colorOf = typeof color === 'function' ? color : () => color;
        let lineVertices = 0;
        let pointVertices = 0;
        for (const poly of polys) {
            const n = poly.points.length;
            if (n >= 2) lineVertices += 2 * (n - 1 + (poly.closed ? 1 : 0));
            pointVertices += n;
        }

        fillGeometry(this.lines, lineVertices, (pos, col) => {
            let k = 0;
            const put = (p) => {
                pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = 0;
                col[k] = scratch.r; col[k + 1] = scratch.g; col[k + 2] = scratch.b;
                k += 3;
            };
            polys.forEach((poly, i) => {
                const pts = poly.points;
                if (pts.length < 2) return;
                scratch.set(colorOf(i));
                for (let j = 1; j < pts.length; j++) {
                    put(pts[j - 1]);
                    put(pts[j]);
                }
                if (poly.closed) {
                    put(pts[pts.length - 1]);
                    put(pts[0]);
                }
            });
        }, true);

        fillGeometry(this.points, pointVertices, (pos, col) => {
            let k = 0;
            polys.forEach((poly, i) => {
                scratch.set(colorOf(i));
                for (const p of poly.points) {
                    pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = 0;
                    col[k] = scratch.r; col[k + 1] = scratch.g; col[k + 2] = scratch.b;
                    k += 3;
                }
            });
        }, true);
        return this;
    }

    dispose() {
        this.lines.geometry.dispose();
        this.lines.material.dispose();
        this.points.geometry.dispose();
        this.points.material.dispose();
    }

}
