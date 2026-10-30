/**
 * Video and audio playback on optional peers (lazily loaded through optionalPeers.ts):
 * - VideoPlayerModal: full-screen expo-video player. Without expo-video ChatScreen opens the
 *   URL with Linking instead (see `inAppVideoAvailable`).
 * - AudioMessageRow: play / pause row via expo-audio, else expo-av. `audioPlaybackAvailable()`
 *   is false without both, and MessageBubble shows the file card.
 */
import { slot } from "../theme";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Modal, Text, View } from "react-native";
import { Icon, ScalePressable, useSafeInsets, useTheme, type EdgeInsets } from "../theme";
import { formatMediaDuration } from "./messageActions";
import { getExpoAudio, getExpoAv, getVideo } from "./optionalPeers";
import { textStyle } from "./primitives";

export const inAppVideoAvailable = (): boolean => !!getVideo();
export const audioPlaybackAvailable = (): boolean => !!(getExpoAudio() || getExpoAv());

export interface VideoPlayerModalProps {
  /** Video to play; null hides the player. */
  uri: string | null;
  onClose: () => void;
  insets?: Partial<EdgeInsets>;
}

/** Full-screen video player (expo-video, native controls). Renders nothing without expo-video. */
export const DefaultVideoPlayerModal = memo(function VideoPlayerModal({ uri, onClose, insets }: VideoPlayerModalProps) {
  const theme = useTheme();
  const safe = useSafeInsets(insets);
  const video = getVideo();
  if (!uri || !video) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={["portrait", "landscape"]}>
      <View style={{ flex: 1, backgroundColor: theme.colors.callBackgroundStart }} accessibilityViewIsModal>
        <ExpoVideo video={video} uri={uri} />
        <ScalePressable
          onPress={onClose}
          accessibilityLabel="Close video"
          style={{
            position: "absolute",
            top: safe.top + theme.space.sm,
            right: safe.right + theme.space.sm,
            width: theme.layout.tapTarget,
            height: theme.layout.tapTarget,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.callControl,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="close" size={theme.font.size.title} color={theme.colors.callText} />
        </ScalePressable>
      </View>
    </Modal>
  );
});

const ExpoVideo = ({ video, uri }: { video: any; uri: string }) => {
  const player = video.useVideoPlayer(uri, (p: any) => {
    try {
      p.play();
    } catch {
      // ignore
    }
  });
  const VideoView = video.VideoView;
  return <VideoView player={player} style={{ flex: 1 }} nativeControls allowsFullscreen allowsPictureInPicture contentFit="contain" accessibilityLabel="Video player" />;
};

export interface AudioMessageRowProps {
  uri: string;
  /** Seconds (message.duration), shown until playback reports one. */
  duration?: number | null;
  /** Foreground / muted colours from the bubble. */
  color: string;
  mutedColor: string;
  label?: string;
}

/** Play / pause + duration for an audio message (expo-audio, else expo-av). */
export const DefaultAudioMessageRow = memo(function AudioMessageRow(props: AudioMessageRowProps) {
  const audio = getExpoAudio();
  if (audio) return <ExpoAudioRow audio={audio} {...props} />;
  const av = getExpoAv();
  if (av) return <ExpoAvRow av={av} {...props} />;
  return null;
});

const AudioRowView = ({ playing, onToggle, position, duration, color, mutedColor, label }: { playing: boolean; onToggle: () => void; position: number; duration: number | null | undefined } & Omit<AudioMessageRowProps, "uri" | "duration">) => {
  const theme = useTheme();
  const time = formatMediaDuration(playing || position > 0 ? position : duration);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minWidth: 180 }}>
      <ScalePressable
        onPress={onToggle}
        accessibilityLabel={playing ? "Pause audio" : "Play audio"}
        style={{
          width: theme.layout.tapTarget,
          height: theme.layout.tapTarget,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={textStyle(theme, "body", theme.colors.onAccent, "semibold")}>{playing ? "❚❚" : "▶"}</Text>
      </ScalePressable>
      <View style={{ marginLeft: theme.space.sm, flexShrink: 1 }}>
        <Text style={textStyle(theme, "small", color, "semibold")} numberOfLines={1}>
          {label || "Audio"}
        </Text>
        {time ? <Text style={textStyle(theme, "caption", mutedColor)}>{time}</Text> : null}
      </View>
    </View>
  );
};

const ExpoAudioRow = ({ audio, uri, duration, ...rest }: AudioMessageRowProps & { audio: any }) => {
  const player = audio.useAudioPlayer({ uri });
  const status = typeof audio.useAudioPlayerStatus === "function" ? audio.useAudioPlayerStatus(player) : null;
  const playing = !!(status ? status.playing : player?.playing);
  const toggle = useCallback(() => {
    try {
      if (playing) player.pause();
      else {
        if (status?.didJustFinish || (status?.duration && status.currentTime >= status.duration - 0.05)) player.seekTo(0);
        player.play();
      }
    } catch {
      // ignore
    }
  }, [player, playing, status]);
  return <AudioRowView playing={playing} onToggle={toggle} position={status?.currentTime || 0} duration={status?.duration || duration} {...rest} />;
};

const ExpoAvRow = ({ av, uri, duration, ...rest }: AudioMessageRowProps & { av: any }) => {
  const sound = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  useEffect(
    () => () => {
      const s = sound.current;
      sound.current = null;
      if (s) void Promise.resolve(s.unloadAsync()).catch(() => undefined);
    },
    [],
  );
  const toggle = useCallback(async () => {
    try {
      if (!sound.current) {
        const { sound: s } = await av.Audio.Sound.createAsync({ uri }, { shouldPlay: true }, (st: any) => {
          if (!st?.isLoaded) return;
          setPlaying(!!st.isPlaying);
          setPosition((st.positionMillis || 0) / 1000);
          if (st.durationMillis) setLength(st.durationMillis / 1000);
          if (st.didJustFinish) void s.setPositionAsync?.(0);
        });
        sound.current = s;
        return;
      }
      if (playing) await sound.current.pauseAsync();
      else await sound.current.playAsync();
    } catch {
      setPlaying(false);
    }
  }, [av, uri, playing]);
  return <AudioRowView playing={playing} onToggle={() => void toggle()} position={position} duration={length ?? duration} {...rest} />;
};

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const VideoPlayerModal = slot("VideoPlayerModal", DefaultVideoPlayerModal);
export const AudioMessageRow = slot("AudioMessageRow", DefaultAudioMessageRow);
