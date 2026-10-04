/*
+ + +   three.twoscilloscope   + + +

XYscope's previews, as three.js objects. ofxTwoscilloscope drew them on the
spot with drawPath(), drawPoints(), drawXY(), drawWaveform() and drawWave().
Here each is a THREE.Group that stays in a scene and catches up with its
XYscope when you call update(), the way three's CameraHelper follows a
camera.

    const preview = new XYscopeHelper(xy, 'xy');
    scene.add(preview);
    ...
    preview.update();

They're in the XYscope's canvas pixels, y down, like the shapes themselves,
so with an OrthographicCamera(0, width, 0, height, -1, 1) they line up with
the canvas, and position and scale put them anywhere else. Lines are one
pixel wide at any scale.

Views:
    'path'      the shapes, as lines (drawPath)
    'points'    the shapes' points (drawPoints)
    'xy'        the output plotted X against Y, as the scope will show it (drawXY)
    'waveform'  the wavetables: X on top, Y below, Z through the middle (drawWaveform)
    'wave'      the output over time: left on top, right below (drawWave)
    'all'       all of the above (drawAll)

options: color (or colorX and colorY for 'waveform'), anything THREE.Color
takes, and opacity. update(mouseX) takes the mouse's x on the canvas, for
the dots of debugView().
*/

import { BufferGeometry, Group, Line, LineBasicMaterial, Points, PointsMaterial } from 'three';
import { XYShapes, fillGeometry } from './XYShapes.js';
import { XYWavetable } from './XYWavetable.js';
import { mapValue } from './XYUtils.js';

const DEFAULT_COLORS = {
    path: 0xffffff,
    points: 0x00ff00,
    xy: 0x32ff32,
    wave: 0xffffff,
    x: 0x3232ff,
    y: 0xff3232,
    z: 0x32ff32
};

export class XYscopeHelper extends Group {

    constructor(scope, view = 'xy', options = {}) {
        super();
        this.type = 'XYscopeHelper';
        this.scope = scope;
        this.view = view;
        this.opacity = options.opacity === undefined ? 1 : options.opacity;

        const single = view !== 'all';
        const colorFor = (name, fallback = DEFAULT_COLORS[name]) => (single && options.color !== undefined ? options.color : fallback);
        const views = single ? [view] : ['path', 'waveform', 'wave', 'xy', 'points'];

        this.parts = {};
        for (const v of views) {
            switch (v) {
                case 'path':
                    this.pathColor = colorFor('path');
                    this.parts.path = new XYShapes({ opacity: this.opacity });
                    this.add(this.parts.path);
                    break;
                case 'points':
                    this.parts.points = this.makePoints(colorFor('points'), 3);
                    break;
                case 'xy':
                    this.parts.xy = { line: this.makeLine(colorFor('xy')), dot: this.makePoints(colorFor('xy'), 10) };
                    break;
                case 'waveform':
                    this.parts.waveform = {
                        x: this.makeLine(options.colorX !== undefined ? options.colorX : DEFAULT_COLORS.x),
                        y: this.makeLine(options.colorY !== undefined ? options.colorY : DEFAULT_COLORS.y),
                        z: this.makeLine(DEFAULT_COLORS.z),
                        dotX: this.makePoints(options.colorX !== undefined ? options.colorX : DEFAULT_COLORS.x, 10),
                        dotY: this.makePoints(options.colorY !== undefined ? options.colorY : DEFAULT_COLORS.y, 10)
                    };
                    break;
                case 'wave': {
                    const color = colorFor('wave');
                    this.parts.wave = [this.makeLine(color), this.makeLine(color), this.makeLine(color)];
                    break;
                }
                default:
                    console.warn('XYscopeHelper: no view called ' + v);
            }
        }
    }

    // transparent even when opaque, so lines draw in the order they're added
    // (three draws opaque things first)
    makeLine(color) {
        const transparent = true;
        const line = new Line(new BufferGeometry(), new LineBasicMaterial({ color, transparent, opacity: this.opacity }));
        line.frustumCulled = false;
        this.add(line);
        return line;
    }

    makePoints(color, size) {
        const transparent = true;
        const points = new Points(new BufferGeometry(), new PointsMaterial({ color, size, sizeAttenuation: false, transparent, opacity: this.opacity }));
        points.frustumCulled = false;
        this.add(points);
        return points;
    }

    // Catch up with the XYscope. mouseX (canvas pixels) places the debug dots.
    update(mouseX = 0) {
        const parts = this.parts;
        if (parts.path) this.updatePath();
        if (parts.points) this.updatePoints();
        if (parts.xy) this.updateXY(mouseX);
        if (parts.waveform) this.updateWaveform(mouseX);
        if (parts.wave) this.updateWave();
        return this;
    }

