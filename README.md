# PrinterFrigo

Aplicativo desktop Windows para conectar o KyberFrigo a balancas e impressoras de etiquetas instaladas na rede ou no computador local.

O PrinterFrigo fica rodando na estacao de pesagem. Ele le a balanca, envia o peso para o KyberFrigo, recebe o job de etiqueta em ZPL e imprime direto na impressora configurada, sem abrir popup de impressao do Chrome.

## O Que Este App Faz

- Matricula uma estacao local no KyberFrigo por codigo gerado no painel de Configuracoes.
- Le balancas seriais, inicialmente com preset generico/Toledo configuravel.
- Captura peso manualmente quando o usuario clica no site.
- Captura peso automaticamente quando a balanca estabiliza.
- Envia cada captura com `captureId` idempotente para evitar volume duplicado.
- Recebe jobs de impressao do KyberFrigo em ZPL.
- Imprime em:
  - arquivo `.zpl` para teste dry-run;
  - impressora TCP/IP porta 9100;
  - fila de impressora Windows.
- Reporta status de impressao para o KyberFrigo.
- Mantem configuracao local em SQLite.
- Suporta tray/background.
- Atualiza por GitHub Releases assinadas, sempre sob clique do operador (nunca sozinho).

## Responsabilidades

### KyberFrigo

O KyberFrigo continua sendo dono das regras de negocio:

- usuarios, permissoes e tenant;
- NF, fornecedor, produto e OP;
- criacao de volume;
- codigo/lote;
- auditoria;
- modelo de etiqueta;
- renderizacao do `LabelDesign` para ZPL;
- fila duravel de capturas e impressoes no Supabase.

### PrinterFrigo

O PrinterFrigo e dono da configuracao fisica local:

- qual porta COM e a balanca;
- parametros seriais;
- regex/parser do peso;
- estabilidade;
- qual impressora local/TCP usar;
- dry-run de diagnostico;
- fila/local logs;
- heartbeat da estacao.

O usuario nao edita modelo de etiqueta no PrinterFrigo. O layout fica no site KyberFrigo.

## Fluxo Operacional

### Receiving

1. Usuario abre `/receiving`.
2. Usuario seleciona NF, fornecedor e produto.
3. Usuario escolhe captura manual ou automatica.
4. KyberFrigo cria uma sessao de hardware para o ponto `receiving`.
5. PrinterFrigo recebe a sessao no heartbeat.
6. Se for manual, o site envia `REQUEST_CAPTURE`.
7. Se for automatico, o PrinterFrigo captura ao estabilizar.
8. PrinterFrigo envia peso bruto e metadados.
9. KyberFrigo cria o volume, gera lote/codigo e cria job ZPL.
10. PrinterFrigo imprime e reporta `PRINTED` ou `FAILED`.

### Saida da OP

1. Usuario abre `/production/cortes/[opId]`.
2. Usuario seleciona produto e quantidade de pecas.
3. KyberFrigo cria sessao no ponto `op_to_stock`.
4. PrinterFrigo captura o peso manualmente ou por estabilidade.
5. KyberFrigo registra volume de saida da OP.
6. PrinterFrigo imprime a etiqueta automaticamente.

## Requisitos Para Instalar

- Windows 10 ou Windows 11.
- Acesso ao KyberFrigo.
- Usuario admin no KyberFrigo para gerar codigo de matricula.
- Balanca com comunicacao serial/USB-serial ou porta COM virtual.
- Impressora de etiqueta compativel com ZPL.
- Para Elgin L42 Pro, configurar em modo ZPL quando aplicavel.
- Driver da impressora instalado no Windows se for usar fila Windows.
- Rede liberada entre a estacao e o KyberFrigo.

## Instalador

O build Tauri gera instaladores em:

```text
src-tauri/target/release/bundle/
```

Normalmente os arquivos ficam em:

```text
src-tauri/target/release/bundle/nsis/PrinterFrigo_0.1.0_x64-setup.exe
src-tauri/target/release/bundle/msi/PrinterFrigo_0.1.0_x64_en-US.msi
```

Use preferencialmente o instalador `.exe` da pasta `nsis`, porque ele e mais simples para usuario final.

