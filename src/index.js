/**
 * Projecto Cut — Cloudflare Workers + SQLite-backed Durable Objects (Free).
 * Multiplayer protocol compatible with the original Railway server.
 * No credentials hardcoded. Existing Railway data is NOT automatically migrated.
 */
// A região não é fixa: o anfitrião mede candidatos e escolhe antes de criar a sala.
// Documentação Cloudflare: 'sam' ainda não hospeda Durable Objects na América do Sul;
// ele normalmente é atendido por um centro de dados na América do Norte.
const REGION_OPTIONS = ['auto', 'enam', 'wnam', 'weur', 'eeur', 'apac', 'oc'];
const REGION_SET = new Set(REGION_OPTIONS);
function roomStub(env, id, region) {
  // A dica só vale na PRIMEIRA criação deste Durable Object.
  // Os dois jogadores usam o mesmo ID, independentemente de onde se conectem.
  return region && region !== 'auto' && REGION_SET.has(region)
    ? env.ROOMS.get(id, { locationHint: region }) : env.ROOMS.get(id);
}
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const ROOM_RE = /^[A-HJ-NP-Z2-9]{4,8}$/;
const SID_RE = /^[A-HJ-NP-Z2-9]{16}$/;
const NICK_RE = /^[A-Z0-9_]{3,12}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' }
});
const error = (message, status = 400) => json({ ok: false, error: message }, status);
const validWS = request => (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
function safeSend(ws, obj) {
  try { if (ws.readyState === 1 && (ws.bufferedAmount || 0) < 200000) ws.send(JSON.stringify(obj)); }
  catch (_e) { /* a disconnected socket is ignored */ }
}
function cloneAccount(a) {
  return { nick: a.nick, friends: Array.isArray(a.friends) ? a.friends : [],
    incoming: Array.isArray(a.incoming) ? a.incoming : [],
    outgoing: Array.isArray(a.outgoing) ? a.outgoing : [] };
}
function getAttachment(ws) { try { return ws.deserializeAttachment() || {}; } catch (_e) { return {}; } }
function attach(ws, info) { ws.serializeAttachment(info); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'projecto-cut-cloudflare', regionMode: 'auto', regionCandidates: REGION_OPTIONS });

    // Medição real de ida e volta até Durable Objects de regiões candidatas.
    // Cada candidato possui ID fixo; uma sala usa outro ID, único para os jogadores.
    if (url.pathname === '/region-probe') {
      if (request.method !== 'GET') return error('GET required', 405);
      const region = url.searchParams.get('region') || 'auto';
      if (!REGION_SET.has(region)) return error('Unsupported region');
      const id = env.PROBES.idFromName('probe:v1:' + region);
      const obj = region === 'auto' ? env.PROBES.get(id) : env.PROBES.get(id, { locationHint: region });
      return obj.fetch(new Request('https://probe.internal/measure?region=' + encodeURIComponent(region), {
        method: 'GET', headers: { 'cache-control': 'no-store' }
      }));
    }

    if (url.pathname === '/ws') {
      if (!validWS(request)) return error('Expected WebSocket', 426);
      const room = String(url.searchParams.get('room') || '').toUpperCase();
      const role = url.searchParams.get('role');
      const sid = url.searchParams.get('sid') || '';
      if (!ROOM_RE.test(room) || !['host','guest'].includes(role) || !SID_RE.test(sid))
        return error('Invalid room, role or session');
      const roomId = env.ROOMS.idFromName('room:' + room);
      const region = role === 'host' ? (url.searchParams.get('region') || 'auto') : 'auto';
      // O convidado nunca escolhe uma região diferente para a mesma sala.
      if (!REGION_SET.has(region)) return error('Unsupported region');
      return roomStub(env, roomId, region).fetch(request);
    }
    if (url.pathname === '/social') {
      if (!validWS(request)) return error('Expected WebSocket', 426);
      const id = env.SOCIAL.idFromName('social-br-v1');
      return env.SOCIAL.get(id).fetch(request);
    }
    if (url.pathname === '/admin/import' && request.method === 'POST') {
      if (!env.IMPORT_KEY || request.headers.get('authorization') !== 'Bearer ' + env.IMPORT_KEY)
        return error('Unauthorized', 401);
      if (Number(request.headers.get('content-length') || 0) > 2_000_000) return error('Too large', 413);
      const id = env.SOCIAL.idFromName('social-br-v1');
      return env.SOCIAL.get(id).fetch(request);
    }
    // Assets hosted on the same Worker: /projecto%20cut.html.
    if (url.pathname === '/' || url.pathname === '/index.html')
      return Response.redirect(url.origin + '/projecto%20cut.html', 302);
    return env.ASSETS.fetch(request);
  }
};

