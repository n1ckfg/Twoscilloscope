/*
+ + +   three.twoscilloscope   + + +
*/

import { XYPolyline } from './XYPolyline.js';
import { HERSHEY_FUTURAL_JHF } from './HersheyFutural.js';

/*
Hershey single-stroke vector fonts, the text engine from XYscope.java
(which credits https://github.com/ixd-hof/HersheyFont).

Hershey glyphs are made of open strokes rather than filled outlines, so
they draw cleanly with a single beam. Give load() one of the names in
getFontNames() to read common/data/hershey_fonts/<name>.jhf (or wherever
HersheyFont.dataPath points), or the URL of any .jhf file. The "futural"
font is built in, so text works even without the data folder.

Differences from ofxTwoscilloscope:
* Fonts are fetched, so they arrive later. load() is instant for a font
  that's already here and otherwise starts fetching it and returns false;
  call it again (XYscope.textFont() each frame does) once it's in. To have
  fonts ready from the first frame, wait for HersheyFont.preload(names).
* Text alignment is 'left', 'center' or 'right', and 'top', 'center',
  'bottom' or 'baseline', in place of oF's constants.

As in ofxTwoscilloscope, glyphs are placed with their left and right
bearings, and the .jhf parser counts the vertices each glyph declares, so it
copes with glyphs that wrap onto several lines.
*/


const HERSHEY_FONT_NAMES = [
    'astrology', 'cursive', 'cyrilc_1', 'cyrillic', 'futural', 'futuram', 'gothgbt', 'gothgrt',
    'gothiceng', 'gothicger', 'gothicita', 'gothitt', 'greek', 'greekc', 'greeks', 'japanese',
    'markers', 'mathlow', 'mathupp', 'meteorology', 'music', 'rowmand', 'rowmans', 'rowmant',
    'scriptc', 'scripts', 'symbolic', 'timesg', 'timesi', 'timesib', 'timesr', 'timesrb'
];

// In Hershey units, the top of a capital is at y = -12 and the baseline at y = 9.
const HERSHEY_BASELINE = 9;
const HERSHEY_R = 'R'.charCodeAt(0);

// .jhf text by font, null for fonts that failed to load
const hersheyText = new Map([['futural', HERSHEY_FUTURAL_JHF]]);
// parsed glyphs by font
const hersheyGlyphs = new Map();
// fetches in progress
const hersheyFetches = new Map();

function resolveHersheyFont(nameOrPath) {
    if (HERSHEY_FONT_NAMES.includes(nameOrPath)) {
        return { key: nameOrPath, name: nameOrPath, url: HersheyFont.dataPath + nameOrPath + '.jhf' };
    }
    const base = nameOrPath.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return { key: nameOrPath, name: base, url: nameOrPath };
}

function splitLines(text) {
    return String(text).replace(/\r/g, '').split('\n');
}

export class HersheyFont {

    constructor() {
        this.glyphs = [];
        this.name = '';
        this.load('futural');
    }

    static getFontNames() {
        return HERSHEY_FONT_NAMES;
    }

    // Fetch fonts (names or URLs) ahead of time. Resolves when they're all in.
    static preload(...namesOrPaths) {
        return Promise.all(namesOrPaths.flat().map((n) => HersheyFont.fetch(n).then((text) => text !== null)));
    }

    // The .jhf text of a font, fetched once and kept. Resolves to null if it couldn't be found.
    static fetch(nameOrPath) {
        const font = resolveHersheyFont(nameOrPath);
        if (hersheyText.has(font.key)) return Promise.resolve(hersheyText.get(font.key));
        if (!hersheyFetches.has(font.key)) {
            const request = fetch(font.url).then((response) => {
                if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
                return response.text();
            }).then((text) => {
                hersheyText.set(font.key, text);
                return text;
            }, (err) => {
                console.error('HersheyFont: couldn\'t load ' + font.url + ' (' + err.message + '). ' +
                    'Serve the sketch over http, and set HersheyFont.dataPath if the fonts live somewhere else.');
                hersheyText.set(font.key, null);
                return null;
            }).finally(() => hersheyFetches.delete(font.key));
            hersheyFetches.set(font.key, request);
        }
        return hersheyFetches.get(font.key);
    }

    // Switch to a font if it's here, and return true. If it isn't, start
    // fetching it and return false, keeping the font that's loaded now.
    load(nameOrPath) {
        const font = resolveHersheyFont(nameOrPath);
        let glyphs = hersheyGlyphs.get(font.key);
        if (!glyphs) {
            if (!hersheyText.has(font.key)) {
                HersheyFont.fetch(nameOrPath);
                return false;
            }
            const text = hersheyText.get(font.key);
            if (text === null) return false;
            glyphs = HersheyFont.parse(text, font.name);
            if (!glyphs) return false;
            hersheyGlyphs.set(font.key, glyphs);
        }
        this.glyphs = glyphs;
        this.name = font.name;
        return true;
    }

