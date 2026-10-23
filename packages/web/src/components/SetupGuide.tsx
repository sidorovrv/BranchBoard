import { useCallback, useEffect, useRef, useState } from "react";
import { installCommandFor, isApiRuntime, needsKey, runtimeInfo, type Catalog, type CredentialStatus, type EngineSetup, type RuntimeId } from "@branchboard/core";
import { fetchAbout, fetchCredentialStatus, fetchRuntimeCatalog } from "../api";
import { copyText, useBoard } from "../store";

const copy = (text: string) => void copyText(text);

export const useRuntimeCatalog = (runtimeId: RuntimeId) => {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(
    async (isFresh = false): Promise<Catalog | undefined> => {
      try {
        const loaded = await fetchRuntimeCatalog(runtimeId, isFresh);
        setCatalog(loaded);
        setError(undefined);
        return loaded;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return undefined;
      }
    },
    [runtimeId],
  );
  useEffect(() => {
    setCatalog(undefined);
    void refresh();
  }, [refresh]);
  return { catalog, error, refresh };
};

type RefreshCatalog = (isFresh?: boolean) => Promise<Catalog | undefined>;

const ENGINE_POLL_MS = 1500;

export const setUpEngine = async (runtimeId: RuntimeId, refresh: RefreshCatalog, isCancelled: () => boolean = () => false): Promise<boolean> => {
  await useBoard.getState().send({ type: "setUpRuntime", runtimeId });
  for (;;) {
    if (isCancelled()) return false;
    const phase = (await refresh(true))?.engine?.phase;
    if (isCancelled() || phase === "failed" || phase === undefined) return false;
    if (phase !== "installing") return true;
    await new Promise((resolve) => setTimeout(resolve, ENGINE_POLL_MS));
  }
};

export const EngineNotice = ({ engine }: { engine?: EngineSetup }) => {
  if (engine?.phase === "ready") return null;
  return (
    <div className="muted">
      Saving a key or connecting a project downloads the OpenCode engine{engine?.version ? ` v${engine.version}` : ""} (@opencode/cli, MIT licence) into the Branchboard data folder.
    </div>
  );
};

export const EngineStatus = ({ runtimeId, engine, refresh }: { runtimeId: RuntimeId; engine?: EngineSetup; refresh: RefreshCatalog }) => {
  const isInstalling = engine?.phase === "installing";
  useEffect(() => {
    if (!isInstalling) return;
    const timer = setInterval(() => void refresh(true), ENGINE_POLL_MS * 2);
    return () => clearInterval(timer);
  }, [isInstalling, refresh]);
  if (!engine || (engine.phase !== "installing" && engine.phase !== "failed")) return null;
  return (
    <div className="setup-step">
      <div className={engine.phase === "failed" ? "part-error" : "muted"}>{engine.message ?? "Downloading the engine."}</div>
      {engine.phase === "failed" && <div className="row"><button onClick={() => void setUpEngine(runtimeId, refresh)}>Try again</button></div>}
    </div>
  );
};

const dateOf =(timestamp: number | undefined): string => (timestamp ? new Date(timestamp).toLocaleDateString() : "earlier");

export const CredentialForm = ({ runtimeId, catalog, refresh, isNoticeShown = false }: { runtimeId: RuntimeId; catalog?: Catalog; refresh: RefreshCatalog; isNoticeShown?: boolean }) => {
  const status: CredentialStatus | undefined = catalog?.credential;
  const info = runtimeInfo(runtimeId);
  const credential = info.credential!;
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? credential.defaultBaseUrl);
  const [isReplacing, setIsReplacing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string }>();
  const [isBusy, setIsBusy] = useState(false);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  useEffect(() => setBaseUrl(status?.baseUrl ?? credential.defaultBaseUrl), [status?.baseUrl, credential.defaultBaseUrl]);
  const send = async (command: Record<string, unknown>) => {
    setIsBusy(true);
    const reply = await useBoard.getState().send<any>({ runtimeId, ...command });
    setIsBusy(false);
    return reply;
  };
  const save = async () => {
    const saved = await send({ type: "setCredential", key: key.trim() || undefined, ...(credential.baseUrlEditable ? { baseUrl } : {}) });
    if (!saved) return;
    setKey("");
    setIsReplacing(false);
    setTestResult(undefined);
    void refresh(true);
  };
  const remove = async () => {
    if (!confirm(`Remove the saved ${info.label} key?`)) return;
    if (await send({ type: "setCredential", key: null })) void refresh(true);
  };
  const test = async () => {
    setIsBusy(true);
    const isEngineReady = await setUpEngine(runtimeId, refresh, () => !isMounted.current);
    if (!isMounted.current) return;
    setIsBusy(false);
    if (isEngineReady) setTestResult(await send({ type: "testCredential" }));
  };
  const showField = !status?.saved || isReplacing;
  const isKeyOptional = !needsKey(runtimeId, baseUrl);
  const isAddressChanged = Boolean(credential.baseUrlEditable) && baseUrl.replace(/\/+$/, "") !== (status?.baseUrl ?? credential.defaultBaseUrl).replace(/\/+$/, "");
  return (
    <div className="credential-form">
      {(isNoticeShown || key.trim() || isAddressChanged) && <EngineNotice engine={catalog?.engine} />}
      <EngineStatus runtimeId={runtimeId} engine={catalog?.engine} refresh={refresh} />
      {credential.baseUrlEditable && (
        <label>
          Address
          <input value={baseUrl} spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} placeholder={credential.defaultBaseUrl} />
        </label>
      )}
      {credential.baseUrlEditable && baseUrl.replace(/\/+$/, "") !== (status?.baseUrl ?? credential.defaultBaseUrl).replace(/\/+$/, "") && status?.saved && <div className="muted">Changing the address removes the saved key unless you enter it again.</div>}
      {status?.saved && !isReplacing && <div className="muted">Key saved on {dateOf(status.updatedAt)}.</div>}
      {showField && (
        <label>
          {isKeyOptional ? "API key (optional for this address)" : "API key"}
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={isReplacing ? "Paste the new key" : "Paste your key"} />
        </label>
      )}
      <div className="row">
        {showField ? (
          <button className="primary" disabled={isBusy || (!key.trim() && !credential.baseUrlEditable)} title={!key.trim() && !credential.baseUrlEditable ? "Paste a key first" : undefined} onClick={() => void save()}>Save</button>
        ) : (
          <>
            <button disabled={isBusy} onClick={() => setIsReplacing(true)}>Replace</button>
            <button disabled={isBusy} onClick={() => void remove()}>Remove</button>
            <button disabled={isBusy} onClick={() => void test()}>Test key</button>
          </>
        )}
        {isReplacing && <button onClick={() => (setIsReplacing(false), setKey(""))}>Cancel</button>}
        {info.setup?.keyUrl && <a href={info.setup.keyUrl} target="_blank" rel="noreferrer">Get a key</a>}
      </div>
      {testResult && <div className={testResult.ok ? "muted" : "part-error"}>{testResult.ok ? "✓ " : ""}{testResult.detail}</div>}
    </div>
  );
};

