import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const appPath = new URL("../src/App.tsx", import.meta.url);

// O modulo so tem sintaxe apagavel (`import type`, anotacoes), entao o type
// stripping nativo do Node carrega o arquivo .ts direto — o teste exercita a
// regra real, sem copia nem transpilador no meio.
const autoCapture = await import("../src/auto-capture.ts");
const autoCaptureSource = await readFile(new URL("../src/auto-capture.ts", import.meta.url), "utf8");

/** Estacao de trilho da ESS: gancho de 8 kg que nunca sai da celula de carga. */
const RAIL_SCALE = { emptyWeightKg: 8, minWeightKg: 10, zeroThresholdKg: 0.25 };
/** Bancada comum: zera de verdade e ninguem configurou peso de base. */
const BENCH_SCALE = { emptyWeightKg: 0, minWeightKg: 1, zeroThresholdKg: 0.25 };

/**
 * Roda a maquina de estados da captura automatica sobre uma sequencia de
 * leituras estaveis e devolve o que teria virado etiqueta.
 */
function runAutoCapture(readings, scale) {
  const state = { armed: true, lastCapturedWeight: null };
  const captured = [];
  for (const weight of readings) {
    if (!state.armed) {
      if (autoCapture.hasReleasedPiece(weight, state.lastCapturedWeight, scale)) {
        state.armed = true;
        state.lastCapturedWeight = null;
      }
      continue;
    }
    if (!autoCapture.hasPieceOnScale(weight, scale)) continue;
    captured.push(weight);
    state.lastCapturedWeight = weight;
    state.armed = false;
  }
  return captured;
}
const apiPath = new URL("../src/api.ts", import.meta.url);
const queuePath = new URL("../src-tauri/src/queue.rs", import.meta.url);

test("automatic capture uses lease, cooldown, and release-based rearm", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("AUTO_SESSION_LEASE_TIMEOUT_MS"), "auto capture must ignore stale browser sessions");
  assert.ok(source.includes("hasFreshAutoSessionLease(session"), "auto loop must check the browser lease before weighing");
  assert.ok(source.includes("lastCapturedWeight"), "auto loop must remember the last captured weight");
  assert.ok(source.includes("cooldownElapsed"), "auto loop must keep cooldown protection");
  assert.ok(source.includes("AUTO_POLL_MS"), "auto polling must have its own faster poll interval");
  assert.ok(source.includes("hasAutoSession"), "auto polling must accelerate when auto sessions are active");
  assert.equal(source.includes("stableWindow: 5"), false, "default stability window must not keep the old slow value");
});

test("only the piece LEAVING the scale rearms the next capture", async () => {
  const source = await readFile(appPath, "utf8");

  // O rearme por variacao de peso rendeu 5 etiquetas para uma carcaca na ESS em
  // 11/08/2026 (53,9 / 53,7 / 52,9 / 53,0 / 52,9 kg em 11,7 s): a peca assenta
  // escorrendo e passa dos 100 g a cada leitura. E o rearme por zero absoluto
  // nunca acontece num trilho, onde o gancho de ~8 kg fica na celula de carga.
  assert.equal(
    source.includes("hasMeaningfulWeightChange"),
    false,
    "weight change must not rearm capture — a settling carcass changes weight all the time",
  );
  assert.equal(
    source.includes("sawZeroSinceCapture"),
    false,
    "absolute zero never happens on a rail scale; the hook stays on the load cell",
  );
  assert.ok(source.includes('from "./auto-capture"'), "the rule must live in its own module, loadable by the tests");
  assert.ok(source.includes("state.armed"), "the auto loop must hold a disarmed state until the piece leaves");
  assert.ok(
    /if \(!state\.armed\) \{[\s\S]*?hasReleasedPiece\(weight, state\.lastCapturedWeight, scale\)[\s\S]*?continue;/.test(source),
    "a disarmed session must only rearm through hasReleasedPiece, and capture nothing meanwhile",
  );

  const release = autoCaptureSource.match(/export function hasReleasedPiece[\s\S]*?\n\}/);
  assert.ok(release, "hasReleasedPiece must be readable as a block");
  assert.ok(
    release[0].includes("emptyWeight + scale.zeroThresholdKg"),
    "returning to the empty-scale weight (hook included) must rearm",
  );
  assert.ok(
    release[0].includes("lastCapturedWeight * (1 - RELEASE_DROP_RATIO)"),
    "a big relative drop must rearm too, for stations that never configured the hook weight",
  );
  assert.ok(
    /export const RELEASE_DROP_RATIO = 0\.[1-9]/.test(autoCaptureSource),
    "the release ratio must be an explicit constant, not a magic number in the loop",
  );
});

