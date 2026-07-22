/**
 * WebViewContext — the orchestrator that connects every WebView container in the
 * native multi-WebView stack (root portal + pushed sub-pages) to a single
 * controller surface (the dev-menu items and the in-app controller panel).
 *
 * Two contexts are exposed from one provider so the heavy WebView containers do
 * not re-render every time the stack/session state changes:
 *
 *  • {@link useWebViewRegistry} — a *stable* object the containers use to
 *    register/unregister themselves, report route/login changes, and expose
 *    their imperative handle (reload / goBack / navigate). Its identity never
 *    changes, so consuming it never forces a WebView re-render.
 *
 *  • {@link useWebViewController} — the *reactive* controller read by the GUI:
 *    live stack + session + visibility, plus actions that drive the active
 *    (top-most) WebView and load/save the dev session.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { registerWebViewDevMenu } from './devMenu';
import {
  EMPTY_SESSION,
  type SessionSnapshot,
  type SessionState,
  type WebViewMode,
} from './sessionSnapshot';
import { readSnapshot, writeSnapshot } from './sessionStore';

/** A live entry in the native stack, as tracked by the orchestrator. */
export type WebViewEntry = {
  id: string;
  /** Monotonic registration order; the highest is the top-most (active) one. */
  seq: number;
  mode: WebViewMode;
  url: string;
  path: string;
  canGoBack: boolean;
  createdAt: number;
};

/** The imperative handle a container exposes for the controller to drive it. */
export type WebViewHandle = {
  reload: () => void;
  reloadClearCache: () => void;
  goBackSpa: () => void;
  navigateSpa: (path: string) => void;
  refreshFcmToken: () => void;
};

/** Native-stack navigation, registered by the root container (owns the router). */
export type StackNavigator = {
  push: (url: string, path: string) => void;
  pop: () => void;
  popToRoot: () => void;
  /** TEMP (flicker debug): spawn a warm slot immediately, bypassing the lazy delay. */
  debugSpawnWarm?: (path: string) => void;
  /** TEMP (flicker debug): reveal the current warm slot as-is (no redirect), to test
   * whether the slide-in animation itself is smooth for already-loaded content. */
  debugForceAdopt?: () => void;
};

/** Stable registration API consumed by the WebView containers. */
export type WebViewRegistry = {
  registerWebView: (
    init: { id: string; mode: WebViewMode; url: string; path: string },
    handle: WebViewHandle,
  ) => void;
  unregisterWebView: (id: string) => void;
  updateWebView: (
    id: string,
    partial: Partial<Pick<WebViewEntry, 'url' | 'path' | 'canGoBack'>>,
  ) => void;
  mergeSession: (partial: Partial<SessionState>) => void;
  registerNavigator: (navigator: StackNavigator | null) => void;
};

/** Reactive controller API consumed by the dev menu + controller panel. */
export type WebViewController = {
  stack: WebViewEntry[];
  session: SessionState;
  panelVisible: boolean;

  getActive: () => WebViewEntry | null;
  reloadActive: (clearCache?: boolean) => void;
  goBackActive: () => void;
  navigateActive: (path: string) => void;
  refreshActiveFcm: () => void;
  popToRoot: () => void;

  saveSession: () => Promise<SessionSnapshot>;
  loadSession: () => Promise<SessionSnapshot | null>;
  restoreSession: (snapshot: SessionSnapshot) => Promise<void>;

  showPanel: () => void;
  hidePanel: () => void;
  togglePanel: () => void;

  /** TEMP (flicker debug). */
  debugSpawnWarm: (path: string) => void;
  /** TEMP (flicker debug). */
  debugForceAdopt: () => void;
};

const RegistryContext = createContext<WebViewRegistry | null>(null);
const ControllerContext = createContext<WebViewController | null>(null);

