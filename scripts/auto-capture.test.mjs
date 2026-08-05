import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const appPath = new URL("../src/App.tsx", import.meta.url);
const apiPath = new URL("../src/api.ts", import.meta.url);
const queuePath = new URL("../src-tauri/src/queue.rs", import.meta.url);

test("automatic capture uses lease, cooldown, and weight-change rearm", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("AUTO_SESSION_LEASE_TIMEOUT_MS"), "auto capture must ignore stale browser sessions");
  assert.ok(source.includes("hasFreshAutoSessionLease(session"), "auto loop must check the browser lease before weighing");
  assert.ok(source.includes("lastCapturedWeight"), "auto loop must remember the last captured weight");
  assert.ok(source.includes("hasMeaningfulWeightChange"), "auto loop must rearm on weight change instead of requiring zero");
  assert.ok(source.includes("cooldownElapsed"), "auto loop must keep cooldown protection");
  assert.ok(source.includes("weightChanged"), "auto loop must avoid duplicate labels for unchanged stable weight");
  assert.equal(source.includes("waitingZero"), false, "auto loop must not require returning to zero between captures");
  assert.ok(source.includes("AUTO_POLL_MS"), "auto polling must have its own faster poll interval");
  assert.ok(source.includes("hasAutoSession"), "auto polling must accelerate when auto sessions are active");
  assert.equal(source.includes("stableWindow: 5"), false, "default stability window must not keep the old slow value");
  assert.ok(
    source.includes("sawZeroSinceCapture"),
    "returning to zero must rearm capture, otherwise two carcasses within the tolerance in a row lose the second label",
  );
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
  assert.ok(source.includes('Amostras minimas</FieldLabel>'), "minimum sample field must have operator help");
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