export class RegionProbe {
  // O corpo é descartável. O tempo HTTP percebido pelo celular inclui
  // a ida pela borda Cloudflare, a consulta ao objeto e o retorno.
  async fetch(request) {
    const region = new URL(request.url).searchParams.get('region') || 'auto';
    return json({ ok: true, region, measuredAt: Date.now() });
  }
}

export class GameRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.limits = new WeakMap(); }
  socketFor(role) {
    return this.ctx.getWebSockets().find(ws => getAttachment(ws).role === role && ws.readyState === 1);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') return json({ host: !!this.socketFor('host'), guest: !!this.socketFor('guest') });
    if (!validWS(request)) return error('Expected WebSocket', 426);
    const room = String(url.searchParams.get('room') || '').toUpperCase();
    const role = url.searchParams.get('role');
    const sid = url.searchParams.get('sid') || '';
    if (!ROOM_RE.test(room) || !['host','guest'].includes(role) || !SID_RE.test(sid)) return error('Invalid room');
    const existing = this.socketFor(role);
    if (existing && getAttachment(existing).sid !== sid) return error('Room role already in use', 409);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    attach(server, { role, sid, room, subs: [] });
    // A reconnect with the same session ID replaces the stale socket.
    if (existing) { try { existing.close(1000, 'Reconnect'); } catch (_e) {} }
    safeSend(server, { op: 'ready' });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 65536) return;
    const info = getAttachment(ws);
    if (!info.role) return;
    const now = Date.now();
    let rate = this.limits.get(ws) || { t: now, n: 0 };
    if (now - rate.t > 1000) rate = { t: now, n: 0 };
    if (++rate.n > 150) { try { ws.close(1008, 'Rate limit'); } catch (_e) {} return; }
    this.limits.set(ws, rate);
    let m; try { m = JSON.parse(data); } catch (_e) { return; }
    if (!m || typeof m !== 'object') return;
    const inbound = 'pc1duel/' + info.room + (info.role === 'host' ? '/g' : '/h');
    const outbound = 'pc1duel/' + info.room + (info.role === 'host' ? '/h' : '/g');
    if (m.op === 'sub' && m.topic === inbound) {
      if (!info.subs.includes(inbound)) { info.subs.push(inbound); attach(ws, info); }
    } else if (m.op === 'pub' && m.topic === outbound && typeof m.payload === 'string' && m.payload.length <= 48000) {
      const target = this.socketFor(info.role === 'host' ? 'guest' : 'host');
      if (target && (getAttachment(target).subs || []).includes(outbound))
        safeSend(target, { op: 'pub', topic: outbound, payload: m.payload });
    }
  }
  webSocketClose(_ws) {}
  webSocketError(ws) { try { ws.close(1011, 'Connection error'); } catch (_e) {} }
}

