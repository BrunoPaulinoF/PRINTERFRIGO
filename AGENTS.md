# AGENTS.md — PrinterFrigo

## Como fazer release (versão nova)

**O release agora é automático a cada merge na `main`.** O workflow `.github/workflows/release.yml` (job `release`, trigger `push` na `main`) faz tudo sozinho:

1. Calcula a próxima versão (incrementa o **patch** a partir da maior entre `package.json` e a última tag `v*`).
2. Bumpa os **4 arquivos** de versão: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (`[package]`) e `BUILD_VERSION` em `src/App.tsx`.
3. Commita o bump de volta na `main` (`chore(release): vX.Y.Z [skip ci]`) e cria a tag `vX.Y.Z`.
4. Builda e publica o instalador Windows assinado + o manifesto de auto-update (`latest.json`) em GitHub Releases.

### Processo (a partir de agora)

1. Faça sua mudança numa branch e **mergeie o PR na `main`**.
2. Aguarde o workflow `Release` (~8 minutos). Também dá para disparar manualmente pela aba Actions (`workflow_dispatch`).
3. **Verifique** em https://github.com/BrunoPaulinoF/PRINTERFRIGO/releases/latest se o release apareceu com o instalador `.exe`.

Não é mais necessário bumpar versão nem criar tag na mão — o CI faz isso. Cada merge na `main` gera uma versão nova.

### Por que ISSO funciona (e o auto-bump antigo não funcionava)

A armadilha do GitHub: **um push feito com `GITHUB_TOKEN` não dispara outros workflows** (proteção contra loops). O auto-bump antigo criava a tag num workflow e esperava que o workflow de release (com trigger `on: push: tags`) fosse disparado — o que **nunca acontecia**.

O workflow atual evita isso fazendo **bump + tag + build + publish no MESMO job**, sem depender de nenhum trigger cruzado. Como bônus, o mesmo mecanismo (`GITHUB_TOKEN` não redispara workflows), somado ao `[skip ci]` no commit de bump, garante que o commit de volta na `main` **não** cria um loop de releases.

### O que NÃO fazer

- Não voltar a separar "workflow que cria a tag" de "workflow que builda no trigger de tag" — é exatamente o padrão que quebra por causa do `GITHUB_TOKEN`.
- Não esquecer de manter o bump dos 4 arquivos sincronizado se editar o workflow — a versão exibida na UI vem do Tauri (`getVersion()`, lê `tauri.conf.json`), mas o `BUILD_VERSION` em `src/App.tsx` é usado para migração de config.
- Não ligar proteção de branch na `main` que bloqueie push do `github-actions[bot]` sem exceção — o workflow precisa commitar o bump de volta.

### Tags existentes

| Tag | Contém |
|-----|--------|
| v0.3.4 | Parser TI200 status+12-digit + version fix |
| v0.3.3 | Tag criada por workflow auto (quebrada, sem release) |
| v0.3.2 | Tag criada por workflow auto (quebrada, sem release) |
| v0.3.1 | Version fix (getVersion) |
| v0.3.0 | Auto-bump workflow + Toledo 9091 preset |

