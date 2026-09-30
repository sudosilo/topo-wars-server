// Game rules, copied from the Topo Wars page so the server plays by the same rules.
const Engine = (() => {
  const WIN = 150, MAX_ROUNDS = 40;
  const COST = { soldier: 1, rifle: 2, drone: 2, jeep: 2, arty: 3, plane: 3, heli: 4 };
  const KILL = { soldier: 5, rifle: 6, drone: 4, jeep: 5, arty: 8 };
  const NAMES = { soldier: 'soldier', rifle: 'rifleman', drone: 'drone', jeep: 'jeep', arty: 'artillery', plane: 'recon plane', heli: 'helicopter' };
  const SIGHT = { cmd: 4, soldier: 3, rifle: 4, arty: 2, drone: 6, jeep: 3 };
  const GRENADES = 2, GRENADE_RANGE = 2, JEEP_RANGE = 2, SEATS = 3;
  const AIR = { plane: { r: 8, turns: 1 }, heli: { r: 4, turns: 3 } };
  const HQ_PTS = 20, ENCIRCLE_PTS = 10, CMD_HIT_PTS = 5, CMD_HP = 3, ROAD_RUN = 3, DRONE_RANGE = 4, INCOME = 2;
  const TIER_CUTS = [0.20, 0.45, 0.70, 0.90];
  // Terrain kinds stored per cell in G.terr
  const T = { OPEN: 0, ROAD: 1, BUILDING: 2, WATER: 3, FOREST: 4, WALL: 5, CLIFF: 6, RAIL: 7, STEEP: 8, TRENCH: 9, BARRICADE: 10 };
  const T_NAMES = ['Open ground', 'Road', 'Buildings', 'Water', 'Forest', 'Barrier', 'Cliff', 'Railway', 'Steep slope', 'Trench', 'Barricade'];
  // Soldier engineering. Digging a trench is free, the others cost supply. Raised ground stacks twice.
  const BUILD = {
    trench: { cost: 0, label: 'Dig trench' },
    barricade: { cost: 1, label: 'Barricade' },
    mound: { cost: 1, label: 'Raise ground' }
  };
  const MOUND_MAX = 2, MOUND_METERS = 4;

  function rng(G) {
    let t = (G.seed = (G.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const foe = s => 3 - s;
  const bump = G => { G.ver = (G.ver || 0) + 1; };
  const rcOf = (G, i) => [(i / G.size) | 0, i % G.size];
  function nb8(G, i) {
    const n = G.size, r = (i / n) | 0, c = i - r * n, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) out.push(rr * n + cc);
    }
    return out;
  }
  function square(G, i, R) {
    const n = G.size, [r, c] = rcOf(G, i), out = [];
    for (let rr = Math.max(0, r - R); rr <= Math.min(n - 1, r + R); rr++)
      for (let cc = Math.max(0, c - R); cc <= Math.min(n - 1, c + R); cc++) out.push(rr * n + cc);
    return out;
  }
  function cheb(G, a, b) {
    const n = G.size;
    return Math.max(Math.abs(((a / n) | 0) - ((b / n) | 0)), Math.abs((a % n) - (b % n)));
  }
  // People on foot cross anything but water and cliffs. Vehicles need roads or open ground.
  const footOK = (G, i) => { const t = G.terr[i]; return t !== T.WATER && t !== T.CLIFF && t !== T.BARRICADE; };
  const vehOK = (G, i) => { const t = G.terr[i]; return t === T.ROAD || t === T.OPEN; };
  // Raised ground adds to a cell's tier, up to the peak tier of 5.
  const tierAt = (G, i) => Math.min(5, G.tier[i] + (G.mound ? G.mound[i] : 0));
  const heightAt = (G, i) => G.elev[i] + (G.mound ? G.mound[i] * MOUND_METERS : 0);
  const artyRange = (G, i) => 2 + tierAt(G, i);
  const rifleRange = (G, i) => (tierAt(G, i) >= 4 ? 3 : 2);
  const unitAt = (G, i) => { for (const u of G.units) if (u.idx === i) return u; return null; };
  const count = (G, side, type) => G.units.reduce((k, u) => {
    if (u.side !== side) return k;
    let n = u.type === type ? 1 : 0;
    if (type === 'arty' && u.cargo) n++;
    for (const r of u.riders || []) if (r.type === type) n++;
    return k + n;
  }, 0);
  const ready = (G, u) => u.placed < G.round;
  const canShoot = (G, u) => (u.type === 'arty' || u.type === 'rifle') && ready(G, u) && !u.fired;
  const artyReady = (G, u) => u.type === 'arty' && canShoot(G, u);
  // A commander riding in a jeep shares the jeep's cell: the cell holds both.
  function occupant(G, i) {
    for (const s of [1, 2]) if (G.cmd[s] === i) return { side: s, cmd: true, unit: G.riding && G.riding[s] ? unitAt(G, i) || undefined : undefined };
    const u = unitAt(G, i);
    return u ? { side: u.side, unit: u } : null;
  }

  function log(G, side, text) {
    G.log.push({ r: G.round, s: side, t: text });
    if (G.log.length > 200) G.log.splice(0, G.log.length - 200);
  }
  function finish(G, winner, reason) { if (!G.over) G.over = { winner, reason }; }
  const stat = (G, side, key, k = 1) => { G.stats[side][key] = (G.stats[side][key] || 0) + k; };
  function award(G, side, pts, text) {
    G.score[side] += pts;
    log(G, side, text + ' +' + pts);
    if (!G.over && G.score[side] >= WIN) finish(G, side, 'Reached ' + WIN + ' points');
  }
  function capture(G, side, i) {
    const f = foe(side);
    if (G.owner[i] === f) {
      stat(G, side, 'captured');
      award(G, side, tierAt(G, i), 'Captured a tier ' + tierAt(G, i) + ' cell');
      if (i === G.hq[f] && !G.hqTaken[f]) {
        G.hqTaken[f] = true;
        award(G, side, HQ_PTS, 'Took the enemy HQ');
      }
    }
    G.owner[i] = side;
  }
  function killUnit(G, side, u) {
    G.units.splice(G.units.indexOf(u), 1);
    if (u.cargo) { stat(G, side, 'kills'); stat(G, u.side, 'lost'); award(G, side, KILL.arty, 'Destroyed the artillery it was towing'); u.cargo = null; }
    for (const r of u.riders || []) { stat(G, side, 'kills'); stat(G, u.side, 'lost'); award(G, side, KILL[r.type], 'Destroyed a ' + NAMES[r.type] + ' riding in the jeep'); }
    if (u.riders) u.riders = [];
    if (G.riding && G.riding[u.side] === u.id) G.riding[u.side] = null;
    stat(G, side, 'kills'); stat(G, u.side, 'lost');
    award(G, side, KILL[u.type], 'Destroyed ' + (u.type === 'arty' ? 'artillery' : 'a ' + NAMES[u.type]));
  }
  function killCommander(G, side, how) {
    G.hp[foe(side)] = 0;
    log(G, side, how);
    finish(G, side, side === 1 ? 'You took out the enemy commander' : 'The enemy took out your commander');
  }
  function hitCommander(G, side, by) {
    const f = foe(side);
    stat(G, side, 'hits');
    G.hp[f] -= 1;
    award(G, side, CMD_HIT_PTS, by + ' hit the enemy commander, ' + Math.max(0, G.hp[f]) + ' health left');
    if (G.hp[f] <= 0) killCommander(G, side, by + ' took out the enemy commander');
  }

  // 4-connected flood from the border through every cell not owned by side.
  // Anything not reached is sealed inside side's territory and flips to side.
  function encircle(G, side) {
    const n = G.size, N = n * n, own = G.owner, seen = new Uint8Array(N), q = new Int32Array(N);
    let h = 0, t = 0;
    const push = i => { if (!seen[i] && own[i] !== side) { seen[i] = 1; q[t++] = i; } };
    for (let k = 0; k < n; k++) { push(k); push((n - 1) * n + k); push(k * n); push(k * n + n - 1); }
    while (h < t) {
      const i = q[h++], r = (i / n) | 0, c = i - r * n;
      if (r > 0) push(i - n);
      if (r < n - 1) push(i + n);
      if (c > 0) push(i - 1);
      if (c < n - 1) push(i + 1);
    }
    const f = foe(side);
    let enemy = 0, neutral = 0;
    for (let i = 0; i < N; i++) {
      if (!seen[i] && own[i] !== side) {
        if (own[i] === f) enemy++; else neutral++;
        own[i] = side;
      }
    }
    if (enemy > 0) { stat(G, side, 'encircled', enemy); award(G, side, ENCIRCLE_PTS, 'Encircled ' + enemy + ' enemy cells'); }
    else if (neutral > 0) log(G, side, 'Sealed off ' + neutral + ' open cells');
    return enemy + neutral;
  }

  // ---------- line of sight and fog ----------
  const obstacle = (G, i) => heightAt(G, i) + (G.terr[i] === T.BUILDING ? 9 : G.terr[i] === T.FOREST ? 12 : G.terr[i] === T.BARRICADE ? 3 : 0);
  function los(G, a, b) {
    const steps = cheb(G, a, b);
    if (steps <= 1) return true;
    const n = G.size, [ar, ac] = rcOf(G, a), [br, bc] = rcOf(G, b);
    const ha = heightAt(G, a) + 2 + (G.terr[a] === T.BUILDING ? 9 : 0), hb = heightAt(G, b) + 1.5;
    for (let k = 1; k < steps; k++) {
      const r = Math.round(ar + (br - ar) * k / steps), c = Math.round(ac + (bc - ac) * k / steps);
      const i = r * n + c;
      if (i === a || i === b) continue;
      if (obstacle(G, i) > ha + (hb - ha) * k / steps) return false;
    }
    return true;
  }
  const airActive = (G, a) => G.round >= a.round && G.round <= a.until && (a.kind !== 'plane' || G.turn === a.side);
  const VCACHE = new WeakMap();
  function sight(G, side) {
    let cache = VCACHE.get(G);
    if (!cache) { cache = {}; VCACHE.set(G, cache); }
    const key = G.ver + ':' + G.turn + ':' + G.round;
    if (cache[side] && cache[side].key === key) return cache[side].vis;
    const N = G.size * G.size, vis = new Uint8Array(N);
    if (!G.fog) vis.fill(1);
    else {
      for (let i = 0; i < N; i++) if (G.owner[i] === side) vis[i] = 1;
      const see = (from, R, useLos) => { for (const i of square(G, from, R)) if (!vis[i] && (!useLos || los(G, from, i))) vis[i] = 1; };
      see(G.cmd[side], SIGHT.cmd, true);
      for (const u of G.units) if (u.side === side) see(u.idx, SIGHT[u.type], u.type !== 'drone');
      for (const a of G.air) if (a.side === side && airActive(G, a)) see(a.idx, AIR[a.kind].r, false);
    }
    const f = foe(side);
    if (vis[G.cmd[f]]) G.intel[side] = { idx: G.cmd[f], round: G.round };
    if (side === 1) for (let i = 0; i < N; i++) if (vis[i]) { G.explored[i] = 1; G.known[i] = G.owner[i]; }
    cache[side] = { key, vis };
    return vis;
  }

  // ---------- movement ----------
  // Every piece steps one cell. Starting on a road or on tire treads, foot and vehicle pieces can
  // also run up to ROAD_RUN cells along empty road or treads. Drones fly DRONE_RANGE cells over
  // anything. Jeeps drive JEEP_RANGE cells over open ground and roads, or ROAD_RUN along road and
  // treads, and leave treads behind. Each destination records whether the trip stayed on road
  // and the path taken.
  const roadLike = (G, i) => G.terr[i] === T.ROAD || (G.tread && G.tread[i] === 1);
  function moveOptions(G, side, from, mode) {
    const out = new Map();
    if (mode === 'air') {
      for (const i of square(G, from, DRONE_RANGE)) if (i !== from && !occupant(G, i)) out.set(i, { road: false, path: [i] });
      return out;
    }
    const foot = mode === 'foot';
    const passable = i => foot ? footOK(G, i) : vehOK(G, i);
    const canEnd = i => { const o = occupant(G, i); return !o || (o.side !== side && foot); };
    const offer = (i, road, path) => { const cur = out.get(i); if (!cur || (road && !cur.road)) out.set(i, { road, path }); };
    // A limited search from the start cell. roadOnly keeps it to road and treads.
    const search = (limit, roadOnly) => {
      const prev = new Map([[from, -1]]), depth = new Map([[from, 0]]), q = [from];
      // Rebuild the route backwards, at each step taking the shortest-route neighbor that sits
      // closest to the straight line from start to finish, so a drive down a straight road
      // leaves its treads on that road instead of zigzagging diagonally beside it.
      const [fr, fc] = rcOf(G, from);
      const pathTo = j => {
        const [jr, jc] = rcOf(G, j), dr = jr - fr, dc = jc - fc, len = Math.hypot(dr, dc) || 1;
        const off = k => { const [r, c] = rcOf(G, k); return Math.abs((r - fr) * dc - (c - fc) * dr) / len; };
        const p = [j];
        let k = j, d = depth.has(j) ? depth.get(j) : Math.min(...nb8(G, j).filter(x => depth.has(x)).map(x => depth.get(x))) + 1;
        while (d > 1) {
          let best = null, bo = Infinity;
          for (const x of nb8(G, k)) {
            if (depth.get(x) !== d - 1 || x === from) continue;
            const o = off(x) + (cheb(G, x, k) === 1 && rcOf(G, x)[0] !== rcOf(G, k)[0] && rcOf(G, x)[1] !== rcOf(G, k)[1] ? 0.01 : 0);
            if (o < bo) { bo = o; best = x; }
          }
          if (best == null) break;
          p.unshift(best); k = best; d--;
        }
        return p;
      };
      while (q.length) {
        const i = q.shift(), d = depth.get(i);
        if (d >= limit) continue;
        for (const j of nb8(G, i)) {
          if (depth.has(j) || !passable(j) || (roadOnly && !roadLike(G, j))) continue;
          const o = occupant(G, j);
          if (o) { if (canEnd(j) && (d === 0 || roadOnly)) { prev.set(j, i); offer(j, roadOnly, pathTo(j)); } continue; }
          prev.set(j, i); depth.set(j, d + 1); q.push(j);
          offer(j, roadOnly || (d === 0 && roadLike(G, from) && roadLike(G, j)), pathTo(j));
        }
      }
    };
    search(mode === 'jeep' ? JEEP_RANGE : 1, false);
    if (roadLike(G, from)) search(ROAD_RUN, true);
    out.delete(from);
    return out;
  }
  const modeOf = u => u.type === 'drone' ? 'air' : u.type === 'arty' ? 'veh' : u.type === 'jeep' ? 'jeep' : 'foot';
  function commanderMoves(G, side) {
    if (G.over || G.cmdMoved[side] || (G.riding && G.riding[side])) return [];
    return [...moveOptions(G, side, G.cmd[side], 'foot').keys()];
  }
  function unitMoveMap(G, u) {
    if (G.over || u.moved || !ready(G, u) || (u.type === 'arty' && u.fired)) return new Map();
    if (u.type === 'jeep' && !hasDriver(G, u)) return new Map();
    return moveOptions(G, u.side, u.idx, modeOf(u));
  }
  const unitMoves = (G, u) => [...unitMoveMap(G, u).keys()];
  const keepsFire = (G, u, to) => { const m = unitMoveMap(G, u).get(to); return !!(m && m.road); };

  function moveCommander(G, side, to) {
    if (!commanderMoves(G, side).includes(to)) return false;
    const f = foe(side), o = occupant(G, to);
    G.cmdMoved[side] = true;
    if (o && o.unit) killUnit(G, side, o.unit);
    G.cmd[side] = to;
    capture(G, side, to);
    if (o && o.cmd) killCommander(G, side, 'Commander took out the enemy commander');
    else encircle(G, side);
    bump(G);
    return true;
  }
  function moveUnit(G, u, to) {
    const opts = unitMoveMap(G, u);
    if (!opts.has(to)) return false;
    const { road, path } = opts.get(to), o = occupant(G, to);
    if (o && o.unit) killUnit(G, u.side, o.unit);
    if (u.type === 'jeep') for (const i of [u.idx, ...path]) if (G.terr[i] !== T.ROAD) G.tread[i] = 1;
    u.idx = to;
    if (u.type === 'jeep' && cmdAboard(G, u)) G.cmd[u.side] = to;
    u.moved = true;
    if (u.type === 'arty') {
      if (!road) u.fired = true;
      log(G, u.side, road ? 'Artillery drove along the road' : 'Artillery repositioned and cannot fire this turn');
    }
    if (u.type === 'jeep') log(G, u.side, u.cargo ? 'Jeep towed artillery ' + path.length + ' cells' : 'Jeep drove ' + path.length + ' cells');
    if (u.type !== 'drone') capture(G, u.side, to);
    if (o && o.cmd) killCommander(G, u.side, (u.type === 'rifle' ? 'Rifleman' : 'Soldier') + ' took out the enemy commander');
    else if (u.type !== 'drone') encircle(G, u.side);
    bump(G);
    return true;
  }

  // ---------- shooting ----------
  // Artillery hits any visible enemy cell or piece in range. Riflemen need a clear line of sight
  // and only hit pieces. Neither can shoot at what its side cannot see.
  function shotTargets(G, u) {
    if (G.over || !canShoot(G, u)) return [];
    const f = foe(u.side), vis = sight(G, u.side), out = [];
    const R = u.type === 'arty' ? artyRange(G, u.idx) : rifleRange(G, u.idx);
    for (const i of square(G, u.idx, R)) {
      if (!vis[i]) continue;
      const o = occupant(G, i), enemyPiece = o && o.side === f;
      if (u.type === 'arty') { if (enemyPiece || G.owner[i] === f || (G.terr[i] === T.BARRICADE && G.owner[i] !== u.side)) out.push(i); }
      else if (enemyPiece && G.terr[i] !== T.TRENCH && los(G, u.idx, i)) out.push(i);
    }
    return out;
  }
  function fire(G, u, to) {
    if (!shotTargets(G, u).includes(to)) return false;
    const f = foe(u.side), o = occupant(G, to), who = u.type === 'arty' ? 'Artillery' : 'Rifleman';
    u.fired = true;
    stat(G, u.side, 'shots');
    // A barricade is knocked flat. A trench takes the blast for whoever is in it and caves in.
    if (G.terr[to] === T.BARRICADE) {
      G.terr[to] = T.OPEN;
      log(G, u.side, 'Artillery knocked down a barricade');
      bump(G);
      return true;
    }
    if (G.terr[to] === T.TRENCH && o && o.side === f) {
      G.terr[to] = T.OPEN;
      log(G, u.side, 'Artillery caved in a trench, the ' + (o.cmd ? 'commander' : NAMES[o.unit.type]) + ' inside survived');
      bump(G);
      return true;
    }
    if (o && o.side === f && o.cmd) {
      hitCommander(G, u.side, who);
      if (G.over || u.type === 'rifle') { bump(G); return true; }
    } else if (o && o.side === f && o.unit) killUnit(G, u.side, o.unit);
    if (u.type === 'arty') {
      if (G.owner[to] !== f && !(o && o.side === f)) log(G, u.side, 'Artillery shelled a cell');
      capture(G, u.side, to);
      encircle(G, u.side);
    }
    bump(G);
    return true;
  }

  // ---------- towing ----------
  // A jeep next to a ready artillery piece can hitch it up, using the gun's turn. The jeep then
  // drives as usual with the gun in tow and can unhitch it onto open ground or road beside it.
  // An unhitched gun sets up and fires from the next turn.
  function hitchTargets(G, j) {
    if (G.over || j.type !== 'jeep' || j.cargo || !ready(G, j) || j.unhitched) return [];
    return G.units.filter(a => a.side === j.side && a.type === 'arty' && ready(G, a) && !a.moved && !a.fired && cheb(G, a.idx, j.idx) === 1).map(a => a.idx);
  }
  function hitch(G, j, i) {
    if (!hitchTargets(G, j).includes(i)) return false;
    const a = unitAt(G, i);
    G.units.splice(G.units.indexOf(a), 1);
    a.moved = true; a.fired = true;
    j.cargo = a;
    log(G, j.side, 'Jeep hitched up artillery');
    bump(G);
    return true;
  }
  function unhitchCells(G, j) {
    if (G.over || j.type !== 'jeep' || !j.cargo) return [];
    return nb8(G, j.idx).filter(i => vehOK(G, i) && !occupant(G, i));
  }
  function unhitch(G, j, i) {
    if (!unhitchCells(G, j).includes(i)) return false;
    const a = j.cargo;
    j.cargo = null; j.unhitched = true;
    a.idx = i; a.moved = true; a.fired = true; a.placed = G.round;
    G.units.push(a);
    capture(G, j.side, i);
    log(G, j.side, 'Jeep dropped off artillery on tier ' + tierAt(G, i));
    encircle(G, j.side);
    bump(G);
    return true;
  }

  // ---------- riding in jeeps ----------
  // A jeep has 3 seats for soldiers, riflemen and the commander, and cannot move without at
  // least one of them aboard to drive. Climbing in uses the rider's turn. Troops who climb out
  // act again from the next turn. The commander rides in the jeep's cell and can climb out the
  // same turn. Troops aboard are lost if the jeep is destroyed.
  const ridersOf = j => j.riders || (j.riders = []);
  const cmdAboard = (G, j) => !!(G.riding && G.riding[j.side] === j.id);
  const seatsUsed = (G, j) => ridersOf(j).length + (cmdAboard(G, j) ? 1 : 0);
  const hasDriver = (G, j) => seatsUsed(G, j) > 0;
  const canRide = (G, u, side) => u && u.side === side && (u.type === 'soldier' || u.type === 'rifle') && ready(G, u) && !u.moved;
  const cmdCanBoard = (G, j) => !G.cmdMoved[j.side] && !(G.riding && G.riding[j.side]) && cheb(G, G.cmd[j.side], j.idx) === 1;
  function loadTargets(G, j) {
    if (G.over || j.type !== 'jeep' || !ready(G, j) || seatsUsed(G, j) >= SEATS) return [];
    const out = nb8(G, j.idx).filter(i => canRide(G, unitAt(G, i), j.side));
    if (cmdCanBoard(G, j)) out.push(G.cmd[j.side]);
    return out;
  }
  function load(G, j, i) {
    if (!loadTargets(G, j).includes(i)) return false;
    if (i === G.cmd[j.side]) {
      G.riding[j.side] = j.id;
      G.cmd[j.side] = j.idx;
      G.cmdMoved[j.side] = true;
      log(G, j.side, 'The commander climbed into a jeep');
      bump(G);
      return true;
    }
    const u = unitAt(G, i);
    G.units.splice(G.units.indexOf(u), 1);
    u.moved = true; u.fired = true;
    ridersOf(j).push(u);
    log(G, j.side, 'A ' + NAMES[u.type] + ' climbed into a jeep');
    bump(G);
    return true;
  }
  function boardTargets(G, u) {
    if (G.over || !canRide(G, u, u.side)) return [];
    return nb8(G, u.idx).filter(i => { const j = unitAt(G, i); return j && j.side === u.side && j.type === 'jeep' && ready(G, j) && seatsUsed(G, j) < SEATS; });
  }
  function board(G, u, i) {
    if (!boardTargets(G, u).includes(i)) return false;
    return load(G, unitAt(G, i), u.idx);
  }
  const exitCells = (G, j) => nb8(G, j.idx).filter(i => footOK(G, i) && !occupant(G, i));
  function unloadCells(G, j) {
    if (G.over || j.type !== 'jeep' || !ridersOf(j).length) return [];
    return exitCells(G, j);
  }
  function unload(G, j, i) {
    if (!unloadCells(G, j).includes(i)) return false;
    const u = ridersOf(j).shift();
    u.idx = i; u.moved = true; u.fired = true;
    G.units.push(u);
    capture(G, j.side, i);
    log(G, j.side, 'A ' + NAMES[u.type] + ' climbed out of a jeep');
    encircle(G, j.side);
    bump(G);
    return true;
  }
  function cmdOutCells(G, j) {
    if (G.over || j.type !== 'jeep' || !cmdAboard(G, j)) return [];
    return exitCells(G, j);
  }
  function cmdOut(G, j, i) {
    if (!cmdOutCells(G, j).includes(i)) return false;
    G.riding[j.side] = null;
    G.cmd[j.side] = i;
    G.cmdMoved[j.side] = true;
    capture(G, j.side, i);
    log(G, j.side, 'The commander climbed out of a jeep');
    encircle(G, j.side);
    bump(G);
    return true;
  }

  // ---------- grenades ----------
  // Soldiers carry 2 grenades. Throwing one takes the soldier's turn and reaches 2 cells, over
  // walls and into trenches, at anything its side can see. It destroys a piece, knocks down a
  // barricade, or takes 1 health from a commander.
  const grenadesLeft = u => (u.g == null ? GRENADES : u.g);
  function grenadeTargets(G, u) {
    if (G.over || u.type !== 'soldier' || u.moved || !ready(G, u) || grenadesLeft(u) <= 0) return [];
    const f = foe(u.side), vis = sight(G, u.side), out = [];
    for (const i of square(G, u.idx, GRENADE_RANGE)) {
      if (i === u.idx || !vis[i]) continue;
      const o = occupant(G, i);
      if ((o && o.side === f) || (G.terr[i] === T.BARRICADE && G.owner[i] !== u.side)) out.push(i);
    }
    return out;
  }
  function throwGrenade(G, u, to) {
    if (!grenadeTargets(G, u).includes(to)) return false;
    const f = foe(u.side), o = occupant(G, to);
    u.g = grenadesLeft(u) - 1;
    u.moved = true;
    stat(G, u.side, 'grenades');
    if (G.terr[to] === T.BARRICADE && !(o && o.side === f)) { G.terr[to] = T.OPEN; log(G, u.side, 'Grenade blew apart a barricade'); }
    else if (o && o.cmd) hitCommander(G, u.side, 'Grenade');
    else if (o && o.unit) killUnit(G, u.side, o.unit);
    bump(G);
    return true;
  }

  // ---------- building ----------
  // A soldier can spend its action instead of moving: dig a trench under itself or next to it,
  // put up a barricade next to it, or pile earth next to it to raise the ground a level.
  const buildable = (G, i) => { const t = G.terr[i]; return t === T.OPEN || t === T.ROAD || t === T.STEEP || t === T.FOREST || t === T.TRENCH; };
  function buildCells(G, u, kind) {
    if (G.over || u.type !== 'soldier' || u.moved || !ready(G, u) || G.supply[u.side] < BUILD[kind].cost) return [];
    const out = [];
    const cand = kind === 'trench' ? [u.idx, ...nb8(G, u.idx)] : nb8(G, u.idx);
    for (const i of cand) {
      if (i !== u.idx && occupant(G, i)) continue;
      if (G.owner[i] === foe(u.side)) continue;
      if (kind === 'trench' && (G.terr[i] === T.TRENCH || !buildable(G, i))) continue;
      if (kind === 'barricade' && !buildable(G, i)) continue;
      if (kind === 'mound' && (!buildable(G, i) || G.mound[i] >= MOUND_MAX)) continue;
      out.push(i);
    }
    return out;
  }
  function build(G, u, kind, i) {
    if (!buildCells(G, u, kind).includes(i)) return false;
    G.supply[u.side] -= BUILD[kind].cost;
    u.moved = true;
    if (kind === 'trench') G.terr[i] = T.TRENCH;
    else if (kind === 'barricade') G.terr[i] = T.BARRICADE;
    else { G.mound[i] += 1; if (G.terr[i] !== T.ROAD) G.terr[i] = T.OPEN; }
    if (G.owner[i] === 0) G.owner[i] = u.side;
    stat(G, u.side, 'built');
    log(G, u.side, kind === 'trench' ? 'Dug a trench' : kind === 'barricade' ? 'Put up a barricade' : 'Raised the ground to level ' + G.mound[i]);
    bump(G);
    return true;
  }

  // ---------- deploying and aircraft ----------
  function deployCheck(G, side, type, i) {
    if (G.over) return 'The battle is over';
    if (G.supply[side] < COST[type]) return 'Needs ' + COST[type] + ' supply';
    if (type === 'plane' || type === 'heli' || i == null) return null;
    if (G.owner[i] !== side) return 'Place units on your own territory';
    if (occupant(G, i)) return 'That cell is occupied';
    if ((type === 'arty' || type === 'jeep') && !vehOK(G, i)) return (type === 'arty' ? 'Artillery' : 'A jeep') + ' needs a road or open ground, not ' + T_NAMES[G.terr[i]].toLowerCase();
    if ((type === 'soldier' || type === 'rifle') && !footOK(G, i)) return 'Troops cannot stand on ' + T_NAMES[G.terr[i]].toLowerCase();
    return null;
  }
  function deployCells(G, side, type) {
    const out = [];
    for (let i = 0; i < G.owner.length; i++) if (G.owner[i] === side && !deployCheck(G, side, type, i)) out.push(i);
    return out;
  }
  function deploy(G, side, type, i) {
    if (type === 'plane' || type === 'heli' || deployCheck(G, side, type, i)) return false;
    G.supply[side] -= COST[type];
    const unit = { id: G.nextId++, side, type, idx: i, placed: G.round, moved: true, fired: true };
    if (type === 'soldier') unit.g = GRENADES;
    G.units.push(unit);
    stat(G, side, 'deployed');
    log(G, side, 'Placed ' + (type === 'arty' ? 'artillery' : 'a ' + NAMES[type]) + ' on tier ' + G.tier[i]);
    bump(G);
    return true;
  }
  function callAir(G, side, kind, i) {
    if (deployCheck(G, side, kind, null) || i == null || i < 0 || i >= G.size * G.size) return false;
    G.supply[side] -= COST[kind];
    G.air.push({ side, kind, idx: i, round: G.round, until: G.round + AIR[kind].turns - 1 });
    stat(G, side, 'air');
    log(G, side, kind === 'plane' ? 'Called a recon plane' : 'Sent a helicopter to hover for ' + AIR.heli.turns + ' turns');
    bump(G);
    return true;
  }

  const INCOME_STEP = 10;
  function territory(G, side) {
    let n = 0;
    for (let i = 0; i < G.owner.length; i++) if (G.owner[i] === side) n++;
    return n;
  }
  function baseIncome(cells) { return INCOME + Math.floor(Math.max(0, cells - INCOME_STEP) / INCOME_STEP); }
  function nextIncomeAt(cells) { return Math.max(2 * INCOME_STEP, (Math.floor(cells / INCOME_STEP) + 1) * INCOME_STEP); }
  function income(G, side) {
    const b = baseIncome(territory(G, side));
    if (side === 2 && G.diff === 'easy') return Math.max(1, Math.floor(b / 2));
    if (side === 2 && G.diff === 'hard' && G.round % 3 === 0) return b + 1;
    return b;
  }
  function beginTurn(G, side) {
    G.turn = side;
    G.supply[side] += income(G, side);
    G.cmdMoved[side] = false;
    for (const u of G.units) if (u.side === side) { u.moved = false; u.fired = false; u.unhitched = false; }
    bump(G);
  }

  // What the given side can hit next turn, judged only from pieces inside mask when one is given.
  // contact: cells its commander or troops can step onto. shot: cells inside rifle or artillery range.
  function reach(G, side, mask) {
    const N = G.size * G.size, contact = new Uint8Array(N), shot = new Uint8Array(N);
    const seen = i => !mask || mask[i];
    if (seen(G.cmd[side]) && !(G.riding && G.riding[side])) for (const i of moveOptions(G, side, G.cmd[side], 'foot').keys()) contact[i] = 1;
    for (const u of G.units) {
      if (u.side !== side || !seen(u.idx)) continue;
      if (u.type === 'soldier' || u.type === 'rifle') for (const i of moveOptions(G, side, u.idx, 'foot').keys()) contact[i] = 1;
      if (u.type === 'rifle') for (const i of square(G, u.idx, rifleRange(G, u.idx))) shot[i] = 1;
      if (u.type === 'arty') for (const i of square(G, u.idx, artyRange(G, u.idx))) shot[i] = 1;
    }
    return { contact, shot };
  }

  function pickCell(G, cells, scoreFn) {
    let best = null, bs = -Infinity;
    for (const i of cells) { const s = scoreFn(i); if (s > bs) { bs = s; best = i; } }
    return best;
  }

  // ---------- computer opponent ----------
  function aiTurn(G, me) {
    const f = foe(me), touched = [];
    if (G.over) return touched;
    const vis = () => sight(G, me);
    const cmdSeen = () => !!vis()[G.cmd[f]];
    const tgt = () => cmdSeen() ? G.cmd[f] : (G.intel[me] ? G.intel[me].idx : G.hq[f]);
    const shotScore = i => {
      const o = occupant(G, i);
      if (o && o.side === f && o.cmd) return G.diff === 'easy' && me === 2 ? 40 : 1000;
      if (o && o.side === f && o.unit) return 100 + KILL[o.unit.type];
      return G.tier[i] * 10 - cheb(G, i, tgt()) * 0.2 + rng(G) * 0.1;
    };
    const shootWith = u => {
      const t = shotTargets(G, u);
      if (!t.length) return false;
      const best = pickCell(G, t, shotScore);
      fire(G, u, best); touched.push(best);
      return true;
    };

    // Lost track of the enemy commander: drones search first. If none is close, call in aircraft,
    // a helicopter when it can afford one, otherwise a recon plane, at most once every 3 rounds.
    const blind = G.fog && !cmdSeen() ? G.round - (G.intel[me] ? G.intel[me].round : 1) : 0;
    const droneNear = G.units.some(u => u.side === me && u.type === 'drone' && cheb(G, u.idx, tgt()) <= SIGHT.drone + DRONE_RANGE);
    const airBusy = G.air.some(a => a.side === me && a.until >= G.round) || (G.lastAir && G.lastAir[me] && G.round - G.lastAir[me] < 3);
    // Guns with nothing to aim at also want spotting, when there is supply to spare.
    const gunsIdle = G.fog && !cmdSeen() && G.units.some(u => u.side === me && u.type === 'arty' && canShoot(G, u) && !shotTargets(G, u).length);
    if (((blind >= 2 && !droneNear) || (gunsIdle && G.supply[me] >= COST.plane + 2)) && !airBusy && G.round >= 3) {
      const kind = G.supply[me] >= COST.heli + 2 ? 'heli' : G.supply[me] >= COST.plane ? 'plane' : null;
      if (kind && callAir(G, me, kind, tgt())) { G.lastAir = G.lastAir || {}; G.lastAir[me] = G.round; touched.push(tgt()); }
    }

    // Jeeps: hitch up guns that have nothing in range, haul them toward the enemy, and drop them
    // on the highest open ground from which the enemy commander should be in range.
    for (const j of G.units.filter(u => u.side === me && u.type === 'jeep')) {
      if (!G.units.includes(j) || !ready(G, j)) continue;
      const T0 = tgt();
      // Pick up troops who still have a long walk ahead.
      for (const i of loadTargets(G, j)) {
        if (i === G.cmd[me] || seatsUsed(G, j) >= SEATS) continue;
        if (!hasDriver(G, j) || cheb(G, i, T0) > 6) { load(G, j, i); touched.push(i); }
      }
      if (!j.cargo) {
        const h = hitchTargets(G, j).filter(i => { const a = unitAt(G, i); return !shotTargets(G, a).length && cheb(G, i, T0) > artyRange(G, i); });
        if (h.length) { hitch(G, j, h[0]); touched.push(h[0]); }
      }
      const drops = () => unhitchCells(G, j).filter(i => cheb(G, i, T0) <= artyRange(G, i) - 1);
      if (j.cargo && drops().length) { const at = pickCell(G, drops(), i => tierAt(G, i)); unhitch(G, j, at); touched.push(at); continue; }
      const opts = unitMoveMap(G, j);
      if (!opts.size) continue;
      const { contact } = reach(G, f, vis());
      let goal = T0, want = j.cargo ? 5 : ridersOf(j).length ? 3 : 4;
      if (!j.cargo) {
        const lonely = G.units.find(a => a.side === me && a.type === 'arty' && ready(G, a) && !a.fired && !shotTargets(G, a).length && cheb(G, a.idx, T0) > artyRange(G, a.idx) + 1);
        if (lonely) { goal = lonely.idx; want = 1; }
      }
      const score = i => -Math.abs(cheb(G, i, goal) - want) * 2 - (contact[i] ? 30 : 0) + (roadLike(G, i) ? 0.5 : 0) + rng(G) * 0.3;
      const best = pickCell(G, [...opts.keys()], score);
      if (best != null && score(best) > score(j.idx)) { moveUnit(G, j, best); touched.push(best); }
      if (j.cargo && drops().length) { const at = pickCell(G, drops(), i => tierAt(G, i)); unhitch(G, j, at); touched.push(at); }
      // Let riders out once the enemy is close.
      while (ridersOf(j).length > 1 && cheb(G, j.idx, T0) <= 5 && unloadCells(G, j).length) {
        const at = pickCell(G, unloadCells(G, j), i => -cheb(G, i, T0));
        unload(G, j, at); touched.push(at);
      }
    }

    // Guns first.
    for (const u of G.units.filter(u => u.side === me && (u.type === 'arty' || u.type === 'rifle'))) {
      if (!G.units.includes(u) || !canShoot(G, u)) continue;
      const tow = G.units.some(j => j.side === me && j.type === 'jeep' && !j.cargo && cheb(G, j.idx, u.idx) <= 3);
      if (!shotTargets(G, u).length && u.type === 'arty' && !tow) {
        const opts = unitMoveMap(G, u);
        if (opts.size && cheb(G, u.idx, tgt()) > artyRange(G, u.idx) - 1) {
          const best = pickCell(G, [...opts.keys()], i => -cheb(G, i, tgt()) + (opts.get(i).road ? 0.8 : 0) + tierAt(G, i) * 0.3 + rng(G) * 0.1);
          if (best != null && cheb(G, best, tgt()) < cheb(G, u.idx, tgt())) { moveUnit(G, u, best); touched.push(best); }
        }
        // Roll up onto freshly raised ground next door when it gives more range.
        const up = [...unitMoveMap(G, u).keys()].filter(i => G.mound[i] && tierAt(G, i) > tierAt(G, u.idx));
        if (up.length && !u.moved && !u.fired) { const at = pickCell(G, up, i => tierAt(G, i)); moveUnit(G, u, at); touched.push(at);
        }
      }
      shootWith(u);
      if (G.over) return touched;
    }

    // Engineering. Raise the ground beside idle artillery so it can roll up for more range,
    // wall off the commander when enemy troops close in, and dig in soldiers guarding it.
    {
      const { contact } = reach(G, f, vis());
      const threats = G.units.filter(v => v.side === f && (v.type === 'soldier' || v.type === 'rifle') && vis()[v.idx] && cheb(G, v.idx, G.cmd[me]) <= 3);
      for (const u of G.units.filter(u => u.side === me && u.type === 'soldier' && !u.moved && ready(G, u))) {
        if (threats.length && cheb(G, u.idx, G.cmd[me]) <= 1 && G.supply[me] >= BUILD.barricade.cost) {
          const near = threats[0].idx;
          const spots = buildCells(G, u, 'barricade').filter(i => cheb(G, i, G.cmd[me]) === 1 && cheb(G, i, near) < cheb(G, G.cmd[me], near));
          if (spots.length) { build(G, u, 'barricade', pickCell(G, spots, i => -cheb(G, i, near))); touched.push(u.idx); continue; }
          const dig = buildCells(G, u, 'trench').includes(u.idx);
          if (dig) { build(G, u, 'trench', u.idx); touched.push(u.idx); continue; }
        }
        const gun = G.units.find(a => a.side === me && a.type === 'arty' && cheb(G, a.idx, u.idx) <= 2 && !shotTargets(G, a).length);
        if (gun && G.supply[me] >= BUILD.mound.cost + 1 && tierAt(G, gun.idx) < 5) {
          const spots = buildCells(G, u, 'mound').filter(i => cheb(G, i, gun.idx) === 1 && vehOK(G, i) && tierAt(G, i) >= tierAt(G, gun.idx));
          if (spots.length) { const at = pickCell(G, spots, i => tierAt(G, i) - cheb(G, i, tgt()) * 0.1); build(G, u, 'mound', at); touched.push(at); continue; }
        }
      }
    }

    // Grenades: soldiers lob one at the commander, at guns and jeeps, at troops dug into trenches,
    // or at a barricade standing between them and the enemy.
    for (const u of G.units.filter(u => u.side === me && u.type === 'soldier')) {
      if (!G.units.includes(u)) continue;
      const t = grenadeTargets(G, u);
      if (!t.length) continue;
      const T0 = tgt();
      const score = i => {
        const o = occupant(G, i);
        if (o && o.cmd) return 1000;
        if (o && o.unit) return { arty: 50, rifle: 40, jeep: 40, drone: 20, soldier: G.terr[i] === T.TRENCH ? 30 : 0 }[o.unit.type] || 0;
        return cheb(G, i, T0) < cheb(G, u.idx, T0) ? 18 : 0;
      };
      const best = pickCell(G, t, score);
      if (best != null && score(best) >= 18) { throwGrenade(G, u, best); touched.push(best); if (G.over) return touched; }
    }

    // A jeep without a driver calls the nearest soldier or rifleman over to climb in.
    const needDriver = G.units.filter(j => j.side === me && j.type === 'jeep' && !hasDriver(G, j));
    const drivers = new Map();
    for (const j of needDriver) {
      const near = G.units.filter(u => u.side === me && (u.type === 'soldier' || u.type === 'rifle') && !u.moved && ready(G, u) && !drivers.has(u) && cheb(G, u.idx, j.idx) <= 6);
      if (!near.length) continue;
      near.sort((a, b) => cheb(G, a.idx, j.idx) - cheb(G, b.idx, j.idx));
      drivers.set(near[0], j);
    }
    for (const [u, j] of drivers) {
      if (!G.units.includes(u) || !G.units.includes(j)) continue;
      if (boardTargets(G, u).includes(j.idx)) { board(G, u, j.idx); touched.push(j.idx); continue; }
      const opts = [...unitMoveMap(G, u).keys()].filter(i => !occupant(G, i));
      const best = pickCell(G, opts, i => -cheb(G, i, j.idx));
      if (best != null && cheb(G, best, j.idx) < cheb(G, u.idx, j.idx)) { moveUnit(G, u, best); touched.push(best); }
    }

    // Troops close in. Soldiers want contact, riflemen hang back two cells and shoot after moving.
    for (const u of G.units.filter(u => u.side === me && (u.type === 'soldier' || u.type === 'rifle'))) {
      if (!G.units.includes(u) || drivers.has(u)) continue;
      const opts = unitMoveMap(G, u);
      if (!opts.size) continue;
      const { contact } = reach(G, f, vis());
      if (opts.has(G.cmd[f]) && cmdSeen()) { moveUnit(G, u, G.cmd[f]); touched.push(G.cmd[f]); return touched; }
      const want = u.type === 'rifle' ? 2 : 0, T0 = tgt(), v = vis();
      let best = null, bs = -Math.abs(cheb(G, u.idx, T0) - want) * 1.6 - 0.5 - (contact[u.idx] ? (u.type === 'rifle' ? 8 : 4) : 0);
      for (const i of opts.keys()) {
        let s = 0;
        const o = occupant(G, i);
        if (o && o.unit && o.side === f && v[i]) s += o.unit.type === 'arty' ? 45 : 32;
        if (G.owner[i] === f) s += G.tier[i] * 3; else if (G.owner[i] === 0) s += 1;
        s -= Math.abs(cheb(G, i, T0) - want) * 1.6;
        if (G.terr[i] === T.ROAD) s += 0.6;
        if (contact[i]) s -= u.type === 'rifle' ? 8 : 4;
        s += rng(G) * 0.3;
        if (s > bs) { bs = s; best = i; }
      }
      if (best != null) { moveUnit(G, u, best); touched.push(best); if (G.over) return touched; }
      if (u.type === 'rifle' && G.units.includes(u)) { shootWith(u); if (G.over) return touched; }
    }

    // Drones hover about four cells from the enemy commander. While blind they sweep outward
    // from the last sighting toward ground nobody has looked at lately.
    for (const u of G.units.filter(u => u.side === me && u.type === 'drone')) {
      const opts = unitMoves(G, u);
      if (!opts.length) continue;
      const { contact, shot } = reach(G, f, vis()), T0 = tgt();
      const want = cmdSeen() ? 4 : 2;
      const score = i => -Math.abs(cheb(G, i, T0) - want) * 2 - (contact[i] ? 20 : 0) - (shot[i] ? 3 : 0) + rng(G) * 0.3;
      const best = pickCell(G, opts, score);
      if (best != null && score(best) > score(u.idx)) { moveUnit(G, u, best); touched.push(best); }
    }

    // Commander: never step where the enemy can touch it next turn, avoid gunfire, hover about 3 out.
    {
      const { contact, shot } = reach(G, f, vis());
      const cur = G.cmd[me], T0 = tgt();
      const score = (i, moving) => {
        if (i === G.cmd[f]) return 1e9;
        let s = 0;
        if (moving) {
          const o = occupant(G, i);
          if (o && o.unit && o.side === f) s += o.unit.type === 'arty' ? 40 : 30;
          if (G.owner[i] === f) { s += G.tier[i] * 4; if (i === G.hq[f] && !G.hqTaken[f]) s += 40; }
          else if (G.owner[i] === 0) s += 1.5;
        }
        if (contact[i]) s -= 5000;
        if (shot[i]) s -= G.hp[me] <= 1 ? 800 : 14;
        s += G.tier[i];
        s -= Math.abs(cheb(G, i, T0) - 3) * 2.5;
        return s + rng(G) * 0.5;
      };
      let best = null, bs = score(cur, false);
      for (const i of commanderMoves(G, me)) { const s = score(i, true); if (s > bs) { bs = s; best = i; } }
      if (best != null) { moveCommander(G, me, best); touched.push(best); if (G.over) return touched; }
    }

    // Spend supply toward a mixed force: roughly 35 percent soldiers, 30 riflemen, 20 artillery
    // and up to 2 drones when fighting in fog. Save up when artillery is the piece most needed.
    const MIX = { soldier: 0.32, rifle: 0.28, arty: 0.20, drone: G.fog ? 0.12 : 0, jeep: 0.08 };
    const reserve = gunsIdle && !airBusy && count(G, me, 'soldier') >= 2 ? COST.plane : 0;
    for (let k = 0; k < 4; k++) {
      const n = t => count(G, me, t), total = G.units.filter(u => u.side === me).length + 1;
      let want = null, gap = -Infinity;
      for (const t of ['soldier', 'rifle', 'arty', 'drone', 'jeep']) {
        if (t === 'drone' && (n('drone') >= 2 || !G.fog)) continue;
        if (t === 'jeep' && (n('jeep') >= 1 || n('arty') < 1)) continue;
        const d = MIX[t] - n(t) / total + (t === 'drone' && blind >= 1 && !n('drone') ? 1 : 0);
        if (d > gap) { gap = d; want = t; }
      }
      if (n('soldier') < 2) want = 'soldier';
      else if (n('arty') >= 1 && n('jeep') < 1) want = 'jeep';
      if (G.supply[me] < COST[want]) {
        if (want === 'arty' || want === 'drone' || want === 'jeep') break;
        want = 'soldier';
        if (G.supply[me] < COST.soldier) break;
      }
      if (G.supply[me] - COST[want] < reserve) break;
      const cells = deployCells(G, me, want);
      if (!cells.length) break;
      const { contact } = reach(G, f, vis()), T0 = tgt();
      const guns = G.units.filter(a => a.side === me && a.type === 'arty');
      const at = want === 'jeep'
        ? pickCell(G, cells, i => -Math.min(99, ...guns.map(a => cheb(G, a.idx, i))) + rng(G) * 0.2)
        : want === 'arty'
        ? pickCell(G, cells, i => G.tier[i] * 3 - Math.abs(cheb(G, i, T0) - (1 + G.tier[i])) * 1.5 - (contact[i] ? 20 : 0) + (G.terr[i] === T.ROAD ? 1 : 0))
        : pickCell(G, cells, i => -cheb(G, i, T0) - (contact[i] ? 4 : 0) + rng(G) * 0.2);
      if (at == null || !deploy(G, me, want, at)) break;
      touched.push(at);
    }
    return touched;
  }

  function nextRound(G) {
    if (G.over) return;
    G.round += 1;
    G.air = G.air.filter(a => a.until >= G.round);
    if (G.round > MAX_ROUNDS) {
      G.round = MAX_ROUNDS;
      const a = G.score[1], b = G.score[2];
      finish(G, a > b ? 1 : b > a ? 2 : 0, 'Scores after ' + MAX_ROUNDS + ' rounds');
      return;
    }
    beginTurn(G, 1);
  }
  function playerEnd(G) {
    if (G.over) return [];
    beginTurn(G, 2);
    const touched = aiTurn(G, 2);
    nextRound(G);
    return touched;
  }

  // Two player battles: the server ends a turn without running the computer side.
  function passTurn(G, side) {
    if (G.over || G.turn !== side) return false;
    if (side === 1) beginTurn(G, 2); else nextRound(G);
    return true;
  }
  // Every change a player makes is one small action, so the server can replay a turn with the same rules.
  function apply(G, side, a) {
    if (!a || G.over || G.turn !== side || typeof a.f !== 'string') return false;
    const i = a.i;
    if (!Number.isInteger(i) || i < 0 || i >= G.size * G.size) return false;
    if (a.f === 'cmd') return moveCommander(G, side, i);
    if (a.f === 'deploy') return ['soldier', 'rifle', 'drone', 'jeep', 'arty'].includes(a.k) && deploy(G, side, a.k, i);
    if (a.f === 'air') return (a.k === 'plane' || a.k === 'heli') && callAir(G, side, a.k, i);
    const u = G.units.find(x => x.id === a.u && x.side === side);
    if (!u) return false;
    switch (a.f) {
      case 'move': return moveUnit(G, u, i);
      case 'fire': return fire(G, u, i);
      case 'grenade': return throwGrenade(G, u, i);
      case 'trench': case 'barricade': case 'mound': return build(G, u, a.f, i);
      case 'hitch': return hitch(G, u, i);
      case 'unhitch': return unhitch(G, u, i);
      case 'load': return load(G, u, i);
      case 'cmdout': return cmdOut(G, u, i);
      case 'unload': return unload(G, u, i);
      case 'board': return board(G, u, i);
    }
    return false;
  }
  // Relabel the two sides so whoever is looking at the battle is always side 1 on their own screen.
  const REASON_FLIP = { 'You took out the enemy commander': 'The enemy took out your commander', 'The enemy took out your commander': 'You took out the enemy commander' };
  function swapSides(G) {
    const sw = v => v === 1 ? 2 : v === 2 ? 1 : v;
    const pair = o => o ? { 1: o[2], 2: o[1] } : o;
    for (const k of ['cmd', 'hq', 'intel', 'hqTaken', 'score', 'supply', 'hp', 'cmdMoved', 'riding', 'stats']) G[k] = pair(G[k]);
    for (let i = 0; i < G.owner.length; i++) { G.owner[i] = sw(G.owner[i]); G.known[i] = sw(G.known[i]); }
    const flipUnit = u => { u.side = sw(u.side); if (u.cargo) u.cargo.side = sw(u.cargo.side); for (const r of u.riders || []) r.side = sw(r.side); };
    G.units.forEach(flipUnit);
    for (const a of G.air) a.side = sw(a.side);
    for (const e of G.log) e.s = sw(e.s);
    G.turn = sw(G.turn);
    if (G.over) G.over = { winner: sw(G.over.winner), reason: REASON_FLIP[G.over.reason] || G.over.reason };
    G.ver = (G.ver || 0) + 1;
    return G;
  }

  function computeTiers(elev) {
    const sorted = Float32Array.from(elev).sort();
    const cuts = TIER_CUTS.map(p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
    const spread = sorted[sorted.length - 1] - sorted[0];
    const tier = new Uint8Array(elev.length);
    for (let i = 0; i < elev.length; i++) {
      if (spread < 1) { tier[i] = 1; continue; }
      let t = 5;
      for (let k = 0; k < cuts.length; k++) if (elev[i] <= cuts[k]) { t = k + 1; break; }
      tier[i] = t;
    }
    return tier;
  }

  // Mark cells steeper than about a 40 percent grade, unless something else already claims them.
  function markSteep(terr, elev, size, groundCell) {
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (terr[i] !== T.OPEN) continue;
      const gx = (elev[r * size + Math.min(size - 1, c + 1)] - elev[r * size + Math.max(0, c - 1)]) / (2 * groundCell);
      const gy = (elev[Math.max(0, r - 1) * size + c] - elev[Math.min(size - 1, r + 1) * size + c]) / (2 * groundCell);
      if (Math.hypot(gx, gy) > 0.4) terr[i] = T.STEEP;
    }
    return terr;
  }

  // Smooth fallback terrain when no elevation source answers.
  function noiseTerrain(size, seed) {
    const S = { seed: seed | 0 || 7 };
    const lat = [];
    const g = 9;
    for (let i = 0; i < g * g; i++) lat.push(rng(S));
    const at = (x, y) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const v = (a, b) => lat[((b % g + g) % g) * g + ((a % g + g) % g)];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const top = v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx;
      const bot = v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx;
      return top * (1 - sy) + bot * sy;
    };
    const out = new Float32Array(size * size);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      let e = 0, amp = 1, freq = 3 / size;
      for (let o = 0; o < 4; o++) { e += at(c * freq + o * 1.7, r * freq + o * 3.1) * amp; amp *= 0.5; freq *= 2; }
      out[r * size + c] = e * 400;
    }
    return out;
  }

  function nearestFoot(G, p) {
    if (footOK(G, p)) return p;
    let best = p, bd = Infinity;
    for (let i = 0; i < G.size * G.size; i++) if (footOK(G, i)) { const d = cheb(G, i, p); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  function create(o) {
    const n = o.size, N = n * n;
    const G = {
      v: 4, size: n, cell: o.cell, x0: o.x0, y0: o.y0, elev: o.elev, tier: o.tier,
      terr: o.terr || new Uint8Array(N), mound: new Uint8Array(N), tread: new Uint8Array(N),
      owner: new Uint8Array(N), known: new Uint8Array(N), explored: new Uint8Array(N),
      units: [], air: [], riding: { 1: null, 2: null }, cmd: { 1: 0, 2: 0 }, hq: { 1: 0, 2: 0 }, intel: { 1: null, 2: null },
      hqTaken: { 1: false, 2: false }, score: { 1: 0, 2: 0 }, supply: { 1: 0, 2: 0 },
      hp: { 1: CMD_HP, 2: CMD_HP }, cmdMoved: { 1: false, 2: false }, round: 1, turn: 1, ver: 0, nextId: 1,
      seed: (o.seed >>> 0) || 1, over: null, log: [], source: o.source || '', mapSource: o.mapSource || '',
      diff: o.diff || 'normal', fog: o.fog !== false, far: o.far !== false, place: o.place || '', stats: { 1: {}, 2: {} }
    };
    const m = 2;
    let p = o.playerIdx == null ? (n >> 1) * n + (n >> 1) : o.playerIdx;
    let [pr, pc] = rcOf(G, p);
    pr = Math.min(n - 1 - m, Math.max(m, pr)); pc = Math.min(n - 1 - m, Math.max(m, pc));
    p = nearestFoot(G, pr * n + pc);
    // Close keeps the old short gap for quick fights. Far adds 20 cells, limited to what fits.
    let farthest = 0;
    for (let r = m; r < n - m; r++) for (let c = m; c < n - m; c++) farthest = Math.max(farthest, cheb(G, r * n + c, p));
    const D = Math.min(farthest - 1, Math.max(7, Math.min(16, Math.round(n * 0.12))) + (o.far === false ? 0 : 20));
    let e = -1, bs = -Infinity;
    for (let r = m; r < n - m; r++) for (let c = m; c < n - m; c++) {
      const i = r * n + c, d = cheb(G, i, p);
      if (d < D - 2 || d > D + 2 || !footOK(G, i)) continue;
      const s = G.tier[i] * 2 - Math.abs(d - D) + rng(G);
      if (s > bs) { bs = s; e = i; }
    }
    if (e < 0) e = nearestFoot(G, (n - 1 - m) * n + (n - 1 - m));
    G.cmd[1] = G.hq[1] = p;
    G.cmd[2] = G.hq[2] = e;
    G.intel = { 1: { idx: e, round: 1 }, 2: { idx: p, round: 1 } };
    for (const s of [1, 2]) {
      G.owner[G.hq[s]] = s;
      for (const i of nb8(G, G.hq[s])) if (G.owner[i] === 0) G.owner[i] = s;
    }
    log(G, 0, 'Battle started');
    beginTurn(G, 1);
    return G;
  }

  function clone(G) {
    return {
      ...G, owner: G.owner.slice(), known: G.known.slice(), explored: G.explored.slice(), terr: G.terr.slice(), mound: G.mound.slice(), tread: G.tread.slice(),
      units: G.units.map(u => ({ ...u, cargo: u.cargo ? { ...u.cargo } : null, riders: u.riders ? u.riders.map(r => ({ ...r })) : undefined })), air: G.air.map(a => ({ ...a })),
      cmd: { ...G.cmd }, riding: { ...(G.riding || { 1: null, 2: null }) }, hq: { ...G.hq }, hqTaken: { ...G.hqTaken }, score: { ...G.score },
      intel: { 1: G.intel[1] && { ...G.intel[1] }, 2: G.intel[2] && { ...G.intel[2] } },
      supply: { ...G.supply }, hp: { ...G.hp }, cmdMoved: { ...G.cmdMoved }, log: G.log.slice(),
      stats: { 1: { ...G.stats[1] }, 2: { ...G.stats[2] } }, over: G.over ? { ...G.over } : null
    };
  }
  function serialize(G) {
    return JSON.stringify({
      ...G, elev: Array.from(G.elev, v => Math.round(v * 10) / 10), tier: Array.from(G.tier),
      owner: Array.from(G.owner), terr: Array.from(G.terr), known: Array.from(G.known), explored: Array.from(G.explored), mound: Array.from(G.mound), tread: Array.from(G.tread)
    });
  }
  function deserialize(s) {
    const o = JSON.parse(s);
    if (!o || ![2, 3, 4].includes(o.v)) return null;
    const N = o.size * o.size;
    o.elev = Float32Array.from(o.elev);
    o.tier = Uint8Array.from(o.tier);
    o.owner = Uint8Array.from(o.owner);
    o.terr = o.terr ? Uint8Array.from(o.terr) : new Uint8Array(N);
    o.mound = o.mound ? Uint8Array.from(o.mound) : new Uint8Array(N);
    o.tread = o.tread ? Uint8Array.from(o.tread) : new Uint8Array(N);
    o.known = o.known ? Uint8Array.from(o.known) : Uint8Array.from(o.owner);
    o.explored = o.explored ? Uint8Array.from(o.explored) : new Uint8Array(N).fill(1);
    if (!o.hp) o.hp = { 1: CMD_HP, 2: CMD_HP };
    if (!o.stats) o.stats = { 1: {}, 2: {} };
    if (!o.diff) o.diff = 'normal';
    if (!o.air) o.air = [];
    if (!o.riding) o.riding = { 1: null, 2: null };
    if (!o.intel) o.intel = { 1: { idx: o.cmd[2], round: o.round }, 2: { idx: o.cmd[1], round: o.round } };
    if (o.fog == null) o.fog = o.v === 4;
    if (!o.turn) o.turn = 1;
    o.ver = 0;
    o.v = 4;
    return o;
  }

  return {
    WIN, MAX_ROUNDS, COST, KILL, NAMES, SIGHT, AIR, CMD_HP, ROAD_RUN, DRONE_RANGE, INCOME, INCOME_STEP, territory, baseIncome, nextIncomeAt, T, T_NAMES,
    BUILD, MOUND_MAX, GRENADES, GRENADE_RANGE, JEEP_RANGE, tierAt, heightAt, buildCells, build, roadLike,
    hitchTargets, hitch, unhitchCells, unhitch, grenadesLeft, grenadeTargets, throwGrenade,
    SEATS, ridersOf, seatsUsed, hasDriver, cmdAboard, loadTargets, load, boardTargets, board, unloadCells, unload, cmdOutCells, cmdOut,
    rcOf, nb8, square, cheb, footOK, vehOK, artyRange, rifleRange, unitAt, occupant, count, ready, canShoot, artyReady,
    los, sight, airActive, reach, moveOptions, commanderMoves, moveCommander, unitMoveMap, unitMoves, keepsFire, moveUnit,
    shotTargets, fire, deployCheck, deployCells, deploy, callAir, income, aiTurn, beginTurn, nextRound, playerEnd,
    computeTiers, markSteep, noiseTerrain, create, clone, serialize, deserialize, apply, passTurn, swapSides
  };
})();
module.exports = Engine;
