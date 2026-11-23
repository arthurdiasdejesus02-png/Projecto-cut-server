# Projecto Cut — servidor multiplayer

Servidor para Cloudflare Workers, com Durable Objects para salas multiplayer e recursos sociais.

## Arquivos

- `src/index.js` — código do servidor.
- `wrangler.toml` — configuração do Worker e dos Durable Objects.
- `package.json` — comandos e dependências.
- `public/projecto cut.html` — jogo HTML.

## Publicação

Conecte este repositório à Cloudflare (Workers & Pages → Settings → Builds), use a branch `main` e o comando `npx wrangler deploy`. As alterações feitas em `main` podem iniciar builds automáticos.

O servidor Railway deve continuar ativo até que o Worker da Cloudflare seja publicado, testado com duas pessoas e os dados sociais sejam migrados com segurança.
