// Metro config for using the linked kit (`"commskit": "file:../../mobile"`, a symlink in node_modules).
// https://docs.expo.dev/guides/customizing-metro/
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const kitRoot = path.resolve(projectRoot, "../../mobile");
// Path -> regex source that matches it with either separator (Windows or POSIX).
const SEP = String.raw`[\\/]`;
const pathPattern = (p) =>
  p
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(SEP);

const config = getDefaultConfig(projectRoot);

// 1. Watch the kit's TypeScript source (it lives outside this project; node_modules/commskit is a symlink).
config.watchFolders = [...(config.watchFolders || []), kitRoot];

// 2. Resolve the kit's own imports (react, react-native, optional peers) from THIS app's node_modules.
//    The kit folder has its own node_modules (react, test tooling) for its unit tests; hide it so the
//    bundle never contains a second copy of React.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
const kitNodeModules = new RegExp(`^${pathPattern(path.join(kitRoot, "node_modules"))}${SEP}.*$`);
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  kitNodeModules,
];

// 3. Package exports ("commskit/chat", "commskit/call", ...) are on by default in SDK 54; keep it explicit.
config.resolver.unstable_enablePackageExports = true;

// 4. The kit lazily require()s optional peers inside try/catch. Every peer is installed here, so this
//    is only a safety net (Expo already defaults it to true).
config.transformer.allowOptionalDependencies = true;

// 5. allowOptionalDependencies only covers a require() written directly inside a try block. Some kit
//    peers are required through a helper (`load(key, () => require("expo-av"))` in
//    chat-ui/optionalPeers.ts), which Metro treats as a hard dependency. For those optional peers that
//    are NOT installed here (expo-av: deprecated in SDK 54, expo-audio is used instead), resolve to an
//    empty module; the kit's getters then report the feature as unavailable.
const OPTIONAL_KIT_PEERS = new Set([
  "react-native-gesture-handler",
  "expo-haptics",
  "expo-clipboard",
  "expo-video",
  "expo-audio",
  "expo-av",
  "expo-file-system",
  "expo-file-system/legacy",
  "expo-sharing",
  "expo-media-library",
  "expo-linear-gradient",
  "@react-native-async-storage/async-storage",
  "react-native-safe-area-context",
]);
const kitSrc = path.join(kitRoot, "src");
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolve || context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (OPTIONAL_KIT_PEERS.has(moduleName) && path.resolve(context.originModulePath).startsWith(kitSrc)) {
      return { type: "empty" };
    }
    throw error;
  }
};

module.exports = config;