test("the empty-scale weight is a configured property of the station", async () => {
  const source = await readFile(appPath, "utf8");
  const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

  // Numa balanca de trilho a balanca nunca esta em zero: o gancho fica nela. Sem
  // dizer isso, "peso minimo" mede o gancho junto e a estacao etiqueta o gancho
  // vazio — foi o que gerou volumes de 8,0 e 8,1 kg no recebimento da ESS.
  assert.ok(typesSource.includes("emptyWeightKg"), "the scale config type must carry the empty-scale weight");
  assert.ok(source.includes("emptyWeightKg: 0"), "the default must keep today's behaviour for scales that zero out");
  assert.ok(autoCaptureSource.includes("export function emptyWeightOf"), "reading the empty weight must go through one helper");
  assert.ok(autoCaptureSource.includes("export function hasPieceOnScale"), "there must be one place deciding a piece is on the scale");
  assert.ok(
    /emptyWeightOf\(scale\) \+ scale\.minWeightKg/.test(autoCaptureSource),
    "the minimum weight must be measured above the hook, not from zero",
  );
  assert.ok(source.includes("Peso do gancho/base kg</FieldLabel>"), "the operator must be able to set it on the station screen");
});

test("stabilisation happens natively instead of one sample per service tick", async () => {
  const source = await readFile(appPath, "utf8");
  const apiSource = await readFile(apiPath, "utf8");

  // Uma amostra por tick custava o poll (1s) + o round-trip HTTP do heartbeat +
  // abrir/fechar a serial, entao fechar peso levava dezenas de segundos. A
  // estabilizacao inteira precisa acontecer numa unica chamada nativa.
  assert.ok(apiSource.includes("read_scale_stable"), "frontend API must expose the native stabilised read");
  assert.ok(source.includes("await readScaleStable(scale)"), "auto loop must stabilise inside a single native call");
  assert.equal(
    source.includes("state.samples"),
    false,
    "auto loop must not rebuild the stability window across service ticks",
  );
  assert.ok(source.includes("reading.stable"), "auto loop must only capture readings the native layer marked stable");
});

test("scale read failures do not park the service loop", async () => {
  const source = await readFile(appPath, "utf8");

  // Um frame instavel (TI200 responde III,III enquanto a peca balanca) lancava
  // erro, derrubava o serviceTick inteiro e jogava o polling para o intervalo
  // ocioso de 5 min; a pesagem seguinte so acontecia quando o Realtime
  // acordasse o agente.
  const loopMatch = source.match(/reading = await readScaleStable\(scale\);[\s\S]*?continue;/);
  assert.ok(loopMatch, "auto loop must guard the scale read with its own try/catch");
  assert.ok(/\}\s*catch \(error\) \{/.test(loopMatch[0]), "scale read failure must be caught inside the session loop");
  assert.ok(
    /serviceNextPollMs\.current = hasAutoSessionRef\.current\s*\?\s*ACTIVE_SERVICE_POLL_MS\s*:\s*IDLE_SERVICE_POLL_MS/.test(source),
    "service errors must not fall back to the idle poll while an auto session is open",
  );
});

test("automatic capture ids are unique beyond millisecond timestamps", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("makeAutoCaptureKey"), "auto capture must use a dedicated id helper");
  assert.ok(source.includes("crypto.randomUUID"), "auto capture id should use UUID when available");
  assert.equal(source.includes("`auto-${Date.now()}`"), false, "auto capture id must not rely only on Date.now");
});

