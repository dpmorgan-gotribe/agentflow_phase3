---
name: expo-rn
description: Prompt pack for the mobile-frontend-builder when architecture.yaml.tooling.stack.mobile_framework=expo-rn. Expo SDK 52 + React Native + Expo Router + NativeWind 4, consuming @repo/ui-kit as tokens + data-kit contract.
stack_tier: mobile
stack_slug: expo-rn
maturity: shipped
authoredAt: 2026-04-22
dependencyPinsRefreshedAt: 2026-04-22
---

# expo-rn — Expo SDK 52 + React Native + Expo Router + NativeWind 4

Stack-skill prompt pack for the mobile-frontend-builder. Loaded when `architecture.yaml.tooling.stack.mobile_framework === "expo-rn"`.

**Component sharing with web**: the kit ships React primitives at `@repo/ui-kit/src/primitives/`. Mobile-native surfaces (touch targets, gestures, safe-area) need platform-specific components. Convention: import a primitive from `@repo/ui-kit`; if it needs platform variance, override in `apps/mobile/components/{name}.native.tsx`. Metro resolves `.native.tsx` on RN, falls back to `.tsx`. Kit's `data-kit-component` + `data-kit-variant` attrs translate to `testID` + accessibility props on RN — see §Gotchas.

## 1. Canonical layout

```
apps/mobile/
├── app/                                  # Expo Router file-based routing
│   ├── _layout.tsx                       # root stack — imports @repo/ui-kit/globals.css via NativeWind
│   ├── index.tsx                         # home — redirects based on auth
│   ├── (auth)/
│   │   ├── _layout.tsx                   # auth group layout
│   │   ├── login.tsx
│   │   └── signup.tsx
│   ├── (tabs)/
│   │   ├── _layout.tsx                   # bottom-tabs layout
│   │   ├── index.tsx                     # dashboard tab
│   │   ├── map.tsx
│   │   ├── progress.tsx
│   │   └── settings.tsx
│   └── [...not-found].tsx                # catch-all 404
├── components/
│   ├── providers.tsx                     # tRPC + QueryClient + SafeAreaProvider + GestureHandler
│   └── ui/                               # .native.tsx platform overrides of kit primitives
│       ├── Button.native.tsx
│       ├── Card.native.tsx
│       └── Drawer.native.tsx
├── lib/
│   ├── trpc-client.ts                    # tRPC client, typed via @repo/api-client
│   ├── auth.ts                           # expo-secure-store + cookie bridge
│   └── cn.ts                             # re-exports kit's cn (works identically on RN)
├── assets/
│   ├── images/
│   └── fonts/
├── app.json                              # Expo config (scheme, bundleIdentifier, plugins)
├── babel.config.js                       # NativeWind + Expo Router plugins
├── metro.config.js                       # workspace monorepo config
├── global.css                            # @tailwind directives + NativeWind preset
├── tailwind.config.ts                    # extends @repo/ui-kit/tokens.css
├── tsconfig.json                         # extends @repo/ui-kit/tsconfig.consumer.json
├── eas.json                              # EAS Build profiles (dev, preview, production)
└── package.json
```

## 2. Idioms

- **Expo Router for navigation.** File-based — `app/(tabs)/map.tsx` becomes a route. `_layout.tsx` files define navigators (stack, tabs, drawer). No imperative `NavigationContainer` / `Stack.Navigator` declarations — those go in `_layout.tsx`.
- **NativeWind className.** Same className syntax as web Tailwind — `<View className="flex-row gap-2 px-4 py-2 bg-primary-500 rounded-lg">`. `className` compiles to `style={...}` at build time.
- **`.native.tsx` overrides.** When a kit primitive needs platform-specific behavior (e.g. `Drawer` uses `react-native-reanimated` gestures on mobile vs CSS transitions on web), write `apps/mobile/components/ui/Drawer.native.tsx`. Metro picks it up; web build falls back to the kit's `Drawer.tsx`.
- **`testID` from `data-kit-*`.** React Native doesn't have HTML `data-*` attrs. The builder converts `data-kit-component="Button"` from HTML screens into `testID="kit-Button"`, `data-kit-variant="primary"` into `accessibilityRole="button"` + `accessibilityHint="primary"`. This preserves the post-build JSX translation contract.
- **Safe areas everywhere.** Use `useSafeAreaInsets()` at every root screen; pad with `paddingTop: insets.top` on headers, `paddingBottom: insets.bottom` on fixed bottom bars.
- **tRPC the same way as web.** Import typed client from `@repo/api-client`; consume via React Query hooks in components. No special mobile variant.
- **Expo secure-store for secrets.** JWT, refresh tokens, biometric-gated values — `expo-secure-store` instead of `AsyncStorage`. Encrypts at rest via iOS Keychain / Android Keystore.
- **Native gestures via react-native-gesture-handler + reanimated.** Drag-to-dismiss drawers, swipe-to-grade on card-study surfaces — these use `Gesture.Pan()` + `useSharedValue()`, not CSS.
- **KeyboardAvoidingView on forms.** Wrap form screens in `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>`.
- **`prefers-reduced-motion` equivalent**: read `useReducedMotion()` from `react-native-reanimated` or `AccessibilityInfo.isReduceMotionEnabled()`. Respect globally.