    updatePath() {
        this.parts.path.setShapes(this.scope.getPolylines(), this.pathColor);
    }

    updatePoints() {
        const s = this.scope;
        const pts = s.wavePoints();
        fillGeometry(this.parts.points, pts.length, (pos) => {
            pts.forEach((p, i) => {
                pos[i * 3] = p.x * s.xyWidth;
                pos[i * 3 + 1] = p.y * s.xyHeight;
                pos[i * 3 + 2] = 0;
            });
        });
    }

    updateXY(mouseX) {
        const s = this.scope;
        const { line, dot } = this.parts.xy;
        const nCh = s.lastChannels;
        const samples = s.lastBuffer.view();
        const nFrames = nCh > 0 ? Math.floor(samples.length / nCh) : 0;
        const hw = s.xyWidth / 2, hh = s.xyHeight / 2;
        line.visible = nCh >= 2 && nFrames >= 2;
        dot.visible = line.visible && s.debugView();
        if (!line.visible) return;

        fillGeometry(line, nFrames, (pos) => {
            for (let i = 0; i < nFrames; i++) {
                const l = samples[i * nCh];
                const r = samples[i * nCh + 1];
                let lAudio = l * hw;
                let rAudio = r * hh;
                if (s.useVectrex) {
                    // undo the Vectrex wiring, so the preview stays upright
                    if (s.vectrexRotation === 90) {
                        lAudio = -r * hw;
                        rAudio = l * hh;
                    } else if (s.vectrexRotation === -90) {
                        lAudio = r * hw;
                        rAudio = -l * hh;
                    } else {
                        lAudio = -l * hw;
                        rAudio = -r * hh;
                    }
                }
                pos[i * 3] = hw + lAudio;
                pos[i * 3 + 1] = hh - rAudio;
                pos[i * 3 + 2] = 0;
            }
        });

        if (dot.visible) {
            const mouseT = mouseX / s.xyWidth;
            const mx = s.tableX.value(mouseT) * hw * s.ampVal.x;
            const my = -s.tableY.value(mouseT) * hh * s.ampVal.y;
            fillGeometry(dot, 1, (pos) => {
                pos[0] = hw + mx;
                pos[1] = hh + my;
                pos[2] = 0;
            });
        }
    }

    updateWaveform(mouseX) {
        const s = this.scope;
        const parts = this.parts.waveform;
        const w = Math.max(2, Math.floor(s.xyWidth));
        const h = s.xyHeight;
        const plot = (line, table, centerY) => {
            const wave = table.getWaveformRef();
            fillGeometry(line, w, (pos) => {
                for (let i = 0; i < w; i++) {
                    pos[i * 3] = i;
                    pos[i * 3 + 1] = centerY - h * 0.125 * XYWavetable.valueAt(wave, i / w);
                    pos[i * 3 + 2] = 0;
                }
            });
        };
        plot(parts.x, s.tableX, h * 0.25);
        plot(parts.y, s.tableY, h * 0.75);
        parts.z.visible = s.zAuto();
        if (parts.z.visible) plot(parts.z, s.tableZ, h * 0.5);

        const debug = s.debugView();
        parts.dotX.visible = debug;
        parts.dotY.visible = debug;
        if (debug) {
            const t = mouseX / s.xyWidth;
            fillGeometry(parts.dotX, 1, (pos) => {
                pos[0] = mouseX;
                pos[1] = h * 0.25 - h * 0.125 * s.tableX.value(t);
                pos[2] = 0;
            });
            fillGeometry(parts.dotY, 1, (pos) => {
                pos[0] = mouseX;
                pos[1] = h * 0.75 - h * 0.125 * s.tableY.value(t);
                pos[2] = 0;
            });
        }
    }

    updateWave() {
        const s = this.scope;
        const nCh = s.lastChannels;
        const samples = s.lastBuffer.view();
        const nFrames = nCh > 0 ? Math.floor(samples.length / nCh) : 0;
        const h = s.xyHeight;
        const centers = [h * 0.25, h * 0.75, h * 0.5];
        this.parts.wave.forEach((line, c) => {
            line.visible = c < nCh && nFrames >= 2;
            if (!line.visible) return;
            fillGeometry(line, nFrames, (pos) => {
                for (let i = 0; i < nFrames; i++) {
                    pos[i * 3] = mapValue(i, 0, nFrames, 0, s.xyWidth);
                    pos[i * 3 + 1] = centers[c] - h * 0.25 * samples[i * nCh + c];
                    pos[i * 3 + 2] = 0;
                }
            });
        });
    }

    dispose() {
        this.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) object.material.dispose();
        });
    }

}
