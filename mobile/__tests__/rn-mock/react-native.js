/**
 * Minimal react-native stand-in for the UI render smoke tests (react-native itself is not
 * installed in this package). Components render as host elements named after the RN
 * component so react-test-renderer can find them; APIs are inert. This checks that the UI
 * kit renders, wires props and reacts to state, NOT native layout/behaviour.
 */
const React = require("react");

const host = (name) => {
  const C = React.forwardRef((props, ref) => {
    const { children, ...rest } = props;
    return React.createElement(name, { ...rest, ref }, children);
  });
  C.displayName = name;
  return C;
};

const View = host("View");
const Text = host("Text");
const Image = host("Image");
const TextInput = host("TextInput");
const ActivityIndicator = host("ActivityIndicator");
const KeyboardAvoidingView = host("KeyboardAvoidingView");
const ScrollView = host("ScrollView");

const Pressable = React.forwardRef((props, ref) => {
  const { children, style, ...rest } = props;
  const state = { pressed: false };
  return React.createElement(
    "Pressable",
    { ...rest, ref, style: typeof style === "function" ? style(state) : style },
    typeof children === "function" ? children(state) : children,
  );
});
Pressable.displayName = "Pressable";

const Modal = (props) => (props.visible === false ? null : React.createElement("Modal", { onRequestClose: props.onRequestClose }, props.children));

const renderMaybe = (C) => (!C ? null : React.isValidElement(C) ? C : React.createElement(C));

class FlatList extends React.Component {
  scrollToOffset(params) {
    FlatList.lastScroll = params;
  }
  scrollToIndex(params) {
    FlatList.lastScrollIndex = params;
  }
  render() {
    const p = this.props;
    const data = p.data || [];
    const items = data.map((item, index) =>
      React.createElement(React.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, index) : String(index) }, p.renderItem({ item, index })),
    );
    return React.createElement(
      "FlatList",
      { inverted: p.inverted, accessibilityLabel: p.accessibilityLabel, onEndReached: p.onEndReached, onScroll: p.onScroll, getItemLayout: p.getItemLayout },
      renderMaybe(p.ListHeaderComponent),
      data.length ? items : renderMaybe(p.ListEmptyComponent),
      renderMaybe(p.ListFooterComponent),
    );
  }
}

const composite = () => ({ start: (cb) => cb && cb({ finished: true }), stop: () => {}, reset: () => {} });
class Value {
  constructor(v) {
    this._value = v;
  }
  setValue(v) {
    this._value = v;
  }
  interpolate(config) {
    return { __interpolation: config, __source: this };
  }
}
const Animated = {
  Value,
  View: host("AnimatedView"),
  timing: (value, config) => ({ start: (cb) => (value.setValue(config.toValue), cb && cb({ finished: true })), stop: () => {}, reset: () => {} }),
  sequence: composite,
  parallel: composite,
  delay: composite,
  loop: composite,
  createAnimatedComponent: (C) => C,
};

const announcements = [];
const AccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(false),
  addEventListener: () => ({ remove() {} }),
  announceForAccessibility: (text) => announcements.push(text),
  __announcements: announcements,
};

const absoluteFill = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 };

module.exports = {
  View,
  Text,
  Image,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Pressable,
  Modal,
  FlatList,
  Animated,
  AccessibilityInfo,
  StyleSheet: { create: (s) => s, hairlineWidth: 1, absoluteFill, absoluteFillObject: absoluteFill },
  Platform: { OS: "ios", select: (spec) => spec.ios ?? spec.native ?? spec.default },
  useColorScheme: () => "light",
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  Linking: { openURL: () => Promise.resolve(true) },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
};
