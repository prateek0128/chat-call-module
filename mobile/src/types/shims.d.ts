/**
 * Minimal ambient declarations used ONLY when type-checking this package on its own
 * (tsconfig.json includes this folder; it is excluded from the published "files").
 *
 * In a host React Native app these come from the real packages / RN globals, and
 * the kit's source only uses the subset declared here, so both environments agree.
 */

// RN / Metro provide a CommonJS `require` (used for lazy optional peer deps).
declare function require(id: string): any;

// Timers + console exist in every RN/Hermes/Node runtime but not in lib ES2020.
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): any;
declare function clearTimeout(handle: any): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): any;
declare function clearInterval(handle: any): void;
declare const console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
};

// fetch (RN global). Only the members the kit uses.
interface ShimResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}
declare function fetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ShimResponse>;

declare module "react-native" {
  import type { Component, ComponentType, ReactElement, ReactNode, Ref } from "react";

  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: {
    currentState: AppStateStatus;
    addEventListener(
      type: "change",
      listener: (state: AppStateStatus) => void,
    ): { remove(): void };
  };

  // ---------------------------------------------------------------------------
  // UI kit subset (theme / chat-ui / call-ui). Declared no looser than the real
  // react-native types for the props the kit passes, so code that checks here
  // also checks in a host app.
  // ---------------------------------------------------------------------------

  export interface EmitterSubscription {
    remove(): void;
  }

  // ---- styles ----
  type Falsy = undefined | null | false;
  interface RecursiveArray<T> extends Array<T | ReadonlyArray<T> | RecursiveArray<T>> {}
  export type StyleProp<T> = T | RecursiveArray<T | Falsy> | Falsy;
  export type DimensionValue = number | "auto" | `${number}%`;
  export type ColorValue = string;

  type TransformEntry =
    | { scale: number }
    | { translateX: number }
    | { translateY: number }
    | { rotate: string };

  export interface FlexStyle {
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    alignSelf?: "auto" | "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
    flex?: number;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexShrink?: number;
    flexGrow?: number;
    flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
    gap?: number;
    position?: "absolute" | "relative";
    top?: DimensionValue;
    bottom?: DimensionValue;
    left?: DimensionValue;
    right?: DimensionValue;
    width?: DimensionValue;
    height?: DimensionValue;
    minWidth?: DimensionValue;
    minHeight?: DimensionValue;
    maxWidth?: DimensionValue;
    maxHeight?: DimensionValue;
    margin?: DimensionValue;
    marginTop?: DimensionValue;
    marginBottom?: DimensionValue;
    marginLeft?: DimensionValue;
    marginRight?: DimensionValue;
    marginHorizontal?: DimensionValue;
    marginVertical?: DimensionValue;
    padding?: DimensionValue;
    paddingTop?: DimensionValue;
    paddingBottom?: DimensionValue;
    paddingLeft?: DimensionValue;
    paddingRight?: DimensionValue;
    paddingHorizontal?: DimensionValue;
    paddingVertical?: DimensionValue;
    zIndex?: number;
    overflow?: "visible" | "hidden" | "scroll";
  }

  export interface ViewStyle extends FlexStyle {
    backgroundColor?: ColorValue;
    opacity?: number;
    borderRadius?: number;
    borderTopLeftRadius?: number;
    borderTopRightRadius?: number;
    borderBottomLeftRadius?: number;
    borderBottomRightRadius?: number;
    borderWidth?: number;
    borderColor?: ColorValue;
    borderTopWidth?: number;
    borderTopColor?: ColorValue;
    borderBottomWidth?: number;
    borderBottomColor?: ColorValue;
    borderLeftWidth?: number;
    borderLeftColor?: ColorValue;
    transform?: TransformEntry[];
    shadowColor?: ColorValue;
    shadowOpacity?: number;
    shadowRadius?: number;
    shadowOffset?: { width: number; height: number };
    elevation?: number;
  }

  export type FontVariant = "small-caps" | "oldstyle-nums" | "lining-nums" | "tabular-nums" | "proportional-nums";

