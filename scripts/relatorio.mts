// Gera os relatórios visuais (HTML) a partir dos resultados do Artillery em reports/dados.
// O relatório não diz se o teste "passou": ele aponta onde o ambiente cede (diagnóstico de gargalo).
// Uso direto: node scripts/relatorio.mts  (regera todos os relatórios e o índice)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIR_RELATORIOS = join(RAIZ, "reports");
export const DIR_DADOS = join(DIR_RELATORIOS, "dados");

// ---------- Tipos ----------

export interface Fase {
  nome: string;
  duracao: number;
  taxaInicial: number;
  taxaFinal: number;
}

export interface Criterio {
  metrica: string;
  operador: string;
  limite: number;
}

export interface Meta {
  id: string;
  cenario?: string; // execuções antigas não têm (eram todas do cenário de acesso)
  titulo?: string;
  ambiente: string;
  inicio: string;
  alvo: string;
  pagina: string;
  permanencia: number;
  fases: Fase[];
  criterios: Criterio[];
}

interface Resumo {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

interface Periodo {
  period: string | number;
  counters: Record<string, number>;
  summaries?: Record<string, Resumo>;
  firstMetricAt?: number;
  lastMetricAt?: number;
}

interface FaseTempo extends Fase {
  inicioSeg: number;
  fimSeg: number;
  alvo: number;
  rampa: boolean;
}

interface Janela {
  fimSeg: number;
  duracaoSeg: number;
  fase: number;
  requisicoes: number;
  ok: number;
  bloqueios: number;
  erros: number;
  codigos: Record<string, number>; // status HTTP e erros de rede (ETIMEDOUT, ECONNRESET...)
  etapasP95: Record<string, number>;
  simultaneos: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

interface Etapa {
  nome: string;
  requisicoes: number;
  p50?: number;
  p95?: number;
  p99?: number;
  ok: number;
  bloqueios: number;
  erros: number;
}

// Números de um degrau (fase), consolidados a partir das janelas de 10 segundos.
interface ResumoFase {
  indice: number;
  fase: FaseTempo;
  pico: number;
  requisicoes: number;
  segundos: number;
  reqSeg: number;
  ok: number;
  bloqueios: number;
  erros: number;
  codigos: Record<string, number>;
  p50?: number; // média ponderada da mediana das janelas
  p95?: number; // pior janela
  p99?: number; // pior janela
  etapasP95: Record<string, number>; // pior janela de cada etapa
}

type Gravidade = "critico" | "alerta" | "info";

interface Achado {
  gravidade: Gravidade;
  titulo: string;
  detalhe: string;
}

interface CriterioAvaliado extends Criterio {
  valor: number | undefined;
  passou: boolean;
}

export interface Execucao {
  meta: Meta;
  titulo: string;
  fases: FaseTempo[];
  janelas: Janela[];
  resumos: ResumoFase[];
  niveis: ResumoFase[]; // degraus sustentados (sem rampa), usados no diagnóstico
  etapas: Etapa[];
  achados: Achado[];
  duracaoSeg: number;
  requisicoes: number;
  erros: number;
  bloqueios: number;
  picoSimultaneos: number;
  picoReqSeg: number;
  p50?: number;
  p95?: number;
  p99?: number;
  // Só para o código de saída do terminal (cenários com critério). O relatório não mostra.
  criteriosAtendidos: boolean;
}

// ---------- Leitura e cálculo ----------

const CODIGOS_DE_BLOQUEIO = ["403", "429", "503"];
const PREFIXO_TEMPO_ETAPA = "plugins.metrics-by-endpoint.response_time.";

function somaPrefixo(contadores: Record<string, number>, prefixo: string): number {
  let soma = 0;
  for (const [chave, valor] of Object.entries(contadores)) {
    if (chave.startsWith(prefixo)) soma += valor;
  }
  return soma;
}

// Sucesso = qualquer status 2xx ou 3xx (a reserva, por exemplo, responde 201).
function desfechos(c: Record<string, number>, prefixo = "http.codes.") {
  let ok = 0;
  let bloqueios = 0;
  let erros = 0;
  for (const [chave, valor] of Object.entries(c)) {
    if (!chave.startsWith(prefixo)) continue;
    const codigo = chave.slice(prefixo.length);
    if (/^[23]\d\d$/.test(codigo)) ok += valor;
    else if (CODIGOS_DE_BLOQUEIO.includes(codigo)) bloqueios += valor;
    else erros += valor;
  }
  return { ok, bloqueios, erros: prefixo === "http.codes." ? erros + somaPrefixo(c, "errors.") : erros };
}

// Tempo e resultado de cada requisição do fluxo (plugin metrics-by-endpoint do Artillery).
function etapasDoFluxo(agregado: Periodo): Etapa[] {
  return Object.entries(agregado.summaries ?? {})
    .filter(([chave]) => chave.startsWith(PREFIXO_TEMPO_ETAPA))
    .map(([chave, resumo]) => {
      const nome = chave.slice(PREFIXO_TEMPO_ETAPA.length);
      const codigos = desfechos(agregado.counters, `plugins.metrics-by-endpoint.${nome}.codes.`);
      return { nome, requisicoes: resumo.count, p50: resumo.p50, p95: resumo.p95, p99: resumo.p99, ...codigos };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true }));
}

function valorMetrica(agregado: Periodo, metrica: string): number | undefined {
  if (metrica in agregado.counters) return agregado.counters[metrica];
  const corte = metrica.lastIndexOf(".");
  const resumo = agregado.summaries?.[metrica.slice(0, corte)] as Record<string, number> | undefined;
  if (resumo) return resumo[metrica.slice(corte + 1)];
  // Contador que nunca foi emitido (ex.: vusers.failed sem nenhuma falha) vale zero.
  return /\.p\d+$|\.(mean|min|max|median)$/.test(metrica) ? undefined : 0;
}

function compara(valor: number, operador: string, limite: number): boolean {
  if (operador === "<") return valor < limite;
  if (operador === "<=") return valor <= limite;
  if (operador === ">") return valor > limite;
  if (operador === ">=") return valor >= limite;
  return valor === limite;
}

function resumirFase(fase: FaseTempo, indice: number, janelas: Janela[]): ResumoFase {
  const js = janelas.filter((j) => j.fase === indice);
  const requisicoes = js.reduce((s, j) => s + j.requisicoes, 0);
  const segundos = js.reduce((s, j) => s + j.duracaoSeg, 0);
  const comTempo = js.filter((j) => j.p50 !== undefined);
  const pesos = comTempo.reduce((s, j) => s + j.requisicoes, 0);
  const pior = (campo: "p95" | "p99") =>
    comTempo.length ? Math.max(...comTempo.map((j) => j[campo] as number)) : undefined;

  const codigos: Record<string, number> = {};
  const etapasP95: Record<string, number> = {};
  for (const j of js) {
    for (const [c, n] of Object.entries(j.codigos)) codigos[c] = (codigos[c] ?? 0) + n;
    for (const [e, v] of Object.entries(j.etapasP95)) etapasP95[e] = Math.max(etapasP95[e] ?? 0, v);
  }

  return {
    indice,
    fase,
    pico: Math.max(0, ...js.map((j) => j.simultaneos)),
    requisicoes,
    segundos,
    reqSeg: segundos > 0 ? requisicoes / segundos : 0,
    ok: js.reduce((s, j) => s + j.ok, 0),
    bloqueios: js.reduce((s, j) => s + j.bloqueios, 0),
    erros: js.reduce((s, j) => s + j.erros, 0),
    codigos,
    p50: pesos > 0 ? comTempo.reduce((s, j) => s + (j.p50 as number) * j.requisicoes, 0) / pesos : undefined,
    p95: pior("p95"),
    p99: pior("p99"),
    etapasP95,
  };
}

export function carregar(caminhoMeta: string): Execucao {
  const meta: Meta = JSON.parse(readFileSync(caminhoMeta, "utf8"));
  const saida: { aggregate: Periodo; intermediate: Periodo[] } = JSON.parse(
    readFileSync(caminhoMeta.replace(/\.meta\.json$/, ".json"), "utf8"),
  );

  const periodos = saida.intermediate.filter((p) => p.firstMetricAt !== undefined);
  const t0 = Math.min(...periodos.map((p) => p.firstMetricAt as number));
  const tFim = Math.max(...periodos.map((p) => p.lastMetricAt as number));
  const passo = periodos.length > 1 ? Number(periodos[1].period) - Number(periodos[0].period) : 10_000;

  let acumulado = 0;
  const fases: FaseTempo[] = meta.fases.map((f) => {
    const inicioSeg = acumulado;
    acumulado += f.duracao;
    return {
      ...f,
      inicioSeg,
      fimSeg: acumulado,
      // Uma fase mais curta que a permanência não chega a acumular usuários de um ciclo inteiro.
      alvo: Math.round(f.taxaFinal * Math.min(meta.permanencia, f.duracao)),
      rampa: f.taxaInicial !== f.taxaFinal,
    };
  });

  let ativos = 0;
  const janelas: Janela[] = periodos.map((p) => {
    const ini = Math.max(Number(p.period), t0);
    const fim = Math.max(Math.min(Number(p.period) + passo, tFim), ini + 1000);
    const meioSeg = ((ini + fim) / 2 - t0) / 1000;
    const indice = fases.findIndex((f) => meioSeg >= f.inicioSeg && meioSeg < f.fimSeg);
    const c = p.counters;
    ativos += (c["vusers.created"] ?? 0) - (c["vusers.completed"] ?? 0) - (c["vusers.failed"] ?? 0);
    const tempo = p.summaries?.["http.response_time"];

    const codigos: Record<string, number> = {};
    for (const [chave, n] of Object.entries(c)) {
      if (chave.startsWith("http.codes.")) codigos[chave.slice(11)] = n;
      else if (chave.startsWith("errors.")) codigos[chave.slice(7)] = n;
    }
    const etapasP95: Record<string, number> = {};
    for (const [chave, r] of Object.entries(p.summaries ?? {})) {
      if (chave.startsWith(PREFIXO_TEMPO_ETAPA)) etapasP95[chave.slice(PREFIXO_TEMPO_ETAPA.length)] = r.p95;
    }

    return {
      fimSeg: (fim - t0) / 1000,
      duracaoSeg: (fim - ini) / 1000,
      fase: indice === -1 ? fases.length - 1 : indice,
      requisicoes: c["http.requests"] ?? 0,
      ...desfechos(c),
      codigos,
      etapasP95,
      simultaneos: Math.max(0, ativos),
      p50: tempo?.p50,
      p95: tempo?.p95,
      p99: tempo?.p99,
    };
  });

  const agregado = saida.aggregate;
  const total = desfechos(agregado.counters);
  const tempoTotal = agregado.summaries?.["http.response_time"];
  const criterios: CriterioAvaliado[] = meta.criterios.map((c) => {
    const valor = valorMetrica(agregado, c.metrica);
    return { ...c, valor, passou: valor !== undefined && compara(valor, c.operador, c.limite) };
  });

  const resumos = fases.map((f, i) => resumirFase(f, i, janelas));
  const sustentados = resumos.filter((r) => !r.fase.rampa && r.requisicoes > 0);
  const niveis = sustentados.length ? sustentados : resumos.filter((r) => r.requisicoes > 0);
  const etapas = etapasDoFluxo(agregado);
  const usuarios = agregado.counters["vusers.created"] ?? 0;
  const reqPorUsuario = usuarios > 0 ? (agregado.counters["http.requests"] ?? 0) / usuarios : 1;

  return {
    meta,
    titulo: meta.titulo ?? "Acesso à landing page",
    fases,
    janelas,
    resumos,
    niveis,
    etapas,
    achados: diagnosticar(niveis, etapas, reqPorUsuario, meta.permanencia),
    duracaoSeg: Math.max(acumulado, (tFim - t0) / 1000),
    requisicoes: agregado.counters["http.requests"] ?? 0,
    erros: total.erros,
    bloqueios: total.bloqueios,
    picoSimultaneos: Math.max(0, ...janelas.map((j) => j.simultaneos)),
    picoReqSeg: Math.max(0, ...janelas.map((j) => j.requisicoes / j.duracaoSeg)),
    p50: tempoTotal?.p50,
    p95: tempoTotal?.p95,
    p99: tempoTotal?.p99,
    criteriosAtendidos: criterios.every((c) => c.passou),
  };
}

// ---------- Diagnóstico de gargalo ----------
//
// Regras (todas olham os degraus sustentados, do mais leve para o mais pesado):
// - Bloqueios: primeiro degrau com respostas 403/429/503.
// - Erros: primeiro degrau com 1% ou mais de falhas (5xx, 4xx fora os bloqueios, erros de rede).
// - Latência: primeiro degrau em que o p95 ficou 2x maior que no degrau mais leve (e +200 ms).
// - Vazão: degrau longo que respondeu menos de 85% das requisições por segundo que chegaram.
// - Gerador: degrau em que a carga gerada ficou abaixo de 80% do alvo (limite da máquina de teste).
// - Etapas: a mais lenta no degrau mais pesado, a que mais piorou e as lentas mesmo sem carga.

const LENTO_MS = 1000;

const usuariosTexto = (n: number) => `~${fmtCompacto(n)} ${n === 1 ? "usuário" : "usuários"}`;
const pct = (parte: number, todo: number) => (todo > 0 ? `${umaCasa.format((parte / todo) * 100)}%` : "0%");

function principaisCodigos(codigos: Record<string, number>, filtro: (c: string) => boolean): string {
  return Object.entries(codigos)
    .filter(([c]) => filtro(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c, n]) => `${c} (${fmt(n)})`)
    .join(", ");
}

