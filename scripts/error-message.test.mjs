import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

// O Tauri rejeita o `invoke` com a STRING que o Rust devolveu, nunca com um
// `Error`. `error instanceof Error ? error.message : "Erro ao ler balanca."`
// jogava fora o motivo verdadeiro ("Acesso negado", "porta nao encontrada") e
// mostrava so a frase generica. Foi assim que a PONTO3 da ESS ficou sem pesar
// em 03/11/2026 com a tela dizendo apenas "Erro ao ler balanca.".

test("mensagem de erro do Rust chega inteira na tela", () => {
  const body = app.slice(app.indexOf("function errorMessage"));
  assert.match(body.slice(0, 600), /typeof error === "string"/);
  const outside = app.replace(/function errorMessage[\s\S]*?\n}\n/, "");
  assert.doesNotMatch(outside, /instanceof Error/, "use errorMessage(error, ...) em vez de instanceof Error");
});
