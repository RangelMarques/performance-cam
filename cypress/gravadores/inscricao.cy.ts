// Cenário 2: inscrição.
// Percorre o fluxo uma vez, como um usuário real, e grava as requisições que a página faz.
// A gravação (gravacoes/inscricao.json) vira o cenário de carga do Artillery.
//
// Fluxo: abre a landing page → seleciona 1 ingresso do setor "Comum" → clica em "Realizar inscrição".

type Passo =
  | { tipo: "requisicao"; metodo: string; url: string; recurso: string; contentType?: string; corpo?: unknown; status?: number; resposta?: unknown }
  | { tipo: "clique"; descricao: string };

const TIPOS_GRAVADOS = ["document", "fetch", "xhr"];

describe("Gravação do cenário de inscrição", () => {
  it("seleciona o ingresso Comum e realiza a inscrição", () => {
    const lpUrl: string = Cypress.expose("LP_URL");
    expect(lpUrl, "LP_URL definida no .env").to.be.a("string").and.not.be.empty;

    const passos: Passo[] = [];

    // Grava toda requisição de página, fetch ou XHR (imagens, CSS e JS ficam de fora).
    const jaGravado = (url: string) =>
      passos.some((p) => p.tipo === "requisicao" && p.recurso === "document" && p.url === url);

    // A navegação para outro domínio (landing page → checkout) não passa pelo intercept,
    // então registra a abertura de cada página nova aqui.
    cy.on("url:changed", (url: string) => {
      if (!jaGravado(url)) passos.push({ tipo: "requisicao", metodo: "GET", url, recurso: "document" });
    });

    cy.intercept({ url: /.*/ }, (req) => {
      if (!TIPOS_GRAVADOS.includes(req.resourceType)) return;
      if (req.resourceType === "document" && jaGravado(req.url)) return;
      const passo: Passo = {
        tipo: "requisicao",
        metodo: req.method,
        url: req.url,
        recurso: req.resourceType,
        contentType: req.headers["content-type"] as string | undefined,
        corpo: req.body === "" ? undefined : req.body,
      };
      passos.push(passo);
      req.on("response", (res) => {
        passo.status = res.statusCode;
        if (req.resourceType !== "document") passo.resposta = res.body;
      });
    });
    cy.intercept("GET", "**/ticket-picker").as("ingressos");
    cy.intercept("POST", "**/v1/selections").as("reserva");
    cy.intercept("GET", "**/v1/selections/*/summary").as("resumo");

    // Marca na gravação o momento de um clique (vira a pausa do usuário no cenário de carga).
    const clique = (descricao: string) => ($el: JQuery<HTMLElement>) => {
      passos.push({ tipo: "clique", descricao });
      return $el;
    };

    cy.visit(lpUrl);

    // A API de ingressos do staging às vezes demora bem mais que o normal para responder.
    cy.wait("@ingressos", { timeout: 60000 }).its("response.statusCode").should("eq", 200);

    // Banner de cookies: recusa os não essenciais (não gera requisição de carga).
    cy.contains("button", "Configurar").click();
    cy.contains("button", "Recusar").click();

    // Seleciona 1 ingresso do setor "Comum".
    cy.contains("span", /^Comum$/)
      .parents("div.rounded-3xl")
      .first()
      .find('button[aria-label="Aumentar quantidade"]')
      .first()
      .then(clique("seleciona o ingresso Comum"))
      .click();

    cy.contains("button", "Realizar inscrição")
      .should("be.enabled")
      .then(clique("clica em Realizar inscrição"))
      .click();

    cy.wait("@reserva").its("response.statusCode").should("eq", 201);
    cy.wait("@resumo").its("response.statusCode").should("be.lessThan", 400);

    cy.location("search").should("contain", "selectionToken=");

    cy.then(() => {
      const requisicoes = passos.filter((p) => p.tipo === "requisicao").length;
      cy.log(`${requisicoes} requisições gravadas`);
      cy.writeFile("gravacoes/inscricao.json", {
        cenario: "inscricao",
        gravadoEm: new Date().toISOString(),
        passos,
      });
    });
  });
});
