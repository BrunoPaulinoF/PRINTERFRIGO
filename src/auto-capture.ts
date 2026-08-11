import type { ScaleConfig } from "./types";

/**
 * Quando a captura automatica pode pesar a PROXIMA peca.
 *
 * O criterio antigo era "o peso mudou mais que a tolerancia (100 g) ou a
 * balanca voltou a zero". Os dois falham num trilho de frigorifico:
 *
 * - a carcaca assenta escorrendo e balancando, e cada patamar novo passa dos
 *   100 g, entao ela parece uma peca nova a cada dois segundos;
 * - o gancho (~8 kg na ESS) nunca sai da celula de carga, entao o zero
 *   absoluto nunca chega e esse braco do criterio e letra morta.
 *
 * Em 11/08/2026, no ponto 1 da ESS, isso deu 5 etiquetas para a mesma carcaca
 * (53,9 → 53,7 → 52,9 → 53,0 → 52,9 kg em 11,7 s).
 *
 * A pergunta certa nao e "o peso mudou?", e sim "a peca SAIU?". Enquanto ela
 * estiver na balanca nao existe peca nova para pesar, por mais que o numero
 * ande.
 *
 * O modulo nao importa nada em tempo de execucao de proposito:
 * `scripts/auto-capture.test.mjs` transpila e executa a regra de verdade.
 */

/**
 * Fracao do peso capturado que precisa SUMIR da balanca para a estacao aceitar
 * que a peca saiu. Metade e folgado de sobra: uma carcaca de 50 kg saindo do
 * gancho de 8 kg derruba 42 kg; uma caixa de 20 kg numa bancada vazia derruba
 * os 20. Nenhum assentamento, escorrimento ou balanco chega perto disso.
 */
export const RELEASE_DROP_RATIO = 0.5;

/**
 * Peso da balanca VAZIA para efeito de captura: o gancho, o balancim, a
 * bandeja. Config antiga nao tem o campo e cai em zero, que e o comportamento
 * de sempre para balanca de bancada.
 */
export function emptyWeightOf(scale: Pick<ScaleConfig, "emptyWeightKg">): number {
  const value = Number(scale.emptyWeightKg);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A peca esta na balanca — e nao so o gancho vazio.
 *
 * Medir o minimo a partir do zero e o que fez a ESS etiquetar o gancho sozinho
 * (volumes de 8,0 e 8,1 kg no meio da NF): com `minWeightKg` em 8 kg, o gancho
 * empatava com o minimo. Medindo a partir do peso da balanca vazia, "peso
 * minimo" volta a significar peso MINIMO DA PECA.
 */
export function hasPieceOnScale(
  weight: number,
  scale: Pick<ScaleConfig, "emptyWeightKg" | "minWeightKg">,
): boolean {
  return weight >= emptyWeightOf(scale) + scale.minWeightKg;
}

/**
 * A peca pesada SAIU da balanca — unico jeito de rearmar a captura.
 *
 * Duas respostas servem, e basta uma:
 *
 * - o peso voltou ao da balanca vazia (gancho configurado, ou zero de verdade);
 * - caiu mais que `RELEASE_DROP_RATIO` do que foi capturado, o que cobre a
 *   estacao onde ninguem configurou o peso do gancho.
 *
 * Duas carcacas de peso identico em sequencia continuam rendendo duas
 * etiquetas: entre elas o trilho fica vazio, e e isso que rearma.
 */
export function hasReleasedPiece(
  weight: number,
  lastCapturedWeight: number | null,
  scale: Pick<ScaleConfig, "emptyWeightKg" | "zeroThresholdKg">,
): boolean {
  if (lastCapturedWeight === null) return true;
  const emptyWeight = emptyWeightOf(scale);
  if (weight <= emptyWeight + scale.zeroThresholdKg) return true;
  return weight <= lastCapturedWeight * (1 - RELEASE_DROP_RATIO);
}