## Como Gerar o Instalador Localmente

No terminal:

```powershell
cd C:\Users\keder\Desktop\Antigravity\PrinterFrigo
npm install
npm run tauri:build
```

Se o build terminar com sucesso, abra:

```powershell
explorer .\src-tauri\target\release\bundle
```

Observacao: quando `createUpdaterArtifacts` esta ativo, o Tauri pode gerar o `.exe` e o `.msi`, mas falhar no final com a mensagem abaixo:

```text
A public key has been found, but no private key.
Make sure to set TAURI_SIGNING_PRIVATE_KEY environment variable.
```

Nesse caso, o instalador normal ja costuma estar criado em `src-tauri/target/release/bundle`. O que falhou foi a geracao dos artefatos assinados de auto-update. Para gerar tudo completo, configure as variaveis abaixo antes de rodar:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .\tauri-private.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "SENHA_DA_CHAVE_SE_TIVER"
npm run tauri:build
```

Se a chave nao tiver senha, deixe `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` vazia.

## Instalacao No Computador Do Usuario

1. Copie o instalador `.exe` para o computador da estacao de pesagem.
2. Execute o instalador.
3. Se o Windows SmartScreen alertar, clique em "Mais informacoes" e depois "Executar assim mesmo", se voce confiar no instalador.
4. Abra o PrinterFrigo pelo menu iniciar.
5. Deixe o app aberto ou minimizado na bandeja do Windows.

## Configuracao No KyberFrigo

1. Abra o KyberFrigo.
2. Entre com usuario admin.
3. Va em `Configuracoes`.
4. Abra `Pontos de Pesagem`.
5. Clique em `Gerar codigo`.
6. Copie o codigo exibido.
7. Depois que o PrinterFrigo for matriculado, volte nessa tela.
8. No ponto desejado, selecione a estacao PrinterFrigo.
   - Para recebimento, use `receiving`.
   - Para saida da OP, use `op_to_stock`.
9. Ative:
   - `Captura por balanca`, se o ponto usa balanca.
   - `Impressao automatica`, se o ponto imprime etiqueta.
10. Clique em `Salvar Configuracoes`.

## Matricula Do PrinterFrigo

No aplicativo desktop:

1. Em `URL KyberFrigo`, informe a URL do sistema.

Exemplos:

```text
http://localhost:3000
https://seudominio.com.br
```

2. Em `Nome da estacao`, informe um nome claro.

Exemplos:

```text
Recebimento - Plataforma 1
Desossa - Saida OP
Balanca Camara 2
```

3. Em `Codigo de matricula`, cole o codigo gerado no KyberFrigo.
4. Clique em `Matricular`.
5. O app deve mostrar que foi matriculado e exibir o tenant vinculado.

Se falhar:

- confira se a URL esta correta;
- confira se o codigo nao expirou;
- gere um novo codigo no KyberFrigo;
- confira se o computador tem internet/rede ate o servidor.

## Configuracao Da Balanca

Abra a area `Balanca` no PrinterFrigo.

### Porta Serial

Selecione a porta COM da balanca.

Exemplos:

```text
COM1
COM3
COM5
```

Se a porta nao aparecer:

1. Confira se o cabo USB/serial esta conectado.
2. Abra o Gerenciador de Dispositivos do Windows.
3. Veja em `Portas (COM e LPT)`.
4. Reinstale o driver USB-serial se necessario.
5. Clique em `Atualizar` no PrinterFrigo.

### Baud Rate

Configure conforme a balanca.

Valores comuns:

```text
9600
4800
19200
```

Para muitas configuracoes Toledo genericas, comece com:

```text
Baud: 9600
Data bits: 8
Stop bits: 1
Parity: none
```

### Regex Parser

O parser extrai o peso do texto recebido da balanca.

Padrao inicial:

```text
([-+]?\d+[\.,]?\d*)\s*kg?
```

Ele captura pesos como:

```text
12.345kg
12,345 kg
ST,GS,+0012.345kg
```

Tambem pode usar grupo nomeado `weight`:

```text
PESO=(?P<weight>\d+,\d+)
```

### Teste De Parser

1. Cole um frame de exemplo em `Frame de teste`.
2. Clique em `Testar`.
3. O app deve mostrar o peso convertido em kg.

Se nao converter:

- ajuste a regex;
- confirme se o frame da balanca realmente contem peso;
- confirme se o separador decimal e ponto ou virgula;
- remova caracteres fixos que mudam entre leituras.

## Captura Automatica Por Estabilidade

A estabilizacao roda inteira dentro do app, com a porta da balanca aberta e
varias amostras por segundo. Ela nao depende do intervalo de polling nem de
falar com o KyberFrigo entre uma leitura e outra.

### Criterio De Estabilidade

**Cada balanca responde de um jeito, e nem todo protocolo sabe avisar que a
peca ainda se move.** O campo `stabilityMode` tem tres valores:

- **`auto` (padrao, recomendado)** — escolhe pelo protocolo configurado no
  `parserRegex`. Balanca cujo protocolo declara movimento usa o criterio
  `indicator`; as demais usam `window`. A regra vive em `parser_declares_motion`
  (`src-tauri/src/hardware.rs`) — hoje vale para a familia `toledo:ti200`
  (TI200/Prix/9091, Protocol G).
- **`indicator`** — sempre confia no aviso da balanca. Um TI200 responde
  `III,III` enquanto a peca se move e so devolve numero quando trava o peso.
  Entao toda leitura numerica ja e o indicador declarando peso parado, e bastam
  `stableWindow` leituras seguidas (padrao `2`) que concordem dentro da
  tolerancia. E o mais rapido e o mais correto: quem decide e o mesmo circuito
  que a metrologia legal aprovou.
- **`window`** — sempre mede a variancia aqui, exigindo que todas as leituras
  dos ultimos `stableMs` caibam na tolerancia.

**Por que `auto` importa:** com um `parserRegex` generico como
`([-+]?\d+[\.,]?\d*)\s*kg?`, QUALQUER frame vira numero — inclusive no meio do
balanco. Ali "frame numerico" nao significa "peso parado", e confiar nisso
capturaria peso errado. So force `indicator` numa balanca que voce sabe que
declara movimento e cujo protocolo ainda nao esta na lista.

**Ao adicionar um protocolo novo**, decida explicitamente se ele declara
movimento e atualize `parser_declares_motion`. Ha teste que percorre todos os
parsers publicados e cobra essa decisao, justamente para nenhum herdar um
padrao por acidente.

A concordancia entre as leituras e exigida nos dois criterios. No `indicator`
ela e a rede de seguranca: se a balanca estiver num modo que transmite ao vivo
sem declarar movimento, duas leituras seguidas dentro da tolerancia ainda
impedem capturar no meio do balanco. Confirmacoes separadas por muito tempo nao
valem — entre elas a peca pode ter entrado e saido de movimento.

O botao **Ler peso** mostra qual criterio valeu de fato, util quando
`stabilityMode` esta em `auto`.

Parametros principais:

- `stableThresholdKg`: variacao maxima aceita para considerar estavel. Para
  carcaca no trilho use `0.1` (100 g); para caixa em balanca de bancada da para
  apertar bem mais.
- `stableWindow`: quantas leituras confirmam o peso (modo `indicator`, padrao
  `2`) ou o minimo de amostras na janela (modo `window`).
- `stableMs`: **so no criterio `window`** — por quanto tempo o peso precisa
  ficar dentro da tolerancia. Ignorado no criterio `indicator`.
- `stableTimeoutMs`: tempo maximo esperando assentar antes de desistir da
  leitura. Padrao `5000`.
- `sampleIntervalMs`: espera maxima por cada resposta da balanca. Nao e pausa
  fixa — a leitura segue assim que o peso chega. Padrao `60`.
- `minWeightKg`: peso minimo para capturar.
- `cooldownMs`: tempo minimo entre capturas.
- `zeroThresholdKg`: peso considerado retorno a zero.

Regra operacional:

1. O peso precisa estar acima do minimo.
2. A balanca precisa confirmar o peso pelo criterio configurado acima.
3. Depois de capturar, a balanca voltar a zero libera a proxima peca.
4. Se ela nao voltar a zero, uma variacao de peso maior que a tolerancia
   tambem libera.

Isso evita imprimir varias etiquetas para a mesma carcaca/caixa.

### Forcar Leitura Com A Peca Em Movimento

Se o operador clicar para capturar e a balanca **nao** confirmar o peso dentro
de `stableTimeoutMs`, **nada e capturado**. Aparece um aviso pedindo para
esperar a peca parar e clicar de novo, e o motivo fica no log local.

Isso e proposital: peso nao confirmado virando volume e peso errado em nota
fiscal. Repetir o clique custa segundos; corrigir o volume depois custa muito
mais. O comando recusado tambem nao fica pendente — o app nao captura sozinho
quando a peca finalmente assentar, porque a essa altura ela pode ser outra.

### Ajuste Fino Da Velocidade

- Pesagem demorando para fechar no modo `indicator`: confira se
  `sampleIntervalMs` nao esta baixo demais (piso de `250`). Abaixo disso a
  balanca nao responde a tempo e nenhuma amostra vale.
- Pesagem demorando no modo `window`: baixe `stableMs` (ex.: `600`) ou suba
  `stableThresholdKg`. Comece pela tolerancia.
- Peso fechando cedo demais, ainda no balanco: suba `stableWindow` para `3`
  antes de mexer em qualquer outra coisa.
- `stableTimeoutMs` nao acelera nada: ele so limita quanto tempo o app insiste
  numa peca que nao para antes de recusar a captura.

## Configuracao Da Impressora

Abra a area `Impressora`.

### Modo Dry-run

Use primeiro:

```text
Dry-run .zpl
```

Esse modo nao imprime. Ele salva o ZPL em arquivo local para diagnostico.

Use para validar:

- se o KyberFrigo esta gerando etiqueta;
- se o PrinterFrigo esta recebendo job;
- se o conteudo ZPL parece correto;
- se nao ha problema de impressora/driver.

### Modo TCP/IP 9100

Use quando a impressora estiver na rede e aceitar impressao bruta.

Configure:

```text
Host TCP: IP da impressora
Porta: 9100
```

Exemplo:

```text
Host TCP: 192.168.0.50
Porta: 9100
```

Teste:

1. Configure IP e porta.
2. Clique em `Teste ZPL`.
3. A impressora deve imprimir uma etiqueta de teste.

Se nao imprimir:

- confira o IP da impressora;
- confira se a impressora responde na rede;
- confira se a porta 9100 esta liberada;
- confira se o modo ZPL esta ativo;
- teste ping pelo Windows.

### Modo Fila Windows

Use quando a impressora estiver instalada no Windows.

Passos:

1. Instale o driver da impressora.
2. Abra `Configuracoes do Windows > Bluetooth e dispositivos > Impressoras e scanners`.
3. Confirme que a impressora aparece.
4. No PrinterFrigo, clique em `Atualizar`.
5. Selecione a fila em `Fila Windows`.
6. Clique em `Teste ZPL`.

Observacao importante:

Fila Windows pode passar o conteudo pelo driver. Para etiqueta termica, o ideal e que a fila aceite RAW/ZPL. Se a impressora imprimir texto ZPL em vez da etiqueta, o driver/fila nao esta enviando como bruto.

Quando possivel, prefira TCP/IP 9100 para impressao ZPL direta.

## Configuracao Elgin L42 Pro

A Elgin L42 Pro pode trabalhar com linguagens de etiqueta como ZPL/EPL/PPLA/PPLB conforme configuracao/driver.

Checklist recomendado:

1. Instale o driver oficial da Elgin.
2. Configure a impressora para linguagem compativel com ZPL.
3. Defina tamanho da etiqueta conforme o modelo usado no KyberFrigo.
4. Calibre a midia no botao/utility da impressora.
5. Teste impressao pelo driver.
6. Teste `Teste ZPL` no PrinterFrigo.
7. Se imprimir texto ZPL, revise linguagem/driver.
8. Se pular etiquetas, calibre sensor e tamanho da etiqueta.

## Teste Completo Sem Risco

Antes de usar em operacao real:

1. No PrinterFrigo, coloque impressora em `Dry-run .zpl`.
2. Matricule a estacao.
3. Vincule a estacao em `Configuracoes > Pontos de Pesagem`.
4. Abra `/receiving`.
5. Selecione NF, fornecedor e produto.
6. Clique para capturar manualmente.
7. Confirme que o volume apareceu no KyberFrigo.
8. Confirme que um arquivo `.zpl` foi gerado.
9. Repita com captura automatica.
10. So depois configure impressao real.

## Operacao Diaria

1. Ligue balanca e impressora.
2. Abra o PrinterFrigo.
3. Confira se a estacao esta matriculada.
4. Confira se a balanca esta lendo.
5. Confira se a impressora esta configurada.
6. Abra o KyberFrigo no Chrome.
7. Use `/receiving` ou `/production/cortes/[opId]`.
8. Ative captura automatica quando o fluxo permitir.
9. Passe as carcacas/caixas pela balanca.
10. Aguarde impressao automatica da etiqueta.

## Falhas Comuns

### Login KyberFrigo funciona, mas PrinterFrigo nao matricula

- URL do KyberFrigo errada.
- Codigo expirado.
- Codigo ja usado.
- Computador sem acesso ao servidor.
- Servidor KyberFrigo fora do ar.

### Balanca nao aparece

- Driver USB-serial nao instalado.
- Cabo desconectado.
- Porta COM mudou.
- Outro programa esta usando a porta.
- Balanca esta desligada.

### Peso nao e lido

- Baud rate errado.
- Paridade/data bits/stop bits errados.
- Balanca nao envia continuamente.
- Necessario configurar comando de leitura.
- Regex nao bate com o frame.

### Captura automatica imprime varias etiquetas

- `zeroThresholdKg` baixo demais.
- Balanca nao volta a zero entre itens.
- `cooldownMs` curto demais.
- `stableThresholdKg` alto demais.

### Impressora nao imprime

- IP errado.
- Porta 9100 bloqueada.
- Fila Windows errada.
- Driver nao envia RAW.
- Impressora nao esta em ZPL.
- Etiqueta/papel mal calibrado.

### Imprime texto com comandos `^XA`

A impressora recebeu ZPL como texto comum.

Correcoes:

- ativar linguagem ZPL na impressora;
- usar TCP/IP 9100;
- revisar driver/fila Windows;
- testar com outro utilitario RAW.

## Atualizacao De Versao

**O app nunca atualiza sozinho.** Nao ha checagem no arranque, nem instalacao
em segundo plano: uma estacao no ponto de pesagem nao pode reiniciar no meio de
um recebimento. Uma versao nova so entra quando alguem clica para instalar.

Como atualizar:

1. Clique no botao com a versao atual, no topo da tela (ex.: `v0.5.5`).
2. Ele consulta as releases e responde ali mesmo: ou "voce ja esta na versao
   mais recente", ou "versao X disponivel". Cada clique refaz a consulta.
3. Se houver versao nova, aparece o botao **Atualizar para vX**. Nada e baixado
   antes disso.
4. Ao clicar, o app baixa, instala e reinicia sozinho.

**Agora nao** fecha o aviso sem instalar. O mesmo fluxo tambem esta na aba
Servico, no botao "Procurar atualizacao".

Consequencia pratica: mergear um PR e publicar uma release **nao** mexe nas
estacoes em campo. Cada estacao continua na versao dela ate alguem atualizar
manualmente.

### Assinatura Das Releases

As releases usam GitHub Releases assinadas.

Configuracao em:

```text
src-tauri/tauri.conf.json
```

Campos importantes:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "CHAVE_PUBLICA",
      "endpoints": [
        "https://github.com/BrunoPaulinoF/PrinterFrigo/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Nunca publique a chave privada.

Secrets esperados no GitHub:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Se a chave privada vazou em algum momento:

1. Gere outra chave.
2. Atualize `pubkey`.
3. Atualize `TAURI_SIGNING_PRIVATE_KEY`.
4. Delete releases antigas.
5. Publique nova release.

## Publicar Uma Release

**O release e automatico a cada merge na `main`.** O workflow `.github/workflows/release.yml` incrementa o patch, bumpa os 4 arquivos de versao (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `BUILD_VERSION` em `src/App.tsx`), cria a tag `vX.Y.Z` e publica o instalador Windows assinado + `latest.json`.

1. Confirme que a chave privada de assinatura esta no GitHub Secrets (`TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`).
2. Confirme que `tauri-private.key` nao esta no git.
3. Mergeie seu PR na `main` (ou dispare o workflow `Release` manualmente pela aba Actions).
4. Aguarde o GitHub Actions gerar os instaladores (~8 min).
5. Baixe o `.exe` na pagina de Releases.

Nao e mais necessario bumpar versao nem criar tag na mao. Detalhes e a razao tecnica em `AGENTS.md`.

## Desenvolvimento

Instalar dependencias:

```powershell
cd C:\Users\keder\Desktop\Antigravity\PrinterFrigo
npm install
```

Rodar em desenvolvimento:

```powershell
npm run tauri:dev
```

Build frontend:

```powershell
npm run build
```

Testes Rust:

```powershell
cd src-tauri
cargo test
```

Build instalador:

```powershell
npm run tauri:build
```

## Estrutura Do Projeto

```text
src/
  App.tsx       UI principal
  api.ts        chamadas Tauri invoke
  types.ts      tipos compartilhados da UI
  styles.css    estilos

