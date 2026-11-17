# performance-cam

Testes de carga de landing pages com [Artillery](https://www.artillery.io/) e TypeScript.
Cada execução gera um relatório visual em HTML e entra num histórico de execuções.

## Pré-requisitos

- **Node.js 24 ou mais novo** (os scripts `.mts` rodam direto no Node, sem etapa de build)
- npm (vem com o Node)

## Como rodar

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Crie o arquivo `.env` a partir do modelo:

   ```bash
   cp .env.example .env
   ```

   No PowerShell: `Copy-Item .env.example .env`

3. Abra o `.env` e coloque em `LP_URL` a URL completa da página a testar:

   ```
   LP_URL=https://seu-ambiente.example.com/caminho/da/pagina
   ```

4. Rode o teste rápido para validar que está tudo certo (10 acessos, cerca de 20 segundos):

   ```bash
   npm run smoke
   ```

Ao terminar, o relatório abre sozinho no navegador (no Windows) e o caminho do arquivo aparece no terminal.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run smoke` | 10 acessos, só para validar o cenário |
| `npm run carga:100` | sobe e segura 100 usuários simultâneos |
| `npm run carga:1k` | sobe e segura 1 mil |
| `npm run carga:5k` | sobe e segura 5 mil |
| `npm run carga:15k` | sobe e segura 15 mil |
| `npm run carga` | todos os degraus em sequência (100 → 1 mil → 5 mil → 15 mil, cerca de 8 minutos) |
| `npm run relatorio` | regera os relatórios a partir dos dados salvos, sem rodar teste |
| `npm run typecheck` | checa os tipos do TypeScript |

Para rodar sem abrir o navegador ao final: `node scripts/rodar.mts smoke --sem-abrir`.

> **Antes de rodar carga de verdade:** avise o time de infraestrutura e combine a janela do teste.
> Milhares de acessos vindos de um único IP podem ser barrados pelo rate limit ou pela proteção
> anti-DDoS do provedor, e aí o resultado mede o bloqueio em vez da página. Suba um degrau por vez.

## Relatórios

- `reports/index.html`: histórico com todas as execuções.
- `reports/<teste>-<data>.html`: relatório de uma execução, com veredito, gráficos de usuários
  simultâneos, tempo de resposta e respostas por segundo, e a tabela de resultado por degrau.
- `reports/dados/`: resultado bruto do Artillery de cada execução.

Os relatórios ficam só na sua máquina; não vão para o git.

O comando termina com código de saída 0 quando o teste é aprovado e 1 quando é reprovado,
então dá para usar em pipeline.

## Como a carga funciona

Cada usuário virtual acessa a página e permanece 10 segundos nela. Por isso:

```
usuários simultâneos ≈ novos acessos por segundo × 10
```

Um degrau de 15 mil simultâneos significa 1.500 novos acessos por segundo.

O teste faz só a requisição HTTP da página: baixa o HTML, mas não executa o JavaScript nem
interage com elementos.

## Critérios de aprovação

Definidos em `config.ensure`, no arquivo `tests/acesso-lp.yml`:

- tempo de resposta p95 abaixo de 1.000 ms
- tempo de resposta p99 abaixo de 2.500 ms
- nenhum usuário virtual com falha

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `tests/acesso-lp.yml` | cenário, degraus de carga e critérios de aprovação |
| `src/processor.ts` | hook que conta bloqueios (403, 429, 503) e status inesperados |
| `scripts/rodar.mts` | roda um teste e gera o relatório |
| `scripts/relatorio.mts` | monta os relatórios em HTML |
| `.env.example` | modelo do arquivo com a URL testada |

## Ajustes comuns

- **Trocar a página testada:** mude `LP_URL` no `.env`.
- **Mudar os degraus:** edite as `phases` do ambiente em `tests/acesso-lp.yml`.
  `arrivalRate` é o número de novos acessos por segundo e `duration` é a duração em segundos.
- **Mudar os limites:** edite `config.ensure` no mesmo arquivo.

## Problemas comuns

- **"Defina LP_URL no arquivo .env":** o `.env` não existe ou está sem a variável. Refaça os passos 2 e 3.
- **Erro de sintaxe ao rodar um script `.mts`:** a versão do Node é antiga. Confira com `node --version`.
- **Pico medido bem abaixo do alvo na tabela por degrau:** a máquina que gera a carga pode não
  estar dando conta, e os números daquele degrau não são confiáveis.