let seqCounter = 0;
/** Next monotonic registration sequence (module-scoped, stable per JS runtime). */
export function nextWebViewSeq(): number {
  return ++seqCounter;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function WebViewProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<WebViewEntry[]>([]);
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION);
  const [panelVisible, setPanelVisible] = useState(false);

  // Imperative handles + navigator live in refs (driving them must not re-render).
  const handlesRef = useRef(new Map<string, WebViewHandle>());
  const navigatorRef = useRef<StackNavigator | null>(null);
  // Latest state mirrored into refs so the stable actions read fresh values.
  const stackRef = useRef(stack);
  const sessionRef = useRef(session);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // --- Registry: stable identity, safe for containers to depend on ----------
  const registry = useMemo<WebViewRegistry>(
    () => ({
      registerWebView(init, handle) {
        handlesRef.current.set(init.id, handle);
        const entry: WebViewEntry = {
          id: init.id,
          seq: nextWebViewSeq(),
          mode: init.mode,
          url: init.url,
          path: init.path,
          canGoBack: false,
          createdAt: Date.now(),
        };
        setStack((prev) =>
          [...prev.filter((e) => e.id !== init.id), entry].sort((a, b) => a.seq - b.seq),
        );
      },
      unregisterWebView(id) {
        handlesRef.current.delete(id);
        setStack((prev) => prev.filter((e) => e.id !== id));
      },
      updateWebView(id, partial) {
        setStack((prev) =>
          prev.map((e) => (e.id === id ? { ...e, ...partial } : e)),
        );
      },
      mergeSession(partial) {
        setSession((prev) => ({ ...prev, ...partial }));
      },
      registerNavigator(navigator) {
        navigatorRef.current = navigator;
      },
    }),
    [],
  );

  // --- Controller actions: stable identity, read live state through refs ----
  const actions = useMemo(() => {
    const getActive = (): WebViewEntry | null => {
      const s = stackRef.current;
      return s.length ? s[s.length - 1] : null;
    };
    const activeHandle = (): WebViewHandle | null => {
      const active = getActive();
      return active ? handlesRef.current.get(active.id) ?? null : null;
    };

    const reloadActive = (clearCache = false) => {
      const handle = activeHandle();
      if (!handle) return;
      if (clearCache) handle.reloadClearCache();
      else handle.reload();
    };
    const goBackActive = () => {
      const active = getActive();
      if (!active) return;
      // Walk the active WebView's own SPA history first; only pop the native
      // container once that history is exhausted.
      if (active.canGoBack) activeHandle()?.goBackSpa();
      else navigatorRef.current?.pop();
    };
    const navigateActive = (path: string) => activeHandle()?.navigateSpa(path);
    const refreshActiveFcm = () => activeHandle()?.refreshFcmToken();
    const popToRoot = () => navigatorRef.current?.popToRoot();

    const saveSession = () => writeSnapshot(stackRef.current, sessionRef.current);
    const loadSession = () => readSnapshot();
    const restoreSession = async (snapshot: SessionSnapshot) => {
      const navigator = navigatorRef.current;
      // Collapse to the root, then re-open the saved pages on top of it.
      navigator?.popToRoot();
      const [root, ...subs] = snapshot.stack;
      if (root) {
        const rootEntry = stackRef.current[0];
        if (rootEntry) handlesRef.current.get(rootEntry.id)?.navigateSpa(root.path);
      }
      for (const sub of subs) {
        navigator?.push(sub.url, sub.path);
        // Let the native stack settle between pushes so each screen mounts.
        await delay(180);
      }
    };

    return {
      getActive,
      reloadActive,
      goBackActive,
      navigateActive,
      refreshActiveFcm,
      popToRoot,
      saveSession,
      loadSession,
      restoreSession,
      showPanel: () => setPanelVisible(true),
      hidePanel: () => setPanelVisible(false),
      togglePanel: () => setPanelVisible((v) => !v),
      debugSpawnWarm: (path: string) => navigatorRef.current?.debugSpawnWarm?.(path),
      debugForceAdopt: () => navigatorRef.current?.debugForceAdopt?.(),
    };
  }, []);

  const controller = useMemo<WebViewController>(
    () => ({ stack, session, panelVisible, ...actions }),
    [stack, session, panelVisible, actions],
  );

  // Keep the latest controller in a ref and register the dev-menu items once, so
  // the (replace-all) registration runs a single time while its callbacks still
  // read fresh state.
  const controllerRef = useRef(controller);
  useEffect(() => {
    controllerRef.current = controller;
  });
  useEffect(() => {
    registerWebViewDevMenu(() => controllerRef.current);
  }, []);

  return (
    <RegistryContext.Provider value={registry}>
      <ControllerContext.Provider value={controller}>
        {children}
      </ControllerContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Container-facing registration API. Throws if used outside the provider. */
export function useWebViewRegistry(): WebViewRegistry {
  const ctx = useContext(RegistryContext);
  if (!ctx) throw new Error('useWebViewRegistry must be used within <WebViewProvider>');
  return ctx;
}

/** Controller-facing API for the dev menu + panel. Throws outside the provider. */
export function useWebViewController(): WebViewController {
  const ctx = useContext(ControllerContext);
  if (!ctx) throw new Error('useWebViewController must be used within <WebViewProvider>');
  return ctx;
}