test("print jobs can retry without duplicate local suppression", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("processingJobs"), "print job loop must only suppress concurrent processing");
  assert.ok(source.includes("printedJobs"), "print job loop must remember labels already printed while confirmation is pending");
  assert.ok(source.includes("printedJobs.current.has(job.id)"), "already printed jobs must be confirmed without reprinting");
  assert.equal(source.includes("handledJobs"), false, "failed jobs must not be permanently skipped in memory");
});

test("printed jobs are saved locally before remote acknowledgement", async () => {
  const appSource = await readFile(appPath, "utf8");
  const apiSource = await readFile(apiPath, "utf8");
  const queueSource = await readFile(queuePath, "utf8");

  assert.ok(apiSource.includes("savePendingPrintJobReport"), "frontend API must expose local pending print report storage");
  assert.ok(queueSource.includes('"print_job_report"'), "SQLite queue must persist print-job reports");
  assert.ok(appSource.includes("savePendingPrintJobReport(job.id, \"PRINTED\")"), "app must save PRINTED locally before reporting to Kyber");
  assert.ok(appSource.includes("pendingPrintReportsByJobId"), "app must detect locally printed jobs returned by heartbeat");
  assert.ok(appSource.includes("deletePendingPrintJobReport(jobId)"), "app must clear local print reports after Kyber accepts them");
});

test("captures are saved locally before remote submission", async () => {
  const appSource = await readFile(appPath, "utf8");
  const apiSource = await readFile(apiPath, "utf8");
  const queueSource = await readFile(queuePath, "utf8");

  assert.ok(apiSource.includes("savePendingCaptureSubmit"), "frontend API must expose local pending capture storage");
  assert.ok(queueSource.includes('"capture_submit"'), "SQLite queue must persist capture submissions");
  assert.ok(appSource.includes("savePendingCaptureSubmit(captureId"), "app must save capture locally before sending it to Kyber");
  assert.ok(appSource.includes("flushPendingCaptures"), "app must retry locally saved captures when service ticks");
  assert.ok(appSource.includes("deletePendingCaptureSubmit(captureId)"), "app must clear local capture after Kyber accepts it");
});

test("advanced automatic capture thresholds are configurable in the station UI", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("stableWindow"), "stability sample window must stay configurable");
  assert.ok(source.includes("stableThresholdKg"), "stability tolerance must stay configurable");
  assert.ok(source.includes("cooldownMs"), "cooldown must stay configurable");
  assert.ok(source.includes("zeroThresholdKg"), "zero threshold must stay configurable");
});

test("station fields include short operator help tooltips", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("function FieldLabel"), "UI must use a shared label helper for field help");
  assert.ok(source.includes('className="help-tip"'), "field help must render visible question-mark tips");
  assert.ok(source.includes('Peso minimo kg</FieldLabel>'), "minimum weight field must explain capture threshold");
  assert.ok(
    /help=\{scale\.stabilityMode === "window"[\s\S]{0,400}"Amostras minimas" : "Confirmacoes \/ amostras"\}<\/FieldLabel>/.test(source),
    "the confirmation/sample field must have operator help and name itself after the criterion in use",
  );
  assert.ok(source.includes('Criterio de estabilidade</FieldLabel>'), "the stability criterion selector must have operator help");
  assert.ok(source.includes('Tolerancia kg</FieldLabel>'), "stability tolerance field must have operator help");
  assert.ok(source.includes('Estabilidade ms</FieldLabel>'), "stability period field must have operator help");
  assert.ok(source.includes('Tempo limite ms</FieldLabel>'), "stabilisation timeout field must have operator help");
  assert.ok(source.includes('Cooldown ms</FieldLabel>'), "cooldown field must have operator help");
  assert.ok(source.includes('Zero kg</FieldLabel>'), "zero threshold field must have operator help");
});

