import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Bot, CheckCircle2, KeyRound, PlugZap, Printer, RefreshCw, Save, Scale, ShieldCheck, WifiOff, Wrench } from "lucide-react";
import {
  adminLogin,
  aiCollectSnapshot,
  aiRunLocalTool,
  aiSaveStationConfig,
  enrollAgent,
  ensureWindowsAutostart,
  fetchRealtimeToken,
  heartbeatOnce,
  listPrinters,
  listSerialPorts,
  loadConfig,
  readScaleOnce,
  reportPrintJob as reportPrintJobApi,
  saveConfig,
  submitCapture as submitCaptureApi,
  testPrintZpl,
  testScaleParse,
} from "./api";
import type { AiProposedAction, PortInfo, PrinterConfig, PrinterInfo, ScaleConfig, StationConfig } from "./types";

const VERSION = "0.2.9";
const DEFAULT_SERVER_URL = "https://kyberfrigo.kybernan.com.br";
const ACTIVE_SERVICE_POLL_MS = 2000;
const IDLE_SERVICE_POLL_MS = 300000;
const OFFLINE_REALTIME_IDLE_SERVICE_POLL_MS = 60000;
const MIN_SERVICE_POLL_MS = 1000;
const MAX_SERVICE_POLL_MS = 600000;
const REALTIME_TOKEN_REFRESH_MARGIN_MS = 60000;

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
  printer_local_id?: string | null;
  payload: { zpl?: string; volumeCode?: string };
};

type HeartbeatResult = {
  sessions?: HardwareSession[];
  printJobs?: PrintJob[];
  nextPollMs?: number;
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
  serverUrl: DEFAULT_SERVER_URL,
  stationLabel: "Estacao PRINTERFRIGO",
  appVersion: VERSION,
  scale: {
    mode: "serial",
    port: "",
    simulatedWeightKg: 12.345,
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
    mode: "windows_spooler",
    localId: "",
    port: 9100,
    dryRunDir: "",
  },
};

function isLocalServerUrl(url: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(url.trim());
}

function normalizeConfig(config: StationConfig): StationConfig {
  const scale = { ...defaultConfig.scale, ...config.scale };
  const printer = { ...defaultConfig.printer, ...config.printer };
  const scales = normalizeScales(config.scales, scale);
  const printers = normalizePrinters(config.printers, printer);
  const merged = {
    ...defaultConfig,
    ...config,
    scale,
    printer,
    scales,
    printers,
  };
  if (import.meta.env.PROD && isLocalServerUrl(merged.serverUrl)) {
    return { ...merged, serverUrl: DEFAULT_SERVER_URL };
  }
  return merged;
}

function normalizeScales(scales: ScaleConfig[] | undefined, fallback: ScaleConfig) {
  const items = (scales && scales.length > 0 ? scales : [fallback])
    .map((scale) => ({ ...defaultConfig.scale, ...scale }))
    .filter((scale, index, all) => scale.port || scale.mode === "simulated" || index === 0 && all.length === 1);
  if (!items.some((scale) => scale.port === fallback.port)) items.unshift(fallback);
  return dedupeBy(items, (scale) => scale.port || "default-scale");
}

function normalizePrinters(printers: PrinterConfig[] | undefined, fallback: PrinterConfig) {
  const items = (printers && printers.length > 0 ? printers : [fallback])
    .map((printer) => ({ ...defaultConfig.printer, ...printer }))
    .filter((printer, index, all) => printer.localId || printer.queueName || printer.host || index === 0 && all.length === 1);
  if (!items.some((printer) => printer.localId === fallback.localId)) items.unshift(fallback);
  return dedupeBy(items, (printer) => printer.localId || printer.queueName || printer.host || "default-printer");
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scaleLabel(scale: ScaleConfig, index: number) {
  if (scale.mode === "simulated") return `${scale.port || `Balanca ${index + 1}`} (simulada)`;
  return scale.port ? `${scale.port}` : `Balanca ${index + 1}`;
}

function printerLabel(printer: PrinterConfig, index: number) {
  return printer.queueName || printer.host || printer.localId || `Impressora ${index + 1}`;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) {
    try {
      const parsed = JSON.parse(error) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      return error;
    }
  }
  return fallback;
}

