# Projecto Cut - Cloudflare

Esse pacote e para publicar o projeto inteiro, nao colar so o JS no editor Hello World.

No Cloudflare, o projeto ja criado se chama `projecto-cut-server`. O `wrangler.toml` deste ZIP usa o MESMO nome para conectar corretamente.

Arquivos:
- `src/index.js` — Worker, salas WebSocket, amizades e auto-regiao
- `public/projecto cut.html` — jogo
- `wrangler.toml` — 3 Durable Objects SQLite, bindings e assets
- `package.json` — scripts de deploy

Publicacao por repositorio GitHub: extrair o ZIP (nao enviar o ZIP sozinho), subir a estrutura de pastas para um repositorio privado, conectar o repositorio em Cloudflare Workers > Build/Connect Git, e usar `npx wrangler deploy` como deploy command. O Root Directory e `/` se os arquivos estiverem na raiz.

Alternativa em computador: npm install, npx wrangler login e npx wrangler deploy dentro da pasta.

NAO altere nem desative o Railway ate testar. Os dados de amizade do Railway ainda nao foram migrados para Cloudflare; o novo servidor comeca com um banco novo.

Nao inclua senhas, tokens ou arquivos de amizade em um repositorio. Verifique o plano Free e os limites de uso.
