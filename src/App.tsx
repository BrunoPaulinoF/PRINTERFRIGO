import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, KeyRound, PlugZap, Printer, RefreshCw, Save, Scale, ShieldCheck, WifiOff, Wrench } from "lucide-react";
import {
  adminLogin,
  aiCollectSnapshot,
  aiRunLocalTool,
  aiSaveStationConfig,
  enrollAgent,
  ensureWindowsAutostart,
  heartbeatOnce,
  listPrinters,
  listSerialPorts,
  loadConfig,
  readScaleOnce,
  saveConfig,
  testPrintZpl,
  testScaleParse,
} from "./api";
import type { AiProposedAction, PortInfo, StationConfig } from "./types";

const VERSION = "0.1.5";

type HardwareSession = {
  id: string;
  point_id: string;
  flow: "RECEIVING" | "OP_OUTPUT";
  mode: "MANUAL" | "AUTO";
  status: string;
  context: Record<string, unknown>;
  command?: { id?: string; type?: string };
};

type PrintJob = {
  id: string;
  payload: { zpl?: string; volumeCode?: string };
};

type HeartbeatResult = {
  sessions?: HardwareSession[];
  printJobs?: PrintJob[];
};

type AutoSessionState = {
  samples: number[];
  waitingZero: boolean;
  lastCapturedAt: number;
};

function isStable(samples: number[], thresholdKg: number) {
  if (samples.length < 2) return false;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return Math.abs(max - min) <= thresholdKg;
}

const defaultConfig: StationConfig = {
  serverUrl: "http://localhost:3000",
  stationLabel: "Estacao PRINTERFRIGO",
  appVersion: VERSION,
  scale: {
    port: "",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    readCommand: "",
    parserRegex: "([-+]?\\d+[\\.,]?\\d*)\\s*kg?",
    stableWindow: 5,
    stableThresholdKg: 0.02,
    stableMs: 1200,
    minWeightKg: 1,
    cooldownMs: 1500,
    zeroThresholdKg: 0.25,
  },
  printer: {
    mode: "dry_run",
    localId: "label-01",
    port: 9100,
    dryRunDir: "",
  },
};