export const ServerAddressForm = ({ runtimeId }: { runtimeId: RuntimeId }) => {
  const [status, setStatus] = useState<CredentialStatus>();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [connection, setConnection] = useState<{ ok: boolean; detail: string }>();
  const [loadError, setLoadError] = useState<string>();
  const loadStatus = useCallback(
    () =>
      fetchCredentialStatus(runtimeId).then((loaded) => {
        setStatus(loaded);
        setAddress(loaded.baseUrl ?? "");
        setLoadError(undefined);
      }, (failure) => setLoadError(failure instanceof Error ? failure.message : String(failure))),
    [runtimeId],
  );
  useEffect(() => void loadStatus(), [loadStatus]);
  const check = async () => {
    setIsBusy(true);
    const catalog = await fetchRuntimeCatalog(runtimeId, true).catch((failure) => ({ health: { ok: false, detail: failure instanceof Error ? failure.message : String(failure) } }));
    setIsBusy(false);
    setConnection(catalog.health);
  };
  const save = async (command: Record<string, unknown>) => {
    setIsBusy(true);
    const saved = await useBoard.getState().send<any>({ runtimeId, type: "setCredential", ...command });
    setIsBusy(false);
    setPassword("");
    setConnection(undefined);
    if (saved) await loadStatus();
  };
  return (
    <div className="credential-form">
      <div className="muted">Address of a running OpenCode 2 server, for example one started with “opencode service start”. The password is in service.json in the OpenCode configuration folder. Leave the address empty to use a server started by Branchboard.</div>
      <label>
        Server address
        <input value={address} disabled={!status} spellCheck={false} onChange={(event) => setAddress(event.target.value)} placeholder="http://127.0.0.1:4096" />
      </label>
      <label>
        Server password
        <input type="password" autoComplete="off" disabled={!status} spellCheck={false} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={status?.saved ? "Saved. Type to replace it" : "Password of the server"} />
      </label>
      <div className="row">
        <button className="primary" disabled={isBusy || !status} onClick={() => void save({ key: password.trim() || undefined, baseUrl: address.trim() })}>Save</button>
        {status?.baseUrl && <button disabled={isBusy} onClick={() => void save({ key: null, baseUrl: "" })}>Disconnect</button>}
        {status?.baseUrl && <button disabled={isBusy} onClick={() => void check()}>Check connection</button>}
      </div>
      {loadError && <div className="part-error">{loadError}</div>}
      {connection && <div className={connection.ok ? "muted" : "part-error"}>{connection.ok ? "✓ " : ""}{connection.detail}</div>}
    </div>
  );
};

export const CliSetup = ({ runtimeId, onCheckAgain }: { runtimeId: RuntimeId; onCheckAgain: () => void }) => {
  const info = runtimeInfo(runtimeId);
  const [platform, setPlatform] = useState<string>();
  const [aboutError, setAboutError] = useState<string>();
  useEffect(() => void fetchAbout().then((about) => setPlatform(about.platform), (failure) => setAboutError(failure instanceof Error ? failure.message : String(failure))), []);
  const install = platform ? installCommandFor(runtimeId, platform) : undefined;
  return (
    <div className="setup-guide">
      {aboutError && <div className="part-error">{aboutError}</div>}
      {install && (
        <div className="setup-step">
          <div>1. Install it:</div>
          <div className="row"><code>{install}</code><button onClick={() => copy(install)}>Copy</button></div>
        </div>
      )}
      {info.setup?.signIn && (
        <div className="setup-step">
          <div>{install ? "2." : "1."} Sign in once by running:</div>
          <div className="row"><code>{info.setup.signIn}</code><button onClick={() => copy(info.setup!.signIn!)}>Copy</button></div>
          {info.setup.signInNote && <div className="muted">{info.setup.signInNote}</div>}
        </div>
      )}
      {info.pathVariable && <div className="muted">If it is installed but not found, set <code>{info.pathVariable}</code> to its full path and restart Branchboard.</div>}
      <div className="row">
        <button onClick={onCheckAgain}>Check again</button>
        {info.setup?.docsUrl && <a href={info.setup.docsUrl} target="_blank" rel="noreferrer">Documentation</a>}
      </div>
    </div>
  );
};