test("auto capture rearms the last-captured weight before submit to avoid duplicate volumes on retry", async () => {
  const source = await readFile(appPath, "utf8");

  // The auto-capture loop must mark lastCapturedWeight/lastCapturedAt BEFORE
  // awaiting submitCapture, otherwise a transient send failure (network/timeout)
  // leaves the state clean and flushPendingCaptures re-submits the same piece
  // with a brand-new captureId, creating a duplicate volume.
  const loopMatch = source.match(/if \(reading\.stable && cooldownElapsed[\s\S]*?autoSessions\.current\.set\(session\.id, state\);/);
  assert.ok(loopMatch, "auto-capture must keep the state update inside the per-session block");
  const block = loopMatch[0];
  const stateUpdateIndex = block.search(/state\.lastCapturedWeight\s*=\s*weight/);
  const submitIndex = block.search(/await submitCapture\(session, weight, makeAutoCaptureKey\(\)\);/);
  assert.ok(stateUpdateIndex >= 0, "auto-capture must update lastCapturedWeight inside the block");
  assert.ok(submitIndex >= 0, "auto-capture must await submitCapture inside the block");
  assert.ok(
    stateUpdateIndex < submitIndex,
    "lastCapturedWeight must be set before submitCapture so retry-via-pending-queue does not duplicate the volume",
  );
  assert.ok(
    /try\s*\{[\s\S]*await submitCapture\(session, weight, makeAutoCaptureKey\(\)\);[\s\S]*\}\s*catch/.test(block),
    "auto-capture must catch submitCapture errors so state stays consistent and flushPendingCaptures can retry",
  );
});

test("updates only ever install from an explicit click", async () => {
  const source = await readFile(appPath, "utf8");
  const libPath = new URL("../src-tauri/src/lib.rs", import.meta.url);
  const libSource = await readFile(libPath, "utf8");

  // A estacao fica num ponto de pesagem: uma atualizacao disparada sozinha
  // reinicia o app no meio do recebimento. Instalar so pode partir do botao.
  assert.ok(source.includes("async function confirmUpdate()"), "install must live behind its own confirm handler");
  const installCalls = source.match(/await installUpdate\(\)/g) ?? [];
  assert.equal(installCalls.length, 1, "installUpdate must have exactly one call site");

  const confirmBlock = source.match(/async function confirmUpdate\(\)[\s\S]*?\n  \}/);
  assert.ok(confirmBlock, "confirmUpdate must be readable as a block");
  assert.ok(
    confirmBlock[0].includes("await installUpdate()"),
    "the only installUpdate call must sit inside confirmUpdate",
  );
  assert.ok(
    /if \(updateCheck\.status !== "available"\) return;/.test(confirmBlock[0]),
    "confirmUpdate must refuse to install unless a check found a newer version",
  );

  // Nenhum useEffect pode chamar a checagem ou a instalacao no arranque.
  for (const effect of source.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/g) ?? []) {
    assert.equal(effect.includes("installUpdate"), false, "no effect may install an update on its own");
    assert.equal(effect.includes("handleCheckUpdate"), false, "no effect may check for updates on its own");
  }

  // O plugin do Tauri tambem nao pode instalar por conta propria no setup.
  assert.equal(
    /download_and_install/.test(libSource.replace(/async fn install_update[\s\S]*?\n\}/, "")),
    false,
    "download_and_install must only exist inside the install_update command",
  );
});

test("the topbar version button drives the manual update flow", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("version-badge-button"), "the current version must be a clickable button in the topbar");
  assert.ok(
    /version-badge-button[\s\S]{0,240}onClick=\{\(\) => void handleCheckUpdate\(\)\}/.test(source),
    "clicking the version button must re-run the check",
  );
  assert.ok(source.includes('updateCheck.status === "available"'), "a newer version must surface an update action");
  assert.ok(source.includes("Atualizar para "), "the update action must name the target version");
  assert.ok(source.includes("dismissUpdateCheck"), "the operator must be able to dismiss the prompt without updating");
});

