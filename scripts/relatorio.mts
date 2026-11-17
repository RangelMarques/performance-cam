// Gera os relatórios visuais (HTML) a partir dos resultados do Artillery em reports/dados.
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
  simultaneos: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

interface CriterioAvaliado extends Criterio {
  valor: number | undefined;
  passou: boolean;
}

export interface Execucao {
  meta: Meta;
  fases: FaseTempo[];
  janelas: Janela[];
  duracaoSeg: number;
  requisicoes: number;
  erros: number;
  bloqueios: number;
  picoSimultaneos: number;
  picoReqSeg: number;
  p50?: number;
  p95?: number;
  p99?: number;
  criterios: CriterioAvaliado[];
  aprovado: boolean;
}

// ---------- Leitura e cálculo ----------

const CODIGOS_DE_BLOQUEIO = ["403", "429", "503"];

function somaPrefixo(contadores: Record<string, number>, prefixo: string): number {
  let soma = 0;
  for (const [chave, valor] of Object.entries(contadores)) {
    if (chave.startsWith(prefixo)) soma += valor;
  }
  return soma;
}

function desfechos(c: Record<string, number>) {
  const ok = c["http.codes.200"] ?? 0;
  const bloqueios = CODIGOS_DE_BLOQUEIO.reduce((s, cod) => s + (c[`http.codes.${cod}`] ?? 0), 0);
  const outrosCodigos = somaPrefixo(c, "http.codes.") - ok - bloqueios;
  return { ok, bloqueios, erros: outrosCodigos + somaPrefixo(c, "errors.") };
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
      alvo: Math.round(f.taxaFinal * meta.permanencia),
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
    return {
      fimSeg: (fim - t0) / 1000,
      duracaoSeg: (fim - ini) / 1000,
      fase: indice === -1 ? fases.length - 1 : indice,
      requisicoes: c["http.requests"] ?? 0,
      ...desfechos(c),
      simultaneos: Math.max(0, ativos),
      p50: tempo?.p50,
      p95: tempo?.p95,
      p99: tempo?.p99,
    };
  });

  const agregado = saida.aggregate;
  const total = desfechos(agregado.counters);
  const tempoTotal = agregado.summaries?.["http.response_time"];
  const criterios = meta.criterios.map((c) => {
    const valor = valorMetrica(agregado, c.metrica);
    return { ...c, valor, passou: valor !== undefined && compara(valor, c.operador, c.limite) };
  });

  return {
    meta,
    fases,
    janelas,
    duracaoSeg: Math.max(acumulado, (tFim - t0) / 1000),
    requisicoes: agregado.counters["http.requests"] ?? 0,
    erros: total.erros,
    bloqueios: total.bloqueios,
    picoSimultaneos: Math.max(0, ...janelas.map((j) => j.simultaneos)),
    picoReqSeg: Math.max(0, ...janelas.map((j) => j.requisicoes / j.duracaoSeg)),
    p50: tempoTotal?.p50,
    p95: tempoTotal?.p95,
    p99: tempoTotal?.p99,
    criterios,
    aprovado: criterios.every((c) => c.passou),
  };
}

// ---------- Formatação ----------

const inteiro = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const umaCasa = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const compacto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

const fmt = (n: number) => inteiro.format(n);
const fmtCompacto = (n: number) => (n >= 10_000 ? compacto.format(n) : inteiro.format(n));
const fmtMs = (n: number | undefined) => (n === undefined ? "–" : `${inteiro.format(n)} ms`);
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

const ROTULOS_METRICA: Record<string, string> = {
  "http.response_time.p95": "Tempo de resposta p95",
  "http.response_time.p99": "Tempo de resposta p99",
  "vusers.failed": "Usuários com falha",
};

// ---------- Gráficos (SVG) ----------

const L = 960; // largura do viewBox
const A = 280; // altura do viewBox
const M = { esq: 56, dir: 76, topo: 30, base: 30 };

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

