// Roda um ambiente do teste com o Artillery em modo silencioso e gera o relatório visual.
// Uso: node scripts/rodar.mts <ambiente> [--sem-abrir]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DIR_DADOS, DIR_RELATORIOS, RAIZ, gerarTudo } from "./relatorio.mts";
import type { Criterio, Fase, Meta } from "./relatorio.mts";

const TESTE = join(RAIZ, "tests", "acesso-lp.yml");

// A URL testada fica fora do repositório, em LP_URL no arquivo .env.
const arquivoEnv = join(RAIZ, ".env");
if (existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv);
if (!process.env.LP_URL) {
  console.error("Defina LP_URL no arquivo .env (copie o .env.example).");
  process.exit(1);
}
const url = new URL(process.env.LP_URL);
const pagina = url.pathname + url.search;

const ambiente = process.argv[2];
const abrir = !process.argv.includes("--sem-abrir");

const yml = parse(readFileSync(TESTE, "utf8"));
const ambientes: Record<string, { phases: Record<string, unknown>[] }> = yml.config.environments;

if (!ambiente || !ambientes[ambiente]) {
  console.error(`Ambiente inválido. Disponíveis: ${Object.keys(ambientes).join(", ")}`);
  process.exit(1);
}

const fases: Fase[] = ambientes[ambiente].phases.map((f) => ({
  nome: String(f.name ?? "fase"),
  duracao: Number(f.duration),
  taxaInicial: Number(f.arrivalRate),
  taxaFinal: Number(f.rampTo ?? f.arrivalRate),
}));

// Tempo que cada usuário virtual fica na página (soma dos "think" do cenário).
const fluxo: Record<string, unknown>[] = yml.scenarios[0].flow;
const permanencia = fluxo.reduce((s, passo) => s + Number(passo.think ?? 0), 0);

const criterios: Criterio[] = [];
for (const limite of yml.config.ensure?.thresholds ?? []) {
  for (const [metrica, valor] of Object.entries(limite)) {
    criterios.push({ metrica, operador: "<", limite: Number(valor) });
  }
}
for (const condicao of yml.config.ensure?.conditions ?? []) {
  const m = /^(\S+)\s*(==|<=|>=|<|>)\s*([\d.]+)$/.exec(String(condicao.expression).trim());
  if (m) criterios.push({ metrica: m[1], operador: m[2], limite: Number(m[3]) });
}

const agora = new Date();
const dois = (n: number) => String(n).padStart(2, "0");
const carimbo =
  `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}` +
  `_${dois(agora.getHours())}-${dois(agora.getMinutes())}-${dois(agora.getSeconds())}`;
const id = `${ambiente}-${carimbo}`;

mkdirSync(DIR_DADOS, { recursive: true });
const arquivoJson = join(DIR_DADOS, `${id}.json`);

const pkgArtillery = join(RAIZ, "node_modules", "artillery", "package.json");
const bin = JSON.parse(readFileSync(pkgArtillery, "utf8")).bin;
const binArtillery = join(RAIZ, "node_modules", "artillery", typeof bin === "string" ? bin : bin.artillery);

const previsto = fases.reduce((s, f) => s + f.duracao, 0) + permanencia;
console.log(`Rodando "${ambiente}" (cerca de ${Math.ceil(previsto / 60)} min). O relatório abre ao final.`);

const execucao = spawnSync(
  process.execPath,
  [
    binArtillery, "run", "-e", ambiente, "--quiet",
    "--target", url.origin,
    "--variables", JSON.stringify({ pagina }),
    "--output", arquivoJson,
    TESTE,
  ],
  { cwd: RAIZ, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

if (!existsSync(arquivoJson)) {
  // Só mostra a saída do Artillery quando ele falha antes de gerar resultado.
  console.error(execucao.stdout);
  console.error("O Artillery não gerou resultado; nenhum relatório foi criado.");
  process.exit(execucao.status ?? 1);
}

const meta: Meta = {
  id,
  ambiente,
  inicio: agora.toISOString(),
  alvo: url.origin,
  pagina,
  permanencia,
  fases,
  criterios,
};
writeFileSync(join(DIR_DADOS, `${id}.meta.json`), JSON.stringify(meta, null, 2));

const execucoes = gerarTudo();
const esta = execucoes.find((e) => e.meta.id === id);
const html = join(DIR_RELATORIOS, `${id}.html`);

console.log(`${esta?.aprovado ? "Aprovado" : "Reprovado"}. Relatório: ${html}`);

if (abrir && process.platform === "win32") {
  spawn("cmd", ["/c", "start", "", html], { detached: true, stdio: "ignore" }).unref();
}

process.exit(esta?.aprovado ? 0 : 1);
