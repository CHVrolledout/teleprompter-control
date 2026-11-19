// The "hub" owns the shared teleprompter state and applies commands.
// It has no browser or Node dependencies, so it runs in two places:
//   • inside the iPad page (peer-to-peer mode — no server at all)
//   • inside server.js (Mac/local server mode)

export const SAMPLE = `Welcome to Teleprompter Control.

Open the Prompter on the iPad and the Controller on your phone or laptop.

Press play on the controller and the text starts scrolling here.

While the speaker reads, you can nudge the text up or down, drag it in the preview, change the speed, or make the font bigger — and the iPad follows instantly.

Paste your own script in the Script tab on the controller and press "Send to iPad".`;

export const DEFAULTS = {
  script: SAMPLE,
  fontSize: 64,      // px on the prompter
  lineHeight: 1.4,
  margin: 8,         // % side padding
  align: 'left',
  speed: 2,          // 1 unit = 0.2 lines/sec
  playing: false,
  mirrorX: false,
  mirrorY: false,
  markerPct: 33,     // eye-line position, % from top
  showMarker: true,
  anchor: 0,         // reading position: paragraph index + fraction
  viewport: { w: 1180, h: 820 },
};

const num = (lo, hi) => (v) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const SETTABLE = {
  script: (v) => (typeof v === 'string' ? v.slice(0, 500000) : undefined),
  fontSize: num(16, 240),
  lineHeight: num(0.9, 2.5),
  margin: num(0, 35),
  align: (v) => (v === 'left' || v === 'center' ? v : undefined),
  speed: num(0, 15),
  mirrorX: bool,
  mirrorY: bool,
  markerPct: num(5, 80),
  showMarker: bool,
};

/**
 * @param emit   (event, data, role?) => void  — role: 'prompter' | 'controller' | undefined (both)
 * @param counts () => ({ prompters, controllers })
 * @param save   (state) => void  — called (debounced) after changes
 */
export function createHub({ initial = {}, emit, counts, save = () => {} }) {
  const state = { ...DEFAULTS, ...initial, playing: false };

  let saveTimer = null;
  // Throttled (not debounced): position reports arrive 10x/sec while playing,
  // and a debounce would postpone saving forever.
  const saveSoon = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(state); }, 1000);
  };

  const publicState = () => {
    const { script, ...rest } = state;
    return { ...rest, ...counts() };
  };
  const changed = () => emit('state', publicState());

  function command(cmd) {
    switch (cmd && cmd.type) {
      case 'set': {
        let scriptChanged = false;
        for (const [k, v] of Object.entries(cmd.patch || {})) {
          if (!SETTABLE[k]) continue;
          const clean = SETTABLE[k](v);
          if (clean === undefined) continue;
          if (k === 'script' && clean !== state.script) scriptChanged = true;
          state[k] = clean;
        }
        if (scriptChanged) emit('script', { script: state.script });
        changed();
        saveSoon();
        break;
      }
      case 'play':
      case 'pause':
      case 'toggle':
        state.playing = cmd.type === 'toggle' ? !state.playing : cmd.type === 'play';
        changed();
        break;
      case 'nudge': // { px } in prompter pixels, or { lines }
        emit('cmd', { type: 'nudge', px: Number(cmd.px) || 0, lines: Number(cmd.lines) || 0 }, 'prompter');
        break;
      case 'seek': {
        const a = Number(cmd.anchor);
        if (!isFinite(a)) break;
        state.anchor = Math.max(0, a);
        emit('cmd', { type: 'seek', anchor: state.anchor }, 'prompter');
        emit('pos', { anchor: state.anchor, seek: true }, 'controller');
        saveSoon();
        break;
      }
      case 'top':
        state.playing = false;
        state.anchor = 0;
        emit('cmd', { type: 'seek', anchor: 0 }, 'prompter');
        emit('pos', { anchor: 0, seek: true }, 'controller');
        changed();
        break;
    }
  }

  // Position report from the prompter (it is the authority on scroll position).
  function position(p) {
    if (isFinite(p.anchor)) state.anchor = Math.max(0, p.anchor);
    if (p.vw > 0 && p.vh > 0 && (p.vw !== state.viewport.w || p.vh !== state.viewport.h)) {
      state.viewport = { w: Math.round(p.vw), h: Math.round(p.vh) };
      changed();
    }
    emit('pos', { anchor: state.anchor }, 'controller');
    saveSoon();
  }

  return { state, publicState, changed, command, position };
}