  export interface TextStyle extends ViewStyle {
    color?: ColorValue;
    fontSize?: number;
    lineHeight?: number;
    fontFamily?: string;
    fontWeight?: "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";
    fontStyle?: "normal" | "italic";
    fontVariant?: FontVariant[];
    textAlign?: "auto" | "left" | "right" | "center" | "justify";
    textAlignVertical?: "auto" | "top" | "bottom" | "center";
  }

  export interface ImageStyle extends FlexStyle {
    backgroundColor?: ColorValue;
    borderRadius?: number;
    opacity?: number;
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    tintColor?: ColorValue;
    position?: "absolute" | "relative";
  }

  type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };
  interface AbsoluteFillStyle {
    position: "absolute";
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
  }
  export const StyleSheet: {
    create<T extends NamedStyles<T> | NamedStyles<any>>(styles: T & NamedStyles<any>): T;
    hairlineWidth: number;
    absoluteFill: AbsoluteFillStyle;
    absoluteFillObject: AbsoluteFillStyle;
  };

  // ---- events ----
  export interface NativeSyntheticEvent<T> {
    nativeEvent: T;
  }
  export interface LayoutChangeEvent {
    nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
  }
  export interface NativeScrollEvent {
    contentOffset: { x: number; y: number };
    contentSize: { width: number; height: number };
    layoutMeasurement: { width: number; height: number };
  }
  export interface TextInputContentSizeChangeEventData {
    contentSize: { width: number; height: number };
  }
  export interface GestureResponderEvent {
    nativeEvent: unknown;
  }

  // ---- accessibility ----
  export type AccessibilityRole =
    | "none"
    | "button"
    | "link"
    | "search"
    | "image"
    | "imagebutton"
    | "text"
    | "header"
    | "summary"
    | "alert"
    | "switch"
    | "progressbar"
    | "adjustable"
    | "radio"
    | "radiogroup"
    | "menu"
    | "menuitem";
  export interface AccessibilityState {
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    busy?: boolean;
    expanded?: boolean;
  }
  export interface Insets {
    top?: number;
    left?: number;
    bottom?: number;
    right?: number;
  }
  export interface AccessibilityValue {
    min?: number;
    max?: number;
    now?: number;
    text?: string;
  }
  export interface AccessibilityActionInfo {
    name: string;
    label?: string;
  }
  export type AccessibilityActionEvent = NativeSyntheticEvent<{ actionName: string }>;
  interface AccessibilityProps {
    accessible?: boolean;
    accessibilityValue?: AccessibilityValue;
    accessibilityActions?: ReadonlyArray<AccessibilityActionInfo>;
    onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityRole?: AccessibilityRole;
    accessibilityState?: AccessibilityState;
    accessibilityLiveRegion?: "none" | "polite" | "assertive";
    accessibilityViewIsModal?: boolean;
    importantForAccessibility?: "auto" | "yes" | "no" | "no-hide-descendants";
    testID?: string;
  }

  // ---- components ----
  export interface ViewProps extends AccessibilityProps {
    style?: StyleProp<ViewStyle>;
    pointerEvents?: "box-none" | "none" | "box-only" | "auto";
    onLayout?: (event: LayoutChangeEvent) => void;
    children?: ReactNode;
  }
  export const View: ComponentType<ViewProps>;

  export interface TextProps extends AccessibilityProps {
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    allowFontScaling?: boolean;
    selectable?: boolean;
    children?: ReactNode;
  }
  export const Text: ComponentType<TextProps>;

  export interface ImageProps extends AccessibilityProps {
    source: { uri: string };
    style?: StyleProp<ImageStyle>;
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    onError?: () => void;
    onLoadStart?: () => void;
    onLoad?: () => void;
    onLoadEnd?: () => void;
  }
  export const Image: ComponentType<ImageProps>;

  export interface PressableStateCallbackType {
    readonly pressed: boolean;
  }
  export interface PressableProps extends AccessibilityProps {
    onPress?: ((event: GestureResponderEvent) => void) | null;
    onLongPress?: ((event: GestureResponderEvent) => void) | null;
    onPressIn?: ((event: GestureResponderEvent) => void) | null;
    onPressOut?: ((event: GestureResponderEvent) => void) | null;
    disabled?: boolean | null;
    hitSlop?: Insets | number | null;
    style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    children?: ReactNode | ((state: PressableStateCallbackType) => ReactNode);
  }
  export const Pressable: ComponentType<PressableProps>;

  export interface ScrollViewProps extends ViewProps {
    contentContainerStyle?: StyleProp<ViewStyle>;
    horizontal?: boolean | null;
    showsHorizontalScrollIndicator?: boolean;
    showsVerticalScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | "always" | "never" | "handled";
    bounces?: boolean;
  }
  export const ScrollView: ComponentType<ScrollViewProps>;

  export interface ActivityIndicatorProps extends AccessibilityProps {
    color?: ColorValue;
    size?: "small" | "large" | number;
  }
  export const ActivityIndicator: ComponentType<ActivityIndicatorProps>;

  export interface TextInputProps extends AccessibilityProps {
    value?: string;
    onChangeText?: (text: string) => void;
    onBlur?: () => void;
    onFocus?: () => void;
    placeholder?: string;
    placeholderTextColor?: ColorValue;
    multiline?: boolean;
    maxLength?: number;
    editable?: boolean;
    scrollEnabled?: boolean;
    autoCorrect?: boolean;
    autoCapitalize?: "none" | "sentences" | "words" | "characters";
    returnKeyType?: "done" | "go" | "next" | "search" | "send" | "default";
    clearButtonMode?: "never" | "while-editing" | "unless-editing" | "always";
    underlineColorAndroid?: ColorValue;
    onContentSizeChange?: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
    style?: StyleProp<TextStyle>;
  }
  export const TextInput: ComponentType<TextInputProps>;

  export interface ModalProps {
    visible?: boolean;
    transparent?: boolean;
    animationType?: "none" | "slide" | "fade";
    presentationStyle?: "fullScreen" | "pageSheet" | "formSheet" | "overFullScreen";
    statusBarTranslucent?: boolean;
    supportedOrientations?: Array<"portrait" | "portrait-upside-down" | "landscape" | "landscape-left" | "landscape-right">;
    onRequestClose?: () => void;
    children?: ReactNode;
  }
  export const Modal: ComponentType<ModalProps>;

  export interface KeyboardAvoidingViewProps extends ViewProps {
    behavior?: "height" | "position" | "padding";
    keyboardVerticalOffset?: number;
    enabled?: boolean;
  }
  export const KeyboardAvoidingView: ComponentType<KeyboardAvoidingViewProps>;

  export interface ViewToken<ItemT = any> {
    item: ItemT;
    key: string;
    index: number | null;
    isViewable: boolean;
  }
  export interface ListRenderItemInfo<ItemT> {
    item: ItemT;
    index: number;
  }
  export interface FlatListProps<ItemT> extends AccessibilityProps {
    data: ReadonlyArray<ItemT> | null | undefined;
    renderItem: (info: ListRenderItemInfo<ItemT>) => ReactElement | null;
    keyExtractor?: (item: ItemT, index: number) => string;
    getItemLayout?: (data: ArrayLike<ItemT> | null | undefined, index: number) => { length: number; offset: number; index: number };
    extraData?: unknown;
    inverted?: boolean | null;
    ListHeaderComponent?: ReactElement | ComponentType<any> | null;
    ListFooterComponent?: ReactElement | ComponentType<any> | null;
    ListEmptyComponent?: ReactElement | ComponentType<any> | null;
    refreshing?: boolean | null;
    onRefresh?: (() => void) | null;
    onEndReached?: ((info: { distanceFromEnd: number }) => void) | null;
    onEndReachedThreshold?: number | null;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollToIndexFailed?: (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => void;
    scrollEventThrottle?: number;
    onViewableItemsChanged?: ((info: { viewableItems: Array<ViewToken<ItemT>>; changed: Array<ViewToken<ItemT>> }) => void) | null;
    viewabilityConfig?: { itemVisiblePercentThreshold?: number; viewAreaCoveragePercentThreshold?: number; minimumViewTime?: number; waitForInteraction?: boolean };
    maintainVisibleContentPosition?: { minIndexForVisible: number; autoscrollToTopThreshold?: number | null } | null;
    keyboardShouldPersistTaps?: boolean | "always" | "never" | "handled";
    keyboardDismissMode?: "none" | "interactive" | "on-drag";
    initialNumToRender?: number | null;
    maxToRenderPerBatch?: number | null;
    windowSize?: number | null;
    removeClippedSubviews?: boolean;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    ref?: Ref<FlatList<ItemT>>;
  }
  export class FlatList<ItemT = any> extends Component<FlatListProps<ItemT>> {
    scrollToOffset(params: { offset: number; animated?: boolean | null }): void;
    scrollToIndex(params: { index: number; animated?: boolean | null; viewOffset?: number; viewPosition?: number }): void;
  }

  // ---- animation ----
  export type AnimatedInterpolation = Animated.AnimatedInterpolation<number>;
  export namespace Animated {
    class AnimatedNode {}
    class AnimatedInterpolation<OutputT extends number | string> extends AnimatedNode {
      private readonly __output?: OutputT;
    }
    interface InterpolationConfig {
      inputRange: number[];
      outputRange: number[] | string[];
      extrapolate?: "extend" | "identity" | "clamp";
    }
    class Value extends AnimatedNode {
      constructor(value: number);
      setValue(value: number): void;
      interpolate<OutputT extends number | string>(config: InterpolationConfig): AnimatedInterpolation<OutputT>;
    }
    interface CompositeAnimation {
      start(callback?: (result: { finished: boolean }) => void): void;
      stop(): void;
      reset(): void;
    }
    interface TimingAnimationConfig {
      toValue: number;
      duration?: number;
      delay?: number;
      easing?: (value: number) => number;
      useNativeDriver: boolean;
    }
    function timing(value: Value, config: TimingAnimationConfig): CompositeAnimation;
    function sequence(animations: CompositeAnimation[]): CompositeAnimation;
    function parallel(animations: CompositeAnimation[]): CompositeAnimation;
    function delay(time: number): CompositeAnimation;
    function loop(animation: CompositeAnimation, config?: { iterations?: number }): CompositeAnimation;

    type Animatable<T> = { [K in keyof T]?: T[K] | AnimatedNode };
    type AnimatedTransform = Array<
      { scale: number | AnimatedNode } | { translateX: number | AnimatedNode } | { translateY: number | AnimatedNode } | { rotate: string | AnimatedNode }
    >;
    type AnimatedViewStyle = Omit<Animatable<ViewStyle>, "transform"> & { transform?: AnimatedTransform };
    type WithAnimatedStyle<P> = Omit<P, "style"> & { style?: StyleProp<AnimatedViewStyle> };
    const View: ComponentType<WithAnimatedStyle<ViewProps>>;
    function createAnimatedComponent<P extends { style?: unknown }>(component: ComponentType<P>): ComponentType<WithAnimatedStyle<P>>;
  }

  // ---- platform / environment ----
  export const Platform: {
    OS: "ios" | "android" | "web" | "windows" | "macos";
    select<T>(spec: { ios?: T; android?: T; native?: T; default?: T }): T | undefined;
  };

  export type ColorSchemeName = "light" | "dark" | null | undefined;
  export function useColorScheme(): ColorSchemeName;

  export interface ScaledSize {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
  }
  export function useWindowDimensions(): ScaledSize;

  export const AccessibilityInfo: {
    isReduceMotionEnabled(): Promise<boolean>;
    addEventListener(eventName: "reduceMotionChanged", handler: (enabled: boolean) => void): EmitterSubscription;
    announceForAccessibility(announcement: string): void;
  };

  export const Linking: {
    openURL(url: string): Promise<any>;
  };
}