## 3. Testing

Binds to `feat-004-builder-tdd-hybrid`. Mobile uses jest-expo (RN ecosystem mandates Jest — Vitest doesn't run Metro's transformer).

- **Test-file naming**: `app/(tabs)/map.tsx` → `app/(tabs)/map.test.tsx`; `components/ui/Button.native.tsx` → `components/ui/Button.test.tsx` (co-located, no `.native.` suffix on the test itself).
- **Test runner**: `pnpm --filter @repo/mobile test` (jest-expo); single file `pnpm --filter @repo/mobile test app/map.test.tsx`; coverage `pnpm --filter @repo/mobile test --coverage`.
- **Component tests via `@testing-library/react-native`**:

  ```tsx
  import { render, screen, fireEvent } from "@testing-library/react-native";
  import { Button } from "@/components/ui/Button.native";

  test("calls onPress", () => {
    const onPress = jest.fn();
    render(<Button label="Start" variant="primary" onPress={onPress} />);
    fireEvent.press(screen.getByRole("button", { name: "Start" }));
    expect(onPress).toHaveBeenCalled();
  });
  ```

- **Mocking patterns**:
  - Mock `expo-router` via `jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }))`.
  - Mock `expo-secure-store`: `jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }))`.
  - Mock tRPC via `@repo/api-client/test-utils`'s `mockTrpcClient()`.
  - Mock `react-native-reanimated`: `jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"))`.
- **Coverage expectation**: 60% builder / 80% total.
- **E2E via Maestro** (tester-owned): YAML flows at `apps/mobile/.maestro/*.yaml`; runner `maestro test .maestro/login-flow.yaml`. Builders do NOT write Maestro tests — tester does.

## 4. Commands

```
lint:      pnpm --filter @repo/mobile lint
typecheck: pnpm --filter @repo/mobile typecheck
test:      pnpm --filter @repo/mobile test
build:     pnpm --filter @repo/mobile build      # eas build --platform all --profile preview
dev:       pnpm --filter @repo/mobile start      # expo start (Metro dev server)
prebuild:  pnpm --filter @repo/mobile prebuild   # generates native ios/android/ dirs (if needed)
```

Builder self-verify gate: `pnpm --filter @repo/mobile lint && pnpm --filter @repo/mobile typecheck && pnpm --filter @repo/mobile test`.

EAS Build for production artifacts — requires `eas.json` + an EAS account. In refactor-003, architect emits `eas.json` at gate 5 with three profiles (dev / preview / production); the actual `eas build` runs in CI, not in the builder.

## 5. Gotchas

