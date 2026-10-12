import { useCallback, useEffect, useState } from "react";
import { installCommandFor, isApiRuntime, needsKey, runtimeInfo, type Catalog, type CredentialStatus, type RuntimeId } from "@branchboard/core";
import { fetchAbout, fetchRuntimeCatalog } from "../api";
import { useBoard } from "../store";

const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => useBoard.getState().notify("Copied"));

export const useRuntimeCatalog = (runtimeId: RuntimeId) => {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(
    async (isFresh = false) => {
      try {
        setCatalog(await fetchRuntimeCatalog(runtimeId, isFresh));
        setError(undefined);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
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

const dateOf = (timestamp: number | undefined): string => (timestamp ? new Date(timestamp).toLocaleDateString() : "earlier");

export const CredentialForm = ({ runtimeId, status, onChanged }: { runtimeId: RuntimeId; status?: CredentialStatus; onChanged: () => void }) => {
  const info = runtimeInfo(runtimeId);
  const credential = info.credential!;
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? credential.defaultBaseUrl);
  const [isReplacing, setIsReplacing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string }>();
  const [isBusy, setIsBusy] = useState(false);
  useEffect(() => setBaseUrl(status?.baseUrl ?? credential.defaultBaseUrl), [status?.baseUrl, credential.defaultBaseUrl]);
  const send = async (command: Record<string, unknown>) => {
    setIsBusy(true);
    const reply = await useBoard.getState().send<any>({ runtimeId, ...command });
    setIsBusy(false);
    return reply;
  };
  const save = async () => {
    const saved = await send({ type: "setCredential", key: key.trim() || undefined, ...(credential.baseUrlEditable ? { baseUrl } : {}) });
    setKey("");
    setIsReplacing(false);
    setTestResult(undefined);
    if (saved) onChanged();
  };
  const remove = async () => {
    if (!confirm(`Remove the saved ${info.label} key?`)) return;
    if (await send({ type: "setCredential", key: null })) onChanged();
  };
  const test = async () => setTestResult(await send({ type: "testCredential" }));
  const showField = !status?.saved || isReplacing;
  const isKeyOptional = !needsKey(runtimeId, baseUrl);
  return (
    <div className="credential-form">
      {credential.baseUrlEditable && (
        <label>
          Address
          <input value={baseUrl} spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} placeholder={credential.defaultBaseUrl} />
        </label>
      )}
      {credential.baseUrlEditable && baseUrl.replace(/\/+$/, "") !== (status?.baseUrl ?? credential.defaultBaseUrl).replace(/\/+$/, "") && status?.saved && <div className="muted">Changing the address removes the saved key unless you enter it again.</div>}
      {status?.saved && !isReplacing && <div className="muted">Key saved on {dateOf(status.updatedAt)}. Replace or remove it to change it.</div>}
      {showField && (
        <label>
          {isKeyOptional ? "API key (optional for this address)" : "API key"}
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={isReplacing ? "Paste the new key" : "Paste your key"} />
        </label>
      )}
      <div className="row">
        {showField ? (
          <button className="primary" disabled={isBusy || (!key.trim() && !credential.baseUrlEditable)} onClick={() => void save()}>Save</button>
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

export const CliSetup = ({ runtimeId, onCheckAgain }: { runtimeId: RuntimeId; onCheckAgain: () => void }) => {
  const info = runtimeInfo(runtimeId);
  const [platform, setPlatform] = useState("linux");
  useEffect(() => void fetchAbout().then((about) => setPlatform(about.platform), () => undefined), []);
  const install = installCommandFor(runtimeId, platform);
  return (
    <div className="setup-guide">
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

export const SetupGuide = ({ runtimeId, catalog, onCheckAgain }: { runtimeId: RuntimeId; catalog?: Catalog; onCheckAgain: () => void }) =>
  isApiRuntime(runtimeId) ? <CredentialForm runtimeId={runtimeId} status={catalog?.credential} onChanged={onCheckAgain} /> : <CliSetup runtimeId={runtimeId} onCheckAgain={onCheckAgain} />;