src-tauri/
  tauri.conf.json   configuracao Tauri
  Cargo.toml        dependencias Rust
  src/
    config.rs       SQLite local e configuracao
    hardware.rs     portas seriais, parser e balanca
    printing.rs     dry-run, TCP 9100 e fila Windows
    queue.rs        fila/log local
    lib.rs          setup Tauri, tray e comandos
    main.rs         entrada do app
```

## Contratos Com KyberFrigo

### Matricula

```text
POST /api/hardware/enroll
```

Entrada:

```json
{
  "code": "CODIGO",
  "stationLabel": "Recebimento - Plataforma 1"
}
```

Retorno:

```json
{
  "agentId": "...",
  "tenantId": "...",
  "name": "...",
  "stationLabel": "...",
  "token": "..."
}
```

### Heartbeat

```text
POST /api/hardware/agent/heartbeat
Authorization: Bearer TOKEN_DO_AGENTE
```

O heartbeat:

- atualiza status da estacao;
- envia dispositivos locais;
- recebe sessoes ativas;
- recebe jobs de impressao pendentes.

### Captura

```text
POST /api/hardware/agent/captures
Authorization: Bearer TOKEN_DO_AGENTE
```

Cada captura precisa de `captureId` unico. Se repetir o mesmo `captureId`, o KyberFrigo nao deve criar volume duplicado.

### Status De Impressao

```text
PATCH /api/hardware/agent/print-jobs/:jobId
Authorization: Bearer TOKEN_DO_AGENTE
```

Status aceitos:

```text
PRINTED
FAILED
CANCELLED
```

## Notas Para Agentes De IA

- Nao mover configuracao fisica de balanca/impressora para o KyberFrigo. O desktop e o dono disso.
- Nao colocar `service_role` no PrinterFrigo.
- Nao editar modelo de etiqueta no PrinterFrigo. O site e a fonte do layout.
- Manter ZPL como formato canonico de impressao.
- Preservar idempotencia por `captureId`.
- Evitar `window.print()` nos fluxos de pesagem automatica.
- Nunca commitar `tauri-private.key`.
- Se alterar payload de jobs, alinhar:
  - KyberFrigo `hardware_print_jobs.payload`;
  - PrinterFrigo `PrintJob`;
  - migration Supabase.
- Se alterar tabelas, atualizar:
  - migration Supabase;
  - `prisma/schema.prisma`;
  - services/API route handlers;
  - README.

## Checklist Antes De Produzir

- [ ] Migration aplicada no Supabase.
- [ ] Estacao matriculada.
- [ ] Ponto de pesagem vinculado no KyberFrigo.
- [ ] Balanca lendo peso correto.
- [ ] Captura manual testada.
- [ ] Captura automatica testada.
- [ ] Dry-run ZPL validado.
- [ ] Impressao real testada.
- [ ] Mesma captura nao duplica volume.
- [ ] Falha de impressora deixa job pendente.
- [ ] Chave privada Tauri fora do git.
- [ ] Release assinada publicada.