- **Metro monorepo config**. Workspace packages don't resolve out of the box — `metro.config.js` needs `config.watchFolders = [monorepoRoot]` + `nodeModulesPaths` set to include monorepo-root `node_modules`. Expo's `createExpoMetroConfig` partially handles this but double-check paths.
- **NativeWind 4 vs 2**. NativeWind v4 uses a different compilation strategy (build-time CSS → JS) and breaks if `babel.config.js` still has the old v2 plugin. Use `nativewind/babel` as a preset, not a plugin.
- **`.native.tsx` resolution only fires on RN**. Web (Next, Vite) ignores it. If you only ship `.native.tsx` for a component and import from web, you get "module not found". Always ship a base `.tsx` + optionally a `.native.tsx` override.
- **Safe-area-inset 0 on Android before SDK 52**. Android < API 35 returns `insets.top = 0` from `useSafeAreaInsets()` when the status bar is translucent. Set `<StatusBar translucent={false} />` OR use `edge-to-edge` mode (Android 15+) with Expo SDK 52+.
- **iOS keyboard doesn't dismiss on tap-outside by default**. Wrap screens with interactive forms in `TouchableWithoutFeedback` + `Keyboard.dismiss()` or use `react-native-keyboard-aware-scroll-view`.
- **`react-native-reanimated` requires babel plugin**. Missing `"react-native-reanimated/plugin"` at the END of plugins array → runtime error "Reanimated 2 failed to create a worklet". Plugin MUST be last.
- **Expo Router + dynamic routes**. `app/posts/[id].tsx` with `useLocalSearchParams()` returns `string | string[]` — guard with `Array.isArray()`. Passing the raw value to a tRPC query will fail typecheck.
- **SecureStore size limit**. iOS Keychain items ≤ 4KB per key. Large JWT refresh tokens (>4KB) need splitting or AsyncStorage fallback (unencrypted, lower-value).
- **EAS update channels vs release channels**. `channels` (new) replaces `release-channels` (old). Mixing the two in `eas.json` causes OTA updates to fail silently. Pick one.
- **`react-native` vs `react-native-web`**. The `.native.tsx` resolution handles native; web side needs `react-native-web` aliased in Vite / Webpack. Not relevant for a pure mobile app; relevant if `apps/web` also consumes RN primitives.

## Review

Stack-specific checks the reviewer agent runs IN ADDITION to `docs/reviewer-playbook.md`'s generic 7 dimensions. Scope: files in the feature's diff under `apps/mobile/`.

#### security — secrets via SecureStore, not AsyncStorage

- **Invocation**: `grep -rnE "AsyncStorage\.(setItem|getItem)" apps/mobile/` → cross-reference each match against the key name: any key containing `token`, `secret`, `jwt`, `refresh`, `password`, `pin` is a fail
- **Threshold**: sensitive keys must use `expo-secure-store`'s `SecureStore.setItemAsync` / `getItemAsync` (iOS Keychain / Android EncryptedSharedPreferences); AsyncStorage is unencrypted plaintext
- **Retry target**: mobile-frontend-builder
- **Playbook §**: augments §2 security (secret-storage sub-check)

#### performance — FlatList vs ScrollView for long lists

- **Invocation**: `grep -rnB2 -A6 "<ScrollView" apps/mobile/` → flag any ScrollView that maps an array with length unbounded or user-fed (look for `.map(` inside the ScrollView body OR data from props/api)
- **Threshold**: lists with a dynamic / potentially unbounded item count must use `FlatList` (or `FlashList` from Shopify) — ScrollView renders ALL children immediately, causing jank at ≥50 items
- **Retry target**: mobile-frontend-builder
- **Playbook §**: augments §6 performance (list-virtualization sub-check)

#### performance — Image vs expo-image

- **Invocation**: `grep -rnE "from 'react-native'" apps/mobile/ | grep -E "Image[,}]"` (named import of Image from react-native)
- **Threshold**: zero hits in production components — `expo-image` provides better caching, blurhash placeholders, and GIF/WebP support; `react-native/Image` is a fallback only
- **Retry target**: mobile-frontend-builder
- **Playbook §**: augments §6 performance (image-loading sub-check)

#### a11y — accessibilityLabel on Pressable / TouchableOpacity

- **Invocation**: `grep -rnB1 -A3 "<(Pressable|TouchableOpacity|TouchableHighlight)" apps/mobile/ | grep -vE "accessibilityLabel=|accessibilityRole="`
- **Threshold**: every pressable wrapping icon-only content has `accessibilityLabel`; every custom pressable with no text content has `accessibilityRole="button"`
- **Retry target**: mobile-frontend-builder
- **Playbook §**: augments §5 a11y (TalkBack / VoiceOver support)

#### architecture — Expo Router file conventions

