// Короткие звуки интерфейса: микрофон вкл/выкл, кто-то зашёл или вышел.
// Синтезируются на лету (Web Audio), файлов не нужно.

const KEY = "sounds";

let ctx: AudioContext | null = null;

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Не сохранилось — до перезапуска всё равно работает как выбрано.
  }
}

/** Несколько мягких нот подряд. */
function notes(freqs: number[], step = 0.075, length = 0.16, volume = 0.09) {
  if (!soundsEnabled()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const start = ctx.currentTime + 0.01;
    freqs.forEach((freq, i) => {
      const at = start + i * step;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(volume, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + length + 0.02);
    });
  } catch {
    // Нет звука — не страшно.
  }
}

export const sound = {
  micOn: () => notes([587, 880]),
  micOff: () => notes([880, 587]),
  join: () => notes([523, 659, 784], 0.08, 0.22, 0.07),
  leave: () => notes([784, 659, 523], 0.08, 0.22, 0.07),
  /** Ко мне обратились в чате. */
  mention: () => notes([988, 1319], 0.09, 0.2, 0.08),
};