function networkErrorMessage(error: unknown, serverUrl: string) {
  const message = errorMessage(error, "Falha de conexao.");
  if (/failed to fetch/i.test(message)) {
    return `Nao foi possivel conectar ao KyberFrigo em ${serverUrl}. Verifique se o site/API esta online, se a URL esta correta e se o app foi matriculado novamente apos o deploy.`;
  }
  return message;
}

export function App() {
  const [config, setConfig] = useState<StationConfig>(defaultConfig);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [enrollCode, setEnrollCode] = useState("");
  const [scaleFrame, setScaleFrame] = useState("ST,GS,+0012.345kg");
  const [lastWeight, setLastWeight] = useState<number | null>(null);
  const [status, setStatus] = useState("Carregando configuracao local...");
  const [isBusy, setIsBusy] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [aiInput, setAiInput] = useState("Configure esta estacao para usar a impressora e a balanca conectadas, validando antes de salvar.");
  const [aiReply, setAiReply] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiActions, setAiActions] = useState<AiProposedAction[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const handledCommands = useRef(new Set<string>());
  const processingCommands = useRef(new Set<string>());
  const handledJobs = useRef(new Set<string>());
  const autoSessions = useRef(new Map<string, AutoSessionState>());
  const serviceNextPollMs = useRef(IDLE_SERVICE_POLL_MS);
  const serviceTicking = useRef(false);
  const realtimeConnected = useRef(false);
  const isEnrolled = Boolean(config.agentId && config.token);
  const scales = config.scales?.length ? config.scales : [config.scale];
  const printersConfig = config.printers?.length ? config.printers : [config.printer];

  useEffect(() => {
    loadConfig()
      .then((saved) => {
        if (saved) {
          const normalized = normalizeConfig({ ...saved, appVersion: VERSION });
          setConfig(normalized);
          if (JSON.stringify(normalized) !== JSON.stringify(saved)) {
            void saveConfig(normalized).catch(() => undefined);
          }
        }
        setStatus(saved?.agentId ? "Agente matriculado." : "Aguardando matricula.");
      })
      .catch((error) => setStatus(String(error)));
    void refreshDevices();
    ensureWindowsAutostart().catch(() => undefined);
  }, []);

  const defaultPrinter = printers.find((printer) => printer.isDefault) ?? printers[0];
  const sampleZpl = useMemo(() => [
    "^XA",
    "^CI28",
    "^PW799",
    "^LL480",
    "^FO35,30^A0N,42,42^FDKYBERFRIGO^FS",
    "^FO35,84^A0N,30,30^FDTESTE DE IMPRESSAO PRINTERFRIGO^FS",
    "^FO35,132^GB720,2,2^FS",
    "^FO35,165^A0N,32,32^FDPESO TESTE: 12,345 KG^FS",
    "^FO35,215^BY3^BCN,105,Y,N,N^FDTESTE-PRINTERFRIGO-0001^FS",
    "^FO35,360^A0N,24,24^FDSe esta etiqueta saiu, a fila Windows aceita ZPL RAW.^FS",
    "^XZ",
  ].join(""), []);

  async function refreshDevices() {
    const [serial, queues] = await Promise.all([
      listSerialPorts().catch(() => []),
      listPrinters().catch(() => []),
    ]);
    setPorts(serial);
    setPrinters(queues);
  }

  async function useDefaultPrinter(index: number) {
    const printer = defaultPrinter;
    if (!printer) {
      setStatus("Nenhuma impressora Windows encontrada. Instale a impressora no Windows e clique Atualizar.");
      return;
    }
    const nextPrinters = [...printersConfig];
    nextPrinters[index] = {
      ...nextPrinters[index],
      mode: "windows_spooler",
      queueName: printer.name,
      localId: printer.name,
      host: "",
    };
    await persist({ ...config, printer: nextPrinters[0], printers: nextPrinters });
    setStatus(`Impressora padrao selecionada: ${printer.name}.`);
  }

  async function persist(next = config) {
    setIsBusy(true);
    try {
      const normalized = normalizeConfig({ ...next, appVersion: VERSION });
      await saveConfig(normalized);
      setConfig(normalized);
      setStatus("Configuracao salva.");
    } finally {
      setIsBusy(false);
    }
  }

  async function enroll() {
    setIsBusy(true);
    try {
      const serverUrl = config.serverUrl.trim() || DEFAULT_SERVER_URL;
      if (import.meta.env.PROD && isLocalServerUrl(serverUrl)) {
        throw new Error(`URL KyberFrigo invalida para instalacao: use ${DEFAULT_SERVER_URL}`);
      }
      setStatus(`Matriculando em ${serverUrl}...`);
      const result = await enrollAgent(serverUrl, enrollCode, config.stationLabel);
      const next = {
        ...config,
        serverUrl,
        agentId: result.agentId,
        tenantId: result.tenantId,
        token: result.token,
        stationLabel: result.stationLabel || config.stationLabel,
      };
      const normalized = normalizeConfig(next);
      setConfig(normalized);
      await saveConfig(normalized);
      setStatus(`Matriculado como ${result.name}.`);
    } catch (error) {
      setStatus(errorMessage(error, "Falha na matricula."));
    } finally {
      setIsBusy(false);
    }
  }

  function updateScaleAt(index: number, patch: Partial<ScaleConfig>) {
    const nextScales = [...scales];
    nextScales[index] = { ...nextScales[index], ...patch };
    setConfig((prev) => ({ ...prev, scale: nextScales[0], scales: nextScales }));
  }

  function addScale() {
    setConfig((prev) => {
      const nextScales = [...(prev.scales?.length ? prev.scales : [prev.scale]), { ...defaultConfig.scale, port: "" }];
      return { ...prev, scales: nextScales };
    });
  }

  function removeScale(index: number) {
    setConfig((prev) => {
      const nextScales = (prev.scales?.length ? prev.scales : [prev.scale]).filter((_, itemIndex) => itemIndex !== index);
      const safeScales = nextScales.length > 0 ? nextScales : [{ ...defaultConfig.scale }];
      return { ...prev, scale: safeScales[0], scales: safeScales };
    });
  }

  function updatePrinterAt(index: number, patch: Partial<PrinterConfig>) {
    const nextPrinters = [...printersConfig];
    nextPrinters[index] = { ...nextPrinters[index], ...patch };
    setConfig((prev) => ({ ...prev, printer: nextPrinters[0], printers: nextPrinters }));
  }

  function addPrinter() {
    setConfig((prev) => {
      const nextPrinters = [...(prev.printers?.length ? prev.printers : [prev.printer]), { ...defaultConfig.printer, localId: `label-${Date.now()}` }];
      return { ...prev, printers: nextPrinters };
    });
  }

  function removePrinter(index: number) {
    setConfig((prev) => {
      const nextPrinters = (prev.printers?.length ? prev.printers : [prev.printer]).filter((_, itemIndex) => itemIndex !== index);
      const safePrinters = nextPrinters.length > 0 ? nextPrinters : [{ ...defaultConfig.printer }];
      return { ...prev, printer: safePrinters[0], printers: safePrinters };
    });
  }

  function scaleForSession(session: HardwareSession) {
    const localId = typeof session.context.scaleLocalId === "string" ? session.context.scaleLocalId : "";
    return scales.find((scale) => scale.port === localId) ?? config.scale;
  }

  function printerForLocalId(localId: string | null | undefined) {
    if (!localId) return config.printer;
    return printersConfig.find((printer) =>
      printer.localId === localId ||
      printer.queueName === localId ||
      printer.host === localId
    ) ?? config.printer;
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

  async function testPrinterAt(index: number) {
    setIsBusy(true);
    try {
      const printer = printersConfig[index] ?? config.printer;
      if (printer.mode === "windows_spooler" && !printer.queueName) {
        throw new Error("Selecione a fila Windows antes do teste de impressao.");
      }
      const result = await testPrintZpl(printer, sampleZpl);
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha no teste de impressao.");
    } finally {
      setIsBusy(false);
    }
  }

  async function reportPrintJob(jobId: string, nextStatus: "PRINTED" | "FAILED", error?: string) {
    if (!config.token) return;
    await reportPrintJobApi(config, { jobId, status: nextStatus, error });
  }

  async function syncReceivingConfig() {
    if (!config.token) {
      setStatus("Matricule o agente antes de sincronizar com KyberFrigo.");
      return;
    }
    const printer = config.printer;
    const scale = config.scale;
    const printerLocalId = printer.queueName || printer.localId || printer.host || "";
    const scaleLocalId = scale.port || (scale.mode === "simulated" ? "Balanca 1" : "");
    if (printer.mode === "windows_spooler" && !printer.queueName) {
      setStatus("Selecione a impressora Windows antes de sincronizar Receiving.");
      return;
    }
    if (printer.mode === "tcp_9100" && !printer.host) {
      setStatus("Informe IP/Host da impressora TCP antes de sincronizar Receiving.");
      return;
    }
    if (!scaleLocalId) {
      setStatus("Configure a balanca antes de sincronizar Receiving.");
      return;
    }

    setIsBusy(true);
    try {
      const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/hardware/agent/configure`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          weighingPointId: "receiving",
          printer: {
            name: printer.queueName || printer.host || printer.localId || "Impressora PRINTERFRIGO",
            mode: printer.mode,
            queueName: printer.queueName,
            host: printer.host,
            port: printer.port,
            localId: printerLocalId,
            type: "zebra",
            labelType: "custom",
          },
          scale: {
            name: scale.mode === "simulated" ? "Balanca simulada PRINTERFRIGO" : `Balanca ${scaleLocalId}`,
            port: scaleLocalId,
            localId: scaleLocalId,
            baudRate: scale.baudRate,
            parserRegex: scale.parserRegex,
            type: "other",
            protocol: "custom",
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Falha ao sincronizar Receiving no KyberFrigo.");
      setStatus("Receiving sincronizado no KyberFrigo. Forcar leitura ja deve capturar peso e imprimir etiqueta.");
    } catch (error) {
      setStatus(networkErrorMessage(error, config.serverUrl));
    } finally {
      setIsBusy(false);
    }
  }

  async function submitCapture(session: HardwareSession, weight: number, commandId: string) {
    if (!config.token) return;
    await submitCaptureApi(config, {
      captureId: `${session.id}-${commandId}`,
      sessionId: session.id,
      pointId: session.point_id,
      flow: session.flow,
      grossWeight: weight,
      stable: true,
      payload: { context: session.context },
    });
  }

  const serviceTick = useCallback(async (showStatus = false) => {
    if (!config.token) return;
    const result = await heartbeatOnce(config) as HeartbeatResult;
    const printJobs = result.printJobs ?? [];
    const sessions = result.sessions ?? [];
    const requestedPollMs = typeof result.nextPollMs === "number"
      ? result.nextPollMs
      : printJobs.length > 0 || sessions.length > 0
        ? ACTIVE_SERVICE_POLL_MS
        : IDLE_SERVICE_POLL_MS;
    const fallbackAwarePollMs = requestedPollMs === IDLE_SERVICE_POLL_MS && !realtimeConnected.current
      ? OFFLINE_REALTIME_IDLE_SERVICE_POLL_MS
      : requestedPollMs;
    serviceNextPollMs.current = Math.min(MAX_SERVICE_POLL_MS, Math.max(MIN_SERVICE_POLL_MS, fallbackAwarePollMs));

    for (const job of printJobs) {
      if (handledJobs.current.has(job.id)) continue;
      handledJobs.current.add(job.id);
      try {
        const zpl = job.payload?.zpl;
        if (!zpl) throw new Error("Job sem payload ZPL.");
        await testPrintZpl(printerForLocalId(job.printer_local_id), zpl);
        await reportPrintJob(job.id, "PRINTED");
      } catch (error) {
        await reportPrintJob(job.id, "FAILED", error instanceof Error ? error.message : "Falha ao imprimir.");
      }
    }

    for (const session of sessions) {
      const commandId = session.command?.id;
      if (
        session.command?.type !== "REQUEST_CAPTURE" ||
        !commandId ||
        handledCommands.current.has(commandId) ||
        processingCommands.current.has(commandId)
      ) continue;
      processingCommands.current.add(commandId);
      try {
        const scale = scaleForSession(session);
        const weight = await readScaleOnce(scale);
        setLastWeight(weight);
        if (weight < scale.minWeightKg) {
          handledCommands.current.add(commandId);
          throw new Error(`Peso ${weight.toFixed(3)} kg abaixo do minimo ${scale.minWeightKg.toFixed(3)} kg.`);
        }
        await submitCapture(session, weight, commandId);
        handledCommands.current.add(commandId);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Falha ao capturar peso.");
      } finally {
        processingCommands.current.delete(commandId);
      }
    }

    for (const session of sessions) {
      if (session.mode !== "AUTO" || session.status !== "ACTIVE") continue;
      const state = autoSessions.current.get(session.id) ?? { samples: [], waitingZero: false, lastCapturedAt: 0 };
      const scale = scaleForSession(session);
      const weight = await readScaleOnce(scale);
      setLastWeight(weight);

      if (weight <= scale.zeroThresholdKg) {
        state.waitingZero = false;
        state.samples = [];
        autoSessions.current.set(session.id, state);
        continue;
      }

      state.samples = [...state.samples, weight].slice(-Math.max(2, scale.stableWindow));
      const cooldownElapsed = Date.now() - state.lastCapturedAt >= scale.cooldownMs;
      if (
        !state.waitingZero &&
        cooldownElapsed &&
        weight >= scale.minWeightKg &&
        state.samples.length >= Math.max(2, scale.stableWindow) &&
        isStable(state.samples, scale.stableThresholdKg)
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
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      if (cancelled) return;
      if (serviceTicking.current) {
        schedule(serviceNextPollMs.current);
        return;
      }

      serviceTicking.current = true;
      try {
        await serviceTick();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Falha no servico.");
        serviceNextPollMs.current = IDLE_SERVICE_POLL_MS;
      } finally {
        serviceTicking.current = false;
        schedule(serviceNextPollMs.current);
      }
    };

    schedule(1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isEnrolled, serviceTick]);

  useEffect(() => {
    if (!isEnrolled || !config.token || !config.agentId) return;

    let cancelled = false;
    let refreshTimer: number | undefined;
    let wakeTimer: number | undefined;
    let client: ReturnType<typeof createClient> | undefined;

    const wakeService = () => {
      if (wakeTimer !== undefined) window.clearTimeout(wakeTimer);
      wakeTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (serviceTicking.current) return;
        serviceTicking.current = true;
        serviceTick()
          .catch((error) => {
            setStatus(error instanceof Error ? error.message : "Falha ao processar evento Realtime.");
          })
          .finally(() => {
            serviceTicking.current = false;
          });
      }, 150);
    };

    const connect = async () => {
      try {
        if (client) {
          await client.removeAllChannels();
          client.realtime.disconnect();
          client = undefined;
        }

        const realtime = await fetchRealtimeToken(config);
        if (cancelled) return;

        client = createClient(realtime.supabaseUrl, realtime.publishableKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
          realtime: {
            params: {
              eventsPerSecond: 5,
            },
          },
        });
        client.realtime.setAuth(realtime.token);

        client
          .channel(`hardware-agent-${realtime.agentId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "hardware_sessions", filter: `agent_id=eq.${realtime.agentId}` },
            wakeService,
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "hardware_print_jobs", filter: `agent_id=eq.${realtime.agentId}` },
            wakeService,
          )
          .subscribe((status) => {
            if (cancelled) return;
            if (status === "SUBSCRIBED") {
              realtimeConnected.current = true;
              setStatus("Realtime conectado. Polling ficou como fallback.");
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              realtimeConnected.current = false;
              setStatus("Realtime indisponivel. Usando polling de fallback.");
            }
          });

        const refreshDelay = Math.max(
          30000,
          new Date(realtime.expiresAt).getTime() - Date.now() - REALTIME_TOKEN_REFRESH_MARGIN_MS,
        );
        refreshTimer = window.setTimeout(connect, refreshDelay);
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : "Falha ao conectar Realtime.");
        realtimeConnected.current = false;
        refreshTimer = window.setTimeout(connect, IDLE_SERVICE_POLL_MS);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (wakeTimer !== undefined) window.clearTimeout(wakeTimer);
      if (client) {
        void client.removeAllChannels();
        client.realtime.disconnect();
      }
      realtimeConnected.current = false;
    };
  }, [config.agentId, config.serverUrl, config.token, isEnrolled, serviceTick]);

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
      const message = "Desbloqueie a area Admin IA com a senha de admin antes de conversar com a IA.";
      setAiError(message);
      setAiReply("");
      setAiActions([]);
      setStatus(message);
      return;
    }
    if (!config.token) {
      const message = "Matricule o PRINTERFRIGO no KyberFrigo antes de usar a IA. Gere um codigo em Ajustes > Pontos de Pesagem e informe no onboarding.";
      setAiError(message);
      setAiReply("");
      setAiActions([]);
      setStatus(message);
      return;
    }
    if (!aiInput.trim()) {
      const message = "Digite o pedido para a IA antes de diagnosticar.";
      setAiError(message);
      setAiReply("");
      setAiActions([]);
      setStatus(message);
      return;
    }
    setAiBusy(true);
    setAiError("");
    setAiReply("Consultando IA admin...");
    setAiActions([]);
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
      setAiError("");
      setAiActions(Array.isArray(payload.proposedActions) ? payload.proposedActions : []);
      setStatus("IA gerou diagnostico e acoes propostas.");
    } catch (error) {
      const message = networkErrorMessage(error, config.serverUrl);
      setAiError(message);
      setAiReply("");
      setAiActions([]);
      setStatus(message);
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
        setConfig(normalizeConfig(next));
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
      const message = networkErrorMessage(error, config.serverUrl);
      setAiError(message);
      setStatus(message);
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
          {scales.map((scale, index) => (
            <div className="device-box" key={`${scale.port}-${index}`}>
              <div className="row spread">
                <strong>{scaleLabel(scale, index)}</strong>
                {scales.length > 1 && <button onClick={() => removeScale(index)} disabled={isBusy}>Remover</button>}
              </div>
              <label>Modo</label>
              <select value={scale.mode ?? "serial"} onChange={(e) => updateScaleAt(index, {
                mode: e.target.value as ScaleConfig["mode"],
                port: e.target.value === "simulated" ? (scale.port || "Balanca 1") : "",
              })}>
                <option value="serial">Serial real</option>
                <option value="simulated">Simulada para teste</option>
              </select>
              {scale.mode === "simulated" ? (
                <>
                  <label>ID local</label>
                  <input value={scale.port} onChange={(e) => updateScaleAt(index, { port: e.target.value })} placeholder="Ex: Balanca 1" />
                  <label>Peso simulado kg</label>
                  <input type="number" step="0.001" value={scale.simulatedWeightKg ?? 12.345} onChange={(e) => updateScaleAt(index, { simulatedWeightKg: Number(e.target.value) })} />
                </>
              ) : (
                <>
                  <label>Porta serial</label>
                  <select value={scale.port} onChange={(e) => updateScaleAt(index, { port: e.target.value })}>
                    <option value="">Selecionar porta</option>
                    {ports.map((port) => <option key={port.name} value={port.name}>{port.name} - {port.kind}</option>)}
                  </select>
                </>
              )}
              <div className="split">
                <div><label>Baud</label><input type="number" value={scale.baudRate} onChange={(e) => updateScaleAt(index, { baudRate: Number(e.target.value) })} /></div>
                <div><label>Peso minimo kg</label><input type="number" value={scale.minWeightKg} onChange={(e) => updateScaleAt(index, { minWeightKg: Number(e.target.value) })} /></div>
              </div>
              <label>Regex parser</label>
              <input value={scale.parserRegex} onChange={(e) => updateScaleAt(index, { parserRegex: e.target.value })} />
            </div>
          ))}
          <button className="add-device-button" onClick={addScale} disabled={isBusy}>Adicionar balanca</button>
          <label>Frame de teste</label>
          <div className="row">
            <input value={scaleFrame} onChange={(e) => setScaleFrame(e.target.value)} />
            <button onClick={testParser}>Testar</button>
          </div>
          <p className="reading">{lastWeight === null ? "--" : `${lastWeight.toFixed(3)} kg`}</p>
        </div>

        <div className="panel">
          <h2><Printer size={18} /> Impressora</h2>
          <p className="muted">Caminho recomendado: instale a Zebra/Elgin no Windows, clique em Atualizar, use a impressora padrao e imprima uma etiqueta de teste.</p>
          {printersConfig.map((printer, index) => (
            <div className="device-box" key={`${printer.localId}-${index}`}>
              <div className="row spread">
                <strong>{printerLabel(printer, index)}</strong>
                {printersConfig.length > 1 && <button onClick={() => removePrinter(index)} disabled={isBusy}>Remover</button>}
              </div>
              <label>Modo</label>
              <select value={printer.mode} onChange={(e) => updatePrinterAt(index, { mode: e.target.value as StationConfig["printer"]["mode"] })}>
                <option value="windows_spooler">Fila Windows</option>
                <option value="tcp_9100">TCP/IP 9100</option>
                <option value="dry_run">Dry-run .zpl</option>
              </select>
              {printer.mode === "windows_spooler" && (
                <>
                  <label>Impressora instalada no Windows</label>
                  <select value={printer.queueName ?? ""} onChange={(e) => updatePrinterAt(index, { queueName: e.target.value, localId: e.target.value || printer.localId })}>
                    <option value="">Selecionar impressora</option>
                    {printers.map((item) => <option key={item.name} value={item.name}>{item.name}{item.isDefault ? " (padrao)" : ""}</option>)}
                  </select>
                  <p className="tip">Este nome precisa bater com a fila instalada no Windows. O PRINTERFRIGO envia ZPL RAW direto para essa fila.</p>
                  <div className="row action-row">
                    <button onClick={() => useDefaultPrinter(index)} disabled={isBusy || !defaultPrinter}>Usar impressora padrao</button>
                    <button onClick={() => testPrinterAt(index)} disabled={isBusy || !printer.queueName}>Imprimir etiqueta teste</button>
                  </div>
                </>
              )}
              {printer.mode === "tcp_9100" && (
                <div className="split">
                  <div><label>IP/Host da impressora</label><input value={printer.host ?? ""} onChange={(e) => updatePrinterAt(index, { host: e.target.value, localId: e.target.value || printer.localId })} placeholder="Ex: 192.168.0.50" /></div>
                  <div><label>Porta TCP</label><input type="number" value={printer.port ?? 9100} onChange={(e) => updatePrinterAt(index, { port: Number(e.target.value) })} /></div>
                </div>
              )}
              {printer.mode === "dry_run" && (
                <>
                  <label>ID local</label>
                  <input value={printer.localId} onChange={(e) => updatePrinterAt(index, { localId: e.target.value })} placeholder="Ex: label-01" />
                  <p className="tip">Modo teste sem impressora. Salva arquivos .zpl em AppData/PRINTERFRIGO/dry-run.</p>
                  <button onClick={() => testPrinterAt(index)} disabled={isBusy}>Gerar etiqueta teste .zpl</button>
                </>
              )}
            </div>
          ))}
          <button className="add-device-button" onClick={addPrinter} disabled={isBusy}>Adicionar impressora</button>
          <div className="row">
            <button onClick={refreshDevices}><RefreshCw size={15} /> Atualizar</button>
          </div>
        </div>

        <div className="panel">
          <h2><PlugZap size={18} /> Servico</h2>
          <p className="muted">Versao {VERSION}. O update Tauri fica bloqueado operacionalmente enquanto houver sessao ativa no KyberFrigo.</p>
          <div className="actions">
            <button onClick={() => persist()} disabled={isBusy}><Save size={15} /> Salvar</button>
            <button onClick={heartbeat} disabled={!isEnrolled || isBusy}>Heartbeat</button>
            <button onClick={syncReceivingConfig} disabled={!isEnrolled || isBusy}>Sincronizar Receiving</button>
          </div>
          <p className="tip">Use depois de escolher impressora/balanca. Isto vincula a estacao ao ponto Receiving no KyberFrigo.</p>
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
              {aiError && <pre className="ai-error">{aiError}</pre>}
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
