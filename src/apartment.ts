/**
 * The apartment Luna actually lives in.
 *
 * Ported from the standalone `cozy_apartment_3d.html` the user built -- a
 * MiSide-inspired pastel dollhouse: kitchen, living/dining, bedroom, bathroom,
 * open along the front so a camera can look in. The original ran on Three.js
 * r128 loaded from a CDN, with its own renderer, camera, orbit controls and
 * animate loop. All of that host scaffolding is gone here; this module only
 * builds a scene graph and hands back a small control surface, so the sandbox
 * keeps owning the renderer, the camera and the frame loop.
 *
 * Three things about the port are worth knowing before changing anything:
 *
 * 1. SCALE. The original is authored in "dollhouse units" -- 6-unit ceilings,
 *    5-unit doors -- which are roughly 2.4x life size. Luna is a VRM in metres
 *    and every locomotion constant in `sandbox.ts` (walk speed, step length,
 *    turn rate) is tuned in metres, so the apartment gets scaled down to meet
 *    her rather than the other way round. Scaling her up instead would have
 *    meant re-tuning all of that and would likely have upset her VRM spring
 *    bones, which are gravity-tuned for 1.0 scale.
 *
 * 2. SCALE-BLIND PROPERTIES. A few three.js properties are world-space and do
 *    *not* inherit a parent group's scale. Verified against the three source in
 *    node_modules rather than from memory: `LightShadow.updateMatrices` parents
 *    the shadow camera to nothing and only copies the light's world *position*,
 *    so the ortho frustum extents stay in world units; and `WebGLLights` passes
 *    `light.distance` straight through as a uniform while taking position from
 *    `matrixWorld`. Both therefore need scaling by hand -- see `applyScaleFixups`.
 *
 * 3. LIGHT FALLOFF. r128's default (non-physical) falloff for punctual lights
 *    was a bounded `(1 - d/cutoff)^decay`. Modern three has only the physical
 *    `1/d^decay` with a windowing term, which at decay 2 goes to a hot spot near
 *    the bulb and darkness away from it -- the authored intensities would read
 *    completely differently. Setting `decay = 0` restores a bounded 0..1
 *    windowed falloff, which keeps the original intensity numbers meaningful.
 *    This is reasoned, not seen: no GPU in the sandbox this was ported in.
 */

import * as THREE from 'three';

export type ApartmentMode = 'day' | 'noon' | 'evening' | 'night';

export const APARTMENT_MODES: ApartmentMode[] = ['day', 'noon', 'evening', 'night'];

/**
 * Dollhouse units -> metres. Pinned to ceiling height: the original's 6-unit
 * walls become a 2.5 m ceiling, which also puts its 5-unit doors at a sane
 * 2.08 m and its 9-unit room depth at 3.75 m. Ceiling height is the cue that
 * most gives away a wrong scale once there's a person standing under it.
 */
export const APARTMENT_SCALE = 2.5 / 6;

/** Local alias -- this is used on nearly every line of the fixup pass. */
const S = APARTMENT_SCALE;

/**
 * The apartment is authored spanning x -16..21, z 0..9. Recentring on those
 * midpoints puts world origin in the middle of the living/dining room, which
 * keeps every coordinate in this scene small and symmetric around the space
 * Luna actually spends her time in.
 *
 * Note that origin is *not* itself walkable -- the middle of the living room
 * is where the coffee table sits. Anything that needs a safe starting
 * position should use a named point from the room table at the bottom of this
 * file rather than assuming (0, 0) is clear floor; sandbox.ts's spawn does.
 */
const APT_CENTER_X = 2.5;
const APT_CENTER_Z = 4.5;

/** Dollhouse-space point -> world metres. */
export function apartmentToWorld(ax: number, az: number): { x: number; z: number } {
  return { x: (ax - APT_CENTER_X) * S, z: (az - APT_CENTER_Z) * S };
}

/** An axis-aligned walkable patch of floor, in world metres. */
export interface RoomRect {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ApartmentHandle {
  /** Scaled, recentred root. Already added to the scene passed in. */
  root: THREE.Group;
  /** Drive the mode cross-fade and the animated props. Call once per frame. */
  update(dt: number, elapsed: number): void;
  /** Cross-fade to a lighting mode over ~1.3 s. */
  setMode(name: ApartmentMode): void;
  /** Snap to a lighting mode with no transition. */
  initMode(name: ApartmentMode): void;
  currentMode(): ApartmentMode;
  /** Walkable floor patches, world metres. */
  rooms: RoomRect[];
}

interface MatOpts {
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: boolean | number;
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  map?: THREE.Texture | null;
  flatShading?: boolean;
  depthWrite?: boolean;
  color?: number;
}

interface ModeState {
  bg: THREE.Color;
  fogNear: number;
  fogFar: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
  ambI: number;
  ambColor: THREE.Color;
  dirColor: THREE.Color;
  dirI: number;
  dirPos: THREE.Vector3;
  winColor: THREE.Color;
  winI: number;
  lampI: number;
  fairyI: number;
  sparkleI: number;
}

/**
 * Build the apartment and add it to `scene`.
 *
 * `scene.background` and `scene.fog` are driven by the lighting modes, so the
 * host scene should not also be setting those.
 */
export function buildApartment(scene: THREE.Scene): ApartmentHandle {
  /** Everything the builders below produce hangs off this. */
  const root = new THREE.Group();
  root.name = 'apartment';
  root.scale.setScalar(S);
  root.position.set(-APT_CENTER_X * S, 0, -APT_CENTER_Z * S);

  /* =========================================================
     COZY APARTMENT — a MiSide-inspired pastel dollhouse scene
     Built with vanilla Three.js. Single self-contained file.
     ========================================================= */

  /* ---------- room-boundary constants ---------- */
  const Z0 = 0;      // back wall plane
  const ZF = 9;       // open front edge (camera side)
  const H  = 6;        // wall height

  const X_KITCHEN_L = -16, X_KITCHEN_R = -8;
  const X_LIVING_R  = 7;
  const X_BEDROOM_R = 16;
  const X_BATH_R    = 21;
  const X_DINE_R    = -1; // planning split: dining sits kitchen-side, lounge sits bedroom-side

  const CX_KITCHEN = (X_KITCHEN_L + X_KITCHEN_R) / 2;
  const CX_DINE    = (X_KITCHEN_R + X_DINE_R) / 2;
  const CX_LOUNGE  = (X_DINE_R + X_LIVING_R) / 2;
  const CX_BEDROOM = (X_LIVING_R + X_BEDROOM_R) / 2;
  const CX_BATH    = (X_BEDROOM_R + X_BATH_R) / 2;

  /* ---------- palette ---------- */
  const PAL = {
    blush:0xf7c9d0, blushDk:0xe39aa6,
    peach:0xffd9b8, peachDk:0xf0a96e,
    cream:0xfdf3e0, creamDk:0xe9dcc0,
    lavender:0xdccdf2, lavenderDk:0xb79bdb,
    mint:0xc9ecd9, mintDk:0x8fcdae,
    sky:0xcfe8f5, skyDk:0x9cc9e0,
    rose:0xe8a0ab, gold:0xe8c07d,
    wood:0xd9b48f, woodDk:0xa9764e, woodDeep:0x7a5334,
    white:0xfdfaf6, offwhite:0xf3ece0,
    plum:0x554568, plumDeep:0x372c47,
    charcoal:0x4a4358
  };
  const BOOK_COLORS = [PAL.blush,PAL.peach,PAL.mint,PAL.sky,PAL.lavender,PAL.rose,PAL.gold,PAL.blushDk];


  /* ---------- geometry / material helpers ---------- */
  function mat(color: number, opts?: MatOpts): THREE.MeshStandardMaterial {
    const base: THREE.MeshStandardMaterialParameters =
      { color: color, roughness: 0.82, metalness: 0.04 };
    return new THREE.MeshStandardMaterial(Object.assign(base, opts || {}));
  }
  function meshOf(geo: THREE.BufferGeometry, material: THREE.Material, castShadow?: boolean, receiveShadow?: boolean): THREE.Mesh {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = (castShadow===undefined) ? true : castShadow;
    m.receiveShadow = (receiveShadow===undefined) ? true : receiveShadow;
    return m;
  }
  function box(w: number, h: number, d: number, color: number, opts?: MatOpts): THREE.Mesh { return meshOf(new THREE.BoxGeometry(w,h,d), mat(color,opts)); }
  function cyl(rt: number, rb: number, h: number, color: number, seg?: number, opts?: MatOpts): THREE.Mesh { seg=seg||14; return meshOf(new THREE.CylinderGeometry(rt,rb,h,seg), mat(color,opts)); }
  function sph(r: number, color: number, seg?: number, opts?: MatOpts): THREE.Mesh { seg=seg||12; return meshOf(new THREE.SphereGeometry(r,seg,Math.max(6,Math.round(seg*0.7))), mat(color,opts)); }
  function cone(r: number, h: number, color: number, seg?: number, openEnded?: boolean, opts?: MatOpts): THREE.Mesh { seg=seg||14; openEnded=!!openEnded; return meshOf(new THREE.ConeGeometry(r,h,seg,1,openEnded), mat(color,opts)); }
  function torus(r: number, tube: number, color: number, opts?: MatOpts): THREE.Mesh { return meshOf(new THREE.TorusGeometry(r,tube,10,20), mat(color,opts)); }
  function lathe(points: Array<[number, number]>, color: number, seg?: number, opts?: MatOpts): THREE.Mesh {
    seg=seg||20;
    const pts = points.map(function(p){ return new THREE.Vector2(p[0],p[1]); });
    return meshOf(new THREE.LatheGeometry(pts,seg), mat(color,opts));
  }
  function grp(){ return new THREE.Group(); }
  function put<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry?: number): T { o.position.set(x,y,z); o.rotation.y = ry||0; return o; }

