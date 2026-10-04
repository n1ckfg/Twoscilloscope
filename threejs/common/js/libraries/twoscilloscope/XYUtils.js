/*
+ + +   three.twoscilloscope   + + +

Small helpers the rest of the library shares, in place of the bits of
openFrameworks it used: ofClamp, ofMap, ofGetTimestampString,
ofFloatColor::fromHsb, and writing files (which become downloads).
*/

export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export function degToRad(degrees) {
    return degrees * PI / 180;
}

// ofMap without clamping
export function mapValue(v, inMin, inMax, outMin, outMax) {
    return outMin + (v - inMin) / (inMax - inMin) * (outMax - outMin);
}

// A date and time as text, like ofGetTimestampString():
// %Y year, %m month, %d day, %H hours, %M minutes, %S seconds, %i milliseconds
export function timestamp(format = '%Y-%m-%d-%H-%M-%S-%i') {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const codes = {
        Y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()),
        H: pad(d.getHours()), M: pad(d.getMinutes()), S: pad(d.getSeconds()), i: pad(d.getMilliseconds(), 3)
    };
    return format.replace(/%([YmdHMSi])/g, (match, code) => codes[code]);
}

// Hand the browser a file to save.
export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// HSB (all 0..1) to RGB (0..1), like ofFloatColor::fromHsb()
export function hsbToRgb(h, s, v) {
    h = (h - Math.floor(h)) * 6;
    const i = Math.floor(h);
    const f = h - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

// {x, y}, [x, y] and THREE.Vector2/3 all work as points
export function px(p) {
    return Array.isArray(p) ? p[0] : p.x;
}

export function py(p) {
    return Array.isArray(p) ? p[1] : p.y;
}

export function pz(p) {
    const z = Array.isArray(p) ? p[2] : p.z;
    return z === undefined ? 0 : z;
}
