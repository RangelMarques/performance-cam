// Transforma uma gravação do Cypress (gravacoes/<cenario>.json) em cenário de carga do Artillery.
//
// - Cada requisição gravada vira um passo do fluxo, com nome numerado (usado no relatório por etapa).
// - Cada clique gravado vira uma pausa do usuário.
// - Valores que o servidor devolve e a página reaproveita depois (tokens, ids de reserva) são
//   capturados da resposta em tempo de execução, então cada usuário virtual usa os seus.
// - UUIDs gerados pela própria página (ex.: sessionId) viram um UUID novo por usuário virtual.
//
// Uso direto: node scripts/gerar-cenario.mts <cenario>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PassoGravado {
  tipo: "requisicao" | "clique";
  metodo?: string;
  url?: string;
  contentType?: string;
  corpo?: unknown;
  resposta?: unknown;
}

interface Correlacao {
  variavel: string;
  caminho: string; // JSONPath dentro da resposta
  origem: Record<string, unknown>; // requisição que devolve o valor
  usado: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Só correlaciona valores com cara de token: longos e misturando letras e números.
// Ids só numéricos (evento, ingresso) são fixos do evento e ficam como gravados.
function pareceToken(valor: string): boolean {
  return valor.length >= 16 && /[0-9]/.test(valor) && /[a-z]/i.test(valor) && !/\s/.test(valor);
}

function percorrer(valor: unknown, caminho: string, visita: (texto: string, caminho: string) => void): void {
  if (typeof valor === "string") visita(valor, caminho);
  else if (Array.isArray(valor)) valor.forEach((v, i) => percorrer(v, `${caminho}[${i}]`, visita));
  else if (valor && typeof valor === "object") {
    for (const [chave, v] of Object.entries(valor)) {
      const segmento = /^[A-Za-z_$][\w$]*$/.test(chave) ? `.${chave}` : `['${chave}']`;
      percorrer(v, caminho + segmento, visita);
    }
  }
}

export function gerarCenario(cenario: string): string {
  const arquivoGravacao = join(RAIZ, "gravacoes", `${cenario}.json`);
  if (!existsSync(arquivoGravacao)) {
    throw new Error(`Gravação não encontrada. Rode primeiro: npm run ${cenario}:gravar`);
  }
  const gravacao: { passos: PassoGravado[] } = JSON.parse(readFileSync(arquivoGravacao, "utf8"));
  const base = parse(readFileSync(join(RAIZ, "tests", `${cenario}.base.yml`), "utf8"));
  const pausas = { porClique: 5, noFinal: 10, ...(base.pausas ?? {}) };

  const correlacoes = new Map<string, Correlacao>();
  const nomesUsados = new Set<string>();
  const fluxo: Record<string, unknown>[] = [];
  let numero = 0;

  const substituir = (texto: string): string => {
    for (const valor of [...correlacoes.keys()].sort((a, b) => b.length - a.length)) {
      if (!texto.includes(valor)) continue;
      const c = correlacoes.get(valor) as Correlacao;
      c.usado = true;
      texto = texto.replaceAll(valor, `{{ ${c.variavel} }}`);
    }
    // UUID que não veio de nenhuma resposta foi gerado pela página: um novo por usuário virtual.
    return texto.replace(UUID, "{{ $uuid }}");
  };

  const nomeDeVariavel = (caminho: string): string => {
    const ultimo = caminho.match(/([A-Za-z_]\w*)[^A-Za-z_]*$/)?.[1] ?? "valor";
    let nome = ultimo;
    for (let n = 2; nomesUsados.has(nome); n++) nome = `${ultimo}${n}`;
    nomesUsados.add(nome);
    return nome;
  };

  for (const passo of gravacao.passos) {
    if (passo.tipo === "clique") {
      fluxo.push({ think: pausas.porClique });
      continue;
    }

    numero += 1;
    const url = new URL(passo.url as string);
    const metodo = (passo.metodo ?? "GET").toLowerCase();
    const caminhoLegivel = substituir(url.pathname).replace(/\{\{ (\S+) \}\}/g, ":$1");
    const requisicao: Record<string, unknown> = {
      name: `${numero}. ${metodo.toUpperCase()} ${url.hostname.split(".")[0]}${caminhoLegivel}`,
      url: substituir(passo.url as string),
    };
    if (passo.corpo !== undefined) {
      if (typeof passo.corpo === "object") {
        requisicao.json = JSON.parse(substituir(JSON.stringify(passo.corpo)));
      } else {
        requisicao.body = substituir(String(passo.corpo));
        if (passo.contentType) requisicao.headers = { "content-type": passo.contentType };
      }
    }
    requisicao.afterResponse = "contarRespostas";

    // Registra os valores com cara de token que esta resposta devolveu.
    percorrer(passo.resposta, "$", (texto, caminho) => {
      if (pareceToken(texto) && !correlacoes.has(texto)) {
        correlacoes.set(texto, { variavel: nomeDeVariavel(caminho), caminho, origem: requisicao, usado: false });
      }
    });

    fluxo.push({ [metodo]: requisicao });
  }
  fluxo.push({ think: pausas.noFinal });

  // Captura da resposta só o que de fato é reaproveitado depois.
  for (const c of correlacoes.values()) {
    if (!c.usado) continue;
    const capturas = (c.origem.capture as Record<string, string>[] | undefined) ?? [];
    capturas.push({ json: c.caminho, as: c.variavel });
    c.origem.capture = capturas;
  }

  const primeira = gravacao.passos.find((p) => p.tipo === "requisicao") as PassoGravado;
  const config = { target: new URL(primeira.url as string).origin, ...base.config };
  const roteiro = { config, scenarios: [{ name: cenario, flow: fluxo }] };

  const destino = join(RAIZ, "tests", "gerado", `${cenario}.yml`);
  mkdirSync(dirname(destino), { recursive: true });
  const cabecalho =
    `# GERADO AUTOMATICAMENTE a partir de gravacoes/${cenario}.json. Não edite à mão:\n` +
    `# pausas, degraus e critérios ficam em tests/${cenario}.base.yml.\n\n`;
  writeFileSync(destino, cabecalho + stringify(roteiro, { lineWidth: 0 }));
  return destino;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Cenário gerado: ${gerarCenario(process.argv[2] ?? "inscricao")}`);
}
