# performance-cam

Testes de carga de landing pages com [Artillery](https://www.artillery.io/), [Cypress](https://www.cypress.io/) e TypeScript.
Cada execução gera um relatório visual em HTML e entra num histórico de execuções.

| Cenário | O que faz | Carga máxima |
|---|---|---|
| **1. Acesso** | abre a landing page e carrega a lista de ingressos, como o navegador faz | 15 mil usuários simultâneos |
| **2. Inscrição** | abre a página, seleciona o ingresso Comum e clica em "Realizar inscrição" | mil usuários simultâneos |

## Pré-requisitos

- **Node.js 24 ou mais novo** (os scripts `.mts` rodam direto no Node, sem etapa de build)
- npm (vem com o Node)

## Como rodar

1. Instale as dependências:

   ```bash
   npm install
   ```

   Se o Cypress reclamar que o binário não está instalado, rode `npx cypress install`.

2. Crie o arquivo `.env` a partir do modelo:

   ```bash
   cp .env.example .env
   ```

   No PowerShell: `Copy-Item .env.example .env`

3. Abra o `.env` e preencha os endereços do ambiente:

   ```
   LP_URL=https://seu-ambiente.example.com/caminho/da/pagina
   LP_API_INGRESSOS=https://api.example.com/v1/events/123/ticket-picker
   ```

   - `LP_URL`: URL completa da landing page.
   - `LP_API_INGRESSOS` (opcional): a API que a página chama ao abrir para carregar os ingressos.
     Para descobrir, abra a página com o DevTools do navegador na aba Rede (Network), filtre por
     Fetch/XHR e copie a URL da chamada que termina em `/ticket-picker`. Se ficar vazia, o
     cenário 1 testa só a página.

4. Rode o teste rápido do cenário de acesso para validar que está tudo certo (10 acessos, cerca de 20 segundos):

   ```bash
   npm run acesso:smoke
   ```

Ao terminar, o relatório abre sozinho no navegador (no Windows) e o caminho do arquivo aparece no terminal.

## Cenário 1: acesso à landing page

| Comando | O que faz |
|---|---|
| `npm run acesso:smoke` | 10 acessos, só para validar |
| `npm run acesso:100` | sobe e segura 100 usuários simultâneos |
| `npm run acesso:1k` | sobe e segura 1 mil |
| `npm run acesso:5k` | sobe e segura 5 mil |
| `npm run acesso:15k` | sobe e segura 15 mil |
| `npm run acesso:completo` | todos os degraus em sequência (cerca de 8 minutos) |

Cada usuário virtual faz o que o navegador faz ao abrir a página, sem interagir com nada:

1. baixa a página (`LP_URL`);
2. chama a API que carrega a lista de ingressos (`LP_API_INGRESSOS`).

Depois fica 10 segundos na página, então `usuários simultâneos ≈ novos acessos por segundo × 10`.
As duas etapas aparecem separadas no relatório. Isso importa porque a página costuma ser servida
rápido pela borda da Cloudflare, enquanto a API vai até o servidor: testar só a página esconde
justamente a parte mais lenta. Imagens, CSS e JavaScript da página não entram na carga.

## Cenário 2: inscrição

Este cenário funciona em duas etapas: **gravar uma vez e multiplicar**.

1. **Gravar** (Cypress, 1 usuário real): percorre o fluxo no navegador e grava todas as
   requisições que a página faz em `gravacoes/inscricao.json`.

   ```bash
   npm run inscricao:gravar
   ```

2. **Rodar a carga** (Artillery): a cada execução, a gravação é transformada no cenário de carga
   `tests/gerado/inscricao.yml` e executada com milhares de usuários virtuais.

   ```bash
   npm run inscricao:smoke
   ```

| Comando | O que faz |
|---|---|
| `npm run inscricao:gravar` | grava o fluxo com o Cypress (rode de novo se a página mudar) |
| `npm run inscricao:smoke` | 2 usuários, só para validar |
| `npm run inscricao:100` | sobe e segura 100 usuários simultâneos |
| `npm run inscricao:500` | sobe e segura 500 |
| `npm run inscricao:1k` | sobe e segura 1 mil |
| `npm run inscricao:pico` | pico de abertura de vendas: mil pessoas em 10 segundos, cada uma se inscreve uma vez |
| `npm run inscricao:completo` | todos os degraus em sequência (cerca de 6 minutos) |

**Degraus x pico.** Os degraus medem capacidade **sustentada**: "mil simultâneos" quer dizer
mil pessoas no fluxo o tempo todo, com gente saindo e entrando (50 novas por segundo). Por isso
criam bem mais reservas que o número de simultâneos. O pico mede o **tranco** da abertura de
vendas: mil pessoas chegam juntas, cada uma reserva uma vez e ninguém é reposto.

O que o gerador faz com a gravação:

- Cada requisição vira uma etapa do fluxo, com nome numerado, e aparece na tabela
  **Resultado por etapa** do relatório.
- Cada clique vira uma pausa do usuário (5 segundos), e no fim ele fica 10 segundos no checkout.
  Por isso `usuários simultâneos ≈ novos acessos por segundo × 20`.
- Valores que o servidor devolve e a página reaproveita depois, como o `selectionToken` da reserva,
  são capturados da resposta, então cada usuário virtual usa o seu.
- UUIDs gerados pela própria página, como o `sessionId`, viram um UUID novo por usuário virtual.
- Imagens, CSS e JavaScript não entram na carga: só a abertura das páginas e as chamadas de API.

> **Atenção: cada usuário cria uma reserva real.** O clique em "Realizar inscrição" reserva uma
> vaga do ingresso por 20 minutos. Se o setor tiver menos vagas que o número de usuários do teste,
> o estoque acaba no meio da carga e o resto do teste passa a medir o "esgotado". Use um evento
> com capacidade suficiente para o que vai rodar e espere 20 minutos entre execuções:
>
> | Execução | Reservas criadas (aprox.) |
> |---|---|
> | `inscricao:smoke` | 2 |
> | `inscricao:100` | ~400 |
> | `inscricao:500` | ~2.300 |
> | `inscricao:pico` | ~1.000 |
> | `inscricao:1k` | ~7.500 |
> | `inscricao:completo` | ~9.500 |

## Antes de rodar carga de verdade

Avise o time de infraestrutura e combine a janela do teste. Milhares de acessos vindos de um
único IP podem ser barrados pelo rate limit ou pela proteção anti-DDoS do provedor, e aí o
resultado mede o bloqueio em vez da aplicação. Suba um degrau por vez.

## Relatórios

- `reports/index.html`: histórico com todas as execuções dos dois cenários e o principal achado de cada uma.
- `reports/<cenario>-<degrau>-<data>.html`: relatório de uma execução.
- `reports/dados/`: resultado bruto do Artillery de cada execução.

O relatório não diz se o teste "passou". Ele mostra **onde está o gargalo**:

- **Diagnóstico**, no topo: achados calculados a partir dos dados, do mais grave para o mais leve,
  marcados como Crítico, Atenção ou Informação. O sistema procura:
  - requisições barradas (403, 429, 503) e a partir de qual degrau começaram;
  - falhas (5xx e erros de conexão) acima de 1% e a partir de qual degrau;
  - o degrau em que a latência dispara (p95 2 vezes maior que no degrau mais leve);
  - vazão travada (o ambiente responde menos requisições por segundo do que chegam);
  - carga gerada abaixo do alvo (sinal de que a máquina de teste, e não o ambiente, chegou no limite);
  - no cenário de inscrição: a etapa mais lenta, a que mais piora com a carga e as que já são
    lentas mesmo sem carga.
- **Tempo de resposta por nível de carga**: gráfico com o p95 de cada degrau. O ponto em que a
  curva dobra para cima é onde o ambiente começa a ceder; no cenário de inscrição há uma linha
  por etapa do fluxo.
- Gráficos ao longo do tempo (usuários simultâneos, tempo de resposta, respostas por segundo),
  a tabela por degrau, a tabela por etapa e os dados de cada janela de 10 segundos.

O diagnóstico só compara degraus quando o teste tem mais de um degrau sustentado, como em
`acesso:completo` e `inscricao:completo`. Os testes de um degrau só mostram o retrato daquela carga.

Para rodar sem abrir o navegador ao final: `node scripts/rodar.mts <cenario> <degrau> --sem-abrir`
(por exemplo `node scripts/rodar.mts inscricao smoke --sem-abrir`).

## Critérios de aprovação

O **cenário 1 (acesso) não tem critério**: o objetivo é achar o ponto em que o ambiente cede, e
o comando sempre termina com código de saída 0.

O **cenário 2 (inscrição)** ainda tem critérios em `config.ensure` de `tests/inscricao.base.yml`
(p95 abaixo de 1.000 ms, p99 abaixo de 2.500 ms, nenhum usuário com falha). Eles não aparecem no
relatório; só fazem o comando terminar com código de saída 1 quando não são atendidos, para uso em pipeline.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `tests/acesso-lp.yml` | cenário 1: fluxo e degraus |
| `tests/inscricao.base.yml` | cenário 2: pausas, degraus e critérios (o fluxo vem da gravação) |
| `cypress/gravadores/inscricao.cy.ts` | gravador do fluxo de inscrição |
| `scripts/gerar-cenario.mts` | transforma a gravação do Cypress em cenário do Artillery |
| `scripts/rodar.mts` | roda um cenário e gera o relatório |
| `scripts/relatorio.mts` | monta os relatórios em HTML |
| `src/processor.ts` | hook que conta bloqueios (403, 429, 503) e outros erros |
| `.env.example` | modelo do arquivo com a URL testada |

Ficam fora do git, porque contêm os endereços do ambiente ou são gerados a cada execução:
`.env`, `gravacoes/`, `tests/gerado/` e os relatórios.

## Ajustes comuns

- **Trocar a página testada:** mude `LP_URL` e `LP_API_INGRESSOS` no `.env`. No cenário 2, rode `npm run inscricao:gravar` de novo.
- **Mudar os degraus:** edite as `phases` do ambiente no arquivo do cenário.
  `arrivalRate` é o número de novos acessos por segundo e `duration` é a duração em segundos.
- **Mudar as pausas do cenário 2:** edite `pausas` em `tests/inscricao.base.yml`.
- **Mudar os limites do cenário 2:** edite `config.ensure` em `tests/inscricao.base.yml`.

## Problemas comuns

- **"Defina LP_URL no arquivo .env":** o `.env` não existe ou está sem a variável. Refaça os passos 2 e 3.
- **"Gravação não encontrada":** rode `npm run inscricao:gravar` antes da carga do cenário 2.
- **Gravador do Cypress falha procurando o ingresso:** a API de ingressos do ambiente pode estar
  lenta ou fora do ar. Se a página mudou, ajuste os seletores em `cypress/gravadores/inscricao.cy.ts`.
- **Erro de sintaxe ao rodar um script `.mts`:** a versão do Node é antiga. Confira com `node --version`.
- **Pico medido bem abaixo do alvo na tabela por degrau:** a máquina que gera a carga pode não
  estar dando conta, e os números daquele degrau não são confiáveis.
