'use strict';

/**
 * WebGL Drum Kit — main.js
 *
 * All rendering has been converted from Canvas 2D to WebGL.
 *
 * Rendering layers (all WebGL):
 *   1. Animated gradient background  — fullscreen quad, GLSL fragment shader
 *   2. Cell dividers                 — line geometry
 *   3. Background shapes             — batched triangulated polygons
 *   4. Looping glow overlays         — coloured quads
 *   5. Instrument images             — textured quads (SVG rasterised via 2D canvas)
 *   6. Sparkles                      — batched triangulated shapes
 *   7. Rings                         — triangle-strip annuli
 *
 * Modals (splash, help), COMBO! text/flash remain as DOM overlays.
 * Audio playback uses Howler.js (unchanged).
 */
(function () {

    // ─── Instrument list ──────────────────────────────────────────────────────
    const INSTRUMENTS = ['crash', 'tom', 'hihat', 'snare', 'bass', 'floortom'];

    // Ticks between hits per instrument (1 tick = 250 ms = 8th note at 120 BPM)
    const LOOP_TICKS = {
        crash:    8,  // whole note    (2 000 ms)
        hihat:    1,  // 8th note      (  250 ms)
        tom:      3,  // dotted quarter(  750 ms)
        snare:    4,  // half note     (1 000 ms)
        bass:     2,  // quarter note  (  500 ms)
        floortom: 6,  // dotted half   (1 500 ms)
    };

    // Instruments that spin vs pulse (mirrors original CSS classes)
    const SPIN_SET  = new Set(['crash', 'hihat']);
    const PULSE_SET = new Set(['tom', 'snare', 'bass', 'floortom']);

    // ─── Colours ──────────────────────────────────────────────────────────────
    const SPARKLE_COLORS = ['#BD93F9', '#66D9EF', '#FF79C6', '#F1FA8C', '#ffffff', '#FFB86C'];

    // Background gradient themes — matches the four body class variants in the original CSS
    const BG_THEMES = [
        ['#BD93F9', '#6e40c9', '#ff79c6', '#6e40c9', '#BD93F9'], // purple
        ['#66D9EF', '#1e90ff', '#BD93F9', '#1e90ff', '#66D9EF'], // blue
        ['#FF79C6', '#ff2d78', '#FFB86C', '#ff2d78', '#FF79C6'], // pink
        ['#F1FA8C', '#FFB86C', '#FF79C6', '#FFB86C', '#F1FA8C'], // yellow
    ];
    let bgThemeIndex = 0;

    // ─── Canvas / WebGL initialisation ───────────────────────────────────────
    const canvas = document.getElementById('drumkit-canvas');
    let gl;

    (function initWebGL() {
        const opts = { alpha: false, antialias: true, premultipliedAlpha: false };
        gl = canvas.getContext('webgl2', opts) ||
             canvas.getContext('webgl',  opts) ||
             canvas.getContext('experimental-webgl', opts);
        if (!gl) {
            console.error('WebGL not supported.');
            return;
        }
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }());

    let dpr = 1;
    let W, H; // logical (CSS-pixel) dimensions

    function resizeCanvas() {
        dpr = window.devicePixelRatio || 1;
        W   = window.innerWidth;
        H   = window.innerHeight;
        canvas.width  = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
        computeCells();
        rebuildDividerBuffer();
    }

    // ─── Grid layout ──────────────────────────────────────────────────────────
    // 2×3 portrait, 3×2 landscape.
    let cells = [];

    function computeCells() {
        const isLandscape = W > H;
        const cols  = isLandscape ? 3 : 2;
        const rows  = isLandscape ? 2 : 3;
        const cellW = W / cols;
        const cellH = H / rows;
        cells = INSTRUMENTS.map(function (name, i) {
            return {
                name: name,
                x:    (i % cols) * cellW,
                y:    Math.floor(i / cols) * cellH,
                w:    cellW,
                h:    cellH,
                cx:   ((i % cols) + 0.5) * cellW,
                cy:   (Math.floor(i / cols) + 0.5) * cellH,
            };
        });
    }

    function getCellAt(x, y) {
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c;
        }
        return null;
    }

    function findCell(name) {
        for (var i = 0; i < cells.length; i++) {
            if (cells[i].name === name) return cells[i];
        }
        return null;
    }

    // ─── Colour helpers ───────────────────────────────────────────────────────
    function hexToRGB(hex) {
        var r = parseInt(hex.slice(1, 3), 16) / 255;
        var g = parseInt(hex.slice(3, 5), 16) / 255;
        var b = parseInt(hex.slice(5, 7), 16) / 255;
        return [r, g, b];
    }

    // ─── Shader helpers ───────────────────────────────────────────────────────
    function compileShader(type, source) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }

    function createProgram(vsSource, fsSource) {
        var vs   = compileShader(gl.VERTEX_SHADER,   vsSource);
        var fs   = compileShader(gl.FRAGMENT_SHADER, fsSource);
        var prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(prog));
            return null;
        }
        return prog;
    }

    // ─── Program 1: Fluid background ─────────────────────────────────────────
    // Fullscreen clip-space quad; the fragment shader builds the fluid animation.
    var bgProg, bgVbo;
    var bgU_resolution, bgU_time, bgU_c0, bgU_c1, bgU_c2, bgU_c3, bgU_c4;

    var BG_VS = [
        'attribute vec2 a_pos;',
        'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }',
    ].join('\n');

    // Domain-warped fluid: two rounds of warping with sine/cosine lattices give
    // an organic, lava-lamp-like flow.  The warp result is mapped through the
    // five theme colours interpolated with sampleGradient().
    var BG_FS = [
        'precision mediump float;',
        'uniform vec2  u_resolution;',
        'uniform float u_time;',
        'uniform vec3  u_c0, u_c1, u_c2, u_c3, u_c4;',
        'vec3 sampleGradient(float t) {',
        '    float s = 0.25;',
        '    if (t < s)          return mix(u_c0, u_c1, t / s);',
        '    else if (t < 2.0*s) return mix(u_c1, u_c2, (t - s) / s);',
        '    else if (t < 3.0*s) return mix(u_c2, u_c3, (t - 2.0*s) / s);',
        '    else                return mix(u_c3, u_c4, (t - 3.0*s) / s);',
        '}',
        'void main() {',
        '    vec2 uv = gl_FragCoord.xy / u_resolution;',
        '    float ar = u_resolution.x / u_resolution.y;',
        '    uv.x *= ar;',
        '    float T = u_time * 0.25;',
        // First warp layer
        '    vec2 q;',
        '    q.x = sin(uv.x * 1.8 + T)        + 0.5 * sin(uv.y * 2.4 + T * 0.7);',
        '    q.y = sin(uv.y * 2.1 + T * 0.9)   + 0.5 * sin(uv.x * 1.6 + T * 1.1);',
        // Second warp layer applied on top of first
        '    vec2 r;',
        '    r.x = sin((uv.x + q.x) * 1.4 + T * 0.8) + 0.4 * cos((uv.y + q.y) * 2.0 + T * 0.5);',
        '    r.y = cos((uv.y + q.y) * 1.9 + T * 0.6) + 0.4 * sin((uv.x + q.x) * 2.3 + T * 0.9);',
        '    float f = clamp((length(r) - 0.2) * 0.35, 0.0, 1.0);',
        '    gl_FragColor = vec4(sampleGradient(f), 1.0);',
        '}',
    ].join('\n');

    function initBgProgram() {
        bgProg         = createProgram(BG_VS, BG_FS);
        bgU_resolution = gl.getUniformLocation(bgProg, 'u_resolution');
        bgU_time       = gl.getUniformLocation(bgProg, 'u_time');
        bgU_c0         = gl.getUniformLocation(bgProg, 'u_c0');
        bgU_c1         = gl.getUniformLocation(bgProg, 'u_c1');
        bgU_c2         = gl.getUniformLocation(bgProg, 'u_c2');
        bgU_c3         = gl.getUniformLocation(bgProg, 'u_c3');
        bgU_c4         = gl.getUniformLocation(bgProg, 'u_c4');

        bgVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bgVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1,  1,-1,  -1, 1,
             1,-1,  1, 1,  -1, 1,
        ]), gl.STATIC_DRAW);
    }

    function drawBackground(bgTime) {
        var colors = BG_THEMES[bgThemeIndex];

        gl.useProgram(bgProg);
        gl.uniform2f(bgU_resolution, canvas.width, canvas.height);
        gl.uniform1f(bgU_time, bgTime);

        var cols = colors.map(hexToRGB);
        gl.uniform3fv(bgU_c0, cols[0]);
        gl.uniform3fv(bgU_c1, cols[1]);
        gl.uniform3fv(bgU_c2, cols[2]);
        gl.uniform3fv(bgU_c3, cols[3]);
        gl.uniform3fv(bgU_c4, cols[4]);

        gl.bindBuffer(gl.ARRAY_BUFFER, bgVbo);
        var aPos = gl.getAttribLocation(bgProg, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ─── Program 2: Flat-colour geometry (sparkles, rings, shapes, glow, dividers) ──
    // Per-vertex layout: x, y, r, g, b, a  (6 floats = 24 bytes)
    var flatProg, flatBuf;
    var flatA_pos, flatA_color;

    var FLAT_VS = [
        'attribute vec2 a_pos;',
        'attribute vec4 a_color;',
        'varying   vec4 v_color;',
        'uniform   vec2 u_resolution;',
        'void main() {',
        '    vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;',
        '    clip.y = -clip.y;',
        '    gl_Position = vec4(clip, 0.0, 1.0);',
        '    v_color = a_color;',
        '}',
    ].join('\n');

    var FLAT_FS = [
        'precision mediump float;',
        'varying vec4 v_color;',
        'void main() { gl_FragColor = v_color; }',
    ].join('\n');

    var FLAT_MAX_VERTS = 65536;
    var flatVerts;   // Float32Array (x, y, r, g, b, a per vertex)
    var flatCount = 0;
    var FLAT_STRIDE = 6;

    function initFlatProgram() {
        flatProg    = createProgram(FLAT_VS, FLAT_FS);
        flatA_pos   = gl.getAttribLocation(flatProg, 'a_pos');
        flatA_color = gl.getAttribLocation(flatProg, 'a_color');
        flatBuf     = gl.createBuffer();
        flatVerts   = new Float32Array(FLAT_MAX_VERTS * FLAT_STRIDE);
    }

    function flatReset() { flatCount = 0; }

    function flatVert(x, y, r, g, b, a) {
        if (flatCount >= FLAT_MAX_VERTS) return;
        var off = flatCount * FLAT_STRIDE;
        flatVerts[off]     = x; flatVerts[off+1] = y;
        flatVerts[off+2]   = r; flatVerts[off+3] = g;
        flatVerts[off+4]   = b; flatVerts[off+5] = a;
        flatCount++;
    }

    function flatTri(x0,y0, x1,y1, x2,y2, r,g,b,a) {
        flatVert(x0,y0,r,g,b,a); flatVert(x1,y1,r,g,b,a); flatVert(x2,y2,r,g,b,a);
    }

    function flatQuad(x, y, w, h, r, g, b, a) {
        flatTri(x,   y,   x+w, y,   x,   y+h, r,g,b,a);
        flatTri(x+w, y,   x+w, y+h, x,   y+h, r,g,b,a);
    }

    // Fan-triangulate a convex polygon from its centroid
    function flatPolygon(pts, cx, cy, r, g, b, a) {
        for (var i = 0; i < pts.length; i++) {
            var p0 = pts[i], p1 = pts[(i+1)%pts.length];
            flatTri(cx,cy, p0[0],p0[1], p1[0],p1[1], r,g,b,a);
        }
    }

    var RING_SEGS = 64;

    function flatRing(cx, cy, radius, lineWidth, r, g, b, a) {
        var inner = radius - lineWidth * 0.5;
        var outer = radius + lineWidth * 0.5;
        for (var i = 0; i < RING_SEGS; i++) {
            var a0 = (i     / RING_SEGS) * Math.PI * 2;
            var a1 = ((i+1) / RING_SEGS) * Math.PI * 2;
            var ix0 = cx + Math.cos(a0)*inner, iy0 = cy + Math.sin(a0)*inner;
            var ox0 = cx + Math.cos(a0)*outer, oy0 = cy + Math.sin(a0)*outer;
            var ix1 = cx + Math.cos(a1)*inner, iy1 = cy + Math.sin(a1)*inner;
            var ox1 = cx + Math.cos(a1)*outer, oy1 = cy + Math.sin(a1)*outer;
            flatTri(ix0,iy0, ox0,oy0, ix1,iy1, r,g,b,a);
            flatTri(ox0,oy0, ox1,oy1, ix1,iy1, r,g,b,a);
        }
    }

    function flatFlush(drawMode) {
        if (flatCount === 0) return;
        drawMode = drawMode || gl.TRIANGLES;

        gl.useProgram(flatProg);
        gl.uniform2f(gl.getUniformLocation(flatProg, 'u_resolution'), W, H);

        gl.bindBuffer(gl.ARRAY_BUFFER, flatBuf);
        gl.bufferData(gl.ARRAY_BUFFER, flatVerts.subarray(0, flatCount * FLAT_STRIDE), gl.DYNAMIC_DRAW);

        var stride = FLAT_STRIDE * 4;
        gl.enableVertexAttribArray(flatA_pos);
        gl.vertexAttribPointer(flatA_pos,   2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(flatA_color);
        gl.vertexAttribPointer(flatA_color, 4, gl.FLOAT, false, stride, 8);

        gl.drawArrays(drawMode, 0, flatCount);
        flatCount = 0;
    }

    // ─── Program 3: Textured quads (instrument images) ────────────────────────
    // Per-vertex layout: x, y, u, v  (4 floats = 16 bytes)
    var texProg, texBuf;
    var texA_pos, texA_uv, texU_resolution, texU_sampler, texU_alpha;

    var TEX_VS = [
        'attribute vec2 a_pos;',
        'attribute vec2 a_uv;',
        'varying   vec2 v_uv;',
        'uniform   vec2 u_resolution;',
        'void main() {',
        '    vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;',
        '    clip.y = -clip.y;',
        '    gl_Position = vec4(clip, 0.0, 1.0);',
        '    v_uv = a_uv;',
        '}',
    ].join('\n');

    var TEX_FS = [
        'precision mediump float;',
        'varying   vec2      v_uv;',
        'uniform   sampler2D u_sampler;',
        'uniform   float     u_alpha;',
        'void main() {',
        '    vec4 t = texture2D(u_sampler, v_uv);',
        '    gl_FragColor = vec4(t.rgb, t.a * u_alpha);',
        '}',
    ].join('\n');

    var TEX_STRIDE = 4;

    function initTexProgram() {
        texProg         = createProgram(TEX_VS, TEX_FS);
        texA_pos        = gl.getAttribLocation(texProg, 'a_pos');
        texA_uv         = gl.getAttribLocation(texProg, 'a_uv');
        texU_resolution = gl.getUniformLocation(texProg, 'u_resolution');
        texU_sampler    = gl.getUniformLocation(texProg, 'u_sampler');
        texU_alpha      = gl.getUniformLocation(texProg, 'u_alpha');
        texBuf          = gl.createBuffer();
    }

    function drawTexturedQuadRotated(tex, cx, cy, size, rotation) {
        var hw  = size / 2;
        var cos = Math.cos(rotation), sin = Math.sin(rotation);

        var tlx = cx + (-hw)*cos - (-hw)*sin, tly = cy + (-hw)*sin + (-hw)*cos;
        var trx = cx + ( hw)*cos - (-hw)*sin, try_ = cy + ( hw)*sin + (-hw)*cos;
        var blx = cx + (-hw)*cos - ( hw)*sin, bly = cy + (-hw)*sin + ( hw)*cos;
        var brx = cx + ( hw)*cos - ( hw)*sin, bry = cy + ( hw)*sin + ( hw)*cos;

        var verts = new Float32Array([
            tlx, tly, 0, 0,
            trx, try_, 1, 0,
            blx, bly, 0, 1,
            trx, try_, 1, 0,
            brx, bry, 1, 1,
            blx, bly, 0, 1,
        ]);

        gl.useProgram(texProg);
        gl.uniform2f(texU_resolution, W, H);
        gl.uniform1f(texU_alpha, 1.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(texU_sampler, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

        var stride = TEX_STRIDE * 4;
        gl.enableVertexAttribArray(texA_pos);
        gl.vertexAttribPointer(texA_pos, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(texA_uv);
        gl.vertexAttribPointer(texA_uv,  2, gl.FLOAT, false, stride, 8);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ─── Texture helpers ──────────────────────────────────────────────────────
    function createTextureFromCanvas(offscreenCanvas) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
    }

    // ─── SVG texture loading ──────────────────────────────────────────────────
    // Rasterise each SVG onto an offscreen 2D canvas, then upload as a WebGL texture.
    var textures = {};
    var texturesReady = 0;
    var TEX_SIZE = 512;

    function loadTextures(cb) {
        INSTRUMENTS.forEach(function (name) {
            var img = new Image();
            img.onload = function () {
                var offscreen = document.createElement('canvas');
                offscreen.width = offscreen.height = TEX_SIZE;
                var ctx2d = offscreen.getContext('2d');
                ctx2d.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
                ctx2d.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
                textures[name] = createTextureFromCanvas(offscreen);
                if (++texturesReady === INSTRUMENTS.length) cb();
            };
            img.src = './img/' + name + '.svg';
        });
    }

    // ─── Cell divider buffer ──────────────────────────────────────────────────
    var dividerData = null;

    function rebuildDividerBuffer() {
        if (!cells.length) return;
        var r = 1, g2 = 1, b2 = 1, a2 = 0.05;
        var verts = [];
        cells.forEach(function (c) {
            // bottom edge
            verts.push(c.x, c.y+c.h, r,g2,b2,a2, c.x+c.w, c.y+c.h, r,g2,b2,a2);
            // right edge
            verts.push(c.x+c.w, c.y, r,g2,b2,a2, c.x+c.w, c.y+c.h, r,g2,b2,a2);
        });
        dividerData = new Float32Array(verts);
    }

    function drawDividers() {
        if (!dividerData || dividerData.length === 0) return;
        gl.useProgram(flatProg);
        gl.uniform2f(gl.getUniformLocation(flatProg, 'u_resolution'), W, H);
        gl.bindBuffer(gl.ARRAY_BUFFER, flatBuf);
        gl.bufferData(gl.ARRAY_BUFFER, dividerData, gl.DYNAMIC_DRAW);
        var stride = FLAT_STRIDE * 4;
        gl.enableVertexAttribArray(flatA_pos);
        gl.vertexAttribPointer(flatA_pos,   2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(flatA_color);
        gl.vertexAttribPointer(flatA_color, 4, gl.FLOAT, false, stride, 8);
        gl.lineWidth(1);
        gl.drawArrays(gl.LINES, 0, dividerData.length / FLAT_STRIDE);
    }

    // ─── Sparkle geometry helpers ─────────────────────────────────────────────
    function emitSparkleGeometry(shape, cx, cy, halfSize, r, g, b, a) {
        var i, a0, a1;
        switch (shape) {
            case 'circle': {
                var SEGS = 16;
                for (i = 0; i < SEGS; i++) {
                    a0 = (i     / SEGS) * Math.PI * 2;
                    a1 = ((i+1) / SEGS) * Math.PI * 2;
                    flatTri(cx, cy,
                        cx + Math.cos(a0)*halfSize, cy + Math.sin(a0)*halfSize,
                        cx + Math.cos(a1)*halfSize, cy + Math.sin(a1)*halfSize,
                        r, g, b, a);
                }
                break;
            }
            case 'diamond':
                flatPolygon([[cx,cy-halfSize],[cx+halfSize,cy],[cx,cy+halfSize],[cx-halfSize,cy]], cx, cy, r,g,b,a);
                break;
            case 'triangle':
                flatPolygon([[cx,cy-halfSize],[cx+halfSize,cy+halfSize],[cx-halfSize,cy+halfSize]], cx, cy, r,g,b,a);
                break;
            case 'star': {
                var outer = halfSize, inner = halfSize * 0.4;
                var pts = [];
                for (i = 0; i < 10; i++) {
                    var rad = i % 2 === 0 ? outer : inner;
                    var ang = i * Math.PI / 5 - Math.PI / 2;
                    pts.push([cx + Math.cos(ang)*rad, cy + Math.sin(ang)*rad]);
                }
                flatPolygon(pts, cx, cy, r,g,b,a);
                break;
            }
        }
    }

    // ─── Rotated bg-shape emitter ─────────────────────────────────────────────
    function emitRotatedBgShape(shape, cx, cy, halfSize, rot, r, g, b, a) {
        var cosR = Math.cos(rot), sinR = Math.sin(rot);
        function rx(lx, ly) { return cx + lx*cosR - ly*sinR; }
        function ry(lx, ly) { return cy + lx*sinR + ly*cosR; }

        function rotPoly(lpts) {
            for (var i = 0; i < lpts.length; i++) {
                var p0 = lpts[i], p1 = lpts[(i+1)%lpts.length];
                flatTri(cx,cy, rx(p0[0],p0[1]),ry(p0[0],p0[1]), rx(p1[0],p1[1]),ry(p1[0],p1[1]), r,g,b,a);
            }
        }

        var i, a0, a1;
        switch (shape) {
            case 'circle': {
                var SEGS = 24;
                for (i = 0; i < SEGS; i++) {
                    a0 = (i     / SEGS) * Math.PI * 2;
                    a1 = ((i+1) / SEGS) * Math.PI * 2;
                    flatTri(cx,cy,
                        rx(Math.cos(a0)*halfSize, Math.sin(a0)*halfSize),
                        ry(Math.cos(a0)*halfSize, Math.sin(a0)*halfSize),
                        rx(Math.cos(a1)*halfSize, Math.sin(a1)*halfSize),
                        ry(Math.cos(a1)*halfSize, Math.sin(a1)*halfSize),
                        r,g,b,a);
                }
                break;
            }
            case 'diamond':
                rotPoly([[0,-halfSize],[halfSize,0],[0,halfSize],[-halfSize,0]]);
                break;
            case 'triangle':
                rotPoly([[0,-halfSize],[halfSize*0.866,halfSize*0.5],[-halfSize*0.866,halfSize*0.5]]);
                break;
            case 'star': {
                var outer = halfSize, inner = halfSize * 0.45;
                var lpts = [];
                for (i = 0; i < 10; i++) {
                    var rad = i % 2 === 0 ? outer : inner;
                    var ang = i * Math.PI / 5 - Math.PI / 2;
                    lpts.push([Math.cos(ang)*rad, Math.sin(ang)*rad]);
                }
                rotPoly(lpts);
                break;
            }
            case 'hexagon': {
                var hpts = [];
                for (i = 0; i < 6; i++) {
                    var ha = i * Math.PI / 3;
                    hpts.push([Math.cos(ha)*halfSize, Math.sin(ha)*halfSize]);
                }
                rotPoly(hpts);
                break;
            }
        }
    }

    // ─── Audio ────────────────────────────────────────────────────────────────
    var sounds = {};

    // ─── Reverb ───────────────────────────────────────────────────────────────
    var reverbEnabled     = false;
    var reverbInitialised = false;
    var reverbWetGain     = null;

    function buildImpulseResponse(audioCtx) {
        var duration   = 2.5;
        var decay      = 3.0;
        var length     = Math.ceil(audioCtx.sampleRate * duration);
        var buffer     = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
        for (var c = 0; c < 2; c++) {
            var ch = buffer.getChannelData(c);
            for (var i = 0; i < length; i++) {
                ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return buffer;
    }

    function initReverbGraph() {
        if (reverbInitialised) return;
        var audioCtx = Howler.ctx;
        if (!audioCtx) return;
        var convolver = audioCtx.createConvolver();
        convolver.buffer = buildImpulseResponse(audioCtx);
        reverbWetGain = audioCtx.createGain();
        reverbWetGain.gain.value = 0;
        Howler.masterGain.disconnect();
        Howler.masterGain.connect(audioCtx.destination);
        Howler.masterGain.connect(convolver);
        convolver.connect(reverbWetGain);
        reverbWetGain.connect(audioCtx.destination);
        reverbInitialised = true;
        if (reverbEnabled) reverbWetGain.gain.value = 0.35;
    }

    function setReverb(enabled) {
        reverbEnabled = enabled;
        if (reverbInitialised) {
            reverbWetGain.gain.setTargetAtTime(
                enabled ? 0.35 : 0,
                Howler.ctx.currentTime,
                0.05
            );
        }
        var btn = document.getElementById('reverb-btn');
        if (btn) btn.classList.toggle('reverb-on', enabled);
    }

    function initAudio() {
        INSTRUMENTS.forEach(function (name) {
            sounds[name] = new Howl({ src: ['./audio/' + name + '.mp3'] });
        });
        sounds['monkey'] = new Howl({ src: ['./audio/monkey.mp3'] });
        sounds['pig']    = new Howl({ src: ['./audio/pig.mp3'] });
        sounds['tiger']  = new Howl({ src: ['./audio/tiger.mp3'] });
        sounds['moo']    = new Howl({ src: ['./audio/moo.mp3'] });
        sounds['lion']   = new Howl({ src: ['./audio/lion.mp3'] });
        sounds['oliver'] = new Howl({ src: ['./audio/oliver.mp3'] });
    }

    function playSound(name) {
        if (!reverbInitialised) initReverbGraph();
        if (sounds[name]) sounds[name].play();
    }

    // ─── Per-instrument animation state ───────────────────────────────────────
    var istate = {};
    INSTRUMENTS.forEach(function (name) {
        istate[name] = {
            rotation:   0,
            pulsePhase: Math.random() * Math.PI * 2, // stagger phases
            hitScale:   1,   // jumps to 1.3 on hit, decays back to 1
            looping:    false,
        };
    });

    // ─── Particle arrays ──────────────────────────────────────────────────────
    // All ages are in seconds.
    var sparkles = [];
    var rings    = [];

    var SPARKLE_SHAPES = ['circle', 'diamond', 'triangle', 'star'];

    function emitSparkles(x, y, count) {
        count = count || 16;
        for (var i = 0; i < count; i++) {
            var angle    = (i / count) * Math.PI * 2;
            var distance = 80 + Math.random() * 120;
            sparkles.push({
                ox:    x,
                oy:    y,
                dx:    Math.cos(angle) * distance,
                dy:    Math.sin(angle) * distance,
                color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
                shape: SPARKLE_SHAPES[Math.floor(Math.random() * SPARKLE_SHAPES.length)],
                size:  10 + Math.random() * 20,
                age:   0,
                life:  0.6,
            });
        }
    }

    function emitRings(x, y, count) {
        count = count || 3;
        for (var i = 0; i < count; i++) {
            rings.push({
                cx:    x,
                cy:    y,
                delay: i * 0.15,
                color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
                age:   0,
                life:  0.9,
            });
        }
    }

    // ─── Background shapes ────────────────────────────────────────────────────
    var bgShapes = [];

    var BG_SHAPE_TYPES = ['circle', 'diamond', 'triangle', 'star', 'hexagon'];

    function emitBgShapes(x, y, count) {
        count = count || 4;
        for (var i = 0; i < count; i++) {
            bgShapes.push({
                x:        x + (Math.random() - 0.5) * W * 0.8,
                y:        y + (Math.random() - 0.5) * H * 0.8,
                shape:    BG_SHAPE_TYPES[Math.floor(Math.random() * BG_SHAPE_TYPES.length)],
                color:    SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
                size:     60 + Math.random() * 120,
                rotation: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * 1.0,
                age:      0,
                life:     1.2 + Math.random() * 1.0,
            });
        }
    }

    // ─── Active loops ─────────────────────────────────────────────────────────
    var activeLoops = {};
    window._drumKitActiveLoops = activeLoops;

    // ─── Master loop clock ────────────────────────────────────────────────────
    // One shared 8th-note tick (250 ms at 120 BPM) drives every active loop so
    // all instruments stay locked to the same rhythmic grid.
    var masterTickCount = 0;
    var masterTimer     = null;
    var bpm             = 120;
    var BPM_MIN         = 60;
    var BPM_MAX         = 200;

    function masterTickFn() {
        // Evaluate before incrementing so tick 0 is a downbeat for all instruments.
        INSTRUMENTS.forEach(function (name) {
            if (!activeLoops[name]) return;
            if (masterTickCount % LOOP_TICKS[name] === 0) {
                var cell = findCell(name);
                if (cell) triggerPlay(name, cell.cx, cell.cy, true);
            }
        });
        masterTickCount++;
    }

    function startMasterClock() {
        if (masterTimer) return;
        masterTickCount = 0;
        masterTimer = setInterval(masterTickFn, Math.round(30000 / bpm));
    }

    function stopMasterClock() {
        if (masterTimer) {
            clearInterval(masterTimer);
            masterTimer = null;
        }
    }

    function setBpm(newBpm) {
        bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, newBpm));
        var display = document.getElementById('bpm-display');
        if (display) display.textContent = bpm;
        if (masterTimer) {
            clearInterval(masterTimer);
            masterTimer = setInterval(masterTickFn, Math.round(30000 / bpm));
        }
    }

    // ─── Play trigger (combines audio + visuals) ───────────────────────────────
    function triggerPlay(name, x, y, trusted) {
        playSound(name);
        emitSparkles(x, y, trusted ? 16 : 4);
        emitRings(x, y, trusted ? 3 : 1);
        emitBgShapes(x, y, trusted ? 4 : 1);
        istate[name].hitScale = 1.3;
        if (trusted) cycleBgTheme();
    }

    function cycleBgTheme() {
        var prev = bgThemeIndex;
        do {
            bgThemeIndex = Math.floor(Math.random() * BG_THEMES.length);
        } while (bgThemeIndex === prev && BG_THEMES.length > 1);
    }

    // ─── Input handling ───────────────────────────────────────────────────────
    var lastPlayTimes = {};
    INSTRUMENTS.forEach(function (n) { lastPlayTimes[n] = 0; });

    // Map pointerId → { instrument, holdTimer }
    var activePointers = {};

    canvas.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        var rect = canvas.getBoundingClientRect();
        var x    = event.clientX - rect.left;
        var y    = event.clientY - rect.top;
        var cell = getCellAt(x, y);
        if (!cell) return;

        var name = cell.name;
        var now  = Date.now();

        // 100 ms debounce (same as original)
        if (now - lastPlayTimes[name] < 100) {
            // Still set up the hold timer so the user can toggle loop on repeat taps
            if (event.isTrusted) setupHoldTimer(event.pointerId, name);
            return;
        }
        lastPlayTimes[name] = now;
        triggerPlay(name, x, y, event.isTrusted);
        if (event.isTrusted) notifyCombo(name);

        if (!event.isTrusted) return;
        setupHoldTimer(event.pointerId, name);
    });

    function updateBpmVisibility() {
        var el = document.getElementById('bpm-control');
        if (!el) return;
        var hasLoop = Object.keys(activeLoops).length > 0;
        el.classList.toggle('bpm-visible', hasLoop);
    }

    function setupHoldTimer(pointerId, name) {
        var holdTimer = setTimeout(function () {
            if (activeLoops[name]) {
                delete activeLoops[name];
                istate[name].looping = false;
                if (Object.keys(activeLoops).length === 0) stopMasterClock();
            } else {
                activeLoops[name] = true;
                istate[name].looping = true;
                startMasterClock();
            }
            updateBpmVisibility();
        }, 500);
        activePointers[pointerId] = { instrument: name, holdTimer: holdTimer };
    }

    function cancelPointer(event) {
        var entry = activePointers[event.pointerId];
        if (entry) {
            clearTimeout(entry.holdTimer);
            delete activePointers[event.pointerId];
        }
    }

    canvas.addEventListener('pointerup',     cancelPointer);
    canvas.addEventListener('pointercancel', cancelPointer);
    canvas.addEventListener('pointermove', function (event) {
        var entry = activePointers[event.pointerId];
        if (!entry) return;
        var rect = canvas.getBoundingClientRect();
        var x    = event.clientX - rect.left;
        var y    = event.clientY - rect.top;
        var cell = getCellAt(x, y);
        // Cancel hold timer when pointer drifts to a different cell (mirrors pointerleave)
        if (!cell || cell.name !== entry.instrument) {
            clearTimeout(entry.holdTimer);
            delete activePointers[event.pointerId];
        }
    });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ─── fireHit — used by the solo/combo system ───────────────────────────────
    // Uses full sparkle/ring counts (same as a real button press) but skips
    // combo notification and background theme cycling.
    function fireHit(name) {
        var cell = findCell(name);
        if (!cell) return;
        var now = Date.now();
        if (now - lastPlayTimes[name] < 100) return;
        lastPlayTimes[name] = now;
        playSound(name);
        emitSparkles(cell.cx, cell.cy, 16);
        emitRings(cell.cx, cell.cy, 3);
        emitBgShapes(cell.cx, cell.cy, 2);
        istate[name].hitScale = 1.3;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ─── Combo + Solo System ─────────────────────────────────────────────────
    // ─── (ported from intro-solo.js — all original logic preserved) ──────────
    // ─────────────────────────────────────────────────────────────────────────

    // Classic intro solo — plays on splash + when all 6 instruments are hit
    var classicHits = [
        [   0, 'crash'   ],
        [   0, 'bass'    ],
        [ 300, 'hihat'   ],
        [ 600, 'hihat'   ],
        [ 600, 'snare'   ],
        [ 900, 'hihat'   ],
        [1200, 'bass'    ],
        [1200, 'hihat'   ],
        [1500, 'snare'   ],
        [1500, 'hihat'   ],
        [1800, 'hihat'   ],
        [2100, 'tom'     ],
        [2280, 'tom'     ],
        [2460, 'snare'   ],
        [2640, 'floortom'],
        [2820, 'bass'    ],
        [2950, 'snare'   ],
        [3080, 'snare'   ],
        [3300, 'crash'   ],
        [3300, 'bass'    ],
    ];

    // Per-instrument solos triggered by 3 consecutive hits on that instrument
    var SOLOS = {
        crash: {
            duration: 4500,
            endSfx: { sound: 'lion', delay: 3800 },
            hits: [
                [   0, 'crash'], [ 300, 'crash'], [ 300, 'bass' ], [ 600, 'crash'],
                [ 900, 'crash'], [ 900, 'hihat'], [1200, 'crash'], [1200, 'bass' ],
                [1500, 'crash'], [1500, 'hihat'], [1800, 'crash'], [2100, 'crash'],
                [2100, 'bass' ], [2400, 'crash'], [2400, 'hihat'], [2700, 'crash'],
                [2700, 'snare'], [2900, 'crash'], [3100, 'crash'], [3100, 'bass' ],
                [3300, 'crash'], [3300, 'bass' ],
            ],
        },
        hihat: {
            duration: 4500,
            endSfx: { sound: 'tiger', delay: 3500 },
            hits: [
                [   0, 'hihat'], [ 150, 'hihat'], [ 300, 'hihat'], [ 300, 'snare'],
                [ 450, 'hihat'], [ 600, 'hihat'], [ 600, 'bass' ], [ 750, 'hihat'],
                [ 900, 'hihat'], [ 900, 'snare'], [1050, 'hihat'], [1200, 'hihat'],
                [1200, 'bass' ], [1350, 'hihat'], [1500, 'hihat'], [1500, 'snare'],
                [1650, 'hihat'], [1800, 'hihat'], [1950, 'hihat'], [1950, 'bass' ],
                [2100, 'hihat'], [2100, 'snare'], [2250, 'hihat'], [2400, 'hihat'],
                [2550, 'hihat'], [2550, 'bass' ], [2700, 'hihat'], [2850, 'hihat'],
                [2850, 'snare'], [3000, 'hihat'], [3000, 'crash'], [3000, 'bass' ],
            ],
        },
        tom: {
            duration: 5000,
            endSfx: { sound: 'monkey', delay: 4000 },
            hits: [
                [   0, 'tom'     ], [ 180, 'tom'     ], [ 360, 'floortom'],
                [ 540, 'tom'     ], [ 720, 'floortom'], [ 900, 'tom'     ],
                [1080, 'crash'   ], [1080, 'bass'    ], [1350, 'tom'     ],
                [1500, 'tom'     ], [1650, 'floortom'], [1800, 'tom'     ],
                [1950, 'floortom'], [2100, 'tom'     ], [2280, 'snare'   ],
                [2400, 'snare'   ], [2550, 'tom'     ], [2700, 'floortom'],
                [2850, 'tom'     ], [3000, 'tom'     ], [3150, 'floortom'],
                [3300, 'tom'     ], [3420, 'tom'     ], [3540, 'floortom'],
                [3660, 'crash'   ], [3660, 'bass'    ], [3660, 'tom'     ],
            ],
        },
        snare: {
            duration: 4500,
            endSfx: { sound: 'pig', delay: 3800 },
            hits: [
                [   0, 'snare'], [ 200, 'snare'], [ 400, 'snare'], [ 400, 'bass' ],
                [ 600, 'snare'], [ 750, 'snare'], [ 900, 'snare'], [ 900, 'bass' ],
                [1050, 'snare'], [1200, 'snare'], [1200, 'hihat'], [1350, 'snare'],
                [1500, 'snare'], [1500, 'bass' ], [1650, 'snare'], [1800, 'snare'],
                [1800, 'tom'  ], [2000, 'snare'], [2200, 'snare'], [2200, 'bass' ],
                [2400, 'snare'], [2550, 'snare'], [2700, 'snare'], [2700, 'hihat'],
                [2850, 'snare'], [3000, 'snare'], [3000, 'bass' ], [3150, 'snare'],
                [3300, 'crash'], [3300, 'snare'], [3300, 'bass' ],
            ],
        },
        bass: {
            duration: 5000,
            endSfx: { sound: 'oliver', delay: 3800 },
            hits: [
                [   0, 'bass'    ], [ 300, 'bass'    ], [ 300, 'floortom'],
                [ 600, 'bass'    ], [ 900, 'bass'    ], [ 900, 'hihat'   ],
                [1200, 'bass'    ], [1200, 'floortom'], [1500, 'bass'    ],
                [1500, 'snare'   ], [1800, 'bass'    ], [2100, 'bass'    ],
                [2100, 'floortom'], [2400, 'bass'    ], [2400, 'snare'   ],
                [2600, 'bass'    ], [2800, 'bass'    ], [2800, 'floortom'],
                [3000, 'bass'    ], [3000, 'snare'   ], [3200, 'bass'    ],
                [3200, 'floortom'], [3400, 'crash'   ], [3400, 'bass'    ],
            ],
        },
        floortom: {
            duration: 5000,
            endSfx: { sound: 'moo', delay: 3800 },
            hits: [
                [   0, 'floortom'], [ 200, 'floortom'], [ 400, 'floortom'],
                [ 400, 'bass'    ], [ 600, 'floortom'], [ 800, 'floortom'],
                [ 800, 'tom'     ], [1000, 'floortom'], [1000, 'bass'    ],
                [1200, 'floortom'], [1400, 'floortom'], [1400, 'snare'   ],
                [1600, 'floortom'], [1600, 'bass'    ], [1800, 'floortom'],
                [1800, 'tom'     ], [2000, 'floortom'], [2200, 'floortom'],
                [2200, 'bass'    ], [2400, 'floortom'], [2400, 'snare'   ],
                [2600, 'floortom'], [2800, 'floortom'], [2800, 'tom'     ],
                [3000, 'floortom'], [3000, 'bass'    ], [3200, 'floortom'],
                [3300, 'crash'   ], [3300, 'floortom'], [3300, 'bass'    ],
            ],
        },
    };

    function playHits(hitList) {
        hitList.forEach(function (hit) {
            setTimeout(function () { fireHit(hit[1]); }, hit[0]);
        });
    }

    // COMBO! text — DOM-based to retain the full original CSS keyframe animation
    function showCombo() {
        var existing = document.getElementById('combo-text');
        if (existing) existing.remove();
        var existingFlash = document.getElementById('combo-flash');
        if (existingFlash) existingFlash.remove();

        // Full-screen burst flash (DOM div)
        var flash = document.createElement('div');
        flash.id = 'combo-flash';
        document.body.appendChild(flash);
        setTimeout(function () { flash.remove(); }, 500);

        var comboColors = ['#FF2D78', '#FF79C6', '#BD93F9', '#8BE9FD', '#50FA7B', '#F1FA8C', '#FFB86C'];
        var letters = 'COMBO!'.split('');
        var container = document.createElement('div');
        container.id = 'combo-text';
        letters.forEach(function (ch, i) {
            var span = document.createElement('span');
            span.className = 'combo-letter';
            span.textContent = ch;
            span.style.color = comboColors[i % comboColors.length];
            span.style.setProperty('--letter-delay', (i * 0.06) + 's');
            var angle = Math.random() * 2 * Math.PI;
            var dist  = 200 + Math.random() * 160;
            span.style.setProperty('--ex', (Math.cos(angle) * dist).toFixed(1) + 'px');
            span.style.setProperty('--ey', (Math.sin(angle) * dist).toFixed(1) + 'px');
            span.style.setProperty('--spin', (Math.random() * 80 - 40).toFixed(1) + 'deg');
            span.style.setProperty('--er',   (Math.random() * 120 - 60).toFixed(1) + 'deg');
            container.appendChild(span);
        });
        document.body.appendChild(container);
        setTimeout(function () { container.remove(); }, (letters.length - 1) * 60 + 1800);
    }

    // ─── Combo state ──────────────────────────────────────────────────────────
    var ALL_INSTRUMENTS = new Set(['crash', 'hihat', 'tom', 'snare', 'bass', 'floortom']);
    var soloPlaying  = false;
    var hitSoFar     = new Set();

    var streaks      = {};
    var resetTimers  = {};
    ALL_INSTRUMENTS.forEach(function (n) { streaks[n] = 0; resetTimers[n] = null; });

    var STREAK_COMBO    = 3;
    var STREAK_RESET_MS = 2000;

    var pairBuffer     = [];
    var pairResetTimer = null;
    var PAIR_RESET_MS  = 3000;

    function resetAllStreaks() {
        ALL_INSTRUMENTS.forEach(function (n) {
            streaks[n] = 0;
            clearTimeout(resetTimers[n]);
        });
    }

    function resetPairBuffer() {
        pairBuffer = [];
        clearTimeout(pairResetTimer);
    }

    // Build a dynamic duo solo for A-B-A-B combos
    function generatePairSolo(instrA, instrB) {
        var hits     = [];
        var hasBass  = instrA === 'bass'  || instrB === 'bass';
        var hasCrash = instrA === 'crash' || instrB === 'crash';
        var kick     = hasBass  ? null : 'bass';
        var accent   = hasCrash ? null : 'crash';

        // Phase 1
        [[0, instrA], [300, instrB], [600, instrA], [900, instrB]].forEach(function (h) { hits.push(h); });
        if (kick) hits.push([0, kick]);

        // Phase 2
        [[1200, instrA], [1380, instrB], [1560, instrA], [1740, instrB], [1920, instrA], [2100, instrB]].forEach(function (h) { hits.push(h); });
        if (kick) { hits.push([1200, kick]); hits.push([1920, kick]); }

        // Phase 3
        [[2300, instrA], [2450, instrB], [2600, instrA], [2750, instrB], [2900, instrA], [3050, instrB]].forEach(function (h) { hits.push(h); });
        if (kick) hits.push([2900, kick]);

        // Ending flourish
        if (accent) hits.push([3300, accent]);
        if (kick)   hits.push([3300, kick]);
        hits.push([3300, instrA]);

        return { hits: hits, duration: 4200 };
    }

    // Called by the input handler for every real (trusted) instrument hit
    function notifyCombo(instrument) {
        if (soloPlaying) return;
        if (Object.keys(activeLoops).length > 0) return;

        // Track last 4 hits for A-B-A-B pair combo
        pairBuffer.push(instrument);
        if (pairBuffer.length > 4) pairBuffer.shift();
        clearTimeout(pairResetTimer);

        // Increment this instrument's streak; reset all others
        ALL_INSTRUMENTS.forEach(function (name) {
            if (name !== instrument) {
                streaks[name] = 0;
                clearTimeout(resetTimers[name]);
            }
        });
        streaks[instrument]++;
        clearTimeout(resetTimers[instrument]);

        // Check 3-in-a-row combo
        if (streaks[instrument] >= STREAK_COMBO) {
            resetAllStreaks();
            resetPairBuffer();
            hitSoFar    = new Set();
            soloPlaying = true;
            showCombo();
            playHits(SOLOS[instrument].hits);
            if (SOLOS[instrument].endSfx) {
                var sfx = SOLOS[instrument].endSfx;
                setTimeout(function () { playSound(sfx.sound); }, sfx.delay);
            }
            setTimeout(function () { soloPlaying = false; }, SOLOS[instrument].duration);
            return;
        }

        // Check A-B-A-B pair combo
        if (pairBuffer.length === 4) {
            var pa = pairBuffer[0], pb = pairBuffer[1];
            if (pa === pairBuffer[2] && pb === pairBuffer[3] && pa !== pb) {
                resetAllStreaks();
                resetPairBuffer();
                hitSoFar    = new Set();
                soloPlaying = true;
                showCombo();
                var combo = generatePairSolo(pa, pb);
                playHits(combo.hits);
                setTimeout(function () { soloPlaying = false; }, combo.duration);
                return;
            }
        }

        // Schedule streak reset if no follow-up hit within window
        resetTimers[instrument] = setTimeout(function () {
            streaks[instrument] = 0;
        }, STREAK_RESET_MS);

        // Schedule pair buffer reset
        pairResetTimer = setTimeout(function () { pairBuffer = []; }, PAIR_RESET_MS);

        // All-6 combo
        hitSoFar.add(instrument);
        if (hitSoFar.size === ALL_INSTRUMENTS.size) {
            resetAllStreaks();
            resetPairBuffer();
            hitSoFar    = new Set();
            soloPlaying = true;
            showCombo();
            playHits(classicHits);
            setTimeout(function () { soloPlaying = false; }, 4500);
        }
    }

    // Splash solo (called from splash button in index.html)
    window.playSplashSolo = function () {
        if (soloPlaying) return;
        soloPlaying = true;
        playHits(classicHits);
        setTimeout(function () { soloPlaying = false; }, 4500);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // ─── WebGL update + draw functions ────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    function updateAndDrawBgShapes(dt) {
        var alive = [];
        for (var i = 0; i < bgShapes.length; i++) {
            var s = bgShapes[i];
            s.age += dt;
            if (s.age >= s.life) continue;
            alive.push(s);

            var t       = s.age / s.life;
            var fadeIn  = t < 0.15 ? t / 0.15 : 1;
            var alpha   = 0.22 * fadeIn * (1 - t);
            var scale   = 0.3 + 0.8 * t;
            s.rotation += s.rotSpeed * dt;

            var rgb = hexToRGB(s.color);
            emitRotatedBgShape(s.shape, s.x, s.y, s.size * scale, s.rotation,
                               rgb[0], rgb[1], rgb[2], alpha);
        }
        bgShapes = alive;
    }

    function updateAndDrawInstruments(dt, bgTime) {
        for (var i = 0; i < INSTRUMENTS.length; i++) {
            var name = INSTRUMENTS[i];
            var st   = istate[name];
            var cell = findCell(name);
            if (!cell) continue;

            // Advance animation state
            if (SPIN_SET.has(name)) {
                st.rotation += (Math.PI * 2 / 5) * dt;
            } else {
                st.pulsePhase += Math.PI * 2 * dt;
            }
            if (st.hitScale > 1) {
                st.hitScale = Math.max(1, st.hitScale - dt / 0.15);
            }

            // Looping glow quad + border drawn via flat program
            if (st.looping) {
                var glowT  = (Math.sin(bgTime * Math.PI / 0.6) + 1) * 0.5;
                var alpha  = 0.08 + 0.12 * glowT;
                flatQuad(cell.x, cell.y, cell.x + cell.w, cell.y + cell.h,
                         1, 1, 1, alpha);

                var bAlpha = 0.25 + 0.35 * glowT;
                var lw = 4;
                // Border as four thin quads
                flatQuad(cell.x + 2,          cell.y + 2,          cell.x + cell.w - 2, cell.y + 2 + lw,      1, 1, 1, bAlpha);
                flatQuad(cell.x + 2,          cell.y + cell.h - 2 - lw, cell.x + cell.w - 2, cell.y + cell.h - 2, 1, 1, 1, bAlpha);
                flatQuad(cell.x + 2,          cell.y + 2 + lw,     cell.x + 2 + lw,     cell.y + cell.h - 2 - lw, 1, 1, 1, bAlpha);
                flatQuad(cell.x + cell.w - 2 - lw, cell.y + 2 + lw, cell.x + cell.w - 2, cell.y + cell.h - 2 - lw, 1, 1, 1, bAlpha);
            }

            var imgSize = Math.min(cell.w, cell.h) * 0.88;
            var rotation = 0;
            var scale = st.hitScale;

            if (SPIN_SET.has(name)) {
                rotation = st.rotation;
            } else {
                var pScale = 1 + 0.025 * Math.sin(st.pulsePhase);
                scale *= pScale;
            }

            var tex = textures[name];
            if (tex) {
                drawTexturedQuadRotated(tex, cell.cx, cell.cy, imgSize * scale, rotation);
            }
        }
    }

    function updateAndDrawSparkles(dt) {
        var alive = [];
        for (var i = 0; i < sparkles.length; i++) {
            var s = sparkles[i];
            s.age += dt;
            if (s.age >= s.life) continue;
            alive.push(s);

            var t       = s.age / s.life;
            var opacity = 1 - t;
            var scl     = 1 - 0.7 * t;
            var x       = s.ox + s.dx * t;
            var y       = s.oy + s.dy * t;

            var rgb = hexToRGB(s.color);
            emitSparkleGeometry(s.shape, x, y, (s.size / 2) * scl,
                                rgb[0], rgb[1], rgb[2], opacity);
        }
        sparkles = alive;
    }

    function updateAndDrawRings(dt) {
        var alive = [];
        for (var i = 0; i < rings.length; i++) {
            var r = rings[i];
            r.age += dt;
            var effectiveAge = r.age - r.delay;
            if (effectiveAge < 0) { alive.push(r); continue; }
            if (effectiveAge >= r.life) continue;
            alive.push(r);

            var t       = effectiveAge / r.life;
            var radius  = 10 + 190 * t;
            var opacity = 0.9 * (1 - t);
            var rgb     = hexToRGB(r.color);
            flatRing(r.cx, r.cy, radius, 4, rgb[0], rgb[1], rgb[2], opacity);
        }
        rings = alive;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ─── Render loop ─────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    var bgTime = 0;
    var lastTs = 0;

    function frame(ts) {
        requestAnimationFrame(frame);

        var dt = Math.min((ts - lastTs) / 1000, 0.1);
        lastTs  = ts;
        bgTime += dt;

        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        drawBackground(bgTime);
        drawDividers();

        flatReset();
        updateAndDrawBgShapes(dt);
        updateAndDrawInstruments(dt, bgTime);
        updateAndDrawSparkles(dt);
        updateAndDrawRings(dt);
        flatFlush();
    }

    // ─── Initialisation ───────────────────────────────────────────────────────
    resizeCanvas();
    initBgProgram();
    initFlatProgram();
    initTexProgram();
    initAudio();

    window.addEventListener('resize', resizeCanvas);

    document.getElementById('bpm-down').addEventListener('click', function (e) {
        e.stopPropagation();
        setBpm(bpm - 10);
    });
    document.getElementById('bpm-up').addEventListener('click', function (e) {
        e.stopPropagation();
        setBpm(bpm + 10);
    });
    document.getElementById('reverb-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        setReverb(!reverbEnabled);
    });

    loadTextures(function () {
        requestAnimationFrame(frame);
    });

}());
