# AGENTS.md — PrinterFrigo

## O Frame Da Balança Tem De Ser Delimitado

A caixa de 20,7 kg saiu etiquetada com **207 kg** na ESS entre 24 e 26/08/2026.
Corrigido em `src-tauri/src/hardware.rs` (`complete_frames`, `frame_is_ambiguous`,
`frame_to_read`).

**Não era a balança mandando peso errado — era o agente cortando o frame no lugar
errado.** `sample_scale` acumulava os bytes da porta e passava o buffer INTEIRO
para um regex sem nenhuma noção de fronteira de frame. No P05 do TI200 o peso é um
campo de seis dígitos sem separador decimal (`020700` = 20,7 kg, dividido por
1000), e ele era procurado com `\d{5,7}` — **guloso e sem âncora**. Leitura da
porta que caía em cima da fronteira trazia o campo colado ao início do frame
seguinte, e o regex engolia SETE dígitos:

```
020700       ->  20,700 kg   (o frame sozinho)
0207000207   -> 207,000 kg   (o mesmo peso, colado ao próximo frame)
02280        ->   2,280 kg   (meia leitura: cinco dígitos já casam)
```

A estação vizinha, com a mesma versão do agente e outra balança, teve **zero**
ocorrências no mesmo período: é defeito latente do parser, revelado pela cadência
de frames da balança nova.

- **Só frame TERMINADO é lido, e o mais recente deles.** `complete_frames` corta
  nos caracteres de controle (CR, LF, ETX, STX) e devolve apenas o que veio
  seguido de terminador. O pedaço final, ainda chegando, fica de fora e o laço
  espera mais bytes — que é o que ele já fazia quando o parse falhava.
- **Balança que não termina o frame continua sendo lida.** Se o prazo acabar,
  tiver chegado byte e nenhum frame houver fechado, o buffer inteiro vale como
  frame — **mas só quando oferece um peso único**. Sem essa saída, um indicador de
  largura fixa sem terminador deixaria de funcionar.
- **Frame ambíguo é recusado, não adivinhado.** Duas corridas de cinco ou mais
  dígitos, ou uma corrida maior que o campo, é dois frames; escolher qual deles é
  o peso é o mesmo erro do regex guloso, com o mesmo resultado — etiqueta com peso
  plausível e errado.
- **`frame_to_read` aplica a mesma regra na leitura avulsa**, que alimenta a
  auto-configuração. É ela que ELEGE o parser da balança: um parser escolhido
  sobre um frame colado fica errado para todas as pesagens seguintes.
- **O frame cru viaja junto da captura** (`StableReading.frame` →
  `payload.scale.frame`). Não havia registro nenhum do que a balança tinha
  enviado, e a causa teve de ser deduzida do próprio número, rodando o parser
  contra frames candidatos até reproduzir os valores gravados em produção. Ao
  mexer no parser, mantenha esse campo.

**Não afrouxe o `\d{5,7}` do P05 achando que resolve.** O campo tem largura fixa;
quem errava era o recorte do buffer, não a largura aceita. E o KyberFrigo tem uma
guarda de peso implausível no servidor (`src/lib/hardware-weight-sanity.ts`) que
existe justamente porque nem todo parque de estações atualiza no mesmo dia — ela é
rede, não substituto desta correção.

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