test("the scale response deadline cannot be set below what a serial indicator needs", async () => {
  const appSource = await readFile(appPath, "utf8");
  const hardwarePath = new URL("../src-tauri/src/hardware.rs", import.meta.url);
  const hardwareSource = await readFile(hardwarePath, "utf8");

  // A v0.5.6 saiu com 60ms de prazo de resposta. O TI200 nao responde a um ENQ
  // nesse tempo — o caminho antigo lhe dava 250ms de sleep mais 1500ms de
  // timeout. Resultado: toda amostra estourava, a janela nunca acumulava, e as
  // 221 capturas do recebimento foram gravadas com stable=false.
  assert.ok(hardwareSource.includes("MIN_RESPONSE_WAIT_MS"), "Rust must floor the response deadline");
  assert.ok(
    /const MIN_RESPONSE_WAIT_MS: u64 = (2[5-9][0-9]|[3-9][0-9]{2}|[0-9]{4,});/.test(hardwareSource),
    "the response deadline floor must be at least 250 ms",
  );
  assert.ok(
    /const SERIAL_POLL_MS: u64 = \d+;/.test(hardwareSource),
    "the port poll step must be its own constant, separate from the response deadline",
  );

  // Configuracao ja salva na estacao precisa ser corrigida ao carregar, senao
  // atualizar o app nao resolve nada.
  assert.ok(appSource.includes("repairSampleInterval"), "saved configs must be repaired on load");
  assert.ok(
    /const MIN_SAMPLE_INTERVAL_MS = (2[5-9][0-9]|[3-9][0-9]{2}|[0-9]{4,});/.test(appSource),
    "the frontend floor must match the Rust one",
  );
  assert.ok(
    /repairSampleInterval\(\{ \.\.\.defaultConfig\.scale, \.\.\.scale \}\)/.test(appSource),
    "every scale in the list must be repaired, not just the primary one",
  );
  assert.equal(appSource.includes("sampleIntervalMs: 60"), false, "the broken default must be gone");
});

