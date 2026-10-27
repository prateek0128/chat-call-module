/**
 * New-message sound: expo-audio (`createAudioPlayer`) if installed, else expo-av (`Audio.Sound`),
 * else a silent no-op. Pure: no React / react-native.
 */
import { getExpoAudio, getExpoAv } from "./optionalPeers";

/** `require("./assets/message.mp3")` (asset id), `{ uri }` or a URL string. */
export type SoundSource = number | string | { uri: string };

export interface MessageSoundPlayer {
  /** "expo-audio" | "expo-av" | "none". */
  readonly backend: "expo-audio" | "expo-av" | "none";
  play(): void;
  release(): void;
}

const normalise = (source: SoundSource) => (typeof source === "string" ? { uri: source } : source);

export const createMessageSoundPlayer = (source: SoundSource | null | undefined, modules?: { expoAudio?: any; expoAv?: any }): MessageSoundPlayer => {
  if (source == null) return { backend: "none", play() {}, release() {} };
  const audio = modules && "expoAudio" in modules ? modules.expoAudio : getExpoAudio();
  if (audio && typeof audio.createAudioPlayer === "function") {
    let player: any = null;
    return {
      backend: "expo-audio",
      play() {
        try {
          if (!player) player = audio.createAudioPlayer(normalise(source));
          player.seekTo?.(0);
          player.play();
        } catch {
          // a sound must never break chat
        }
      },
      release() {
        try {
          (player?.remove || player?.release)?.call(player);
        } catch {
          // ignore
        }
        player = null;
      },
    };
  }
  const av = modules && "expoAv" in modules ? modules.expoAv : getExpoAv();
  if (av?.Audio?.Sound?.createAsync) {
    let sound: Promise<any> | null = null;
    return {
      backend: "expo-av",
      play() {
        try {
          if (!sound) sound = Promise.resolve(av.Audio.Sound.createAsync(normalise(source))).then((r: any) => r?.sound ?? r);
          void sound.then((s: any) => s?.replayAsync?.()).catch(() => undefined);
        } catch {
          // ignore
        }
      },
      release() {
        const s = sound;
        sound = null;
        void s?.then((x: any) => x?.unloadAsync?.()).catch(() => undefined);
      },
    };
  }
  return { backend: "none", play() {}, release() {} };
};

/** Play only when enabled, not muted and the app is in the foreground. */
export const shouldPlayMessageSound = (i: { enabled?: boolean; muted?: boolean; appActive?: boolean }): boolean =>
  i.enabled !== false && !i.muted && i.appActive !== false;
