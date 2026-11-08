// Микрофон пульта на Android TV.
//
// Встроенного микрофона у ТВ нет, а пульт отдаёт звук только записи на
// 16 кГц, открытой после нажатия его кнопки. WebView так писать не умеет
// (получает нули), поэтому пишет Kotlin (PlayerPlugin, «Микрофон пульта»)
// и присылает сюда кусочки по 40 мс: window.__bhRemotePcm(base64 PCM16 моно).
// Здесь из них собирается обычная звуковая дорожка, и голосовой чат
// отправляет её друзьям вместо микрофона (voice.ts).

import { invoke } from "@tauri-apps/api/core";

/** Частота звука от пульта. */
const RATE = 16000;

// AudioWorklet: кольцевой буфер. Начинаем играть, накопив 100 мс (чтобы
// неровно приходящие кусочки не рвали звук); накопилось больше 400 мс —
// выкидываем старое, чтобы голос не отставал. 16 кГц → частота контекста
// (обычно 48 кГц) — линейной интерполяцией.
const WORKLET = `
const RATE = ${RATE};
const START = RATE / 10;
const MAX = RATE * 0.4;
class RemoteMicSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(RATE * 2);
    this.r = 0; this.w = 0; this.n = 0; this.frac = 0; this.playing = false;
    this.step = RATE / sampleRate;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === "reset") { this.r = this.w = this.n = 0; this.frac = 0; this.playing = false; return; }
      const cap = this.buf.length;
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % cap; }
      this.n += d.length;
      if (this.n > MAX) {
        const drop = this.n - START;
        this.r = (this.r + drop) % cap;
        this.n = START;
        this.frac = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const cap = this.buf.length;
    if (!this.playing && this.n >= START) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.n < 2) {
        out[i] = 0;
        if (this.playing) this.playing = false;
        continue;
      }
      const a = this.buf[this.r];
      const b = this.buf[(this.r + 1) % cap];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this.r = (this.r + 1) % cap; this.n--; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("bh-remote-mic", RemoteMicSink);
`;

type Listener = (on: boolean, error: string | null) => void;

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let ready: Promise<void> | null = null;
let dest: MediaStreamAudioDestinationNode | null = null;
let active = false;
const listeners = new Set<Listener>();

function log(message: string) {
  invoke("ui_log", { message: `микрофон пульта: ${message}` }).catch(() => {});
}

/** Пульт сейчас передаёт звук (запись идёт). */
export function remoteMicActive(): boolean {
  return active;
}

/** Подписка на включение/выключение микрофона пульта. Возвращает отписку. */
export function onRemoteMic(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Выключить микрофон пульта (из интерфейса). */
export function stopRemoteMic() {
  invoke("mobile_remote_mic", { on: false }).catch(() => {});
}

/** Подготовить звук заранее (при подключении к голосу на ТВ). */
export function prepareRemoteMic(): Promise<void> {
  ready ??= (async () => {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    node = new AudioWorkletNode(ctx, "bh-remote-mic", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    wake();
    log(`звук ${ctx.state}, ${ctx.sampleRate} Гц`);
  })().catch((err) => {
    ready = null;
    log(`не подготовился: ${err}`);
    throw err;
  });
  return ready;
}

/** Будим AudioContext: при любом нажатии, пока не проснётся. */
function wake() {
  const c = ctx;
  if (!c || c.state === "running") return;
  c.resume().catch(() => {});
  const again = () => {
    c.resume()
      .then(() => {
        if (c.state !== "running") return;
        window.removeEventListener("keydown", again, true);
        window.removeEventListener("pointerdown", again, true);
      })
      .catch(() => {});
  };
  window.addEventListener("keydown", again, true);
  window.addEventListener("pointerdown", again, true);
}

/**
 * Дорожка со звуком пульта для голосового чата. Пока пульт молчит — в ней
 * тишина. Остановленную (после выхода из голоса) заменяем новой.
 */
export async function remoteMicTrack(): Promise<MediaStreamTrack> {
  await prepareRemoteMic();
  const c = ctx!;
  const current = dest?.stream.getAudioTracks()[0];
  if (current && current.readyState === "live") return current;
  if (dest) node!.disconnect(dest);
  dest = c.createMediaStreamDestination();
  node!.connect(dest);
  return dest.stream.getAudioTracks()[0];
}

// ----- Вызовы из Kotlin -----

type RemoteMicWindow = {
  __bhRemoteMic?: (on: boolean, error: string | null) => void;
  __bhRemotePcm?: (b64: string) => void;
};
const w = window as unknown as RemoteMicWindow;

w.__bhRemoteMic = (on, error) => {
  active = on;
  node?.port.postMessage("reset");
  if (on) ctx?.resume().catch(() => {});
  log(on ? "включён" : `выключен${error ? `: ${error}` : ""}`);
  listeners.forEach((cb) => cb(on, error));
};

w.__bhRemotePcm = (b64) => {
  if (!node || !active) return;
  const bin = atob(b64);
  const n = bin.length >> 1;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    pcm[i] = v / 32768;
  }
  node.port.postMessage(pcm, [pcm.buffer]);
};