- **Invocation**: confirm per-feature route files adhere to Expo Router conventions: `find apps/mobile/app -name "_layout.tsx" -o -name "+not-found.tsx"` in the diff's app subtree; each tab / stack group MUST have a `_layout.tsx` parent
- **Threshold**: every new directory under `apps/mobile/app/` containing ≥2 route files has a `_layout.tsx` sibling (or inherits from a parent `_layout.tsx`)
- **Retry target**: mobile-frontend-builder
- **Playbook §**: augments §1 architecture

## 6. Dependency pins

```
expo                      ~52.0.0
expo-router               ~4.0.0
expo-secure-store         ~14.0.0
expo-status-bar           ~2.0.0
expo-constants            ~17.0.0
react                      19.0.0
react-native              0.76.5
nativewind                 4.1.x
tailwindcss                3.4.x       # mobile NativeWind 4 still on TW3 (TW4 compat pending)
react-native-reanimated   ~3.16.0
react-native-gesture-handler ~2.21.0
react-native-safe-area-context ~4.12.0
@tanstack/react-query     5.60.x
@trpc/client              11.0.x
@trpc/react-query         11.0.x
zod                       3.23.x
jest                      29.7.x
jest-expo                 ~52.0.0
@testing-library/react-native 12.9.x
@testing-library/jest-native 5.4.x
typescript                5.6.x
```

Workspace packages:

```
@repo/ui-kit           workspace:*    # CSS tokens + primitive types; .native.tsx overrides live here in apps/mobile
@repo/types            workspace:*
@repo/api-client       workspace:*
@repo/utils            workspace:*
```

## 7. Anti-patterns

- **Never use `AsyncStorage` for secrets.** It's unencrypted. Use `expo-secure-store`.
- **Never hardcode absolute dimensions.** Use `useWindowDimensions()` or responsive `vw` / `vh` via NativeWind.
- **Never use web-only CSS in className.** `hover:` + `focus-within:` + `md:` breakpoint prefixes don't work on RN — they're silently ignored. Keep responsive logic in JS.
- **Never trigger JS-thread animations for core interactions.** Use `react-native-reanimated` (runs on UI thread) for drags / pinches / swipes — `setState`-driven animations visibly jank.
- **Never ship `react-native-web` polyfills in the mobile app.** Metro bundle should not include them; tree-shake aggressively.
- **Never skip safe-area insets on any screen.** Notch / dynamic island / home indicator obscure content without them.
- **Never call `push()` on an already-pushed route in Expo Router.** Use `replace()` to avoid duplicate stack entries.
- **Never ignore the `react-native-reanimated/plugin` babel warning.** It means animations are falling back to JS thread — performance hit is immediate.

## Self-verify (RUN BEFORE REPORTING TASK COMPLETE)

After authoring code + tests for a task, run these commands IN ORDER from the worktree root. Each must succeed before you report `taskStatus: "completed"` for that task. ANY failure → set `taskStatus: "failed"` for the task and surface the stderr in the `errors` field of your return JSON.

```bash
# 1. Install: catches "I added a package.json line but the lockfile doesn't have it"
pnpm install

# 2. Typecheck: catches missing types, Expo SDK drift, kit primitive mismatch
pnpm --filter @repo/mobile typecheck

# 3. Tests: runs the .test.tsx + .test.ts files you authored (jest-expo)
pnpm --filter @repo/mobile test
```

There is no kit-consumer-contract validator on the mobile tier (NativeWind / RN doesn't expose the same hex-in-className surface as web Tailwind); the typecheck step + the kit's platform-aware imports cover the equivalent ground.

If you skip ANY of these commands, your task will fail downstream when feat-018's commit-discipline gate evaluates. The orchestrator will mark the feature failed via `feature-no-commits`. Save yourself the round-trip: run the three commands.

If `pnpm install` fails because of a registry network issue, retry once with `--prefer-offline`. If still failing, report the failure verbatim — don't try to work around it.

## 8. References

- [Expo SDK 52 release notes](https://expo.dev/changelog/2024/11-12-sdk-52)
- [Expo Router docs](https://docs.expo.dev/router/introduction/)
- [NativeWind v4 docs](https://www.nativewind.dev/v4/overview)
- [React Native 0.76 New Architecture](https://reactnative.dev/blog/2024/10/23/the-new-architecture-is-here)
- [Maestro mobile UI testing](https://maestro.mobile.dev/)
- Blueprint §17 / Appendix E