test("a lost frame does not wipe the stability window", async () => {
  const hardwarePath = new URL("../src-tauri/src/hardware.rs", import.meta.url);
  const hardwareSource = await readFile(hardwarePath, "utf8");

  // Zerar a janela a cada falha de transporte fazia uma balanca so um pouco
  // mais lenta nunca estabilizar: cada amostra atrasada apagava as boas.
  const errorArm = hardwareSource.match(/Err\(err\) => \{[\s\S]*?samples\.clear\(\);[\s\S]*?last_error = Some\(err\);/);
  assert.ok(errorArm, "the sampling loop must still handle read errors");
  assert.ok(
    /if err\.contains\("instavel"\)[\s\S]*?\{\s*\n\s*samples\.clear\(\);/.test(errorArm[0]),
    "only an indicator-declared instability may clear the window",
  );
});

test("stability can come from the indicator itself, confirmed by a couple of readings", async () => {
  const appSource = await readFile(appPath, "utf8");
  const hardwarePath = new URL("../src-tauri/src/hardware.rs", import.meta.url);
  const hardwareSource = await readFile(hardwarePath, "utf8");

  // O TI200 responde III,III enquanto a peca se move e so devolve numero
  // quando trava o peso. Medir variancia por 1,2s aqui repete um trabalho que
  // o indicador ja fez, e cobra esse tempo em cada carcaca.
  assert.ok(hardwareSource.includes("evaluate_indicator_stability"), "there must be an indicator-driven criterion");
  assert.ok(
    /let trusts_indicator = trusts_indicator_signal\(&config\);/.test(hardwareSource),
    "the criterion must be resolved per scale, not hardcoded in the reading loop",
  );
  assert.ok(
    /if now_ms\.saturating_sub\(oldest\.at_ms\) > max_span_ms/.test(hardwareSource),
    "stale readings must not confirm each other",
  );
  assert.ok(
    /let needed = confirmations\.max\(2\);/.test(hardwareSource),
    "a single reading must never be enough, whatever the config says",
  );
  assert.ok(appSource.includes('stabilityMode: "auto"'), "the app default must resolve the criterion per protocol");
});

test("only protocols that report motion are trusted to declare stability", async () => {
  const appSource = await readFile(appPath, "utf8");
  const hardwarePath = new URL("../src-tauri/src/hardware.rs", import.meta.url);
  const hardwareSource = await readFile(hardwarePath, "utf8");

  // Cada balanca responde de um jeito. Um regex generico casa QUALQUER frame,
  // inclusive no meio do balanco: ali "frame numerico" nao significa "peso
  // parado", e confiar nisso capturaria peso errado.
  assert.ok(hardwareSource.includes("fn parser_declares_motion"), "there must be one place deciding this per protocol");
  assert.ok(
    /_ => parser_declares_motion\(&config\.parser_regex\),/.test(hardwareSource),
    "the default must fall back to the protocol check, not to blanket trust",
  );

  // Config antiga (sem o campo) e qualquer valor desconhecido caem no caminho
  // seguro, e nao em "confia sempre".
  const resolver = hardwareSource.match(/pub fn trusts_indicator_signal[\s\S]*?\n\}/);
  assert.ok(resolver, "the resolver must be readable as a block");
  assert.ok(/"indicator" => true/.test(resolver[0]), "explicit indicator mode must stay available");
  assert.ok(/"window" => false/.test(resolver[0]), "explicit window mode must stay available");
  assert.equal(
    /_ => true/.test(resolver[0]),
    false,
    "an unknown or empty mode must never mean blanket trust",
  );

  assert.ok(appSource.includes('value="auto"'), "the operator must be able to pick the automatic criterion");
  assert.ok(appSource.includes('value="window"'), "the operator must be able to force the measured criterion");
});

test("a forced capture is refused when the scale never confirmed the weight", async () => {
  const source = await readFile(appPath, "utf8");

  // Peso nao confirmado virando volume e peso errado em nota fiscal. Repetir o
  // clique custa segundos; corrigir o volume depois custa muito mais.
  const manualBlock = source.match(/const reading = await readScaleStable\(scale\);[\s\S]*?await submitCapture\(session, weight, commandId, reading\.stable\);/);
  assert.ok(manualBlock, "the forced-capture path must be readable as a block");
  const refusalIndex = manualBlock[0].search(/if \(!reading\.stable\) \{/);
  const submitIndex = manualBlock[0].search(/await submitCapture/);
  assert.ok(refusalIndex >= 0, "the forced-capture path must check the stable flag");
  assert.ok(refusalIndex < submitIndex, "the refusal must come before the submit");
  assert.ok(
    /throw new Error\(\s*`Balanca ainda em movimento/.test(manualBlock[0]),
    "the operator must be told why nothing was captured",
  );
  assert.ok(
    /handledCommands\.current\.add\(commandId\);[\s\S]{0,600}throw new Error\(\s*`Balanca ainda em movimento/.test(manualBlock[0]),
    "the refused command must be marked handled so it does not capture on its own once the piece settles",
  );
});

test("the indicator triggers the capture but the window confirms the weight", async () => {
  const hardwarePath = new URL("../src-tauri/src/hardware.rs", import.meta.url);
  const hardwareSource = await readFile(hardwarePath, "utf8");

  // O TI200 declara peso travado a cada pausa da carcaca, e uma carcaca no
  // trilho pausa varias vezes enquanto assenta. Confiar so nele e rapido e
  // errado; medir so aqui e certo e lento. Os dois juntos sao rapidos e certos:
  // a janela so comeca a fechar depois que o indicador ja travou.
  const loop = hardwareSource.match(/let window_settled = evaluate_stability\([\s\S]*?\};/);
  assert.ok(loop, "the reading loop must evaluate the time window on every sample");
  assert.ok(
    /evaluate_indicator_stability\([\s\S]*?\)\s*\.and\(window_settled\)/.test(loop[0]),
    "indicator mode must ALSO require the time window, not replace it",
  );
  assert.ok(
    /\} else \{\s*\n\s*window_settled\s*\n\s*\};/.test(loop[0]),
    "the measured criterion must stay untouched for scales that never declare motion",
  );

  // A tolerancia sozinha aceita o assentamento: numa balanca de 100 g de
  // divisao cada degrau cabe nela. A deriva entre as metades da janela e o que
  // separa peso parado de peso ainda caindo.
  assert.ok(hardwareSource.includes("pub fn window_drift_kg"), "there must be a drift check on the window");
  assert.ok(
    /if window_drift_kg\(&window\) > threshold_kg \/ 2\.0/.test(hardwareSource),
    "evaluate_stability must refuse a window that is still walking in one direction",
  );
});

test("the station keeps the settling window it was configured with", async () => {
  const source = await readFile(appPath, "utf8");

  // stableMs existia e era ignorado no modo indicador. Voltando a valer, ele e
  // o tempo que a peca precisa ficar sem andar — o campo que o operador ajusta
  // se a carcaca da planta dele assenta mais devagar.
  assert.ok(source.includes("Estabilidade ms</FieldLabel>"), "the settling window must stay on the station screen");
  assert.equal(
    /Estabilidade ms<\/FieldLabel><input[^>]*disabled=\{scale\.stabilityMode === "indicator"\}/.test(source),
    false,
    "the settling window is no longer ignored in indicator mode, so it must not be greyed out",
  );
});

// ──────────────────────────────────────────────────────────────
// A regra rodando de verdade, sobre os dados da ESS
// ──────────────────────────────────────────────────────────────

test("the 11/08/2026 burst yields exactly one label per carcass", () => {
  // Leituras gravadas em hardware_capture_events (sessao a339e310, ponto1),
  // na ordem em que a estacao as considerou estaveis. Cinco carcacas foram
  // pesadas; sairam 19 etiquetas.
  const captured = runAutoCapture([
    53.9, 53.7, 52.9, 53.0, 52.9, // carcaca 1, assentando
    8.0,                          // gancho vazio: a peca saiu
    52.2, 50.5,                   // carcaca 2, assentando
    8.1,                          // gancho vazio
    50.7, 49.6,                   // carcaca 3
    8.0,                          // gancho vazio
    51.6, 49.4, 49.5, 49.4,       // carcaca 4
  ], RAIL_SCALE);

  assert.deepEqual(captured, [53.9, 52.2, 50.7, 51.6], "one label per piece, and the hook never gets one");
});

test("two carcasses of the same weight in a row still get two labels", () => {
  // O caso que o rearme por variacao de peso existia para cobrir. Com o
  // trilho ficando vazio entre elas, o peso identico deixa de importar.
  const captured = runAutoCapture([52.0, 8.0, 52.0, 8.0, 52.0], RAIL_SCALE);

  assert.deepEqual(captured, [52.0, 52.0, 52.0]);
});

test("a settling carcass never rearms on its own, however long it drips", () => {
  const captured = runAutoCapture([54.0, 53.8, 53.5, 53.0, 52.4, 51.9, 51.5], RAIL_SCALE);

  assert.deepEqual(captured, [54.0], "half the captured weight has to disappear before the next capture");
});

test("the empty hook never reaches the minimum piece weight", () => {
  assert.equal(autoCapture.hasPieceOnScale(8.1, RAIL_SCALE), false, "hook alone is not a piece");
  assert.equal(autoCapture.hasPieceOnScale(17.9, RAIL_SCALE), false, "8 kg hook + 9,9 kg piece is below the 10 kg minimum");
  assert.equal(autoCapture.hasPieceOnScale(18.0, RAIL_SCALE), true, "8 kg hook + 10 kg piece is a piece");
});

test("a bench scale with no configured base keeps behaving as before", () => {
  const captured = runAutoCapture([20.0, 0.0, 21.5, 0.0, 19.8], BENCH_SCALE);

  assert.deepEqual(captured, [20.0, 21.5, 19.8]);
  assert.equal(autoCapture.hasReleasedPiece(0.1, 20.0, BENCH_SCALE), true, "returning to zero releases");
  assert.equal(autoCapture.hasReleasedPiece(19.9, 20.0, BENCH_SCALE), false, "same piece still on the bench");
  assert.equal(autoCapture.hasReleasedPiece(9.0, 20.0, BENCH_SCALE), true, "losing half the weight means the piece left");
});

test("the first capture of a session never waits for a release", () => {
  assert.equal(autoCapture.hasReleasedPiece(53.9, null, RAIL_SCALE), true);
});

test("a swap the scale never saw empty costs a label, not a duplicate", () => {
  // Trade-off deliberado. Se o operador trocar a peca tao rapido que nenhuma
  // leitura pega o trilho vazio, a segunda carcaca fica sem etiqueta e o
  // operador usa FORCAR LEITURA. O inverso — capturar na duvida — devolve as
  // 5 etiquetas por peca, que e o defeito que estamos corrigindo.
  const captured = runAutoCapture([53.9, 52.0], RAIL_SCALE);

  assert.deepEqual(captured, [53.9], "no empty reading in between means no rearm");
});