    // Fetch a font if need be, then switch to it. Resolves to true if it loaded.
    loadAsync(nameOrPath) {
        return HersheyFont.fetch(nameOrPath).then(() => this.load(nameOrPath));
    }

    loadFromString(jhf, name = '') {
        const glyphs = HersheyFont.parse(jhf, name);
        if (!glyphs) return false;
        this.glyphs = glyphs;
        this.name = name;
        return true;
    }

    // Each glyph starts with a 5 character id and a 3 character vertex count,
    // followed by that many coordinate pairs. The first pair holds the left and
    // right bearings, and " R" lifts the pen. A long glyph may wrap onto the
    // next line, so keep reading until all of its pairs have been collected.
    static parse(jhf, name = '') {
        const parsed = [];
        let data = '';
        let wanted = 0;

        const coord = (s, i) => s.charCodeAt(i) - HERSHEY_R;
        const finishGlyph = () => {
            const glyph = { left: coord(data, 0), right: coord(data, 1), strokes: [] };
            let stroke = [];
            for (let i = 2; i + 1 < data.length; i += 2) {
                if (data[i] === ' ' && data[i + 1] === 'R') {
                    if (stroke.length > 1) glyph.strokes.push(stroke);
                    stroke = [];
                } else {
                    stroke.push({ x: coord(data, i), y: coord(data, i + 1) });
                }
            }
            if (stroke.length > 1) glyph.strokes.push(stroke);
            parsed.push(glyph);
            data = '';
            wanted = 0;
        };

        for (let line of String(jhf).split('\n')) {
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.length === 0) continue;

            if (wanted === 0) {
                if (line.length < 8) continue;
                wanted = (parseInt(line.substr(5, 3).trim(), 10) || 0) * 2;
                if (wanted <= 0) {
                    wanted = 0;
                    continue;
                }
                line = line.substr(8);
            }

            data += line.substr(0, wanted - data.length);
            if (data.length >= wanted) finishGlyph();
        }

        if (parsed.length === 0) {
            console.error('HersheyFont: no glyphs found in ' + (name || 'font data'));
            return null;
        }
        return parsed;
    }

    isLoaded() {
        return this.glyphs.length > 0;
    }

    getName() {
        return this.name;
    }

    // Glyphs start at ASCII 32 (space).
    getGlyph(codePoint) {
        if (codePoint < 32) return null;
        return this.glyphs[codePoint - 32] || null;
    }

    getLineWidth(line, factor) {
        let width = 0;
        const space = this.getGlyph(32);
        for (const ch of line) {
            const glyph = this.getGlyph(ch.codePointAt(0)) || space;
            if (glyph) width += (glyph.right - glyph.left) * factor;
        }
        return width;
    }

    // Width of the widest line, in pixels.
    getWidth(text, size) {
        const factor = size / HersheyFont.CAP_HEIGHT;
        let width = 0;
        for (const line of splitLines(text)) width = Math.max(width, this.getLineWidth(line, factor));
        return width;
    }

    // Lay out a string (with \n for line breaks) as XYPolyline strokes in
    // pixels. size is the height of a capital letter, leading is the distance
    // from one baseline to the next.
    getStrokes(text, x, y, size, leading, alignX = 'left', alignY = 'top') {
        const result = [];
        const factor = size / HersheyFont.CAP_HEIGHT;
        const lines = splitLines(text);
        const blockHeight = size + (lines.length - 1) * leading;

        // baseline of the first line
        let baseline = y;
        if (alignY === 'top') baseline = y + size;
        else if (alignY === 'center') baseline = y - blockHeight / 2 + size;
        else if (alignY === 'bottom') baseline = y - (lines.length - 1) * leading;

        const space = this.getGlyph(32);
        for (const line of lines) {
            let penX = x;
            if (alignX === 'center') penX -= this.getLineWidth(line, factor) / 2;
            else if (alignX === 'right') penX -= this.getLineWidth(line, factor);

            for (const ch of line) {
                const glyph = this.getGlyph(ch.codePointAt(0)) || space;
                if (!glyph) continue;
                for (const stroke of glyph.strokes) {
                    const polyline = new XYPolyline();
                    for (const p of stroke) {
                        polyline.addVertex(penX + (p.x - glyph.left) * factor, baseline + (p.y - HERSHEY_BASELINE) * factor);
                    }
                    result.push(polyline);
                }
                penX += (glyph.right - glyph.left) * factor;
            }
            baseline += leading;
        }

        return result;
    }

}

// Hershey units from the top of a capital letter to the baseline.
HersheyFont.CAP_HEIGHT = 21;
// Where the .jhf files are: common/data/hershey_fonts.
HersheyFont.dataPath = new URL('../../../data/hershey_fonts/', import.meta.url).href;
