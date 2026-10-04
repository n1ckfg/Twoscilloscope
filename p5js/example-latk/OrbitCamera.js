// The camera the Latk drawing is seen through, in place of ofEasyCam: drag to
// orbit, scroll to zoom, double-click to go back to the start.
//
// The scope has to project every stroke onto the canvas itself, so this camera
// keeps its own matrices and the sketch draws through them by hand, rather than
// through p5's WEBGL camera. Y is up, as ofxLatk and Latk for Processing have
// it, and it starts out in front of the drawing, looking down -Z.
class OrbitCamera {

    constructor() {
        this.fov = Math.PI / 3; // 60 degrees, like p5's and oF's
        this.target = [0, 0, 0];
        this.radius = 1;        // of what it's looking at
        this.home = { distance: 2.2, yaw: 0, pitch: 0.15 };
        this.dragging = false;
        this.lastX = 0;
        this.lastY = 0;
        this.reset();
    }

    // Look at the middle of a box, from far enough back to see all of it.
    fit(min, max) {
        this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        this.radius = Math.max(1e-6, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
        this.home.distance = this.radius / Math.sin(this.fov / 2) * 1.05;
        this.reset();
    }

    reset() {
        this.distance = this.home.distance;
        this.yaw = this.home.yaw;
        this.pitch = this.home.pitch;
    }

    mousePressed(x, y) {
        this.dragging = true;
        this.lastX = x;
        this.lastY = y;
    }

    mouseDragged(x, y) {
        if (!this.dragging) return;
        this.yaw -= (x - this.lastX) * 0.01;
        this.pitch = Math.min(1.55, Math.max(-1.55, this.pitch + (y - this.lastY) * 0.01));
        this.lastX = x;
        this.lastY = y;
    }

    mouseReleased() {
        this.dragging = false;
    }

    zoom(delta) {
        this.distance = Math.min(this.radius * 50, Math.max(this.radius * 0.05, this.distance * Math.exp(delta * 0.001)));
    }

    getEye() {
        const cp = Math.cos(this.pitch);
        return [
            this.target[0] + this.distance * cp * Math.sin(this.yaw),
            this.target[1] + this.distance * Math.sin(this.pitch),
            this.target[2] + this.distance * cp * Math.cos(this.yaw)
        ];
    }

    // World -> clip space for a width x height canvas, column-major.
    getModelViewProjectionMatrix(width, height) {
        const eye = this.getEye();
        const t = this.target;
        const normalize = (v) => {
            const l = Math.hypot(v[0], v[1], v[2]) || 1;
            return [v[0] / l, v[1] / l, v[2] / l];
        };
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

        // lookAt, with y up
        const f = normalize([t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]]);
        const s = normalize(cross(f, [0, 1, 0]));
        const u = cross(s, f);
        const view = [
            s[0], u[0], -f[0], 0,
            s[1], u[1], -f[1], 0,
            s[2], u[2], -f[2], 0,
            -dot(s, eye), -dot(u, eye), dot(f, eye), 1
        ];

        // perspective
        const near = this.distance * 0.01;
        const far = this.distance + this.radius * 10;
        const g = 1 / Math.tan(this.fov / 2);
        const proj = [
            g / (width / height), 0, 0, 0,
            0, g, 0, 0,
            0, 0, (far + near) / (near - far), -1,
            0, 0, 2 * far * near / (near - far), 0
        ];

        const m = new Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                m[c * 4 + r] = proj[r] * view[c * 4] + proj[4 + r] * view[c * 4 + 1] + proj[8 + r] * view[c * 4 + 2] + proj[12 + r] * view[c * 4 + 3];
            }
        }
        return m;
    }

    // A world point through mvp onto a width x height canvas, in pixels.
    // valid is false behind the camera or outside its depth range.
    static project(m, x, y, z, width, height) {
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        return {
            x: (cx / cw + 1) * 0.5 * width,
            y: (1 - cy / cw) * 0.5 * height,
            valid: cw > 0 && cz / cw >= -1 && cz / cw <= 1
        };
    }

}