export function App() {
  const [config, setConfig] = useState<StationConfig>(defaultConfig);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [printers, setPrinters] = useState<string[]>([]);
  const [enrollCode, setEnrollCode] = useState("");
  const [scaleFrame, setScaleFrame] = useState("ST,GS,+0012.345kg");
  const [lastWeight, setLastWeight] = useState<number | null>(null);
  const [status, setStatus] = useState("Carregando configuracao local...");
  const [isBusy, setIsBusy] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [aiInput, setAiInput] = useState("Configure esta estacao para usar a impressora e a balanca conectadas, validando antes de salvar.");
  const [aiReply, setAiReply] = useState("");
  const [aiActions, setAiActions] = useState<AiProposedAction[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const handledCommands = useRef(new Set<string>());
  const handledJobs = useRef(new Set<string>());
  const autoSessions = useRef(new Map<string, AutoSessionState>());
  const isEnrolled = Boolean(config.agentId && config.token);

  useEffect(() => {
    loadConfig()
      .then((saved) => {
        if (saved) setConfig({ ...defaultConfig, ...saved, scale: { ...defaultConfig.scale, ...saved.scale }, printer: { ...defaultConfig.printer, ...saved.printer } });
        setStatus(saved?.agentId ? "Agente matriculado." : "Aguardando matricula.");
      })
      .catch((error) => setStatus(String(error)));
    void refreshDevices();
    ensureWindowsAutostart().catch(() => undefined);
  }, []);

  const sampleZpl = useMemo(() => "^XA^CI28^FO40,40^A0N,36,36^FDPRINTERFRIGO^FS^FO40,90^BY2^BCN,80,Y,N,N^FDTESTE-0001^FS^XZ", []);

  async function refreshDevices() {
    const [serial, queues] = await Promise.all([
      listSerialPorts().catch(() => []),
      listPrinters().catch(() => []),
    ]);
    setPorts(serial);
    setPrinters(queues);
  }

  async function persist(next = config) {
    setIsBusy(true);
    try {
      await saveConfig({ ...next, appVersion: VERSION });
      setStatus("Configuracao salva.");
    } finally {
      setIsBusy(false);
    }
  }

  async function enroll() {
    setIsBusy(true);
    try {
      const result = await enrollAgent(config.serverUrl, enrollCode, config.stationLabel);
      const next = {
        ...config,
        agentId: result.agentId,
        tenantId: result.tenantId,
        token: result.token,
        stationLabel: result.stationLabel || config.stationLabel,
      };
      setConfig(next);
      await saveConfig(next);
      setStatus(`Matriculado como ${result.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha na matricula.");
    } finally {
      setIsBusy(false);
    }
  }

  async function testParser() {
    try {
      setLastWeight(await testScaleParse(scaleFrame, config.scale.parserRegex));
      setStatus("Parser de peso validado.");
    } catch (error) {
      setLastWeight(null);
      setStatus(error instanceof Error ? error.message : "Nao foi possivel ler o peso.");
    }
  }

  async function testPrinter() {
    setIsBusy(true);
    try {
      const result = await testPrintZpl(config.printer, sampleZpl);
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha no teste de impressao.");
    } finally {
      setIsBusy(false);
    }
  }

  async function reportPrintJob(jobId: string, nextStatus: "PRINTED" | "FAILED", error?: string) {
    if (!config.token) return;
    await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/hardware/agent/print-jobs/${jobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ status: nextStatus, error }),
    });
  }

  async function submitCapture(session: HardwareSession, weight: number, commandId: string) {
    if (!config.token) return;
    await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/hardware/agent/captures`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        captureId: `${session.id}-${commandId}`,
        sessionId: session.id,
        pointId: session.point_id,
        flow: session.flow,
        grossWeight: weight,
        stable: true,
        payload: { context: session.context },
      }),
    });
  }

  const serviceTick = useCallback(async (showStatus = false) => {
    if (!config.token) return;
    const result = await heartbeatOnce(config) as HeartbeatResult;
    const printJobs = result.printJobs ?? [];
    const sessions = result.sessions ?? [];

    for (const job of printJobs) {
      if (handledJobs.current.has(job.id)) continue;
      handledJobs.current.add(job.id);
      try {
        const zpl = job.payload?.zpl;
        if (!zpl) throw new Error("Job sem payload ZPL.");
        await testPrintZpl(config.printer, zpl);
        await reportPrintJob(job.id, "PRINTED");
      } catch (error) {
        await reportPrintJob(job.id, "FAILED", error instanceof Error ? error.message : "Falha ao imprimir.");
      }
    }

    for (const session of sessions) {
      const commandId = session.command?.id;
      if (session.command?.type !== "REQUEST_CAPTURE" || !commandId || handledCommands.current.has(commandId)) continue;
      handledCommands.current.add(commandId);
      const weight = await readScaleOnce(config.scale);
      setLastWeight(weight);
      await submitCapture(session, weight, commandId);
    }

    for (const session of sessions) {
      if (session.mode !== "AUTO" || session.status !== "ACTIVE") continue;
      const state = autoSessions.current.get(session.id) ?? { samples: [], waitingZero: false, lastCapturedAt: 0 };
      const weight = await readScaleOnce(config.scale);
      setLastWeight(weight);

      if (weight <= config.scale.zeroThresholdKg) {
        state.waitingZero = false;
        state.samples = [];
        autoSessions.current.set(session.id, state);
        continue;
      }

      state.samples = [...state.samples, weight].slice(-Math.max(2, config.scale.stableWindow));
      const cooldownElapsed = Date.now() - state.lastCapturedAt >= config.scale.cooldownMs;
      if (
        !state.waitingZero &&
        cooldownElapsed &&
        weight >= config.scale.minWeightKg &&
        state.samples.length >= Math.max(2, config.scale.stableWindow) &&
        isStable(state.samples, config.scale.stableThresholdKg)
      ) {
        const captureId = `auto-${Date.now()}`;
        await submitCapture(session, weight, captureId);
        state.waitingZero = true;
        state.lastCapturedAt = Date.now();
        state.samples = [];
      }
      autoSessions.current.set(session.id, state);
    }

    if (showStatus || printJobs.length > 0 || sessions.length > 0) {
      setStatus(`Servico online. Sessoes: ${sessions.length}. Jobs: ${printJobs.length}.`);
    }
  }, [config]);

  useEffect(() => {
    if (!isEnrolled) return;
    const timer = window.setInterval(() => {
      serviceTick().catch((error) => setStatus(error instanceof Error ? error.message : "Falha no servico."));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [isEnrolled, serviceTick]);

  async function heartbeat() {
    setIsBusy(true);
    try {
      await serviceTick(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha no heartbeat.");
    } finally {
      setIsBusy(false);
    }
  }

  async function unlockAdmin() {
    setIsBusy(true);
    try {
      const session = await adminLogin(adminPassword);
      setAdminToken(session.token);
      setAdminPassword("");
      setStatus("Area Admin IA desbloqueada.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha ao desbloquear admin.");
    } finally {
      setIsBusy(false);
    }
  }

  async function askAi() {
    if (!adminToken) {
      setStatus("Desbloqueie a area Admin IA.");
      return;
    }
    if (!config.token) {
      setStatus("Matricule o PRINTERFRIGO antes de usar a IA.");
      return;
    }
    setAiBusy(true);
    try {
      const snapshot = await aiCollectSnapshot(adminToken, config);
      const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/hardware/agent/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ message: aiInput, snapshot }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Falha ao consultar IA.");
      setAiReply(payload.reply ?? "");
      setAiActions(Array.isArray(payload.proposedActions) ? payload.proposedActions : []);
      setStatus("IA gerou diagnostico e acoes propostas.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha na IA admin.");
    } finally {
      setAiBusy(false);
    }
  }

  async function runAiAction(action: AiProposedAction) {
    if (!adminToken) return;
    if (action.requiresConfirmation !== false && !window.confirm(`Executar: ${action.label}?`)) return;
    setAiBusy(true);
    try {
      const args = action.args ?? {};
      if (action.tool === "save_station_config") {
        const next = args.config as StationConfig | undefined;
        if (!next) throw new Error("Acao sem config.");
        await aiSaveStationConfig(adminToken, next);
        setConfig({ ...defaultConfig, ...next, scale: { ...defaultConfig.scale, ...next.scale }, printer: { ...defaultConfig.printer, ...next.printer } });
        setStatus("Configuracao local salva pela IA.");
      } else if (action.tool === "apply_kyberfrigo_config") {
        if (!config.token) throw new Error("Agente nao matriculado.");
        const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/hardware/agent/configure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(args),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? "Falha ao aplicar no KyberFrigo.");
        setStatus("Configuracao sincronizada com KyberFrigo.");
      } else {
        const result = await aiRunLocalTool(adminToken, action.tool, args);
        setStatus(result.message);
      }
      await refreshDevices();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha ao executar acao.");
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">PRINTERFRIGO</p>
          <h1>Estacao de pesagem e etiquetas</h1>
        </div>
        <div className={isEnrolled ? "pill online" : "pill"}>
          {isEnrolled ? <CheckCircle2 size={16} /> : <WifiOff size={16} />}
          {isEnrolled ? "Matriculado" : "Nao matriculado"}
        </div>
      </section>

      <section className="grid">
        <div className="panel">
          <h2><ShieldCheck size={18} /> Onboarding</h2>
          <label>URL KyberFrigo</label>
          <input value={config.serverUrl} onChange={(e) => setConfig({ ...config, serverUrl: e.target.value })} />
          <label>Nome da estacao</label>
          <input value={config.stationLabel} onChange={(e) => setConfig({ ...config, stationLabel: e.target.value })} />
          <label>Codigo de matricula</label>
          <div className="row">
            <input value={enrollCode} onChange={(e) => setEnrollCode(e.target.value.toUpperCase())} placeholder="ABC12345" />
            <button disabled={isBusy || !enrollCode.trim()} onClick={enroll}>Matricular</button>
          </div>
          <p className="muted">Tenant: {config.tenantId ?? "nao vinculado"}</p>
        </div>

        <div className="panel">
          <h2><Scale size={18} /> Balanca</h2>
          <label>Porta serial</label>
          <select value={config.scale.port} onChange={(e) => setConfig({ ...config, scale: { ...config.scale, port: e.target.value } })}>
            <option value="">Selecionar porta</option>
            {ports.map((port) => <option key={port.name} value={port.name}>{port.name} - {port.kind}</option>)}
          </select>
          <div className="split">
            <div><label>Baud</label><input type="number" value={config.scale.baudRate} onChange={(e) => setConfig({ ...config, scale: { ...config.scale, baudRate: Number(e.target.value) } })} /></div>
            <div><label>Peso minimo kg</label><input type="number" value={config.scale.minWeightKg} onChange={(e) => setConfig({ ...config, scale: { ...config.scale, minWeightKg: Number(e.target.value) } })} /></div>
          </div>
          <label>Regex parser</label>
          <input value={config.scale.parserRegex} onChange={(e) => setConfig({ ...config, scale: { ...config.scale, parserRegex: e.target.value } })} />
          <label>Frame de teste</label>
          <div className="row">
            <input value={scaleFrame} onChange={(e) => setScaleFrame(e.target.value)} />
            <button onClick={testParser}>Testar</button>
          </div>
          <p className="reading">{lastWeight === null ? "--" : `${lastWeight.toFixed(3)} kg`}</p>
        </div>

        <div className="panel">
          <h2><Printer size={18} /> Impressora</h2>
          <label>Modo</label>
          <select value={config.printer.mode} onChange={(e) => setConfig({ ...config, printer: { ...config.printer, mode: e.target.value as StationConfig["printer"]["mode"] } })}>
            <option value="dry_run">Dry-run .zpl</option>
            <option value="windows_spooler">Fila Windows</option>
            <option value="tcp_9100">TCP/IP 9100</option>
          </select>
          <label>Fila Windows</label>
          <select value={config.printer.queueName ?? ""} onChange={(e) => setConfig({ ...config, printer: { ...config.printer, queueName: e.target.value } })}>
            <option value="">Selecionar fila</option>
            {printers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <div className="split">
            <div><label>Host TCP</label><input value={config.printer.host ?? ""} onChange={(e) => setConfig({ ...config, printer: { ...config.printer, host: e.target.value } })} /></div>
            <div><label>Porta</label><input type="number" value={config.printer.port ?? 9100} onChange={(e) => setConfig({ ...config, printer: { ...config.printer, port: Number(e.target.value) } })} /></div>
          </div>
          <div className="row">
            <button onClick={testPrinter} disabled={isBusy}>Teste ZPL</button>
            <button onClick={refreshDevices}><RefreshCw size={15} /> Atualizar</button>
          </div>
        </div>

        <div className="panel">
          <h2><PlugZap size={18} /> Servico</h2>
          <p className="muted">Versao {VERSION}. O update Tauri fica bloqueado operacionalmente enquanto houver sessao ativa no KyberFrigo.</p>
          <div className="actions">
            <button onClick={() => persist()} disabled={isBusy}><Save size={15} /> Salvar</button>
            <button onClick={heartbeat} disabled={!isEnrolled || isBusy}>Heartbeat</button>
          </div>
          <pre>{status}</pre>
        </div>

        <div className="panel ai-panel">
          <h2><Bot size={18} /> Admin IA</h2>
          {!adminToken ? (
            <>
              <label>Senha admin</label>
              <div className="row">
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adminPassword) void unlockAdmin();
                  }}
                />
                <button onClick={unlockAdmin} disabled={isBusy || !adminPassword}>
                  <KeyRound size={15} /> Entrar
                </button>
              </div>
              <p className="muted">A IA fica bloqueada para usuario comum. A chave OpenAI permanece no backend KyberFrigo.</p>
            </>
          ) : (
            <>
              <label>Pedido para IA</label>
              <textarea value={aiInput} onChange={(e) => setAiInput(e.target.value)} />
              <div className="row">
                <button onClick={askAi} disabled={aiBusy || !aiInput.trim()}>
                  <Bot size={15} /> Diagnosticar
                </button>
                <button onClick={() => setAdminToken(null)} disabled={aiBusy}>Bloquear</button>
              </div>
              {aiReply && <pre className="ai-reply">{aiReply}</pre>}
              {aiActions.length > 0 && (
                <div className="action-list">
                  {aiActions.map((action) => (
                    <button key={action.id} onClick={() => runAiAction(action)} disabled={aiBusy}>
                      <Wrench size={15} /> {action.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