function diagnosticar(niveis: ResumoFase[], etapas: Etapa[], reqPorUsuario: number, permanencia: number): Achado[] {
  const achados: Achado[] = [];
  if (niveis.length === 0) return achados;
  const base = niveis[0];
  const maisPesado = niveis[niveis.length - 1];
  const onde = (n: ResumoFase) => `no degrau de ${usuariosTexto(n.fase.alvo)}`;
  const Onde = (n: ResumoFase) => `No degrau de ${usuariosTexto(n.fase.alvo)}`;
  const ehErro = (c: string) => !/^[23]\d\d$/.test(c) && !CODIGOS_DE_BLOQUEIO.includes(c);

  const comBloqueio = niveis.find((n) => n.bloqueios > 0);
  if (comBloqueio) {
    achados.push({
      gravidade: "critico",
      titulo: `Requisições barradas a partir de ${usuariosTexto(comBloqueio.fase.alvo)}`,
      detalhe:
        `${Onde(comBloqueio)}, ${pct(comBloqueio.bloqueios, comBloqueio.requisicoes)} das respostas foram bloqueadas ou recusadas ` +
        `(${principaisCodigos(comBloqueio.codigos, (c) => CODIGOS_DE_BLOQUEIO.includes(c))}). ` +
        `403 e 429 costumam ser rate limit ou proteção anti-DDoS; 503 indica serviço sem capacidade. ` +
        `Daqui em diante o teste mede o bloqueio, não a aplicação.`,
    });
  }

  const comErro = niveis.find((n) => n.requisicoes > 0 && n.erros / n.requisicoes >= 0.01);
  if (comErro) {
    achados.push({
      gravidade: "critico",
      titulo: `Falhas a partir de ${usuariosTexto(comErro.fase.alvo)}`,
      detalhe:
        `${Onde(comErro)}, ${pct(comErro.erros, comErro.requisicoes)} das requisições falharam ` +
        `(${principaisCodigos(comErro.codigos, ehErro)}). Erros 5xx e de conexão (ETIMEDOUT, ECONNRESET) ` +
        `indicam que algum componente esgotou a capacidade.`,
    });
  }

  if (base.p95 !== undefined) {
    const degradou = niveis.slice(1).find((n) => n.p95 !== undefined && n.p95 >= base.p95! * 2 && n.p95 - base.p95! >= 200);
    if (degradou) {
      achados.push({
        gravidade: "alerta",
        titulo: `Latência dispara a partir de ${usuariosTexto(degradou.fase.alvo)}`,
        detalhe:
          `O p95 foi de ${fmtMs(base.p95)} ${onde(base)} para ${fmtMs(degradou.p95)} ${onde(degradou)}, ` +
          `${umaCasa.format(degradou.p95! / base.p95)} vezes mais. É o ponto em que as requisições começam a fazer fila.`,
      });
    }
  }

  for (const n of niveis) {
    const esperado = n.fase.taxaFinal * reqPorUsuario;
    const geradorNoLimite = n.fase.alvo >= 20 && n.fase.duracao >= permanencia && n.pico < n.fase.alvo * 0.8;
    if (geradorNoLimite) {
      achados.push({
        gravidade: "alerta",
        titulo: `Carga gerada abaixo do alvo ${onde(n)}`,
        detalhe:
          `A meta era ${usuariosTexto(n.fase.alvo)} e o pico medido foi ${usuariosTexto(n.pico)}. ` +
          `A máquina que gera o teste pode ter chegado no limite: os números desse degrau subestimam a carga, ` +
          `e o gargalo pode ser o gerador, não o ambiente.`,
      });
    } else if (n.fase.duracao >= permanencia * 2 && esperado >= 5 && n.reqSeg < esperado * 0.85) {
      // Só vale em degrau longo o bastante para a carga estabilizar (2x o tempo de um usuário no fluxo).
      achados.push({
        gravidade: "alerta",
        titulo: `Vazão travou ${onde(n)}`,
        detalhe:
          `Chegaram cerca de ${umaCasa.format(esperado)} requisições por segundo, mas o ambiente respondeu ` +
          `${umaCasa.format(n.reqSeg)} por segundo (${pct(n.reqSeg, esperado)}). O sistema não acompanha o ritmo de chegada.`,
      });
    }
  }

  if (etapas.length >= 2) {
    const nomesEtapas = etapas.map((e) => e.nome);
    // Com um degrau só, usa o p95 do teste inteiro (o mesmo da tabela por etapa).
    // Com vários, usa a pior janela de cada degrau, que é o que permite comparar um com o outro.
    const p95No = (n: ResumoFase, e: string) =>
      (niveis.length === 1 ? etapas.find((x) => x.nome === e)?.p95 : n.etapasP95[e]) as number;
    const ordenadas = nomesEtapas
      .filter((e) => p95No(maisPesado, e) !== undefined)
      .sort((a, b) => p95No(maisPesado, b) - p95No(maisPesado, a));
    if (ordenadas.length) {
      const lenta = ordenadas[0];
      const total = ordenadas.reduce((s, e) => s + p95No(maisPesado, e), 0);
      achados.push({
        gravidade: p95No(maisPesado, lenta) >= LENTO_MS ? "alerta" : "info",
        titulo: `Etapa mais lenta: ${lenta}`,
        detalhe:
          `${niveis.length > 1 ? Onde(maisPesado) : "Neste teste"}, o p95 dela foi ${fmtMs(p95No(maisPesado, lenta))}, ` +
          `${pct(p95No(maisPesado, lenta), total)} da soma do p95 de todas as etapas do fluxo.`,
      });
    }

    if (niveis.length > 1) {
      const crescimento = nomesEtapas
        .filter((e) => p95No(base, e) && p95No(maisPesado, e))
        .map((e) => ({ e, de: p95No(base, e), para: p95No(maisPesado, e) }))
        .sort((a, b) => b.para / b.de - a.para / a.de)[0];
      if (crescimento && crescimento.para / crescimento.de >= 1.5) {
        achados.push({
          gravidade: "alerta",
          titulo: `Etapa que mais piora com a carga: ${crescimento.e}`,
          detalhe:
            `O p95 foi de ${fmtMs(crescimento.de)} ${onde(base)} para ${fmtMs(crescimento.para)} ${onde(maisPesado)}, ` +
            `${umaCasa.format(crescimento.para / crescimento.de)} vezes mais. É a candidata mais forte a gargalo.`,
        });
      }
    }

    const lentasSemCarga = nomesEtapas.filter((e) => (p95No(base, e) ?? 0) >= LENTO_MS);
    if (lentasSemCarga.length) {
      achados.push({
        gravidade: "alerta",
        titulo: `${lentasSemCarga.length === 1 ? "Etapa lenta" : "Etapas lentas"} mesmo com pouca carga`,
        detalhe:
          `${Onde(base)}, ${lentasSemCarga.map((e) => `${e} (${fmtMs(p95No(base, e))})`).join("; ")} ` +
          `já ${lentasSemCarga.length === 1 ? "passou" : "passaram"} de 1 segundo. A lentidão vem do próprio componente, não da carga.`,
      });
    }
  } else if (base.p95 !== undefined && base.p95 >= LENTO_MS) {
    achados.push({
      gravidade: "alerta",
      titulo: "Lenta mesmo com pouca carga",
      detalhe: `${Onde(base)}, o p95 já foi ${fmtMs(base.p95)}. A lentidão vem do próprio ambiente, não da carga.`,
    });
  }

  if (!achados.some((a) => a.gravidade !== "info")) {
    achados.unshift({
      gravidade: "info",
      titulo: `Nenhum sinal de gargalo até ${usuariosTexto(maisPesado.pico)}`,
      detalhe:
        `Latência estável, sem erros e sem bloqueios ${niveis.length === 1 ? "no degrau testado" : `em todos os ${niveis.length} degraus`}. ` +
        `Para achar o limite, rode um degrau mais pesado.`,
    });
  }

  const ordem: Record<Gravidade, number> = { critico: 0, alerta: 1, info: 2 };
  return achados.sort((a, b) => ordem[a.gravidade] - ordem[b.gravidade]);
}

