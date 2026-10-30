import { slot } from "../theme";
import { memo, useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { Avatar, useReducedMotion, useTheme } from "../theme";

export interface PulseAvatarProps {
  name?: string | null;
  id?: string | null;
  uri?: string | null;
  size?: number;
  /** Rings expand while true (ringing / calling). */
  pulsing?: boolean;
}

const LOOP_MS = 2000;

/** Large avatar with 2 expanding rings (scale 1 -> 1.7 + fade, 2 s loop). No rings with reduced motion. */
export const DefaultPulseAvatar = memo(function PulseAvatar({ name, id, uri, size = 128, pulsing = false }: PulseAvatarProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;
  const active = pulsing && !reduced;

  useEffect(() => {
    if (!active) {
      rings.forEach((r) => r.setValue(0));
      return;
    }
    const loops = rings.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((i * LOOP_MS) / 2),
          Animated.timing(r, { toValue: 1, duration: LOOP_MS, useNativeDriver: true }),
          Animated.timing(r, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.delay(((1 - i) * LOOP_MS) / 2),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, rings]);

  const box = Math.round(size * 1.8);
  return (
    <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }} accessible={false} importantForAccessibility="no-hide-descendants">
      {active
        ? rings.map((r, i) => (
            <Animated.View
              key={i}
              style={{
                position: "absolute",
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 2,
                borderColor: theme.colors.callTextMuted,
                opacity: r.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }],
              }}
            />
          ))
        : null}
      <Avatar name={name} id={id} uri={uri} size={size} />
    </View>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const PulseAvatar = slot("PulseAvatar", DefaultPulseAvatar);
