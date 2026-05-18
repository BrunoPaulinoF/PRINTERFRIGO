# AGENTS.md — PRINTERFRIGO

## Como fazer release (versão nova)

**NUNA usar workflow automático de bump.** O `GITHUB_TOKEN` usado por workflows não dispara outros workflows (proteção do GitHub contra loops). Isso quebra o release automático do Tauri.

### Processo manual (funciona 100%)

1. **Bumpar versão** nos 4 arquivos:
   - `package.json` → `"version": "X.Y.Z"`
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
   - `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
   - `src/App.tsx` → `const BUILD_VERSION = "X.Y.Z"`

2. **Commit**:
   ```bash
   git add -A
   git commit -m "chore(release): bump version to X.Y.Z"
   ```

3. **Push para `main`**:
   ```bash
   git push origin main
   ```

4. **Criar e pushar a tag** (isso dispara o GitHub Actions de release):
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Aguardar** o workflow `Release` buildar no GitHub Actions (~8 minutos).

6. **Verificar** em https://github.com/BrunoPaulinoF/PRINTERFRIGO/releases/latest se o release apareceu com o instalador `.exe`.

### O que NÃO fazer

- Não criar `.github/workflows/bump-version.yml` com auto-tag usando `secrets.GITHUB_TOKEN` — isso bloqueia o trigger do workflow `Release`.
- Não esquecer de atualizar `BUILD_VERSION` em `src/App.tsx` — a versão exibida na UI vem do Tauri (`getVersion()`), mas o `BUILD_VERSION` é usado para migração de config.

### Tags existentes

| Tag | Contém |
|-----|--------|
| v0.3.4 | Parser TI200 status+12-digit + version fix |
| v0.3.3 | Tag criada por workflow auto (quebrada, sem release) |
| v0.3.2 | Tag criada por workflow auto (quebrada, sem release) |
| v0.3.1 | Version fix (getVersion) |
| v0.3.0 | Auto-bump workflow + Toledo 9091 preset |

