import React, { useCallback, useMemo, useState } from "react";
import apiPost from "roamjs-components/util/apiPost";
import localStorageGet from "roamjs-components/util/localStorageGet";
import localStorageSet from "roamjs-components/util/localStorageSet";
import DropboxLogo from "./DropboxLogo";

type OauthAccount = {
  uid: string;
  text: string;
  data: string;
  time: number;
};

const OAUTH_KEY = "oauth-dropbox";
const ROAMJS_ORIGIN = "https://roamjs.com";
const REDIRECT_URI = `${ROAMJS_ORIGIN}/oauth?auth=true`;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DESKTOP_POLL_INTERVAL_MS = 1500;
const DROPBOX_CLIENT_ID = "ghagecp4sgm6v99";

const getStoredAccounts = (): OauthAccount[] => {
  try {
    return JSON.parse(localStorageGet(OAUTH_KEY) || "[]");
  } catch {
    return [];
  }
};

const getAccount = (): OauthAccount | null => getStoredAccounts()[0] || null;

const setAccount = (account: OauthAccount | null) =>
  localStorageSet(OAUTH_KEY, JSON.stringify(account ? [account] : []));

const createNonce = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createSessionId = () =>
  `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const encodeState = (value: unknown) => {
  const json = JSON.stringify(value);
  return window
    .btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const createState = (session?: string) => {
  const nonce = createNonce();
  try {
    const payload: { nonce: string; origin: string; session?: string } = {
      nonce,
      origin: window.location.origin,
    };
    if (session) {
      payload.session = session;
    }
    return encodeState(payload);
  } catch {
    return nonce;
  }
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const createUid = () =>
  window.roamAlphaAPI?.util?.generateUID?.() ||
  Math.random().toString(36).slice(2, 11);

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const e = error as { error?: string; message?: string };
    return e.error || e.message || JSON.stringify(error);
  }
  return "Failed to exchange OAuth code. Please try again in a moment.";
};

const DropboxOauthPanel = () => {
  const [account, setLocalAccount] = useState<OauthAccount | null>(() =>
    getAccount(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const nextLabel = useMemo(() => "Dropbox Account", []);

  const removeAccount = useCallback(() => {
    setAccount(null);
    setLocalAccount(null);
  }, []);

  const login = useCallback(() => {
    const isDesktop = !!window.roamAlphaAPI?.platform?.isDesktop;
    const session = isDesktop ? createSessionId() : undefined;
    const state = createState(session);
    setError("");
    setLoading(true);

    const url =
      "https://www.dropbox.com/oauth2/authorize?" +
      `client_id=${DROPBOX_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&token_access_type=offline&state=${encodeURIComponent(
        state,
      )}`;

    const width = 600;
    const height = 525;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;
    const popup = window.open(
      url,
      "roamjs_dropbox_login",
      `left=${left},top=${top},width=${width},height=${height},status=1`,
    );

    if (!popup) {
      if (!isDesktop) {
        setLoading(false);
        setError("Popup blocked. Please allow popups and try again.");
        return;
      }
    }
    popup?.focus?.();

    const exchangeCode = (payload: Record<string, string>) =>
      apiPost({
        anonymous: true,
        domain: ROAMJS_ORIGIN,
        path: "dropbox-auth",
        data: {
          ...payload,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
        },
      }).then((tokenData) => {
        const label =
          typeof tokenData?.label === "string" && tokenData.label
            ? tokenData.label
            : nextLabel;
        const nextAccount: OauthAccount = {
          uid: createUid(),
          text: label,
          data: JSON.stringify(tokenData),
          time: Date.now(),
        };
        setAccount(nextAccount);
        setLocalAccount(nextAccount);
      });

    if (isDesktop && session) {
      void (async () => {
        try {
          const deadline = Date.now() + OAUTH_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const pollUrl = `${ROAMJS_ORIGIN}/oauth/session?session=${encodeURIComponent(
              session,
            )}`;
            const response = await fetch(pollUrl, { cache: "no-store" });
            if (response.ok) {
              const pollData = (await response.json()) as {
                status?: string;
                code?: string;
                state?: string;
                error?: string;
              };
              if (pollData.status === "completed") {
                if (pollData.state !== state) {
                  throw new Error("OAuth state mismatch. Please try again.");
                }
                if (pollData.error) {
                  throw new Error(pollData.error);
                }
                if (!pollData.code) {
                  throw new Error(
                    "Did not receive an authorization code from Dropbox.",
                  );
                }
                await exchangeCode({
                  code: pollData.code,
                  state: pollData.state,
                });
                return;
              }
            }
            await wait(DESKTOP_POLL_INTERVAL_MS);
          }
          throw new Error(
            "Dropbox login timed out or was closed before completing. Please try again.",
          );
        } catch (e) {
          setError(toErrorMessage(e));
        } finally {
          setLoading(false);
        }
      })();
      return;
    }

    let timeoutId = 0;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeoutId);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== ROAMJS_ORIGIN) {
        return;
      }
      cleanup();
      const raw = event.data;
      let payload: Record<string, string> = {};
      if (typeof raw === "string") {
        try {
          payload = JSON.parse(raw || "{}") as Record<string, string>;
        } catch {
          setLoading(false);
          setError("Invalid OAuth response from callback page.");
          return;
        }
      } else if (raw && typeof raw === "object") {
        payload = raw as Record<string, string>;
      }

      if (payload.state !== state) {
        setLoading(false);
        setError("OAuth state mismatch. Please try again.");
        return;
      }
      if (payload.error) {
        setLoading(false);
        setError(payload.error);
        return;
      }
      if (!payload.code) {
        setLoading(false);
        setError("Did not receive an authorization code from Dropbox.");
        return;
      }

      exchangeCode(payload)
        .catch((e) => {
          setError(toErrorMessage(e));
        })
        .finally(() => {
          setLoading(false);
        });
    };

    window.addEventListener("message", onMessage);
    timeoutId = window.setTimeout(() => {
      cleanup();
      setLoading(false);
      setError(
        "Dropbox login timed out or was closed before completing. Please try again.",
      );
    }, OAUTH_TIMEOUT_MS);
  }, [nextLabel]);

  return (
    <div className="flex flex-col gap-2" style={{ minWidth: 300 }}>
      {!account ? (
        <button
          className="bp3-button bp3-minimal"
          onClick={login}
          disabled={loading}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ width: 15, height: 15, display: "inline-flex" }}>
              <DropboxLogo />
            </span>
            {loading ? "Connecting..." : "Login With Dropbox"}
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 30,
            }}
          >
            <span style={{ width: 15, height: 15, display: "inline-flex" }}>
              <DropboxLogo />
            </span>
            <span style={{ fontWeight: 600 }}>Connected</span>
            <span className="bp3-text-muted" style={{ marginLeft: 4 }}>
              {account.text}
            </span>
          </div>
          <details>
            <summary className="bp3-text-muted" style={{ cursor: "pointer" }}>
              Connection options
            </summary>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                className="bp3-button bp3-small bp3-minimal"
                onClick={login}
                disabled={loading}
              >
                {loading ? "Connecting..." : "Reconnect"}
              </button>
              <button
                className="bp3-button bp3-small bp3-minimal"
                onClick={removeAccount}
                disabled={loading}
              >
                Log Out
              </button>
            </div>
          </details>
        </div>
      )}
      {!!error && (
        <div style={{ color: "red", whiteSpace: "pre-line" }}>{error}</div>
      )}
    </div>
  );
};

export default DropboxOauthPanel;
