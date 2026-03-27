'use strict';

/**
 * Canvas Drum Kit — main.js
 *
 * Replaces all DOM-based animations (instrument spin/pulse, sparkles, rings,
 * looping glow, background gradient) with a single requestAnimationFrame
 * render loop on an HTML <canvas> for significantly better performance.
 *
 * Modals (splash, help) remain as standard HTML overlays.
 * COMBO! text and flash remain as DOM overlays (infrequent, complex animation).
 * Audio playback uses Howler.js (unchanged from original).
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

    // ─── Canvas ───────────────────────────────────────────────────────────────
    const canvas = document.getElementById('drumkit-canvas');
    const ctx    = canvas.getContext('2d');
    let dpr = 1; // set in resizeCanvas
    let W, H;    // logical (CSS-pixel) dimensions

    function resizeCanvas() {
        dpr = window.devicePixelRatio || 1;
        W   = window.innerWidth;
        H   = window.innerHeight;
        canvas.width  = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        computeCells();
    }

    // ─── Grid layout ──────────────────────────────────────────────────────────
    // Mirrors the original CSS grid: 2×3 portrait, 3×2 landscape.
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

    // ─── Audio ────────────────────────────────────────────────────────────────
    var sounds = {};

    function initAudio() {
        INSTRUMENTS.forEach(function (name) {
            sounds[name] = new Howl({ src: ['./audio/' + name + '.mp3'] });
        });
        sounds['monkey'] = new Howl({ src: ['./audio/monkey.mp3'] });
        sounds['pig'] = new Howl({ src: ['./audio/pig.mp3'] });
        sounds['tiger'] = new Howl({ src: ['./audio/tiger.mp3'] });
        sounds['moo'] = new Howl({ src: ['./audio/moo.mp3'] });
        sounds['lion'] = new Howl({ src: ['./audio/lion.mp3'] });
    }

    function playSound(name) {
        if (sounds[name]) sounds[name].play();
    }

    // ─── SVG image loading ────────────────────────────────────────────────────
    var images = {};
    var imagesReady = 0;

    function loadImages(cb) {
        INSTRUMENTS.forEach(function (name) {
            var img = new Image();
            img.onload = function () {
                imagesReady++;
                if (imagesReady === INSTRUMENTS.length) cb();
            };
            img.src = './img/' + name + '.svg';
            images[name] = img;
        });
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

    function drawSparkleShape(context, shape, halfSize) {
        context.beginPath();
        switch (shape) {
            case 'circle':
                context.arc(0, 0, halfSize, 0, Math.PI * 2);
                break;
            case 'diamond':
                context.moveTo(0, -halfSize);
                context.lineTo(halfSize, 0);
                context.lineTo(0, halfSize);
                context.lineTo(-halfSize, 0);
                context.closePath();
                break;
            case 'triangle':
                context.moveTo(0, -halfSize);
                context.lineTo(halfSize, halfSize);
                context.lineTo(-halfSize, halfSize);
                context.closePath();
                break;
            case 'star': {
                var outer = halfSize, inner = halfSize * 0.4;
                for (var j = 0; j < 10; j++) {
                    var r = j % 2 === 0 ? outer : inner;
                    var a = j * Math.PI / 5 - Math.PI / 2;
                    if (j === 0) context.moveTo(Math.cos(a) * r, Math.sin(a) * r);
                    else         context.lineTo(Math.cos(a) * r, Math.sin(a) * r);
                }
                context.closePath();
                break;
            }
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

    function drawBgShape(context, shape, halfSize) {
        context.beginPath();
        switch (shape) {
            case 'circle':
                context.arc(0, 0, halfSize, 0, Math.PI * 2);
                break;
            case 'diamond':
                context.moveTo(0, -halfSize);
                context.lineTo(halfSize, 0);
                context.lineTo(0, halfSize);
                context.lineTo(-halfSize, 0);
                context.closePath();
                break;
            case 'triangle':
                context.moveTo(0, -halfSize);
                context.lineTo(halfSize * 0.866, halfSize * 0.5);
                context.lineTo(-halfSize * 0.866, halfSize * 0.5);
                context.closePath();
                break;
            case 'star': {
                var outer = halfSize, inner = halfSize * 0.45;
                for (var j = 0; j < 10; j++) {
                    var r = j % 2 === 0 ? outer : inner;
                    var a = j * Math.PI / 5 - Math.PI / 2;
                    if (j === 0) context.moveTo(Math.cos(a) * r, Math.sin(a) * r);
                    else         context.lineTo(Math.cos(a) * r, Math.sin(a) * r);
                }
                context.closePath();
                break;
            }
            case 'hexagon': {
                for (var k = 0; k < 6; k++) {
                    var ha = k * Math.PI / 3;
                    if (k === 0) context.moveTo(Math.cos(ha) * halfSize, Math.sin(ha) * halfSize);
                    else         context.lineTo(Math.cos(ha) * halfSize, Math.sin(ha) * halfSize);
                }
                context.closePath();
                break;
            }
        }
    }

    function updateAndDrawBgShapes(dt) {
        var alive = [];
        for (var i = 0; i < bgShapes.length; i++) {
            var s = bgShapes[i];
            s.age += dt;
            if (s.age >= s.life) continue;
            alive.push(s);

            var t       = s.age / s.life;
            var fadeIn  = t < 0.15 ? t / 0.15 : 1;
            var opacity = 0.22 * fadeIn * (1 - t);
            var scale   = 0.3 + 0.8 * t;
            s.rotation += s.rotSpeed * dt;

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle   = s.color;
            ctx.translate(s.x, s.y);
            ctx.rotate(s.rotation);
            ctx.scale(scale, scale);
            drawBgShape(ctx, s.shape, s.size);
            ctx.fill();
            ctx.restore();
        }
        bgShapes = alive;
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

    function findCell(name) {
        for (var i = 0; i < cells.length; i++) {
            if (cells[i].name === name) return cells[i];
        }
        return null;
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
    // ─── Render loop ─────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    var bgTime = 0; // monotonically increasing seconds for background animation

    // Draw the animated gradient background (replaces CSS gradient-shift animation)
    function drawBackground() {
        // Replicate CSS background-position animation: 0%→100%→0% over 8 s
        var p   = (bgTime / 8) % 1;
        var pos = p < 0.5 ? p * 2 : 2 - p * 2; // triangle wave 0→1→0
        var colors = BG_THEMES[bgThemeIndex];

        // Diagonal gradient whose origin slides left/right
        var x0 = W * pos * 0.6;
        var y0 = 0;
        var x1 = W * (1 - pos * 0.4);
        var y1 = H;
        var grd = ctx.createLinearGradient(x0, y0, x1, y1);
        var n = colors.length;
        for (var i = 0; i < n; i++) {
            grd.addColorStop(i / (n - 1), colors[i]);
        }
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);

        // Subtle cell dividers
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth   = 1;
        for (var c = 0; c < cells.length; c++) {
            var cell = cells[c];
            ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
        }
    }

    // Update and draw all six instrument images
    function updateAndDrawInstruments(dt) {
        for (var i = 0; i < INSTRUMENTS.length; i++) {
            var name = INSTRUMENTS[i];
            var st   = istate[name];
            var img  = images[name];
            var cell = findCell(name);
            if (!cell) continue;

            // Advance animation state
            if (SPIN_SET.has(name)) {
                // CSS spin: 5000 ms per full rotation → 2π/5 rad/s
                st.rotation += (Math.PI * 2 / 5) * dt;
            } else {
                // CSS pulse: 1000 ms period
                st.pulsePhase += Math.PI * 2 * dt;
            }

            // Decay hit-scale back to 1.0 over ~150 ms
            if (st.hitScale > 1) {
                st.hitScale = Math.max(1, st.hitScale - dt / 0.15);
            }

            // Looping highlight — pulsing glow behind the instrument
            if (st.looping) {
                var glowT  = (Math.sin(bgTime * Math.PI / 0.6) + 1) * 0.5;
                var alpha  = 0.08 + 0.12 * glowT;
                ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
                ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

                var bAlpha = 0.25 + 0.35 * glowT;
                ctx.strokeStyle = 'rgba(255,255,255,' + bAlpha + ')';
                ctx.lineWidth = 4;
                ctx.strokeRect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4);
            }

            // Image size: match original CSS 88% of the shorter cell dimension
            var imgSize = Math.min(cell.w, cell.h) * 0.88;

            ctx.save();
            ctx.translate(cell.cx, cell.cy);

            if (SPIN_SET.has(name)) {
                ctx.rotate(st.rotation);
            } else {
                // Pulse: scale oscillates 1.0 → 1.025 → 1.0 (gentle; original CSS was 1.0→1.05)
                var pScale = 1 + 0.025 * Math.sin(st.pulsePhase);
                ctx.scale(pScale, pScale);
            }

            // Hit feedback scale (tap response)
            ctx.scale(st.hitScale, st.hitScale);

            ctx.drawImage(img, -imgSize / 2, -imgSize / 2, imgSize, imgSize);
            ctx.restore();
        }
    }

    // Update + draw sparkles (replaces DOM .sparkle elements)
    function updateAndDrawSparkles(dt) {
        var alive = [];
        for (var i = 0; i < sparkles.length; i++) {
            var s = sparkles[i];
            s.age += dt;
            if (s.age >= s.life) continue;
            alive.push(s);

            var t       = s.age / s.life;
            var opacity = 1 - t;
            var scale   = 1 - 0.7 * t;
            var x       = s.ox + s.dx * t;
            var y       = s.oy + s.dy * t;

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle   = s.color;
            ctx.translate(x, y);
            ctx.scale(scale, scale);
            drawSparkleShape(ctx, s.shape, s.size / 2);
            ctx.fill();
            ctx.restore();
        }
        sparkles = alive;
    }

    // Update + draw rings (replaces DOM .ring elements)
    function updateAndDrawRings(dt) {
        var alive = [];
        for (var i = 0; i < rings.length; i++) {
            var r = rings[i];
            r.age += dt;
            var effectiveAge = r.age - r.delay;
            if (effectiveAge < 0) { alive.push(r); continue; }
            if (effectiveAge >= r.life) continue;
            alive.push(r);

            var t      = effectiveAge / r.life;
            // Matches CSS ring-expand: 20px → 400px diameter → use radius 10px → 200px
            var radius  = 10 + 190 * t;
            var opacity = 0.9 * (1 - t);

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.strokeStyle = r.color;
            ctx.lineWidth   = 4;
            ctx.beginPath();
            ctx.arc(r.cx, r.cy, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
        rings = alive;
    }

    // ─── Main rAF loop ────────────────────────────────────────────────────────
    var lastTs = 0;

    function frame(ts) {
        requestAnimationFrame(frame);

        var dt = Math.min((ts - lastTs) / 1000, 0.1); // cap at 100 ms (tab reactivation)
        lastTs  = ts;
        bgTime += dt;

        // Reset transform, clear in physical pixels, then re-apply DPR scale
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        drawBackground();
        updateAndDrawBgShapes(dt);
        updateAndDrawInstruments(dt);
        updateAndDrawSparkles(dt);
        updateAndDrawRings(dt);
    }

    // ─── Initialisation ───────────────────────────────────────────────────────
    resizeCanvas();
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

    loadImages(function () {
        requestAnimationFrame(frame);
    });

}());