  /* ---------- canvas-generated textures ---------- */
  function canvasTex(draw: (ctx: CanvasRenderingContext2D, size: number) => void, size?: number): THREE.CanvasTexture {
    size = size||256;
    const c=document.createElement('canvas'); c.width=size; c.height=size;
    const ctx=c.getContext('2d');
    if (!ctx) throw new Error('apartment: 2d canvas context unavailable');
    draw(ctx,size);
    const tex=new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function makeWoodTex(base: string, grain: string): THREE.CanvasTexture {
    return canvasTex(function(ctx,s){
      ctx.fillStyle=base; ctx.fillRect(0,0,s,s);
      ctx.strokeStyle=grain; ctx.lineWidth=2;
      const rows=6;
      for(let i=0;i<=rows;i++){ const y=i*s/rows; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(s,y); ctx.stroke(); }
      for(let i=0;i<rows;i++){
        const y=i*s/rows;
        const offset=(i%2===0)?0:s/6;
        for(let x=offset;x<s;x+=s/3){ ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y+s/rows); ctx.stroke(); }
      }
      for(let i=0;i<70;i++){
        ctx.strokeStyle='rgba(120,85,55,0.08)';
        const y=Math.random()*s;
        ctx.beginPath(); ctx.moveTo(Math.random()*s,y); ctx.lineTo(Math.random()*s,y+(Math.random()*4-2)); ctx.stroke();
      }
    });
  }
  const texWoodLiving = makeWoodTex('#d9b48f','rgba(130,95,60,0.28)');
  texWoodLiving.repeat.set(8,3);
  const texWoodBedroom = makeWoodTex('#e0c09c','rgba(150,110,75,0.22)');
  texWoodBedroom.repeat.set(5,3);

  function makeDotTex(base: string, dot: string): THREE.CanvasTexture {
    return canvasTex(function(ctx,s){
      ctx.fillStyle=base; ctx.fillRect(0,0,s,s);
      ctx.fillStyle=dot;
      for(let y=s/8; y<s; y+=s/4){ for(let x=s/8; x<s; x+=s/4){ ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill(); } }
    });
  }
  const texWallKitchen = makeDotTex('#eef2e4','rgba(150,185,140,0.4)');
  texWallKitchen.repeat.set(4,1.6);
  const texWallBath = makeDotTex('#eaf5f3','rgba(140,185,190,0.35)');
  texWallBath.repeat.set(2.2,1.6);

  const texWallLiving = canvasTex(function(ctx,s){
    ctx.fillStyle='#f3e7d6'; ctx.fillRect(0,0,s,s);
    ctx.fillStyle='rgba(215,188,150,0.28)';
    for(let x=0;x<s;x+=s/10){ ctx.fillRect(x,0,2,s); }
  });
  texWallLiving.repeat.set(6,1.6);