export class SocialHub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.rate = new WeakMap();
    this.ctx.blockConcurrencyWhile(async () => {
      this.db = (await this.ctx.storage.get('db')) || { accounts: {} };
      if (!this.db.accounts) this.db = { accounts: {} };
    });
  }
  allSockets() { return this.ctx.getWebSockets(); }
  socketsOf(id) { return this.allSockets().filter(ws => ws.readyState === 1 && getAttachment(ws).id === id); }
  online(id) { return this.socketsOf(id).length > 0; }
  send(id, obj) { for (const ws of this.socketsOf(id)) safeSend(ws, obj); }
  account(id) { return this.db.accounts[id]; }
  findNick(nick) { return Object.keys(this.db.accounts).find(id => this.db.accounts[id]?.nick === nick) || null; }
  save() { return this.ctx.storage.put('db', this.db); }
  state(id) {
    const a = this.account(id); if (!a) return;
    const item = other => ({ nick: this.account(other)?.nick || '?', online: this.online(other) });
    const valid = list => (list || []).filter(x => !!this.account(x));
    this.send(id, { op: 'state', nick: a.nick,
      friends: valid(a.friends).map(item).sort((x,y) => x.nick.localeCompare(y.nick)),
      incoming: valid(a.incoming).map(item), outgoing: valid(a.outgoing).map(item) });
  }
  stateGroup(id) { this.state(id); for (const fid of this.account(id)?.friends || []) this.state(fid); }
  notice(ws, message) { safeSend(ws, { op: 'error', message }); }
  async fetch(request) {
    if (new URL(request.url).pathname === '/admin/import') {
      // Explicit one-time import of a backup; never silently overwrites existing users.
      let backup; try { backup = await request.json(); } catch (_e) { return error('Invalid JSON'); }
      const source = backup?.accounts;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return error('Expected accounts object');
      const ids = Object.keys(source);
      if (ids.length > 5000) return error('Too many accounts');
      const next = { accounts: { ...this.db.accounts } };
      const nicks = new Map(Object.entries(next.accounts).map(([id,a]) => [a.nick,id]));
      for (const id of ids) {
        const account = source[id];
        if (!ID_RE.test(id) || !account || !NICK_RE.test(account.nick)) return error('Invalid account entry');
        const owner = nicks.get(account.nick);
        if (owner && owner !== id) return error('Duplicate nickname: ' + account.nick);
        next.accounts[id] = cloneAccount(account);
        nicks.set(account.nick,id);
      }
      this.db = next;
      await this.save();
      return json({ ok: true, imported: ids.length });
    }
    if (!validWS(request)) return error('Expected WebSocket', 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    attach(server, { id: null, lastLookup: 0, lastInvite: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 4096) return;
    const now = Date.now();
    let rate = this.rate.get(ws) || { t: now, n: 0 };
    if (now - rate.t > 1000) rate = { t: now, n: 0 };
    if (++rate.n > 20) { try { ws.close(1008, 'Rate limit'); } catch (_e) {} return; }
    this.rate.set(ws, rate);
    let m; try { m = JSON.parse(data); } catch (_e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.op === 'hello') return this.join(ws, m);
    const info = getAttachment(ws);
    if (info.id) return this.operation(ws, info, m);
  }
  async join(ws, m) {
    if (getAttachment(ws).id) return;
    const token = String(m.token || '');
    const nick = String(m.nick || '').trim().toUpperCase();
    if (!TOKEN_RE.test(token) || !NICK_RE.test(nick)) return this.notice(ws,'Nickname inválido: 3 a 12 letras, números ou _');
    const bytes = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const id = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
    const owner = this.findNick(nick);
    if (owner && owner !== id) return safeSend(ws, { op: 'error', code: 'NICK_TAKEN', message: 'Nickname já está em uso' });
    let a = this.account(id);
    if (!a) this.db.accounts[id] = { nick, friends: [], incoming: [], outgoing: [] };
    else if (a.nick !== nick) a.nick = nick;
    await this.save();
    attach(ws, { id, lastLookup: 0, lastInvite: 0 });
    safeSend(ws, { op:'auth', nick });
    this.stateGroup(id);
  }
  async operation(ws, info, m) {
    const id = info.id, a = this.account(id);
    if (!a) return this.notice(ws, 'Conecte seu nickname primeiro');
    const targetNick = String(m.nick || '').trim().toUpperCase();
    const to = this.findNick(targetNick), b = to ? this.account(to) : null;
    if (m.op === 'refresh') return this.state(id);
    if (m.op === 'lookup') {
      const now = Date.now();
      if (now - (info.lastLookup || 0) < 160) return;
      info.lastLookup = now; attach(ws, info);
      return safeSend(ws, { op: 'lookupResult', query: targetNick,
        player: NICK_RE.test(targetNick) && b ? { nick:b.nick, online:this.online(to) } : null });
    }
    if (m.op === 'request') {
      if (!b) return this.notice(ws,'Jogador não encontrado. Ele precisa registrar o nickname');
      if (id === to) return this.notice(ws,'Você não pode adicionar a si mesmo');
      if (a.friends.includes(to)) return this.notice(ws,'Vocês já são amigos');
      if (a.outgoing.includes(to)) return this.notice(ws,'Solicitação já enviada');
      if (a.incoming.includes(to)) return this.notice(ws,'Essa pessoa já te enviou uma solicitação. Aceite-a.');
      if (a.outgoing.length >= 30 || b.incoming.length >= 30) return this.notice(ws,'Limite de solicitações atingido');
      a.outgoing.push(to); b.incoming.push(id); await this.save();
      this.state(id); this.state(to); this.send(to,{op:'notice',message:a.nick+' enviou uma solicitação de amizade'});
    } else if (m.op === 'accept' || m.op === 'decline') {
      if (!b || !a.incoming.includes(to)) return this.notice(ws,'Solicitação não encontrada');
      if (m.op === 'accept' && (a.friends.length >= 60 || b.friends.length >= 60)) return this.notice(ws,'Limite de amigos atingido');
      a.incoming = a.incoming.filter(x => x !== to);
      b.outgoing = b.outgoing.filter(x => x !== id);
      if (m.op === 'accept') {
        if (!a.friends.includes(to)) a.friends.push(to);
        if (!b.friends.includes(id)) b.friends.push(id);
        this.send(to,{op:'notice',message:a.nick+' aceitou sua amizade'});
      }
      await this.save(); this.state(id); this.state(to);
    } else if (m.op === 'remove') {
      if (!b || !a.friends.includes(to)) return this.notice(ws,'Amigo não encontrado');
      a.friends = a.friends.filter(x => x !== to);
      b.friends = b.friends.filter(x => x !== id);
      await this.save(); this.state(id); this.state(to);
    } else if (m.op === 'invite') {
      const code = String(m.code || '').toUpperCase();
      if (!b || !a.friends.includes(to) || !b.friends.includes(id)) return this.notice(ws,'A amizade precisa estar aceita antes do convite');
      if (!CODE_RE.test(code)) return this.notice(ws,'Código de sala inválido');
      if (!this.online(to)) return this.notice(ws,'Seu amigo está offline');
      const now = Date.now();
      if (now - (info.lastInvite || 0) < 2500) return this.notice(ws,'Aguarde um pouco antes de convidar novamente');
      const roomId = this.env.ROOMS.idFromName('room:' + code);
      const status = await this.env.ROOMS.get(roomId)
        .fetch('https://local/status').then(r => r.json()).catch(() => ({}));
      if (!status.host) return this.notice(ws,'Crie uma sala antes de convidar');
      if (status.guest) return this.notice(ws,'Esta sala já está cheia');
      info.lastInvite = now; attach(ws, info);
      this.send(to, { op:'invite', from:a.nick, code, ts:now });
      safeSend(ws, { op:'notice', message:'Convite enviado para ' + b.nick });
    } else if (m.op === 'inviteResponse') {
      if (!b || !a.friends.includes(to)) return;
      this.send(to, { op:'notice', message:a.nick + (m.accepted ? ' aceitou' : ' recusou') + ' seu convite' });
    }
  }
  webSocketClose(ws) {
    const info = getAttachment(ws);
    if (info.id) this.stateGroup(info.id);
  }
  webSocketError(ws) { try { ws.close(1011, 'Connection error'); } catch (_e) {} }
}