// ---------- Formatação ----------

const inteiro = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const umaCasa = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const compacto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

const fmt = (n: number) => inteiro.format(n);
const fmtCompacto = (n: number) => (n >= 10_000 ? compacto.format(n) : inteiro.format(n));
const fmtMs = (n: number | undefined) => (n === undefined ? "–" : `${inteiro.format(n)} ms`);
// Eixo de tempo: em segundos a partir de 1.000 ms ("30 s" em vez de "30 mil").
const fmtEixoMs = (n: number) => (n >= 1000 ? `${umaCasa.format(n / 1000)} s` : `${inteiro.format(n)} ms`);
const fmtTempo = (seg: number) =>
  `${Math.floor(seg / 60)}:${String(Math.floor(seg % 60)).padStart(2, "0")}`;
const fmtData = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function esc(texto: string): string {
  return texto
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------- Gráficos (SVG) ----------

const L = 960; // largura do viewBox
const A = 280; // altura do viewBox
const M = { esq: 56, dir: 76, topo: 30, base: 30 };
const CORES_SERIES = ["--serie-1", "--serie-2", "--serie-3", "--serie-4", "--serie-5", "--serie-6", "--serie-7", "--serie-8"];

interface Serie {
  nome: string;
  cor: string; // nome da variável CSS
  valores: (number | undefined)[];
}

interface LinhaDica {
  nome: string;
  valor: string;
  cor: string;
}

function ticksLegiveis(maximo: number, passoMinimo = 0, quantidade = 4): number[] {
  const bruto = (maximo > 0 ? maximo : 1) / quantidade;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const fracao = bruto / potencia;
  const passoBruto = (fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 2.5 ? 2.5 : fracao <= 5 ? 5 : 10) * potencia;
  const passo = Math.max(passoBruto, passoMinimo);
  const topo = Math.ceil((maximo > 0 ? maximo : 1) / passo - 1e-9) * passo;
  const ticks: number[] = [];
  for (let v = 0; v <= topo + passo / 2; v += passo) ticks.push(v);
  return ticks;
}

function ticksDeTempo(duracao: number): number[] {
  const passo = [5, 10, 15, 30, 60, 120, 300, 600].find((p) => duracao / p <= 8) ?? 900;
  const ticks: number[] = [];
  for (let t = 0; t <= duracao; t += passo) ticks.push(t);
  return ticks;
}

interface Moldura {
  x: (seg: number) => number;
  y: (valor: number) => number;
  fundo: string;
}

function eixoY(maximo: number, fmtEixo: (n: number) => string, passoMinimo: number) {
  const ticksY = ticksLegiveis(maximo, passoMinimo);
  const topoY = ticksY[ticksY.length - 1];
  const y = (valor: number) => A - M.base - (valor / topoY) * (A - M.topo - M.base);
  let fundo = "";
  for (const t of ticksY) {
    const classe = t === 0 ? "eixo" : "grade";
    fundo += `<line class="${classe}" x1="${M.esq}" x2="${L - M.dir}" y1="${y(t)}" y2="${y(t)}"/>`;
    fundo += `<text class="tick" x="${M.esq - 8}" y="${y(t) + 4}" text-anchor="end">${fmtEixo(t)}</text>`;
  }
  return { y, fundo };
}

// Eixos, grade e a marcação dos degraus dos gráficos ao longo do tempo.
function moldura(exec: Execucao, maximo: number, fmtEixo: (n: number) => string, passoMinimo = 0): Moldura {
  const { y, fundo: grade } = eixoY(maximo, fmtEixo, passoMinimo);
  const x = (seg: number) => M.esq + (seg / exec.duracaoSeg) * (L - M.esq - M.dir);

  let fundo = grade;
  for (const t of ticksDeTempo(exec.duracaoSeg)) {
    fundo += `<text class="tick" x="${x(t)}" y="${A - M.base + 18}" text-anchor="middle">${fmtTempo(t)}</text>`;
  }
  for (const f of exec.fases) {
    if (f.inicioSeg > 0) {
      fundo += `<line class="degrau" x1="${x(f.inicioSeg)}" x2="${x(f.inicioSeg)}" y1="${M.topo - 14}" y2="${A - M.base}"/>`;
    }
    const largura = x(f.fimSeg) - x(f.inicioSeg);
    const rotulo = f.rampa ? "subida" : fmtCompacto(f.alvo);
    if (largura >= rotulo.length * 7 + 10) {
      fundo += `<text class="rotulo-degrau" x="${x(f.inicioSeg) + largura / 2}" y="${M.topo - 12}" text-anchor="middle">${rotulo}</text>`;
    }
  }
  return { x, y, fundo };
}

function figura(titulo: string, sub: string, legenda: Serie[], svg: string, xs: number[], dicas: { titulo: string; linhas: LinhaDica[] }[]): string {
  const dados = JSON.stringify({ largura: L, xs, dicas }).replaceAll("<", "\\u003c");
  const itens = legenda
    .map((s) => `<span class="item"><i style="background:var(${s.cor})"></i>${esc(s.nome)}</span>`)
    .join("");
  return `<figure class="cartao grafico">
  <figcaption><h3>${esc(titulo)}</h3><p>${esc(sub)}</p></figcaption>
  ${legenda.length > 1 ? `<div class="legenda">${itens}</div>` : ""}
  <div class="palco">
    <svg viewBox="0 0 ${L} ${A}" role="img" aria-label="${esc(titulo)}">${svg}<line class="mira" y1="${M.topo}" y2="${A - M.base}" style="display:none"/></svg>
    <div class="dica" hidden></div>
  </div>
  <script type="application/json">${dados}</script>
</figure>`;
}

// Desenha as linhas das séries sobre posições x já calculadas.
function tracarLinhas(series: Serie[], xs: number[], y: (v: number) => number, fmtValor: (n: number) => string, area: boolean): string {
  let svg = "";
  const finais: { y: number; texto: string }[] = [];
  for (const s of series) {
    const pontos = s.valores
      .map((v, i) => (v === undefined ? undefined : { x: xs[i], y: y(v), v }))
      .filter((p): p is { x: number; y: number; v: number } => p !== undefined);
    if (pontos.length === 0) continue;
    // A curva de área parte do zero no início do teste (ponto só de traçado, sem marcador).
    if (area) pontos.unshift({ x: M.esq, y: y(0), v: 0 });
    const tracado = pontos.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    if (area && pontos.length > 1) {
      const base = y(0);
      svg += `<path d="${tracado} L${pontos[pontos.length - 1].x.toFixed(1)} ${base} L${pontos[0].x.toFixed(1)} ${base} Z" style="fill:var(${s.cor});opacity:.1"/>`;
    }
    svg += `<path class="linha" d="${tracado}" style="stroke:var(${s.cor})"/>`;
    const visiveis = area ? pontos.slice(1) : pontos;
    const marcados = visiveis.length <= 12 ? visiveis : [visiveis[visiveis.length - 1]];
    for (const p of marcados) {
      svg += `<circle class="marca" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" style="fill:var(${s.cor})"/>`;
    }
    const ultimo = pontos[pontos.length - 1];
    finais.push({ y: ultimo.y, texto: fmtValor(ultimo.v) });
  }

  // Rótulo direto no fim de cada linha, só quando não se sobrepõem.
  const ordenados = [...finais].sort((a, b) => a.y - b.y);
  const colidem = ordenados.some((f, i) => i > 0 && f.y - ordenados[i - 1].y < 14);
  if (!colidem && xs.length) {
    const xFim = xs[xs.length - 1] + 10;
    for (const f of finais) svg += `<text class="valor" x="${xFim}" y="${f.y + 4}">${esc(f.texto)}</text>`;
  }
  return svg;
}

function tituloDica(exec: Execucao, j: Janela): string {
  const fase = exec.fases[j.fase];
  return `${fmtTempo(j.fimSeg)} · ${fase ? fase.nome : ""}`;
}

function graficoLinhas(
  exec: Execucao,
  opcoes: {
    titulo: string;
    sub: string;
    series: Serie[];
    fmtValor: (n: number) => string;
    area?: boolean;
    inteiro?: boolean; // contagens: o eixo não usa frações
    fmtEixo?: (n: number) => string;
  },
): string {
  const { series, fmtValor } = opcoes;
  const todos = series.flatMap((s) => s.valores).filter((v): v is number => v !== undefined);
  const m = moldura(exec, Math.max(0, ...todos), opcoes.fmtEixo ?? fmtCompacto, opcoes.inteiro ? 1 : 0);
  const xs = exec.janelas.map((j) => m.x(j.fimSeg));
  const svg = m.fundo + tracarLinhas(series, xs, m.y, fmtValor, opcoes.area ?? false);

  const dicas = exec.janelas.map((j, i) => ({
    titulo: tituloDica(exec, j),
    linhas: series
      .filter((s) => s.valores[i] !== undefined)
      .map((s) => ({ nome: s.nome, valor: fmtValor(s.valores[i] as number), cor: s.cor })),
  }));
  return figura(opcoes.titulo, opcoes.sub, series, svg, xs, dicas);
}

function graficoColunas(exec: Execucao, opcoes: { titulo: string; sub: string; series: Serie[]; fmtValor: (n: number) => string }): string {
  const { series, fmtValor } = opcoes;
  const totais = exec.janelas.map((_, i) => series.reduce((s, serie) => s + (serie.valores[i] ?? 0), 0));
  const m = moldura(exec, Math.max(0, ...totais), (n) => umaCasa.format(n));
  const centros = exec.janelas.map((j) => m.x(j.fimSeg - j.duracaoSeg / 2));
  const faixa = (L - M.esq - M.dir) / Math.max(1, exec.duracaoSeg / 10);
  const largura = Math.max(2, Math.min(24, faixa - 2));
  let svg = m.fundo;

  exec.janelas.forEach((_, i) => {
    const partes = series.map((s) => ({ cor: s.cor, v: s.valores[i] ?? 0 })).filter((p) => p.v > 0);
    let acumulado = 0;
    partes.forEach((p, k) => {
      const yBase = m.y(acumulado) - (k > 0 ? 2 : 0); // vão de 2px entre segmentos
      acumulado += p.v;
      const yTopo = m.y(acumulado);
      const h = yBase - yTopo;
      if (h <= 0) return;
      const x0 = centros[i] - largura / 2;
      const r = k === partes.length - 1 ? Math.min(4, h, largura / 2) : 0;
      svg += `<path d="M${x0.toFixed(1)} ${yBase.toFixed(1)} V${(yTopo + r).toFixed(1)} q0 ${-r} ${r} ${-r} H${(x0 + largura - r).toFixed(1)} q${r} 0 ${r} ${r} V${yBase.toFixed(1)} Z" style="fill:var(${p.cor})"/>`;
    });
  });

  const dicas = exec.janelas.map((j, i) => ({
    titulo: tituloDica(exec, j),
    linhas: series.map((s) => ({ nome: s.nome, valor: fmtValor(s.valores[i] ?? 0), cor: s.cor })),
  }));
  return figura(opcoes.titulo, opcoes.sub, series, svg, centros, dicas);
}

// Tempo de resposta em cada degrau sustentado: mostra onde a curva "dobra".
function graficoPorNivel(exec: Execucao): string {
  const { niveis, etapas } = exec;
  if (niveis.length < 2) return "";

  let series: Serie[];
  let sub: string;
  if (etapas.length >= 2) {
    // Uma linha por etapa do fluxo (até 8; as mais lentas no degrau mais pesado).
    const pesado = niveis[niveis.length - 1];
    const escolhidas = etapas
      .map((e) => e.nome)
      .sort((a, b) => (pesado.etapasP95[b] ?? 0) - (pesado.etapasP95[a] ?? 0))
      .slice(0, CORES_SERIES.length)
      .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
    series = escolhidas.map((nome, i) => ({ nome, cor: CORES_SERIES[i], valores: niveis.map((n) => n.etapasP95[nome]) }));
    sub = "p95 de cada etapa do fluxo, por degrau. A linha que sobe mais rápido é o gargalo.";
  } else {
    series = [
      { nome: "p50 (mediana)", cor: "--serie-1", valores: niveis.map((n) => n.p50) },
      { nome: "p95", cor: "--serie-2", valores: niveis.map((n) => n.p95) },
      { nome: "p99", cor: "--serie-3", valores: niveis.map((n) => n.p99) },
    ];
    sub = "Tempo de resposta em cada degrau. O ponto em que a curva dobra para cima é onde o ambiente começa a ceder.";
  }

  const todos = series.flatMap((s) => s.valores).filter((v): v is number => v !== undefined);
  const { y, fundo } = eixoY(Math.max(0, ...todos), fmtEixoMs, 0);
  const passo = (L - M.esq - M.dir) / Math.max(1, niveis.length - 1);
  const xs = niveis.map((_, i) => M.esq + i * passo);
  let svg = fundo;
  niveis.forEach((n, i) => {
    svg += `<text class="tick" x="${xs[i]}" y="${A - M.base + 18}" text-anchor="middle">${esc(usuariosTexto(n.fase.alvo))}</text>`;
  });
  svg += tracarLinhas(series, xs, y, fmtMs, false);

  const dicas = niveis.map((n, i) => ({
    titulo: `${n.fase.nome} · ${usuariosTexto(n.fase.alvo)}`,
    linhas: series
      .filter((s) => s.valores[i] !== undefined)
      .map((s) => ({ nome: s.nome, valor: fmtMs(s.valores[i]), cor: s.cor })),
  }));
  return figura("Tempo de resposta por nível de carga", sub, series, svg, xs, dicas);
}

// ---------- Páginas ----------

const ESTILO = `
:root {
  color-scheme: light;
  --plano: #f9f9f7; --superficie: #fcfcfb; --tinta: #0b0b0b; --tinta-2: #52514e; --apagado: #898781;
  --grade: #e1e0d9; --eixo: #c3c2b7; --borda: rgba(11,11,11,.10);
  --serie-1: #2a78d6; --serie-2: #eb6834; --serie-3: #1baf7a; --serie-4: #eda100;
  --serie-5: #e87ba4; --serie-6: #008300; --serie-7: #6250d6; --serie-8: #e34948;
  --bom: #0ca30c; --alerta: #fab219; --critico: #d03b3b; --info: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --plano: #0d0d0d; --superficie: #1a1a19; --tinta: #f0efec; --tinta-2: #c3c2b7; --apagado: #898781;
    --grade: #2c2c2a; --eixo: #383835; --borda: rgba(255,255,255,.10);
    --serie-1: #3987e5; --serie-2: #d95926; --serie-3: #199e70; --serie-4: #c98500;
    --serie-5: #d55181; --serie-6: #0ca30c; --serie-7: #9085e9; --serie-8: #e66767;
    --info: #3987e5;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--plano); color: var(--tinta); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 40px 0 12px; }
h3 { font-size: 14px; margin: 0; }
p { margin: 0; }
a { color: inherit; }
.sub { color: var(--tinta-2); overflow-wrap: anywhere; }
.voltar { display: inline-block; margin-bottom: 16px; color: var(--tinta-2); }
.cartao { background: var(--superficie); border: 1px solid var(--borda); border-radius: 10px; padding: 16px; margin: 0; }
.diagnostico { margin-top: 24px; }
.diagnostico .manchete { display: flex; align-items: flex-start; gap: 10px; font-size: 20px; font-weight: 600; line-height: 1.35; }
.diagnostico .manchete .selo { margin-top: 3px; }
.achados { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
.achados li { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: start; }
.achados .titulo { font-weight: 600; }
.achados .detalhe { grid-column: 2; color: var(--tinta-2); }
.selo { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.icone { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; flex: none; }
.icone.critico { background: var(--critico); } .icone.alerta { background: var(--alerta); color: #0b0b0b; } .icone.info { background: var(--info); }
.nota-prd { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--grade); color: var(--tinta-2); font-size: 13px; }
.blocos { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
.bloco .rotulo { color: var(--tinta-2); font-size: 13px; }
.bloco .numero { font-size: 26px; font-weight: 600; line-height: 1.25; }
.bloco .nota { color: var(--apagado); font-size: 12px; }
.grafico { margin-top: 12px; }
.grafico figcaption p { color: var(--tinta-2); font-size: 13px; }
.legenda { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-top: 8px; font-size: 13px; color: var(--tinta-2); }
.legenda .item { display: inline-flex; align-items: center; gap: 6px; }
.legenda i { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.palco { position: relative; margin-top: 8px; }
svg { display: block; width: 100%; height: auto; }
svg text { font-family: inherit; }
.grade { stroke: var(--grade); stroke-width: 1; } .eixo { stroke: var(--eixo); stroke-width: 1; }
.degrau { stroke: var(--eixo); stroke-width: 1; }
.tick { fill: var(--apagado); font-size: 11px; font-variant-numeric: tabular-nums; }
.rotulo-degrau { fill: var(--tinta-2); font-size: 11px; }
.valor { fill: var(--tinta); font-size: 12px; font-weight: 600; }
.linha { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.marca { stroke: var(--superficie); stroke-width: 2; }
.mira { stroke: var(--apagado); stroke-width: 1; pointer-events: none; }
.dica { position: absolute; top: 0; pointer-events: none; background: var(--superficie); border: 1px solid var(--borda); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); white-space: nowrap; z-index: 1; }
.dica strong { display: block; margin-bottom: 4px; }
.dica div { display: flex; align-items: center; gap: 6px; color: var(--tinta-2); }
.dica i { width: 8px; height: 8px; border-radius: 2px; }
.dica b { margin-left: auto; padding-left: 12px; color: var(--tinta); font-variant-numeric: tabular-nums; }
.rolagem { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--grade); white-space: nowrap; font-variant-numeric: tabular-nums; }
th { color: var(--tinta-2); font-weight: 500; }
th:first-child, td:first-child { text-align: left; }
tr:last-child td { border-bottom: 0; }
td.texto { text-align: left; white-space: normal; min-width: 160px; }
td .icone { vertical-align: -4px; margin-right: 6px; }
details { margin-top: 12px; } summary { cursor: pointer; color: var(--tinta-2); }
`;

const SCRIPT_DICAS = `
document.querySelectorAll("figure.grafico").forEach(function (fig) {
  var svg = fig.querySelector("svg");
  var dados = JSON.parse(fig.querySelector('script[type="application/json"]').textContent);
  var dica = fig.querySelector(".dica");
  var mira = svg.querySelector(".mira");
  function esconder() { dica.hidden = true; mira.style.display = "none"; }
  svg.addEventListener("pointerleave", esconder);
  svg.addEventListener("pointermove", function (ev) {
    if (!dados.xs.length) return;
    var caixa = svg.getBoundingClientRect();
    var x = (ev.clientX - caixa.left) / caixa.width * dados.largura;
    var i = 0, menor = Infinity;
    dados.xs.forEach(function (v, k) { var d = Math.abs(v - x); if (d < menor) { menor = d; i = k; } });
    mira.setAttribute("x1", dados.xs[i]); mira.setAttribute("x2", dados.xs[i]); mira.style.display = "";
    dica.textContent = "";
    var titulo = document.createElement("strong"); titulo.textContent = dados.dicas[i].titulo; dica.appendChild(titulo);
    dados.dicas[i].linhas.forEach(function (l) {
      var linha = document.createElement("div");
      var cor = document.createElement("i"); cor.style.background = "var(" + l.cor + ")";
      var valor = document.createElement("b"); valor.textContent = l.valor;
      linha.appendChild(cor); linha.appendChild(document.createTextNode(l.nome)); linha.appendChild(valor);
      dica.appendChild(linha);
    });
    dica.hidden = false;
    var px = dados.xs[i] / dados.largura * caixa.width;
    var naDireita = px + 12 + dica.offsetWidth < caixa.width;
    dica.style.left = (naDireita ? px + 12 : Math.max(0, px - 12 - dica.offsetWidth)) + "px";
  });
});
`;

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<style>${ESTILO}</style>
</head>
<body>
<main>
${corpo}
</main>
<script>${SCRIPT_DICAS}</script>
</body>
</html>
`;
}

const ROTULO_GRAVIDADE: Record<Gravidade, string> = { critico: "Crítico", alerta: "Atenção", info: "Informação" };
const SIMBOLO_GRAVIDADE: Record<Gravidade, string> = { critico: "✕", alerta: "!", info: "i" };

const icone = (g: Gravidade) => `<span class="icone ${g}" aria-hidden="true">${SIMBOLO_GRAVIDADE[g]}</span>`;
const selo = (g: Gravidade) => `<span class="selo">${icone(g)}${ROTULO_GRAVIDADE[g]}</span>`;

function bloco(rotulo: string, numero: string, nota = ""): string {
  return `<div class="cartao bloco"><div class="rotulo">${esc(rotulo)}</div><div class="numero">${esc(numero)}</div><div class="nota">${esc(nota)}</div></div>`;
}

function secaoDiagnostico(exec: Execucao): string {
  const [principal, ...demais] = exec.achados;
  if (!principal) return "";
  const itens = demais
    .map(
      (a) => `<li>${selo(a.gravidade)}<span class="titulo">${esc(a.titulo)}</span><span class="detalhe">${esc(a.detalhe)}</span></li>`,
    )
    .join("");
  return `
<section class="cartao diagnostico" aria-label="Onde está o gargalo">
  <div class="manchete">${icone(principal.gravidade)}<span>${esc(principal.titulo)}</span></div>
  <p class="sub" style="margin:6px 0 0 28px">${esc(principal.detalhe)}</p>
  ${itens ? `<ul class="achados">${itens}</ul>` : ""}
  <p class="nota-prd">Este teste roda em staging. Cada achado aponta onde o ambiente cede; se produção usa os mesmos
  componentes (workers, APIs, proteção da Cloudflare), o mesmo ponto fraco tende a existir lá, com o limite em outro número.</p>
</section>`;
}

// Só aparece quando o fluxo tem mais de uma requisição (cenários com interação).
function tabelaEtapas(exec: Execucao): string {
  if (exec.etapas.length < 2) return "";
  const linhas = exec.etapas
    .map(
      (e) => `<tr><td>${esc(e.nome)}</td><td>${fmt(e.requisicoes)}</td><td>${fmtMs(e.p50)}</td>
<td>${fmtMs(e.p95)}</td><td>${fmtMs(e.p99)}</td><td>${fmt(e.ok)}</td><td>${fmt(e.bloqueios)}</td><td>${fmt(e.erros)}</td></tr>`,
    )
    .join("");
  return `
<h2>Resultado por etapa do fluxo</h2>
<p class="sub">Cada requisição do fluxo, na ordem em que acontece, somando o teste inteiro.</p>
<div class="cartao rolagem" style="margin-top:12px">
<table>
<thead><tr><th>Etapa</th><th>Requisições</th><th>Mediana</th><th>p95</th><th>p99</th><th>Sucesso</th><th>Bloqueios</th><th>Erros</th></tr></thead>
<tbody>${linhas}</tbody>
</table>
</div>
`;
}

function htmlExecucao(exec: Execucao): string {
  const { meta, janelas } = exec;

  const linhasFases = exec.resumos
    .map(
      (r) => `<tr>
  <td>${esc(r.fase.nome)}</td><td>${fmtTempo(r.fase.duracao)}</td><td>${fmt(r.fase.alvo)}</td>
  <td>${fmt(r.pico)}</td><td>${fmt(r.requisicoes)}</td>
  <td>${r.segundos > 0 ? umaCasa.format(r.reqSeg) : "–"}</td>
  <td>${fmtMs(r.p50)}</td><td>${fmtMs(r.p95)}</td><td>${fmtMs(r.p99)}</td>
  <td>${fmt(r.bloqueios)}</td><td>${fmt(r.erros)}</td>
</tr>`,
    )
    .join("");

  const linhasJanelas = janelas
    .map(
      (j) => `<tr><td>${fmtTempo(j.fimSeg)}</td><td>${fmt(j.simultaneos)}</td><td>${fmt(j.requisicoes)}</td>
<td>${fmtMs(j.p50)}</td><td>${fmtMs(j.p95)}</td><td>${fmtMs(j.p99)}</td><td>${fmt(j.bloqueios)}</td><td>${fmt(j.erros)}</td></tr>`,
    )
    .join("");

  const taxa = (campo: "ok" | "bloqueios" | "erros") => janelas.map((j) => j[campo] / j.duracaoSeg);

  const corpo = `
<a class="voltar" href="index.html">← Todas as execuções</a>
<h1>${esc(exec.titulo)} · ${esc(meta.ambiente)}</h1>
<p class="sub">${esc(fmtData(meta.inicio))} · duração ${fmtTempo(exec.duracaoSeg)} · ${esc(meta.alvo + meta.pagina)}</p>

<h2 style="margin-top:24px">Onde está o gargalo</h2>
${secaoDiagnostico(exec)}
${graficoPorNivel(exec)}

<div class="blocos">
  ${bloco("Pico de simultâneos", fmtCompacto(exec.picoSimultaneos), "usuários no fluxo ao mesmo tempo")}
  ${bloco("Requisições", fmtCompacto(exec.requisicoes), `pico de ${umaCasa.format(exec.picoReqSeg)} por segundo`)}
  ${bloco("Tempo p95", fmtMs(exec.p95), `mediana ${fmtMs(exec.p50)}`)}
  ${bloco("Tempo p99", fmtMs(exec.p99))}
  ${bloco("Erros", fmtCompacto(exec.erros), "status inesperado ou falha de rede")}
  ${bloco("Bloqueios", fmtCompacto(exec.bloqueios), "respostas 403, 429 ou 503")}
</div>

<h2>Escalonamento</h2>
${graficoLinhas(exec, {
  titulo: "Usuários simultâneos",
  sub: "Usuários virtuais ativos ao longo do teste. As linhas verticais marcam cada degrau e o número no topo é o alvo dele.",
  series: [{ nome: "Simultâneos", cor: "--serie-1", valores: janelas.map((j) => j.simultaneos) }],
  fmtValor: fmt,
  area: true,
  inteiro: true,
})}
${graficoLinhas(exec, {
  titulo: "Tempo de resposta",
  sub: "Em milissegundos, por janela de 10 segundos.",
  series: [
    { nome: "p50 (mediana)", cor: "--serie-1", valores: janelas.map((j) => j.p50) },
    { nome: "p95", cor: "--serie-2", valores: janelas.map((j) => j.p95) },
    { nome: "p99", cor: "--serie-3", valores: janelas.map((j) => j.p99) },
  ],
  fmtValor: (n) => fmtMs(n),
  fmtEixo: fmtEixoMs,
})}
${graficoColunas(exec, {
  titulo: "Respostas por segundo",
  sub: "Média de cada janela de 10 segundos, separada por resultado.",
  series: [
    { nome: "Sucesso (2xx/3xx)", cor: "--serie-1", valores: taxa("ok") },
    { nome: "Bloqueio (403/429/503)", cor: "--alerta", valores: taxa("bloqueios") },
    { nome: "Erro", cor: "--critico", valores: taxa("erros") },
  ],
  fmtValor: (n) => `${umaCasa.format(n)}/s`,
})}

<h2>Resultado por degrau</h2>
<div class="cartao rolagem">
<table>
<thead><tr><th>Degrau</th><th>Duração</th><th>Alvo simultâneos</th><th>Pico medido</th><th>Requisições</th><th>Req/s</th><th>Mediana</th><th>p95 (pior janela)</th><th>p99 (pior janela)</th><th>Bloqueios</th><th>Erros</th></tr></thead>
<tbody>${linhasFases}</tbody>
</table>
</div>
${tabelaEtapas(exec)}
<details>
<summary>Ver dados de cada janela de 10 segundos</summary>
<div class="cartao rolagem" style="margin-top:8px">
<table>
<thead><tr><th>Tempo</th><th>Simultâneos</th><th>Requisições</th><th>p50</th><th>p95</th><th>p99</th><th>Bloqueios</th><th>Erros</th></tr></thead>
<tbody>${linhasJanelas}</tbody>
</table>
</div>
</details>
`;
  return pagina(`${exec.titulo} · ${meta.ambiente}`, corpo);
}

function htmlIndice(execucoes: Execucao[]): string {
  const linhas = execucoes
    .map((e) => {
      const principal = e.achados[0];
      return `<tr>
  <td><a href="${esc(e.meta.id)}.html">${esc(fmtData(e.meta.inicio))}</a></td>
  <td class="texto">${esc(e.titulo)} · ${esc(e.meta.ambiente)}</td>
  <td class="texto">${principal ? `${icone(principal.gravidade)}${esc(principal.titulo)}` : "–"}</td>
  <td>${fmt(e.picoSimultaneos)}</td><td>${fmt(e.requisicoes)}</td>
  <td>${fmtMs(e.p95)}</td><td>${fmtMs(e.p99)}</td><td>${fmt(e.bloqueios)}</td><td>${fmt(e.erros)}</td>
</tr>`;
    })
    .join("");
  const corpo = `
<h1>Testes de carga · execuções</h1>
<p class="sub">${execucoes.length} ${execucoes.length === 1 ? "execução registrada" : "execuções registradas"}, da mais recente para a mais antiga. Clique na data para abrir o relatório.</p>
<div class="cartao rolagem" style="margin-top:24px">
<table>
<thead><tr><th>Data</th><th style="text-align:left">Teste</th><th style="text-align:left">Principal achado</th><th>Pico de simultâneos</th><th>Requisições</th><th>p95</th><th>p99</th><th>Bloqueios</th><th>Erros</th></tr></thead>
<tbody>${linhas}</tbody>
</table>
</div>
`;
  return pagina("Testes de carga · execuções", corpo);
}

// Regera o relatório de cada execução salva e o índice com o histórico.
export function gerarTudo(): Execucao[] {
  mkdirSync(DIR_DADOS, { recursive: true });
  const execucoes = readdirSync(DIR_DADOS)
    .filter((nome) => nome.endsWith(".meta.json"))
    .filter((nome) => existsSync(join(DIR_DADOS, nome.replace(/\.meta\.json$/, ".json"))))
    .map((nome) => carregar(join(DIR_DADOS, nome)))
    .sort((a, b) => b.meta.inicio.localeCompare(a.meta.inicio));

  for (const exec of execucoes) {
    writeFileSync(join(DIR_RELATORIOS, `${exec.meta.id}.html`), htmlExecucao(exec));
  }
  writeFileSync(join(DIR_RELATORIOS, "index.html"), htmlIndice(execucoes));
  return execucoes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const execucoes = gerarTudo();
  console.log(`${execucoes.length} relatório(s) em ${DIR_RELATORIOS}`);
}
