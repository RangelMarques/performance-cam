import { existsSync } from "node:fs";
import { defineConfig } from "cypress";

// A URL da landing page vem do .env (LP_URL), igual aos testes de carga.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  e2e: {
    specPattern: "cypress/gravadores/**/*.cy.ts",
    supportFile: false,
    // O fluxo sai do domínio da landing page e vai para o domínio do checkout.
    chromeWebSecurity: false,
    // O seletor de ingressos é um componente isolado em shadow DOM.
    includeShadowDom: true,
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 15000,
    pageLoadTimeout: 60000,
    expose: {
      LP_URL: process.env.LP_URL,
    },
  },
});
