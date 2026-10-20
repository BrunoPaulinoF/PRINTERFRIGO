import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const lib = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const cargo = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");

// Duas copias do agente na mesma estacao dividem a fila local: a segunda
// reenviava a captura que a primeira ainda estava enviando, e as duas pegavam
// a mesma etiqueta. Caixa e etiqueta em dobro na ESS (PONTO3, 20/10/2026).

test("o agente nao abre duas vezes na mesma estacao", () => {
  assert.match(cargo, /^tauri-plugin-single-instance = "2"$/m);
  const builder = lib.slice(lib.indexOf("tauri::Builder::default()"));
  const firstPlugin = builder.indexOf(".plugin(");
  assert.ok(firstPlugin > 0);
  assert.ok(
    builder.slice(firstPlugin).startsWith(".plugin(tauri_plugin_single_instance::init("),
    "o plugin de instancia unica precisa ser o PRIMEIRO registrado",
  );
});

test("abrir de novo traz a janela que ja esta aberta", () => {
  const start = lib.indexOf("tauri_plugin_single_instance::init(");
  const block = lib.slice(start, lib.indexOf("}))", start));
  assert.match(block, /get_webview_window\("main"\)/);
  assert.match(block, /\.show\(\)/);
  assert.match(block, /\.set_focus\(\)/);
});