  const texWallBedroom = canvasTex(function(ctx,s){
    ctx.fillStyle='#f5c9d6'; ctx.fillRect(0,0,s,s);
    ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=2;
    const step=s/4;
    for(let x=-s; x<2*s; x+=step){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x+s,s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x+s,0); ctx.lineTo(x,s); ctx.stroke();
    }
  });
  texWallBedroom.repeat.set(3,1.4);

  const texTileKitchen = canvasTex(function(ctx,s){
    const n=4, cell=s/n;
    for(let i=0;i<n;i++){ for(let j=0;j<n;j++){
      ctx.fillStyle = (i+j)%2===0 ? '#f7efe0' : '#ecd9c2';
      ctx.fillRect(i*cell,j*cell,cell,cell);
    }}
  });
  texTileKitchen.repeat.set(5,2.2);

  const texTileBath = canvasTex(function(ctx,s){
    const n=6, cell=s/n;
    for(let i=0;i<n;i++){ for(let j=0;j<n;j++){
      ctx.fillStyle = (i+j)%2===0 ? '#eef7f5' : '#dcecf0';
      ctx.fillRect(i*cell,j*cell,cell,cell);
    }}
  });
  texTileBath.repeat.set(3,3);

  function makeSparkleTex(){
    const c=document.createElement('canvas'); c.width=64; c.height=64;
    const ctx=c.getContext('2d');
    if (!ctx) throw new Error('apartment: 2d canvas context unavailable');
    const g=ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,'rgba(255,250,235,1)');
    g.addColorStop(0.4,'rgba(255,240,210,0.6)');
    g.addColorStop(1,'rgba(255,240,210,0)');
    ctx.fillStyle=g; ctx.fillRect(0,0,64,64);
    return new THREE.CanvasTexture(c);
  }
  const sparkleTex = makeSparkleTex();

  /* screen canvas helper — shared by PC monitor + TV, built in later stages */
  function drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number, hue: number): void {
    const g=ctx.createLinearGradient(0,0,w,h);
    g.addColorStop(0, 'hsl('+hue+',70%,72%)');
    g.addColorStop(0.5, 'hsl('+((hue+40)%360)+',75%,68%)');
    g.addColorStop(1, 'hsl('+((hue+80)%360)+',70%,60%)');
    ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    ctx.fillStyle='rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(w*0.28,h*0.35,h*0.22,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.arc(w*0.72,h*0.62,h*0.3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.9)';
    ctx.font = Math.floor(h*0.24)+'px sans-serif';
    ctx.fillText('\u2726', w*0.08, h*0.3);
  }
  let pcScreenCanvas: HTMLCanvasElement | undefined;
  let pcScreenCtx: CanvasRenderingContext2D | null = null;
  let pcScreenTex: THREE.CanvasTexture | undefined;
  let tvScreenCanvas: HTMLCanvasElement | undefined;
  let tvScreenCtx: CanvasRenderingContext2D | null = null;
  let tvScreenTex: THREE.CanvasTexture | undefined;

  /* ---------- base lights ---------- */
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0xffe3d2, 0.85);
  root.add(hemiLight);
  const ambLight = new THREE.AmbientLight(0xffffff, 0.3);
  root.add(ambLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(14,24,18);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1536,1536);
  dirLight.shadow.camera.left = -28;
  dirLight.shadow.camera.right = 28;
  dirLight.shadow.camera.top = 20;
  dirLight.shadow.camera.bottom = -6;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 70;
  dirLight.shadow.bias = -0.0015;
  dirLight.shadow.normalBias = 0.02;
  const dirTarget = new THREE.Object3D();
  dirTarget.position.set(2,2,4);
  root.add(dirTarget);
  dirLight.target = dirTarget;
  root.add(dirLight);

  /* ---------- shared registries populated by builders below ---------- */
  const windowMats: THREE.MeshStandardMaterial[] = [];
  const windowLights: THREE.PointLight[] = [];
  const lampLights: THREE.PointLight[] = [];
  const starMeshes: THREE.Mesh[] = [];
  const fanBladeGroups: Array<{ blades: THREE.Group; head: THREE.Group; speed: number }> = [];

  /* ---------- specialized structural / decor helpers ---------- */
  function addWindow(cx: number, w: number, h: number, sillY: number) {
    const frameColor = PAL.white;
    const fr = box(w+0.5, h+0.5, 0.18, frameColor, {roughness:0.65});
    put(fr, cx, sillY+h/2, Z0+0.09);
    fr.castShadow=false;
    root.add(fr);

    const paneMat = mat(0xffffff, {emissive:0xffffff, emissiveIntensity:1, roughness:0.35, metalness:0});
    const pane = meshOf(new THREE.PlaneGeometry(w,h), paneMat, false, false);
    put(pane, cx, sillY+h/2, Z0+0.19);
    root.add(pane);
    windowMats.push(paneMat);

    const vBar = box(0.08, h, 0.05, frameColor); put(vBar, cx, sillY+h/2, Z0+0.21); vBar.castShadow=false; root.add(vBar);
    const hBar = box(w, 0.08, 0.05, frameColor); put(hBar, cx, sillY+h/2, Z0+0.21); hBar.castShadow=false; root.add(hBar);

    const sill = box(w+0.6, 0.15, 0.55, PAL.white);
    put(sill, cx, sillY-0.05, Z0+0.28);
    root.add(sill);

    const rod = cyl(0.05,0.05, w+1.2, PAL.creamDk, 8);
    rod.rotation.z = Math.PI/2;
    put(rod, cx, sillY+h+0.35, Z0+0.34);
    rod.castShadow=false;
    root.add(rod);

    const curtColors=[PAL.blush,PAL.peach,PAL.lavender];
    const curtColor = curtColors[Math.floor(Math.random()*curtColors.length)];
    [-1,1].forEach(function(side){
      const curt = cyl(0.15,0.19, h+0.42, curtColor, 8, {roughness:0.95});
      put(curt, cx+side*(w/2+0.3), sillY+(h+0.42)/2, Z0+0.3);
      root.add(curt);
    });

    const wl = new THREE.PointLight(0xffffff, 0.9, 18, 2);
    wl.userData.base = 0.9;
    wl.position.set(cx, sillY+h*0.55, Z0+3);
    root.add(wl);
    windowLights.push(wl);
  }

  function addLamp(x: number, y: number, z: number, scale: number, shadeColor: number, baseColor: number) {
    scale = scale||1; shadeColor = shadeColor||PAL.peach; baseColor = baseColor||PAL.white;
    const g = grp();
    const poleH = 1.6*scale;
    const base = cyl(0.22*scale,0.26*scale,0.1*scale, baseColor);
    put(base, 0, 0.05*scale, 0); g.add(base);
    const pole = cyl(0.05*scale,0.06*scale, poleH, baseColor);
    put(pole, 0, 0.1*scale+poleH/2, 0); g.add(pole);
    const shadeY = 0.1*scale+poleH+0.28*scale;
    const shade = cone(0.42*scale, 0.56*scale, shadeColor, 14, true, {roughness:0.7, side:THREE.DoubleSide});
    put(shade, 0, shadeY, 0); g.add(shade);
    const bulb = meshOf(new THREE.SphereGeometry(0.16*scale,10,8), new THREE.MeshBasicMaterial({color:0xfff3d0}), false, false);
    put(bulb, 0, shadeY-0.05*scale, 0); g.add(bulb);

    const pl = new THREE.PointLight(0xffcf94, 1.1, 9*scale, 2);
    pl.userData.base = 1.1;
    pl.position.set(0, shadeY-0.05*scale, 0);
    g.add(pl);
    lampLights.push(pl);

    put(g, x, y, z);
    root.add(g);
    return g;
  }

  function addPendant(x: number, y: number, z: number, scale: number, shadeColor: number) {
    scale=scale||1; shadeColor=shadeColor||PAL.peach;
    const g=grp();
    const cordLen = Math.max(0.15, (H+0.08) - y);
    const cord = cyl(0.012,0.012, cordLen, PAL.creamDk, 6);
    put(cord, 0, cordLen/2, 0);
    cord.castShadow=false;
    g.add(cord);
    const shade = cone(0.4*scale, 0.34*scale, shadeColor, 16, true, {roughness:0.65, side:THREE.DoubleSide});
    put(shade, 0, -0.1*scale, 0);
    g.add(shade);
    const bulb = meshOf(new THREE.SphereGeometry(0.13*scale,10,8), new THREE.MeshBasicMaterial({color:0xfff3d0}), false, false);
    put(bulb, 0, -0.24*scale, 0);
    g.add(bulb);
    const pl = new THREE.PointLight(0xffcf94, 1.0, 9*scale, 2);
    pl.userData.base = 1.0;
    pl.position.set(0,-0.24*scale,0);
    g.add(pl);
    lampLights.push(pl);
    put(g,x,y,z);
    root.add(g);
    return g;
  }

  function addStar(x: number, y: number, z: number, scale: number) {
    scale = scale||1;
    const m = meshOf(new THREE.OctahedronGeometry(0.09*scale,0),
      new THREE.MeshStandardMaterial({color:0xfff2c4, emissive:0xffe9a8, emissiveIntensity:0, roughness:0.4}), false, false);
    put(m,x,y,z);
    m.userData.phase = Math.random()*Math.PI*2;
    root.add(m);
    starMeshes.push(m);
    return m;
  }

  function addPlant(x: number, y: number, z: number, scale: number, potColor: number) {
    scale = scale||1; potColor = potColor||0xdd8f66;
    const g=grp();
    const pot = cyl(0.28*scale,0.22*scale,0.34*scale,potColor,10,{roughness:0.85});
    put(pot,0,0.17*scale,0); g.add(pot);
    const leafColors=[0x7fb069,0x8fc27a,0x6a9c5a];
    const n=4+Math.floor(Math.random()*3);
    for(let i=0;i<n;i++){
      const a=(i/n)*Math.PI*2 + Math.random()*0.4;
      const lr=0.16*scale+Math.random()*0.08*scale;
      const leaf = sph(lr, leafColors[i%leafColors.length], 8, {roughness:0.85});
      leaf.scale.set(0.7,1.3,0.7);
      put(leaf, Math.cos(a)*0.14*scale, 0.34*scale+lr*0.9, Math.sin(a)*0.14*scale);
      g.add(leaf);
    }
    const center = sph(0.17*scale, leafColors[0], 8, {roughness:0.85});
    center.scale.set(0.8,1.1,0.8);
    put(center,0,0.34*scale+0.22*scale,0); g.add(center);
    put(g,x,y,z);
    root.add(g);
    return g;
  }


  function addBookshelf(x: number, y: number, z: number, w: number, h: number, shelfCount: number, d: number) {
    d = d||0.32;
    const g=grp();
    const frameColor=PAL.white;
    const sideT=0.06;
    const left = box(sideT,h,d,frameColor); put(left,-w/2+sideT/2,h/2,0); g.add(left);
    const right = box(sideT,h,d,frameColor); put(right,w/2-sideT/2,h/2,0); g.add(right);
    const back = box(w,h,0.04,PAL.creamDk,{roughness:0.9}); put(back,0,h/2,-d/2+0.02); g.add(back);
    const shelfGap = h/shelfCount;
    for(let i=0;i<=shelfCount;i++){
      const shelf = box(w,0.05,d,frameColor);
      put(shelf,0,i*shelfGap,0); g.add(shelf);
      if(i<shelfCount){
        const compY = i*shelfGap+0.05;
        const compH = shelfGap-0.08;
        let bx = -w/2+0.12;
        const maxX = w/2-0.12;
        let guard=0;
        while(bx < maxX-0.05 && guard<60){
          guard++;
          const bw = 0.09+Math.random()*0.1;
          if(bx+bw>maxX) break;
          const bh = Math.min(compH*0.85, 0.28+Math.random()*0.34);
          const color = BOOK_COLORS[Math.floor(Math.random()*BOOK_COLORS.length)];
          const tilt = Math.random()<0.15 ? (Math.random()*0.12-0.06) : 0;
          const bk = box(bw,bh,d*0.82,color,{roughness:0.75});
          bk.position.set(bx+bw/2, compY+bh/2, 0);
          bk.rotation.z = tilt;
          g.add(bk);
          bx += bw+0.02;
        }
      }
    }
    put(g,x,y,z);
    root.add(g);
    return g;
  }

  function addFan(x: number, y: number, z: number, ry: number, scale: number, color: number) {
    ry=ry||0; scale=scale||1; color=color||PAL.white;
    const base = grp();
    const foot = cyl(0.32*scale,0.36*scale,0.08*scale,color);
    put(foot,0,0.04*scale,0); base.add(foot);
    const pole = cyl(0.045*scale,0.05*scale,1.5*scale,color);
    put(pole,0,0.08*scale+0.75*scale,0); base.add(pole);

    const head = grp();
    const hub = cyl(0.1*scale,0.1*scale,0.14*scale,color);
    hub.rotation.x = Math.PI/2;
    put(hub,0,0,0); head.add(hub);

    const blades = grp();
    const bladeColor = PAL.sky;
    const bladeCount=3;
    for(let i=0;i<bladeCount;i++){
      const bl = sph(0.22*scale, bladeColor, 8, {roughness:0.6, side:THREE.DoubleSide});
      bl.scale.set(1,0.42,0.14);
      const a=(i/bladeCount)*Math.PI*2;
      bl.position.set(Math.cos(a)*0.18*scale, Math.sin(a)*0.18*scale, 0.04*scale);
      blades.add(bl);
    }
    head.add(blades);
    const cage = torus(0.32*scale, 0.018*scale, color, {roughness:0.5});
    put(cage,0,0,0.05*scale); head.add(cage);

    put(head, 0, 0.08*scale+1.5*scale, 0.08*scale);
    base.add(head);

    put(base, x, y, z, ry);
    root.add(base);

    fanBladeGroups.push({blades:blades, head:head, speed: 7+Math.random()*2});
    return base;
  }

  function addSideWallWithDoor(xPos: number, zSpan: number, doorZStart: number, doorW: number, doorH: number, color: number) {
    color = color||PAL.white;
    const t=0.22;
    const doorZEnd = doorZStart+doorW;
    if(doorZStart>0.05){
      const seg = box(t, H, doorZStart, color, {roughness:0.85});
      put(seg, xPos, H/2, doorZStart/2);
      seg.castShadow=false;
      root.add(seg);
    }
    if(zSpan-doorZEnd>0.05){
      const seg = box(t, H, zSpan-doorZEnd, color, {roughness:0.85});
      put(seg, xPos, H/2, doorZEnd+(zSpan-doorZEnd)/2);
      seg.castShadow=false;
      root.add(seg);
    }
    const header = box(t, H-doorH, doorW, color, {roughness:0.85});
    put(header, xPos, doorH+(H-doorH)/2, doorZStart+doorW/2);
    header.castShadow=false;
    root.add(header);
  }

  function addDoorLeaf(xPos: number, zStart: number, doorW: number, doorH: number, openAngle: number, color: number) {
    const g = grp();
    const w = doorW-0.08, hgt = doorH-0.06;
    const leaf = box(0.06, hgt, w, color, {roughness:0.6});
    put(leaf, 0, hgt/2, w/2); g.add(leaf);
    const knob = sph(0.045, PAL.gold, 8, {metalness:0.55, roughness:0.3});
    put(knob, 0.05, hgt*0.5, w-0.12); g.add(knob);
    const p1 = box(0.014, hgt*0.36, w*0.6, PAL.white, {roughness:0.6});
    put(p1, 0.024, hgt*0.27, w*0.5); g.add(p1);
    const p2 = box(0.014, hgt*0.36, w*0.6, PAL.white, {roughness:0.6});
    put(p2, 0.024, hgt*0.68, w*0.5); g.add(p2);
    put(g, xPos, 0.03, zStart);
    g.rotation.y = openAngle;
    root.add(g);
    return g;
  }

  function addFloor(x0: number, x1: number, tex: THREE.Texture, thickness?: number) {
    thickness = thickness||0.2;
    const w = x1-x0;
    const f = box(w, thickness, ZF, PAL.white, {map:tex, roughness:0.85});
    f.castShadow=false;
    put(f, (x0+x1)/2, -thickness/2, ZF/2);
    root.add(f);
    return f;
  }

  function addBackWall(x0: number, x1: number, tex: THREE.Texture) {
    const w=x1-x0;
    const wall = box(w,H,0.25,PAL.white,{map:tex,roughness:0.9});
    put(wall,(x0+x1)/2,H/2,-0.02);
    wall.castShadow=false;
    root.add(wall);
    const baseb = box(w,0.32,0.3,PAL.white,{roughness:0.55});
    put(baseb,(x0+x1)/2,0.16,0.02);
    baseb.castShadow=false;
    root.add(baseb);
    return wall;
  }

  /* ---------- room shell: floors, walls, windows, doors, trim ---------- */
  addFloor(X_KITCHEN_L, X_KITCHEN_R, texTileKitchen);
  addFloor(X_KITCHEN_R, X_LIVING_R, texWoodLiving);
  addFloor(X_LIVING_R, X_BEDROOM_R, texWoodBedroom);
  addFloor(X_BEDROOM_R, X_BATH_R, texTileBath);

  addBackWall(X_KITCHEN_L, X_KITCHEN_R, texWallKitchen);
  addBackWall(X_KITCHEN_R, X_LIVING_R, texWallLiving);
  addBackWall(X_LIVING_R, X_BEDROOM_R, texWallBedroom);
  addBackWall(X_BEDROOM_R, X_BATH_R, texWallBath);

  const trim = box(X_BATH_R-X_KITCHEN_L, 0.22, 0.28, PAL.white, {roughness:0.5});
  put(trim, (X_KITCHEN_L+X_BATH_R)/2, H+0.11, -0.02);
  trim.castShadow=false;
  root.add(trim);

  addWindow(CX_KITCHEN, 2.1, 1.7, 3.0);
  addWindow(CX_DINE - 0.4, 1.7, 2.2, 2.6);
  addWindow(CX_LOUNGE + 0.6, 1.7, 2.2, 2.6);
  addWindow(CX_BEDROOM, 2.6, 2.1, 2.9);

  const bathDoorZStart = 5.4, bathDoorW = 1.7, bathDoorH = 4.6;
  addSideWallWithDoor(X_BEDROOM_R, ZF, bathDoorZStart, bathDoorW, bathDoorH, PAL.white);
  addDoorLeaf(X_BEDROOM_R, bathDoorZStart, bathDoorW, bathDoorH, 0.55, PAL.mint);

  const bathOuter = box(0.22, H, ZF, PAL.white, {roughness:0.85});
  put(bathOuter, X_BATH_R, H/2, ZF/2);
  bathOuter.castShadow=false;
  root.add(bathOuter);

  const frontDoorZStart = 2.6, frontDoorW = 1.9, frontDoorH = 5.0;
  addSideWallWithDoor(X_KITCHEN_L, ZF, frontDoorZStart, frontDoorW, frontDoorH, PAL.white);
  addDoorLeaf(X_KITCHEN_L, frontDoorZStart, frontDoorW, frontDoorH, 0.4, PAL.peachDk);

  /* ---------- ambient floating sparkle motes ---------- */
  let sparklePoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  (function buildSparkles(){
    const count=140;
    const positions = new Float32Array(count*3);
    for(let i=0;i<count;i++){
      positions[i*3+0] = X_KITCHEN_L + Math.random()*(X_BATH_R-X_KITCHEN_L);
      positions[i*3+1] = 0.3 + Math.random()*H*1.05;
      positions[i*3+2] = Math.random()*ZF;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
    const spMat = new THREE.PointsMaterial({
      size: 0.22, map: sparkleTex, transparent:true, opacity:0.3,
      depthWrite:false, blending:THREE.AdditiveBlending, sizeAttenuation:true
    });
    sparklePoints = new THREE.Points(geo, spMat);
    root.add(sparklePoints);
  })();

  /* =========================================================
     LIGHTING MODES — day / noon / evening / night
     ========================================================= */
  const MODES = {
    day: {
      bg: new THREE.Color(0xEAF2FF), fogNear:26, fogFar:70,
      hemiSky:new THREE.Color(0xffffff), hemiGround:new THREE.Color(0xffe3d2), hemiI:0.85,
      ambI:0.32, ambColor:new THREE.Color(0xffffff),
      dirColor:new THREE.Color(0xfff3e2), dirI:1.05, dirPos:new THREE.Vector3(14,24,18),
      winColor:new THREE.Color(0xffffff), winI:1.0,
      lampI:0.12, fairyI:0.0, sparkleI:0.15
    },
    noon: {
      bg: new THREE.Color(0xFFF6E4), fogNear:30, fogFar:78,
      hemiSky:new THREE.Color(0xffffff), hemiGround:new THREE.Color(0xffe0bd), hemiI:1.0,
      ambI:0.4, ambColor:new THREE.Color(0xffffff),
      dirColor:new THREE.Color(0xffffff), dirI:1.3, dirPos:new THREE.Vector3(3,28,10),
      winColor:new THREE.Color(0xffffff), winI:1.25,
      lampI:0.08, fairyI:0.0, sparkleI:0.1
    },
    evening: {
      bg: new THREE.Color(0xF4B98F), fogNear:20, fogFar:60,
      hemiSky:new THREE.Color(0xffcf9e), hemiGround:new THREE.Color(0xc97a68), hemiI:0.6,
      ambI:0.28, ambColor:new THREE.Color(0xffb37a),
      dirColor:new THREE.Color(0xff9a5c), dirI:0.85, dirPos:new THREE.Vector3(-18,10,14),
      winColor:new THREE.Color(0xffb37a), winI:0.8,
      lampI:0.65, fairyI:0.4, sparkleI:0.35
    },
    night: {
      bg: new THREE.Color(0x241a3d), fogNear:14, fogFar:48,
      hemiSky:new THREE.Color(0x2f2f5f), hemiGround:new THREE.Color(0x180f2b), hemiI:0.22,
      ambI:0.1, ambColor:new THREE.Color(0x8ea0ff),
      dirColor:new THREE.Color(0x8fa6ff), dirI:0.15, dirPos:new THREE.Vector3(-8,20,-10),
      winColor:new THREE.Color(0x9fc4ff), winI:0.22,
      lampI:1.0, fairyI:1.0, sparkleI:0.8
    }
  };

  function cloneState(s: ModeState): ModeState {
    return {
      bg:s.bg.clone(), fogNear:s.fogNear, fogFar:s.fogFar,
      hemiSky:s.hemiSky.clone(), hemiGround:s.hemiGround.clone(), hemiI:s.hemiI,
      ambI:s.ambI, ambColor:s.ambColor.clone(),
      dirColor:s.dirColor.clone(), dirI:s.dirI, dirPos:s.dirPos.clone(),
      winColor:s.winColor.clone(), winI:s.winI,
      lampI:s.lampI, fairyI:s.fairyI, sparkleI:s.sparkleI
    };
  }
  let liveState = cloneState(MODES.day);
  let fromState = cloneState(MODES.day);
  let toState   = cloneState(MODES.day);
  let transT = 1, transDur = 1.3;
  let currentMode: ApartmentMode = 'day';

  function easeInOutQuad(t: number){ return t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2; }

  function applyLiveState(){
    scene.background = liveState.bg;
    const fog = scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.copy(liveState.bg);
      fog.near = liveState.fogNear * S;
      fog.far = liveState.fogFar * S;
    }
    hemiLight.color.copy(liveState.hemiSky);
    hemiLight.groundColor.copy(liveState.hemiGround);
    hemiLight.intensity = liveState.hemiI;
    ambLight.color.copy(liveState.ambColor);
    ambLight.intensity = liveState.ambI;
    dirLight.color.copy(liveState.dirColor);
    dirLight.intensity = liveState.dirI;
    dirLight.position.copy(liveState.dirPos);
    windowMats.forEach(function(m){
      m.color.copy(liveState.winColor);
      m.emissive.copy(liveState.winColor);
      m.emissiveIntensity = liveState.winI;
    });
    windowLights.forEach(function(l){ l.color.copy(liveState.winColor); l.intensity = l.userData.base * liveState.winI; });
    lampLights.forEach(function(l){ l.intensity = l.userData.base * liveState.lampI; });
  }

  function updateTransition(dt: number){
    if(transT>=1) return;
    transT = Math.min(1, transT + dt/transDur);
    const e = easeInOutQuad(transT);
    liveState.bg.copy(fromState.bg).lerp(toState.bg, e);
    liveState.fogNear = THREE.MathUtils.lerp(fromState.fogNear, toState.fogNear, e);
    liveState.fogFar  = THREE.MathUtils.lerp(fromState.fogFar, toState.fogFar, e);
    liveState.hemiSky.copy(fromState.hemiSky).lerp(toState.hemiSky, e);
    liveState.hemiGround.copy(fromState.hemiGround).lerp(toState.hemiGround, e);
    liveState.hemiI = THREE.MathUtils.lerp(fromState.hemiI, toState.hemiI, e);
    liveState.ambI  = THREE.MathUtils.lerp(fromState.ambI, toState.ambI, e);
    liveState.ambColor.copy(fromState.ambColor).lerp(toState.ambColor, e);
    liveState.dirColor.copy(fromState.dirColor).lerp(toState.dirColor, e);
    liveState.dirI = THREE.MathUtils.lerp(fromState.dirI, toState.dirI, e);
    liveState.dirPos.copy(fromState.dirPos).lerp(toState.dirPos, e);
    liveState.winColor.copy(fromState.winColor).lerp(toState.winColor, e);
    liveState.winI = THREE.MathUtils.lerp(fromState.winI, toState.winI, e);
    liveState.lampI = THREE.MathUtils.lerp(fromState.lampI, toState.lampI, e);
    liveState.fairyI = THREE.MathUtils.lerp(fromState.fairyI, toState.fairyI, e);
    liveState.sparkleI = THREE.MathUtils.lerp(fromState.sparkleI, toState.sparkleI, e);
    applyLiveState();
  }

  function goToMode(name: ApartmentMode){
    if(!MODES[name] || name===currentMode && transT>=1) { /* still allow re-trigger below */ }
    if(!MODES[name]) return;
    currentMode = name;
    fromState = cloneState(liveState);
    toState = cloneState(MODES[name]);
    transT = 0;
  }

  function initMode(name: ApartmentMode){
    currentMode = name;
    liveState = cloneState(MODES[name]);
    fromState = cloneState(MODES[name]);
    toState = cloneState(MODES[name]);
    transT = 1;
    applyLiveState();
  }

  function updateStars(elapsed: number){
    for(let i=0;i<starMeshes.length;i++){
      const s = starMeshes[i];
      const tw = 0.55 + 0.45*Math.sin(elapsed*2.2 + s.userData.phase);
      (s.material as THREE.MeshStandardMaterial).emissiveIntensity = liveState.fairyI * tw;
      s.visible = liveState.fairyI > 0.03;
    }
  }

  let screenTimer = 0;
  function updateScreens(dt: number, elapsed: number){
    screenTimer += dt;
    if(screenTimer < 0.12) return;
    screenTimer = 0;
    if (pcScreenCtx && pcScreenCanvas && pcScreenTex) {
      drawScreen(pcScreenCtx, pcScreenCanvas.width, pcScreenCanvas.height, (elapsed*22)%360);
      pcScreenTex.needsUpdate = true;
    }
    if (tvScreenCtx && tvScreenCanvas && tvScreenTex) {
      drawScreen(tvScreenCtx, tvScreenCanvas.width, tvScreenCanvas.height, (elapsed*14+160)%360);
      tvScreenTex.needsUpdate = true;
    }
  }

  function updateFan(dt: number, elapsed: number){
    fanBladeGroups.forEach(function(fb){
      fb.blades.rotation.z += dt*fb.speed;
      fb.head.rotation.y = Math.sin(elapsed*0.5)*0.5;
    });
  }

  /* =========================================================
     ROOM FURNITURE — filled in below, one room at a time
     ========================================================= */
  function buildKitchen(){
    const counterY=0.95, counterD=0.65;
    const cX0=X_KITCHEN_L+0.8, cX1=X_KITCHEN_R-0.55;

    const counter = box(cX1-cX0, counterY, counterD, PAL.cream, {roughness:0.7});
    put(counter, (cX0+cX1)/2, counterY/2, counterD/2+0.05);
    root.add(counter);

    const doorCount = 5;
    const doorW = (cX1-cX0)/doorCount;
    for(let i=0;i<doorCount;i++){
      const dcolor = (i%2===0)? PAL.mint : PAL.mintDk;
      const d = box(doorW-0.06, counterY-0.14, 0.03, dcolor, {roughness:0.6});
      put(d, cX0+doorW*(i+0.5), counterY/2, counterD+0.06);
      root.add(d);
      const handle = cyl(0.015,0.015,0.14,PAL.gold,6,{metalness:0.5,roughness:0.3});
      handle.rotation.z=Math.PI/2;
      put(handle, cX0+doorW*(i+0.5), counterY*0.42, counterD+0.09);
      root.add(handle);
    }

    const slab = box(cX1-cX0+0.1, 0.06, counterD+0.08, PAL.white, {roughness:0.4});
    put(slab, (cX0+cX1)/2, counterY+0.03, counterD/2+0.03);
    root.add(slab);

    const upperY=4.35, upperH=1.1, upperD=0.32;
    const upper = box(cX1-cX0-1.2, upperH, upperD, PAL.mint, {roughness:0.7});
    put(upper, (cX0+cX1)/2-0.6, upperY, upperD/2+0.03);
    root.add(upper);

    const stoveX = cX0+0.65;
    const stoveBody = box(0.85,counterY,counterD, PAL.charcoal, {roughness:0.45,metalness:0.3});
    put(stoveBody, stoveX, counterY/2, counterD/2+0.05);
    root.add(stoveBody);
    const stoveTop = box(0.85,0.04,counterD, 0x2c2833, {roughness:0.3,metalness:0.4});
    put(stoveTop, stoveX, counterY+0.02, counterD/2+0.05);
    root.add(stoveTop);
    for(let bx=-0.22; bx<=0.22; bx+=0.44){
      for(let bz=-0.14; bz<=0.14; bz+=0.28){
        const burner = torus(0.08,0.012,0x1c1a22,{roughness:0.4});
        burner.rotation.x=Math.PI/2;
        put(burner, stoveX+bx, counterY+0.05, counterD/2+0.05+bz);
        root.add(burner);
      }
    }
    for(let k=0;k<3;k++){
      const knob = cyl(0.03,0.03,0.03,PAL.white,8);
      knob.rotation.x=Math.PI/2;
      put(knob, stoveX-0.25+k*0.25, counterY-0.02, counterD+0.08);
      root.add(knob);
    }

    const sinkX = CX_KITCHEN;
    const sinkBasin = box(0.62,0.14,0.4, 0xd7dee0, {roughness:0.3, metalness:0.2});
    put(sinkBasin, sinkX, counterY-0.02, counterD/2+0.08);
    root.add(sinkBasin);
    const faucetStem = cyl(0.02,0.02,0.32,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    put(faucetStem, sinkX, counterY+0.16, counterD-0.02);
    root.add(faucetStem);
    const faucetSpout = cyl(0.018,0.018,0.16,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    faucetSpout.rotation.x=Math.PI/2.3;
    put(faucetSpout, sinkX, counterY+0.3, counterD-0.1);
    root.add(faucetSpout);

    const fridgeX = X_KITCHEN_L+0.85;
    const fridge = box(0.95,3.0,0.78, PAL.blush, {roughness:0.55});
    put(fridge, fridgeX, 1.5, 0.5);
    root.add(fridge);
    const fridgeLine = box(0.97,0.03,0.02, PAL.blushDk);
    put(fridgeLine, fridgeX, 1.85, 0.9);
    root.add(fridgeLine);
    const fridgeHandle = box(0.03,0.5,0.05, PAL.white,{roughness:0.4});
    put(fridgeHandle, fridgeX+0.42, 2.15, 0.9);
    root.add(fridgeHandle);
    const fridgeHandle2 = box(0.03,0.5,0.05, PAL.white,{roughness:0.4});
    put(fridgeHandle2, fridgeX+0.42, 1.15, 0.9);
    root.add(fridgeHandle2);

    const shelfX = cX1-0.35;
    for(let s=0;s<2;s++){
      const sY = 1.5+s*0.55;
      const shelfBoard = box(0.9,0.05,0.32, PAL.white, {roughness:0.55});
      put(shelfBoard, shelfX, sY, 0.2);
      root.add(shelfBoard);
      for(let p=0;p<4;p++){
        const plate = cyl(0.14,0.14,0.025, BOOK_COLORS[(p+s)%BOOK_COLORS.length],14,{roughness:0.5});
        put(plate, shelfX-0.28, sY+0.04+p*0.03, 0.2);
        root.add(plate);
      }
      for(let m2=0;m2<2;m2++){
        const mug = cyl(0.06,0.06,0.09,PAL.sky,10,{roughness:0.55});
        put(mug, shelfX+0.1+m2*0.22, sY-0.09, 0.15);
        root.add(mug);
        const mHandle = torus(0.035,0.008,PAL.sky,{roughness:0.55});
        mHandle.rotation.y=Math.PI/2;
        put(mHandle, shelfX+0.1+m2*0.22+0.06, sY-0.09, 0.15);
        root.add(mHandle);
      }
    }

    const crock = cyl(0.09,0.11,0.18,PAL.rose,10,{roughness:0.6});
    put(crock, stoveX+0.7, counterY+0.12, counterD/2+0.15);
    root.add(crock);
    for(let u=0;u<4;u++){
      const utensil = cyl(0.012,0.012,0.34,PAL.woodDk,6);
      utensil.rotation.z = (u-1.5)*0.18;
      put(utensil, stoveX+0.7+(u-1.5)*0.03, counterY+0.28, counterD/2+0.15);
      root.add(utensil);
    }

    const pan = cyl(0.16,0.16,0.03,0x8f8a94,16,{metalness:0.5,roughness:0.35});
    pan.rotation.x=Math.PI/2;
    put(pan, cX0+2.4, 2.6, 0.12);
    root.add(pan);
    const panHandle = cyl(0.012,0.012,0.22,0x8f8a94,6,{metalness:0.5,roughness:0.35});
    panHandle.rotation.z=Math.PI/2;
    put(panHandle, cX0+2.4+0.28, 2.6, 0.12);
    root.add(panHandle);

    const pot1 = cyl(0.13,0.13,0.16,PAL.mintDk,14,{roughness:0.5});
    put(pot1, stoveX-0.22, counterY+0.16, counterD/2+0.05-0.14);
    root.add(pot1);
    const potLid = cyl(0.135,0.02,0.02,PAL.mintDk,14,{roughness:0.4});
    put(potLid, stoveX-0.22, counterY+0.16+0.09, counterD/2+0.05-0.14);
    root.add(potLid);
    const lidKnob = sph(0.02, PAL.woodDk, 6);
    put(lidKnob, stoveX-0.22, counterY+0.16+0.1, counterD/2+0.05-0.14);
    root.add(lidKnob);

    const towel = box(0.16,0.22,0.02, PAL.sky, {roughness:0.85});
    put(towel, stoveX, counterY-0.32, counterD+0.12);
    root.add(towel);

    addPlant(CX_KITCHEN-0.7, 3.05, 0.35, 0.6, 0xd98a5c);
    addPlant(cX1-0.15, counterY+0.03, 0.2, 0.55, 0xe0a479);

    addPendant(cX0+2.4, 4.55, 0.55, 0.85, PAL.mint);

    const rug = cyl(0.9,0.9,0.03, PAL.blush, 24, {roughness:0.9});
    put(rug, sinkX, 0.02, 1.6);
    root.add(rug);
    const rugRing = torus(0.85,0.05, PAL.white, {roughness:0.9});
    rugRing.rotation.x=Math.PI/2;
    put(rugRing, sinkX, 0.035, 1.6);
    root.add(rugRing);

    const hookBoard = box(0.05,0.5,0.05, PAL.woodDk, {roughness:0.7});
    hookBoard.rotation.z=Math.PI/2;
    put(hookBoard, X_KITCHEN_L+0.05, 4.0, 1.3);
    root.add(hookBoard);
    const bag = box(0.28,0.34,0.12, PAL.lavender, {roughness:0.75});
    put(bag, X_KITCHEN_L+0.16, 3.65, 1.3);
    root.add(bag);
  }
  function buildLivingDining(){
    addBookshelf(X_KITCHEN_R+0.75, 0, 0.32, 1.0, 3.2, 4, 0.32);
    addPlant(X_KITCHEN_R+0.75, 3.2, 0.32, 0.5, 0xdd8f66);

    const tX=CX_DINE, tZ=4.1;
    const tableTop = box(2.6,0.08,1.5, PAL.wood, {roughness:0.55});
    put(tableTop, tX, 0.92, tZ);
    root.add(tableTop);
    [[-1.15,-0.6],[1.15,-0.6],[-1.15,0.6],[1.15,0.6]].forEach(function(o){
      const leg = cyl(0.05,0.06,0.9,PAL.woodDk,10);
      put(leg, tX+o[0], 0.46, tZ+o[1]);
      root.add(leg);
    });
    const runner = box(2.5,0.015,0.42, PAL.blush, {roughness:0.8});
    put(runner, tX, 0.965, tZ);
    root.add(runner);
    const bowl = lathe([[0,0],[0.28,0.03],[0.34,0.16],[0.3,0.24],[0.22,0.26]], PAL.gold, 16, {roughness:0.5});
    put(bowl, tX, 0.97, tZ);
    root.add(bowl);
    const fruitColors=[0xe0685a,0xf0b13a,0xdba646];
    for(let i=0;i<4;i++){
      const a=(i/4)*Math.PI*2;
      const fr = sph(0.075, fruitColors[i%fruitColors.length], 8, {roughness:0.55});
      put(fr, tX+Math.cos(a)*0.12, 1.1, tZ+Math.sin(a)*0.12);
      root.add(fr);
    }
    [[-0.75,-0.35],[0.75,0.35]].forEach(function(o){
      const plate = cyl(0.12,0.12,0.02, PAL.white, 16, {roughness:0.45});
      put(plate, tX+o[0], 0.965, tZ+o[1]);
      root.add(plate);
      const mug = cyl(0.045,0.045,0.07,PAL.sky,10,{roughness:0.5});
      put(mug, tX+o[0]+0.18, 0.975, tZ+o[1]);
      root.add(mug);
    });

    function diningChair(x: number, z: number, ry: number){
      const g=grp();
      const seat = box(0.44,0.06,0.44, PAL.blushDk, {roughness:0.7});
      put(seat,0,0.46,0); g.add(seat);
      const back = box(0.44,0.5,0.06, PAL.blushDk, {roughness:0.7});
      put(back,0,0.72,-0.19); g.add(back);
      [[-0.18,-0.18],[0.18,-0.18],[-0.18,0.18],[0.18,0.18]].forEach(function(o){
        const leg = cyl(0.025,0.03,0.46,PAL.woodDk,8);
        put(leg,o[0],0.23,o[1]); g.add(leg);
      });
      put(g,x,0,z,ry);
      root.add(g);
    }
    diningChair(tX, tZ-0.95, 0);
    diningChair(tX, tZ+0.95, Math.PI);
    diningChair(tX-1.45, tZ, Math.PI/2);
    diningChair(tX+1.45, tZ, -Math.PI/2);

    addPendant(tX-0.5, 4.7, tZ, 0.75, PAL.peach);
    addPendant(tX+0.5, 4.7, tZ, 0.75, PAL.peach);

    const dineRug = cyl(1.85,1.85,0.03, PAL.cream, 28, {roughness:0.9});
    put(dineRug, tX, 0.015, tZ);
    root.add(dineRug);

    const tvX = CX_LOUNGE-1.6;
    const standW=2.4, standH=0.55, standD=0.42;
    const tvStand = box(standW,standH,standD, PAL.white, {roughness:0.6});
    put(tvStand, tvX, standH/2, standD/2+0.05);
    root.add(tvStand);
    for(let i=0;i<2;i++){
      const handle=cyl(0.014,0.014,0.12,PAL.gold,6,{metalness:0.5,roughness:0.3});
      handle.rotation.z=Math.PI/2;
      put(handle, tvX-0.5+i*1.0, standH*0.5, standD+0.07);
      root.add(handle);
    }
    const tvBody = box(1.7,0.98,0.07, PAL.charcoal, {roughness:0.4});
    put(tvBody, tvX, standH+0.5, standD*0.4);
    root.add(tvBody);

    tvScreenCanvas = document.createElement('canvas'); tvScreenCanvas.width=128; tvScreenCanvas.height=96;
    tvScreenCtx = tvScreenCanvas.getContext('2d');
    tvScreenTex = new THREE.CanvasTexture(tvScreenCanvas);
    tvScreenTex.colorSpace = THREE.SRGBColorSpace;
    const tvScreen = meshOf(new THREE.PlaneGeometry(1.5,0.82), new THREE.MeshBasicMaterial({map:tvScreenTex}), false, false);
    put(tvScreen, tvX, standH+0.5, standD*0.4+0.045);
    root.add(tvScreen);

    const tvFoot = box(0.5,0.05,0.15, PAL.charcoal, {roughness:0.5});
    put(tvFoot, tvX, standH+0.02, standD*0.4);
    root.add(tvFoot);

    const clockFace = cyl(0.28,0.28,0.04, PAL.white, 24, {roughness:0.5});
    clockFace.rotation.x=Math.PI/2;
    put(clockFace, tvX, 5.15, 0.14);
    root.add(clockFace);
    const clockRim = torus(0.28,0.025, PAL.woodDk, {roughness:0.5});
    put(clockRim, tvX, 5.15, 0.14);
    root.add(clockRim);
    const hourHand = box(0.02,0.13,0.01, PAL.charcoal);
    put(hourHand, tvX, 5.15+0.06, 0.17);
    hourHand.rotation.z = -0.6;
    root.add(hourHand);
    const minHand = box(0.015,0.19,0.01, PAL.charcoal);
    put(minHand, tvX, 5.15+0.09, 0.17);
    minHand.rotation.z = 1.1;
    root.add(minHand);

    const sofaX=CX_LOUNGE+0.2, sofaZ=5.9;
    const sofaG = grp();
    const sofaBase = box(2.9,0.42,1.0, PAL.peach, {roughness:0.8});
    put(sofaBase,0,0.32,0); sofaG.add(sofaBase);
    const sofaBack = box(2.9,0.62,0.24, PAL.peach, {roughness:0.8});
    put(sofaBack,0,0.72,-0.42); sofaG.add(sofaBack);
    [-1,1].forEach(function(side){
      const arm = box(0.22,0.5,1.0, PAL.peachDk, {roughness:0.8});
      put(arm, side*1.44, 0.48, 0); sofaG.add(arm);
    });
    for(let c=0;c<3;c++){
      const cushion = box(0.86,0.16,0.86, PAL.blush, {roughness:0.85});
      put(cushion, -0.95+c*0.95, 0.58, 0.02);
      sofaG.add(cushion);
    }
    const throwPillow = box(0.32,0.3,0.12, PAL.lavender, {roughness:0.85});
    put(throwPillow, -1.0, 0.75, 0.15);
    throwPillow.rotation.y=0.3;
    sofaG.add(throwPillow);
    const throwPillow2 = box(0.32,0.3,0.12, PAL.sky, {roughness:0.85});
    put(throwPillow2, 1.05, 0.75, 0.15);
    throwPillow2.rotation.y=-0.35;
    sofaG.add(throwPillow2);
    put(sofaG, sofaX, 0, sofaZ, Math.PI);
    root.add(sofaG);

    const coffeeTable = box(1.3,0.45,0.72, PAL.woodDk, {roughness:0.55});
    put(coffeeTable, sofaX, 0.225, 3.4);
    root.add(coffeeTable);
    const coffeeTop = box(1.36,0.05,0.78, PAL.wood, {roughness:0.45});
    put(coffeeTop, sofaX, 0.47, 3.4);
    root.add(coffeeTop);
    const coffeeBook1 = box(0.32,0.04,0.22, PAL.mint, {roughness:0.7});
    put(coffeeBook1, sofaX-0.2, 0.51, 3.35);
    root.add(coffeeBook1);
    const coffeeBook2 = box(0.28,0.035,0.19, PAL.rose, {roughness:0.7});
    put(coffeeBook2, sofaX-0.2, 0.545, 3.38);
    coffeeBook2.rotation.y=0.15;
    root.add(coffeeBook2);
    const coffeeMug = cyl(0.05,0.05,0.08, PAL.white, 10, {roughness:0.5});
    put(coffeeMug, sofaX+0.35, 0.5, 3.42);
    root.add(coffeeMug);

    addLamp(sofaX+1.9, 0, 5.6, 1.3, PAL.lavender, PAL.white);

    const loungeRug = cyl(2.0,2.0,0.03, PAL.sky, 28, {roughness:0.9});
    put(loungeRug, sofaX-0.3, 0.015, 4.3);
    root.add(loungeRug);
    const loungeRugRing = torus(1.9,0.06, PAL.white, {roughness:0.9});
    loungeRugRing.rotation.x=Math.PI/2;
    put(loungeRugRing, sofaX-0.3, 0.035, 4.3);
    root.add(loungeRugRing);

    function frame(x: number, y: number, z: number, w: number, h: number, color: number){
      const fr = box(w,h,0.04, PAL.white, {roughness:0.55});
      put(fr,x,y,z);
      root.add(fr);
      const canv = box(w-0.12,h-0.12,0.02, color, {roughness:0.8});
      put(canv,x,y,z+0.03);
      root.add(canv);
    }
    frame(CX_DINE+1.6, 3.6, 0.13, 0.55, 0.7, PAL.rose);
    frame(tvX+0.95, 2.2, 0.13, 0.42, 0.52, PAL.mintDk);
  }
  function buildBedroom(){
    const bedX=CX_BEDROOM, bedZ=2.3, bedW=3.0, bedD=4.0;
    const bedFrame = box(bedW,0.5,bedD,PAL.white,{roughness:0.6});
    put(bedFrame,bedX,0.25,bedZ);
    root.add(bedFrame);
    const mattress = box(bedW-0.15,0.32,bedD-0.15,PAL.white,{roughness:0.75});
    put(mattress,bedX,0.5+0.16,bedZ);
    root.add(mattress);
    const headboard = box(bedW+0.1,2.0,0.22,PAL.blush,{roughness:0.7});
    put(headboard,bedX,1.15,bedZ-bedD/2+0.05);
    root.add(headboard);
    [-0.62,0.62].forEach(function(ox){
      const pillow = box(0.82,0.26,0.52,PAL.white,{roughness:0.8});
      put(pillow,bedX+ox,0.5+0.32+0.13,bedZ-bedD/2+0.42);
      root.add(pillow);
    });
    const blanket = box(bedW-0.1,0.1,bedD*0.6,PAL.blush,{roughness:0.85});
    put(blanket,bedX,0.5+0.32+0.05,bedZ+bedD*0.14);
    root.add(blanket);
    const blanketFold = box(bedW-0.1,0.14,0.3,PAL.blushDk,{roughness:0.85});
    put(blanketFold,bedX,0.5+0.32+0.07,bedZ+bedD*0.14-bedD*0.3);
    root.add(blanketFold);
    const bench = box(1.7,0.4,0.55,PAL.lavender,{roughness:0.8});
    put(bench,bedX,0.32,bedZ+bedD/2+0.32);
    root.add(bench);
    [[-0.7,-0.2],[0.7,-0.2],[-0.7,0.2],[0.7,0.2]].forEach(function(o){
      const leg=cyl(0.03,0.03,0.28,PAL.woodDk,8);
      put(leg,bedX+o[0],0.14,bedZ+bedD/2+0.32+o[1]);
      root.add(leg);
    });

    [[bedX-1.85,PAL.mint],[bedX+1.85,PAL.sky]].forEach(function(ns,idx){
      const nsX=ns[0], nsColor=ns[1];
      const nsZ=0.55;
      const body = box(0.55,0.55,0.42,nsColor,{roughness:0.7});
      put(body,nsX,0.275,nsZ);
      root.add(body);
      const drawer = box(0.44,0.16,0.02,PAL.white,{roughness:0.6});
      put(drawer,nsX,0.32,nsZ+0.21);
      root.add(drawer);
      const knob = sph(0.02,PAL.gold,6,{metalness:0.5,roughness:0.3});
      put(knob,nsX,0.32,nsZ+0.225);
      root.add(knob);
      if(idx===0){
        addLamp(nsX,0.55,nsZ,0.7,PAL.peach,PAL.white);
      } else {
        const clockBody = box(0.16,0.1,0.1,PAL.white,{roughness:0.5});
        put(clockBody,nsX,0.6,nsZ);
        root.add(clockBody);
        const clockBell = sph(0.05,PAL.blushDk,8);
        put(clockBell,nsX,0.66,nsZ-0.06);
        root.add(clockBell);
      }
    });

    const deskX=8.2, deskZ=0.5, deskW=1.8, deskD=0.7, deskH=0.75;
    const deskTop = box(deskW,0.06,deskD,PAL.white,{roughness:0.55});
    put(deskTop,deskX,deskH,deskZ);
    root.add(deskTop);
    [[-0.82,-0.3],[0.82,-0.3],[-0.82,0.3],[0.82,0.3]].forEach(function(o){
      const leg=cyl(0.03,0.035,deskH-0.06,PAL.woodDk,8);
      put(leg,deskX+o[0],(deskH-0.06)/2,deskZ+o[1]);
      root.add(leg);
    });
    const monitorStand = box(0.08,0.16,0.12,PAL.charcoal,{roughness:0.5});
    put(monitorStand,deskX,deskH+0.08,deskZ-0.12);
    root.add(monitorStand);
    const monitorBody = box(0.62,0.4,0.03,PAL.charcoal,{roughness:0.45});
    put(monitorBody,deskX,deskH+0.36,deskZ-0.12);
    root.add(monitorBody);

    pcScreenCanvas = document.createElement('canvas'); pcScreenCanvas.width=128; pcScreenCanvas.height=96;
    pcScreenCtx = pcScreenCanvas.getContext('2d');
    pcScreenTex = new THREE.CanvasTexture(pcScreenCanvas);
    pcScreenTex.colorSpace = THREE.SRGBColorSpace;
    const pcScreen = meshOf(new THREE.PlaneGeometry(0.56,0.34), new THREE.MeshBasicMaterial({map:pcScreenTex}), false, false);
    put(pcScreen,deskX,deskH+0.36,deskZ-0.10);
    root.add(pcScreen);

    const keyboard = box(0.4,0.02,0.14,PAL.white,{roughness:0.6});
    put(keyboard,deskX-0.05,deskH+0.04,deskZ+0.15);
    root.add(keyboard);
    const mouse = box(0.06,0.03,0.09,PAL.white,{roughness:0.5});
    put(mouse,deskX+0.28,deskH+0.045,deskZ+0.16);
    root.add(mouse);

    addLamp(deskX-0.72,deskH,deskZ-0.22,0.55,PAL.lavender,PAL.white);

    [PAL.mint,PAL.rose,PAL.sky].forEach(function(c,i){
      const bk=box(0.24-i*0.02,0.045,0.17,c,{roughness:0.75});
      put(bk,deskX+0.68,deskH+0.03+i*0.05,deskZ+0.18);
      root.add(bk);
    });
    const penCup = cyl(0.035,0.04,0.09,PAL.gold,10,{roughness:0.6});
    put(penCup,deskX+0.68,deskH+0.075,deskZ-0.05);
    root.add(penCup);

    const chairSeat = grp();
    const seatPad = box(0.42,0.07,0.42,PAL.lavender,{roughness:0.75});
    put(seatPad,0,0.46,0); chairSeat.add(seatPad);
    const seatBack = box(0.4,0.42,0.06,PAL.lavender,{roughness:0.75});
    put(seatBack,0,0.7,-0.19); chairSeat.add(seatBack);
    const seatPole = cyl(0.035,0.04,0.42,PAL.charcoal,10);
    put(seatPole,0,0.24,0); chairSeat.add(seatPole);
    const seatBase = cyl(0.22,0.22,0.03,PAL.charcoal,12);
    put(seatBase,0,0.03,0); chairSeat.add(seatBase);
    put(chairSeat,deskX,0,deskZ+0.62,Math.PI);
    root.add(chairSeat);

    const wX=14.55, wZ=0.42;
    const wardrobe = box(1.3,2.6,0.62,PAL.white,{roughness:0.65});
    put(wardrobe,wX,1.3,wZ);
    root.add(wardrobe);
    [-0.32,0.32].forEach(function(ox){
      const doorPanel = box(0.58,2.3,0.02,PAL.cream,{roughness:0.6});
      put(doorPanel,wX+ox,1.3,wZ+0.32);
      root.add(doorPanel);
      const dHandle = cyl(0.014,0.014,0.16,PAL.gold,6,{metalness:0.5,roughness:0.3});
      put(dHandle,wX+ox*1.5,1.3,wZ+0.34);
      root.add(dHandle);
    });

    const hookX=wX-0.95;
    const hook = cyl(0.02,0.02,0.08,PAL.woodDk,6);
    hook.rotation.x=Math.PI/2;
    put(hook,hookX,3.0,0.16);
    root.add(hook);
    const hoodieBody = box(0.42,0.5,0.1,PAL.lavender,{roughness:0.8});
    put(hoodieBody,hookX,2.55,0.17);
    root.add(hoodieBody);
    [-1,1].forEach(function(side){
      const sleeve = box(0.14,0.34,0.09,PAL.lavender,{roughness:0.8});
      put(sleeve,hookX+side*0.26,2.66,0.17);
      sleeve.rotation.z = side*0.35;
      root.add(sleeve);
    });
    const hoodieHood = box(0.24,0.16,0.11,PAL.lavenderDk,{roughness:0.8});
    put(hoodieHood,hookX,2.86,0.17);
    root.add(hoodieHood);

    const basket = cyl(0.24,0.2,0.34,PAL.woodDk,12,{roughness:0.8});
    put(basket,hookX,0.17,0.55);
    root.add(basket);
    const clothPoke = box(0.18,0.08,0.14,PAL.sky,{roughness:0.85});
    put(clothPoke,hookX+0.03,0.36,0.55);
    clothPoke.rotation.y=0.3;
    root.add(clothPoke);

    const vanX=X_BEDROOM_R-0.32, vanZ=2.5;
    const vanDesk = box(0.5,0.72,1.3,PAL.white,{roughness:0.6});
    put(vanDesk,vanX,0.36,vanZ);
    root.add(vanDesk);
    const vanMirror = box(0.04,1.1,0.8,0xdfe8ea,{roughness:0.15,metalness:0.85});
    put(vanMirror,vanX-0.18,1.55,vanZ);
    root.add(vanMirror);
    const vanMirrorFrame = box(0.05,1.22,0.92,PAL.white,{roughness:0.5});
    put(vanMirrorFrame,vanX-0.16,1.55,vanZ);
    root.add(vanMirrorFrame);
    const stool = cyl(0.2,0.22,0.42,PAL.blush,12,{roughness:0.8});
    put(stool,vanX-0.75,0.21,vanZ);
    root.add(stool);
    const vanBottle = cyl(0.03,0.035,0.09,PAL.sky,10,{roughness:0.4});
    put(vanBottle,vanX,0.72+0.045,vanZ-0.3);
    root.add(vanBottle);
    addPlant(vanX,0.72,vanZ+0.42,0.4,0xe0a479);

    addFan(9.5,0,1.8,0,0.8,PAL.white);

    for(let i=0;i<20;i++){
      const sx = X_LIVING_R+0.6+Math.random()*(X_BEDROOM_R-X_LIVING_R-1.2);
      const sy = 3.9+Math.random()*1.9;
      addStar(sx, sy, 0.14, 0.9+Math.random()*0.6);
    }

    const bedRug = cyl(2.3,2.3,0.03, PAL.lavender, 28, {roughness:0.9});
    put(bedRug, bedX, 0.015, bedZ+1.6);
    root.add(bedRug);
    const bedRugRing = torus(2.2,0.06, PAL.white, {roughness:0.9});
    bedRugRing.rotation.x=Math.PI/2;
    put(bedRugRing, bedX, 0.035, bedZ+1.6);
    root.add(bedRugRing);

    const frBody = box(0.5,0.64,0.04,PAL.white,{roughness:0.55});
    put(frBody, bedX-1.7, 4.6, 0.13);
    root.add(frBody);
    const frCanvas = box(0.38,0.52,0.02,PAL.rose,{roughness:0.8});
    put(frCanvas, bedX-1.7, 4.6, 0.16);
    root.add(frCanvas);
  }
  function buildBathroom(){
    const sinkX=17.2, sinkZ=0.4;
    const pedestal = cyl(0.16,0.11,0.72,PAL.white,14,{roughness:0.4});
    put(pedestal,sinkX,0.36,sinkZ);
    root.add(pedestal);
    const basin = sph(0.26,PAL.white,14,{roughness:0.35});
    basin.scale.set(1,0.55,0.85);
    put(basin,sinkX,0.74,sinkZ);
    root.add(basin);
    const basinRim = torus(0.24,0.02,PAL.white,{roughness:0.35});
    basinRim.rotation.x=Math.PI/2;
    put(basinRim,sinkX,0.8,sinkZ);
    root.add(basinRim);
    const faucetStem = cyl(0.018,0.018,0.26,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    put(faucetStem,sinkX,0.95,sinkZ-0.12);
    root.add(faucetStem);
    const faucetSpout = cyl(0.015,0.015,0.14,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    faucetSpout.rotation.x=Math.PI/2.4;
    put(faucetSpout,sinkX,1.06,sinkZ-0.06);
    root.add(faucetSpout);

    const mirrorFrame = box(0.6,0.8,0.05,PAL.white,{roughness:0.5});
    put(mirrorFrame,sinkX,2.1,0.13);
    root.add(mirrorFrame);
    const mirrorGlass = box(0.5,0.7,0.02,0xdfe8ea,{roughness:0.15,metalness:0.85});
    put(mirrorGlass,sinkX,2.1,0.16);
    root.add(mirrorGlass);

    const smallShelf = box(0.5,0.04,0.14,PAL.white,{roughness:0.55});
    put(smallShelf,sinkX,1.55,0.16);
    root.add(smallShelf);
    const cupHolder = cyl(0.035,0.035,0.08,PAL.mint,10,{roughness:0.55});
    put(cupHolder,sinkX-0.15,1.61,0.16);
    root.add(cupHolder);
    const soapPump = cyl(0.03,0.035,0.11,PAL.sky,10,{roughness:0.4});
    put(soapPump,sinkX+0.15,1.62,0.16);
    root.add(soapPump);

    const tubX=19.9, tubZ=0.6;
    const tubOuter = box(1.5,0.55,0.75,PAL.mint,{roughness:0.55});
    put(tubOuter,tubX,0.275,tubZ);
    root.add(tubOuter);
    const tubInner = box(1.32,0.32,0.58,PAL.white,{roughness:0.35});
    put(tubInner,tubX,0.42,tubZ);
    root.add(tubInner);
    [[-0.62,-0.28],[0.62,-0.28],[-0.62,0.28],[0.62,0.28]].forEach(function(o){
      const foot = cyl(0.03,0.04,0.1,0xcfd6d8,8,{metalness:0.6,roughness:0.3});
      put(foot,tubX+o[0],0.05,tubZ+o[1]);
      root.add(foot);
    });
    const tubFaucetStem = cyl(0.018,0.018,0.2,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    put(tubFaucetStem,tubX,0.65,tubZ-0.3);
    root.add(tubFaucetStem);
    const tubFaucetSpout = cyl(0.016,0.016,0.14,0xcfd6d8,8,{metalness:0.7,roughness:0.25});
    tubFaucetSpout.rotation.x=Math.PI/2.3;
    put(tubFaucetSpout,tubX,0.74,tubZ-0.24);
    root.add(tubFaucetSpout);

    const towelBar = cyl(0.02,0.02,0.55,PAL.woodDk,8);
    towelBar.rotation.z=Math.PI/2;
    put(towelBar,X_BATH_R-0.1,1.7,1.6);
    root.add(towelBar);
    const towel = box(0.4,0.5,0.03,PAL.blush,{roughness:0.85});
    put(towel,X_BATH_R-0.28,1.4,1.6);
    root.add(towel);

    const towelShelf = box(0.55,0.04,0.28,PAL.white,{roughness:0.55});
    put(towelShelf,X_BATH_R-0.32,1.0,2.5);
    root.add(towelShelf);
    [PAL.mint,PAL.peach].forEach(function(c,i){
      const folded = box(0.5,0.1,0.24,c,{roughness:0.85});
      put(folded,X_BATH_R-0.32,1.05+i*0.12,2.5);
      root.add(folded);
    });

    addPlant(sinkX+0.9,0,1.5,0.55,0xdd8f66);

    const mat1 = cyl(0.55,0.55,0.03,PAL.sky,24,{roughness:0.9});
    put(mat1,(sinkX+tubX)/2,0.015,1.5);
    root.add(mat1);
    const mat1Ring = torus(0.5,0.04,PAL.white,{roughness:0.9});
    mat1Ring.rotation.x=Math.PI/2;
    put(mat1Ring,(sinkX+tubX)/2,0.03,1.5);
    root.add(mat1Ring);

    addPendant(CX_BATH, 4.9, 1.4, 0.6, PAL.sky);
  }

  buildKitchen();
  buildLivingDining();
  buildBedroom();
  buildBathroom();

  // -------------------------------------------------------------------
  // Scale fixups.
  //
  // `root` is uniformly scaled, which correctly shrinks every mesh and
  // every light *position*. It does not touch the handful of three.js
  // properties that are interpreted in world units regardless of parent
  // transform. Those are corrected here, once, after the whole tree
  // exists. Both cases below were checked against the three source in
  // node_modules rather than assumed:
  //
  //   - LightShadow.updateMatrices() copies only the light's world
  //     position onto a shadow camera that is parented to nothing, so
  //     the ortho frustum keeps its authored extents.
  //   - WebGLLights passes light.distance through to the shader as-is
  //     while deriving position from matrixWorld.
  //
  // Point-light decay is also forced to 0 here. See this file's header:
  // the authored intensities assume r128's bounded falloff, and modern
  // three's physical 1/d^2 would turn every lamp into a hot spot.
  // -------------------------------------------------------------------
  function applyScaleFixups(): void {
    const shadowCam = dirLight.shadow.camera;
    shadowCam.left *= S;
    shadowCam.right *= S;
    shadowCam.top *= S;
    shadowCam.bottom *= S;
    shadowCam.near *= S;
    shadowCam.far *= S;
    shadowCam.updateProjectionMatrix();
    // Depth-buffer offsets, so these are world-space too. Left proportional
    // rather than retuned by eye, which isn't possible here.
    dirLight.shadow.bias *= S;
    dirLight.shadow.normalBias *= S;

    root.traverse((obj) => {
      const light = obj as THREE.PointLight;
      if (light.isPointLight) {
        light.distance *= S;
        light.decay = 0;
      }
    });

    // PointsMaterial.size with sizeAttenuation is a world-space diameter.
    sparklePoints.material.size *= S;
  }
  applyScaleFixups();

  // -------------------------------------------------------------------
  // Walkable floor, as a handful of overlapping convex rectangles.
  //
  // This is a deliberately crude stand-in for the per-room navmesh in
  // the roadmap, and it is shaped by one property worth preserving: a
  // straight line between any two points inside a single rectangle stays
  // inside it. So as long as each walk leg stays within one rect, and
  // room-to-room moves are aimed at a point in the *overlap* of two
  // rects, she can never cut a corner through a wall. WanderController
  // relies on exactly that -- see its pickPoint().
  //
  // Kitchen / dining / lounge / bedroom are one open-plan strip with no
  // dividing walls; only the bathroom is walled off, reached through the
  // doorway at x 16, z 5.4-7.1, which is what the `bath-door` rect is.
  //
  // IMPORTANT: the furniture clearances below were derived by reading
  // coordinates out of the builders, not by looking at a render -- there
  // was no GPU in the sandbox this was ported in. Expect to nudge these
  // once it's on screen. They're a flat data table for exactly that
  // reason. Values are in the apartment's own dollhouse units; the
  // conversion to world metres happens right below.
  // -------------------------------------------------------------------
  const ROOM_RECTS_LOCAL: Array<{ name: string; x: [number, number]; z: [number, number] }> = [
    // Front strip running the length of the open-plan rooms. Clear of the
    // dining chairs (to z 5.3) and the sofa front (to z 6.4).
    { name: 'corridor', x: [-14.8, 15.6], z: [7.1, 8.3] },
    // Counters, stove and fridge all sit against the back wall, under z 0.9.
    { name: 'kitchen', x: [-14.8, -8.8], z: [1.5, 8.3] },
    // In front of the dining table (table + chairs occupy z 3.15-5.3).
    { name: 'dining', x: [-8.2, -1.8], z: [5.5, 8.3] },
    // Side passage past the sofa (ends x 4.65) linking the corridor to the
    // floor in front of the TV.
    { name: 'lounge-run', x: [4.9, 6.3], z: [1.2, 8.3] },
    // The open floor between the TV stand (to z 0.6) and the coffee table
    // (from z 3.04).
    { name: 'lounge-tv', x: [-0.8, 6.3], z: [1.2, 2.9] },
    // Foot of the bed: bed ends z 4.3, bench ends 4.9, vanity ends z 3.0.
    { name: 'bedroom', x: [7.6, 15.6], z: [5.3, 8.3] },
    // The bathroom doorway itself, straddling the x=16 wall. Connects to
    // `bedroom` rather than `corridor` -- they overlap, and it keeps her
    // from clipping the door frame on the way through.
    { name: 'bath-door', x: [15.2, 16.9], z: [5.6, 7.1] },
    // Sink and tub are both against the back wall, under z 1.0.
    { name: 'bathroom', x: [16.6, 20.4], z: [2.0, 8.3] },
  ];

  const rooms: RoomRect[] = ROOM_RECTS_LOCAL.map((r) => {
    const a = apartmentToWorld(r.x[0], r.z[0]);
    const b = apartmentToWorld(r.x[1], r.z[1]);
    return {
      name: r.name,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z),
    };
  });

  scene.add(root);
  initMode('day');

  return {
    root,
    rooms,
    currentMode: () => currentMode,
    setMode: goToMode,
    initMode,
    update(dt: number, elapsed: number): void {
      updateTransition(dt);
      updateStars(elapsed);
      updateScreens(dt, elapsed);
      updateFan(dt, elapsed);
      sparklePoints.material.opacity = liveState.sparkleI;
      sparklePoints.rotation.y += dt * 0.008;
    },
  };
}