function ticksLegiveis(maximo: number, quantidade = 4): number[] {
  const bruto = (maximo > 0 ? maximo : 1) / quantidade;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const fracao = bruto / potencia;
  const passo = (fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 2.5 ? 2.5 : fracao <= 5 ? 5 : 10) * potencia;
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

// Eixos, grade e a marcação dos degraus, comuns a todos os gráficos.
function moldura(exec: Execucao, maximo: number, fmtEixo: (n: number) => string): Moldura {
  const ticksY = ticksLegiveis(maximo);
  const topoY = ticksY[ticksY.length - 1];
  const x = (seg: number) => M.esq + (seg / exec.duracaoSeg) * (L - M.esq - M.dir);
  const y = (valor: number) => A - M.base - (valor / topoY) * (A - M.topo - M.base);

  let fundo = "";
  for (const t of ticksY) {
    const classe = t === 0 ? "eixo" : "grade";
    fundo += `<line class="${classe}" x1="${M.esq}" x2="${L - M.dir}" y1="${y(t)}" y2="${y(t)}"/>`;
    fundo += `<text class="tick" x="${M.esq - 8}" y="${y(t) + 4}" text-anchor="end">${fmtEixo(t)}</text>`;
  }
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

function tituloDica(exec: Execucao, j: Janela): string {
  const fase = exec.fases[j.fase];
  return `${fmtTempo(j.fimSeg)} · ${fase ? fase.nome : ""}`;
}

function graficoLinhas(
  exec: Execucao,
  opcoes: { titulo: string; sub: string; series: Serie[]; fmtValor: (n: number) => string; area?: boolean; limite?: { valor: number; rotulo: string } },
): string {
  const { series, fmtValor } = opcoes;
  const todos = series.flatMap((s) => s.valores).filter((v): v is number => v !== undefined);
  const m = moldura(exec, Math.max(0, ...todos), fmtCompacto);
  const xs = exec.janelas.map((j) => m.x(j.fimSeg));
  let svg = m.fundo;

  const topoEscala = Math.max(0, ...todos);
  if (opcoes.limite && opcoes.limite.valor <= topoEscala) {
    const yl = m.y(opcoes.limite.valor);
    svg += `<line class="limite" x1="${M.esq}" x2="${L - M.dir}" y1="${yl}" y2="${yl}"/>`;
    svg += `<text class="tick" x="${M.esq + 6}" y="${yl - 5}">${esc(opcoes.limite.rotulo)}</text>`;
  }

  const finais: { y: number; texto: string }[] = [];
  for (const s of series) {
    const pontos = s.valores
      .map((v, i) => (v === undefined ? undefined : { x: xs[i], y: m.y(v), v }))
      .filter((p): p is { x: number; y: number; v: number } => p !== undefined);
    if (pontos.length === 0) continue;
    // A curva de área parte do zero no início do teste (ponto só de traçado, sem marcador).
    if (opcoes.area) pontos.unshift({ x: m.x(0), y: m.y(0), v: 0 });
    const tracado = pontos.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    if (opcoes.area && pontos.length > 1) {
      const base = m.y(0);
      svg += `<path d="${tracado} L${pontos[pontos.length - 1].x.toFixed(1)} ${base} L${pontos[0].x.toFixed(1)} ${base} Z" style="fill:var(${s.cor});opacity:.1"/>`;
    }
    svg += `<path class="linha" d="${tracado}" style="stroke:var(${s.cor})"/>`;
    const visiveis = opcoes.area ? pontos.slice(1) : pontos;
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
  if (!colidem) {
    const xFim = xs[xs.length - 1] + 10;
    for (const f of finais) svg += `<text class="valor" x="${xFim}" y="${f.y + 4}">${esc(f.texto)}</text>`;
  }

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

// ---------- Páginas ----------

const ESTILO = `
:root {
  color-scheme: light;
  --plano: #f9f9f7; --superficie: #fcfcfb; --tinta: #0b0b0b; --tinta-2: #52514e; --apagado: #898781;
  --grade: #e1e0d9; --eixo: #c3c2b7; --borda: rgba(11,11,11,.10);
  --serie-1: #2a78d6; --serie-2: #eb6834; --serie-3: #1baf7a;
  --bom: #0ca30c; --alerta: #fab219; --critico: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --plano: #0d0d0d; --superficie: #1a1a19; --tinta: #f0efec; --tinta-2: #c3c2b7; --apagado: #898781;
    --grade: #2c2c2a; --eixo: #383835; --borda: rgba(255,255,255,.10);
    --serie-1: #3987e5; --serie-2: #d95926; --serie-3: #199e70;
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
.veredito { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; margin-top: 24px; }
.selo { display: flex; align-items: center; gap: 10px; font-size: 28px; font-weight: 600; min-width: 200px; }
.icone { display: inline-grid; place-items: center; width: 1.25em; height: 1.25em; border-radius: 50%; color: #fff; font-size: .7em; font-weight: 700; flex: none; }
.icone.ok { background: var(--bom); } .icone.falha { background: var(--critico); }
.criterios { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; flex: 1; min-width: 260px; }
.criterios li { display: flex; align-items: center; gap: 8px; }
.criterios .icone { font-size: 10px; width: 16px; height: 16px; }
.criterios b { font-weight: 600; }
.blocos { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
.bloco .rotulo { color: var(--tinta-2); font-size: 13px; }
.bloco .numero { font-size: 26px; font-weight: 600; line-height: 1.25; }
.bloco .nota { color: var(--apagado); font-size: 12px; }
.grafico { margin-top: 12px; }
.grafico figcaption p { color: var(--tinta-2); font-size: 13px; }
.legenda { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 13px; color: var(--tinta-2); }
.legenda .item { display: inline-flex; align-items: center; gap: 6px; }
.legenda i { width: 10px; height: 10px; border-radius: 3px; }
.palco { position: relative; margin-top: 8px; }
svg { display: block; width: 100%; height: auto; }
svg text { font-family: inherit; }
.grade { stroke: var(--grade); stroke-width: 1; } .eixo { stroke: var(--eixo); stroke-width: 1; }
.degrau { stroke: var(--eixo); stroke-width: 1; }
.limite { stroke: var(--apagado); stroke-width: 1; }
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
td .icone { font-size: 10px; width: 16px; height: 16px; vertical-align: -3px; margin-right: 6px; }
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

const icone = (passou: boolean) =>
  `<span class="icone ${passou ? "ok" : "falha"}" aria-hidden="true">${passou ? "✓" : "✕"}</span>`;

function bloco(rotulo: string, numero: string, nota = ""): string {
  return `<div class="cartao bloco"><div class="rotulo">${esc(rotulo)}</div><div class="numero">${esc(numero)}</div><div class="nota">${esc(nota)}</div></div>`;
}

function htmlExecucao(exec: Execucao): string {
  const { meta, janelas } = exec;

  const criterios = exec.criterios
    .map((c) => {
      const nome = ROTULOS_METRICA[c.metrica] ?? c.metrica;
      const ehTempo = c.metrica.includes("response_time");
      const mostra = (n: number | undefined) => (n === undefined ? "sem dados" : ehTempo ? fmtMs(n) : fmt(n));
      const regra = `${c.operador === "==" ? "igual a" : c.operador} ${mostra(c.limite)}`;
      return `<li>${icone(c.passou)}<span>${esc(nome)}: <b>${esc(mostra(c.valor))}</b> (limite: ${esc(regra)})</span></li>`;
    })
    .join("");

  const linhasFases = exec.fases
    .map((f, i) => {
      const js = janelas.filter((j) => j.fase === i);
      const reqs = js.reduce((s, j) => s + j.requisicoes, 0);
      const tempo = js.reduce((s, j) => s + j.duracaoSeg, 0);
      const comTempo = js.filter((j) => j.p50 !== undefined);
      const pesos = comTempo.reduce((s, j) => s + j.requisicoes, 0);
      const mediana = pesos > 0 ? comTempo.reduce((s, j) => s + (j.p50 as number) * j.requisicoes, 0) / pesos : undefined;
      const pior = (campo: "p95" | "p99") => (comTempo.length ? Math.max(...comTempo.map((j) => j[campo] as number)) : undefined);
      return `<tr>
  <td>${esc(f.nome)}</td><td>${fmtTempo(f.duracao)}</td><td>${fmt(f.alvo)}</td>
  <td>${fmt(Math.max(0, ...js.map((j) => j.simultaneos)))}</td><td>${fmt(reqs)}</td>
  <td>${tempo > 0 ? umaCasa.format(reqs / tempo) : "–"}</td>
  <td>${fmtMs(mediana)}</td><td>${fmtMs(pior("p95"))}</td><td>${fmtMs(pior("p99"))}</td>
  <td>${fmt(js.reduce((s, j) => s + j.bloqueios, 0))}</td><td>${fmt(js.reduce((s, j) => s + j.erros, 0))}</td>
</tr>`;
    })
    .join("");

  const linhasJanelas = janelas
    .map(
      (j) => `<tr><td>${fmtTempo(j.fimSeg)}</td><td>${fmt(j.simultaneos)}</td><td>${fmt(j.requisicoes)}</td>
<td>${fmtMs(j.p50)}</td><td>${fmtMs(j.p95)}</td><td>${fmtMs(j.p99)}</td><td>${fmt(j.bloqueios)}</td><td>${fmt(j.erros)}</td></tr>`,
    )
    .join("");

  const limiteP95 = exec.criterios.find((c) => c.metrica === "http.response_time.p95");
  const taxa = (campo: "ok" | "bloqueios" | "erros") => janelas.map((j) => j[campo] / j.duracaoSeg);

  const corpo = `
<a class="voltar" href="index.html">← Todas as execuções</a>
<h1>Acesso à landing page · ${esc(meta.ambiente)}</h1>
<p class="sub">${esc(fmtData(meta.inicio))} · duração ${fmtTempo(exec.duracaoSeg)} · ${esc(meta.alvo + meta.pagina)}</p>

<div class="cartao veredito">
  <div class="selo">${icone(exec.aprovado)}${exec.aprovado ? "Aprovado" : "Reprovado"}</div>
  <ul class="criterios">${criterios}</ul>
</div>

<div class="blocos">
  ${bloco("Pico de simultâneos", fmtCompacto(exec.picoSimultaneos), "usuários na página ao mesmo tempo")}
  ${bloco("Requisições", fmtCompacto(exec.requisicoes), `pico de ${umaCasa.format(exec.picoReqSeg)} por segundo`)}
  ${bloco("Tempo p95", fmtMs(exec.p95), `mediana ${fmtMs(exec.p50)}`)}
  ${bloco("Tempo p99", fmtMs(exec.p99))}
  ${bloco("Erros", fmtCompacto(exec.erros), "status inesperado ou falha de rede")}
  ${bloco("Bloqueios Cloudflare", fmtCompacto(exec.bloqueios), "respostas 403, 429 ou 503")}
</div>

<h2>Escalonamento</h2>
${graficoLinhas(exec, {
  titulo: "Usuários simultâneos",
  sub: "Usuários virtuais ativos ao longo do teste. As linhas verticais marcam cada degrau e o número no topo é o alvo dele.",
  series: [{ nome: "Simultâneos", cor: "--serie-1", valores: janelas.map((j) => j.simultaneos) }],
  fmtValor: fmt,
  area: true,
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
  limite: limiteP95 ? { valor: limiteP95.limite, rotulo: `limite p95: ${fmtMs(limiteP95.limite)}` } : undefined,
})}
${graficoColunas(exec, {
  titulo: "Respostas por segundo",
  sub: "Média de cada janela de 10 segundos, separada por resultado.",
  series: [
    { nome: "Sucesso (200)", cor: "--serie-1", valores: taxa("ok") },
    { nome: "Bloqueio Cloudflare", cor: "--alerta", valores: taxa("bloqueios") },
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
  return pagina(`${meta.ambiente} · ${fmtData(meta.inicio)}`, corpo);
}

function htmlIndice(execucoes: Execucao[]): string {
  const linhas = execucoes
    .map(
      (e) => `<tr>
  <td><a href="${esc(e.meta.id)}.html">${esc(fmtData(e.meta.inicio))}</a></td>
  <td style="text-align:left">${esc(e.meta.ambiente)}</td>
  <td style="text-align:left">${icone(e.aprovado)}${e.aprovado ? "Aprovado" : "Reprovado"}</td>
  <td>${fmt(e.picoSimultaneos)}</td><td>${fmt(e.requisicoes)}</td>
  <td>${fmtMs(e.p95)}</td><td>${fmtMs(e.p99)}</td><td>${fmt(e.bloqueios)}</td><td>${fmt(e.erros)}</td>
</tr>`,
    )
    .join("");
  const corpo = `
<h1>Testes de carga · execuções</h1>
<p class="sub">${execucoes.length} ${execucoes.length === 1 ? "execução registrada" : "execuções registradas"}, da mais recente para a mais antiga. Clique na data para abrir o relatório.</p>
<div class="cartao rolagem" style="margin-top:24px">
<table>
<thead><tr><th>Data</th><th style="text-align:left">Teste</th><th style="text-align:left">Resultado</th><th>Pico de simultâneos</th><th>Requisições</th><th>p95</th><th>p99</th><th>Bloqueios</th><th>Erros</th></tr></thead>
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
