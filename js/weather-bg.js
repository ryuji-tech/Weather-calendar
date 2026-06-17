/* =========================================================================
   weather-bg.js — 天気背景の描画エンジン (Three.js + GLSL)
   設計:
     ・空   … フルスクリーンの板ポリ1枚にフラグメントシェーダを貼り、GPUで描く
              (縦グラデ + fbmノイズの雲 + 太陽グロー + 暗さ + 雷フラッシュ + 微粒ノイズ)
     ・降水 … THREE.Points で雨/雪の粒子を大量描画（1ドローコールで軽量）
     ・遷移 … 天気を切り替えると、色やパラメータを毎フレーム線形補間(lerp)し滑らかに変化
     ・負荷 … devicePixelRatio を上限2に丸め、高DPI環境での描画ピクセル増を抑える
   app.js から渡される WX パラメータを uniform(uSkyTop 等)に流し込んで見た目を決める。
   公開API: window.WeatherBG = { init, apply, setStyle, setMouseEnabled, flash }
   ========================================================================= */
(function () {
  const THREE = window.THREE;

  // ---- 共有GLSLノイズ ----
  // hash: 疑似乱数 / noise: 補間したバリューノイズ / fbm: noiseを多重に重ねた雲状の模様。
  const NOISE = `
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
      vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
    }
    float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*noise(p); p=p*2.02+vec2(1.7,9.2); a*=0.5; } return v; }
  `;

  // 頂点シェーダ: position をそのままクリップ空間(-1..1)へ渡す＝画面全体を覆う板ポリ。
  // 投影行列を使わないので最軽量。vUv はフラグメント側で画面座標(0..1)として使う。
  const VERT = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  // フラグメントシェーダ共通の宣言部。uniform は loop()/app.js から毎フレーム更新される。
  const HEAD = `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime; uniform vec2 uRes; uniform vec2 uMouse;
    uniform vec3 uSkyTop, uSkyBot, uCloudCol, uSunCol;
    uniform float uCloud, uSpeed, uSun, uGrain, uDark, uFlash;
    uniform vec2 uSunPos;
  ` + NOISE;

  // A — Atmosphere: 流れる雲＋柔らかな太陽グロー（本作で実際に使うスタイル）
  // 手順: ①縦グラデ ②fbmをドメインワープ(歪ませて重ねる)して雲を作りuCloudで混色
  //       ③太陽位置からの距離を exp 減衰させてグロー加算 ④暗さ・雷フラッシュ・微粒ノイズ
  const FRAG_A = HEAD + `
    void main(){
      vec2 uv=vUv; float aspect=uRes.x/uRes.y;
      vec2 p=vec2(uv.x*aspect, uv.y);
      vec3 col=mix(uSkyBot,uSkyTop,pow(clamp(uv.y,0.0,1.0),0.85));
      float t=uTime*0.025*uSpeed;
      vec2 q=p*1.6 + uMouse*0.12;
      float f=fbm(q+vec2(t,t*0.3));
      f=fbm(q+f*1.2+vec2(-t*0.6,t*0.25));
      float clouds=smoothstep(0.35,0.95,f)*uCloud;
      col=mix(col,uCloudCol,clouds*0.85);
      vec2 sp=vec2(uSunPos.x*aspect,uSunPos.y);
      float d=distance(vec2(uv.x*aspect,uv.y),sp);
      col+=uSunCol*exp(-d*3.4)*uSun*0.6;
      col*=(1.0-uDark*0.5); col+=uFlash;
      col+=(hash(uv*uRes+uTime)-0.5)*uGrain;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // B — Volumetric: god rays とビネット付きの濃いめ版（代替スタイル。現在は未使用）
  const FRAG_B = HEAD + `
    void main(){
      vec2 uv=vUv; float aspect=uRes.x/uRes.y;
      vec2 p=vec2(uv.x*aspect, uv.y);
      vec3 col=mix(uSkyBot,uSkyTop,pow(clamp(uv.y,0.0,1.0),1.1));
      float t=uTime*0.03*uSpeed;
      vec2 q=p*2.2 + uMouse*0.18;
      float w=fbm(q+vec2(t,0.0));
      float f=fbm(q+vec2(w*1.8 - t*0.5, w*1.2 + t*0.2));
      float clouds=smoothstep(0.45,0.85,f)*uCloud;
      col=mix(col,uCloudCol,clouds);
      // god rays toward sun
      vec2 sp=vec2(uSunPos.x*aspect,uSunPos.y); vec2 cuv=vec2(uv.x*aspect,uv.y);
      vec2 dir=(sp-cuv); float ray=0.0;
      for(int i=0;i<8;i++){ float s=float(i)/8.0; vec2 sm=cuv+dir*s;
        ray += smoothstep(0.9,0.2,distance(sm,sp)); }
      ray/=8.0;
      col+=uSunCol*ray*uSun*0.9;
      float dd=distance(cuv,sp); col+=uSunCol*exp(-dd*3.2)*uSun;
      float vig=smoothstep(1.25,0.35,distance(uv,vec2(0.5)));
      col*=mix(1.0,vig,0.5);
      col*=(1.0-uDark*0.55); col+=uFlash;
      col+=(hash(uv*uRes+uTime)-0.5)*uGrain;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // C — Minimal: 光のスイープのみの軽量版（代替スタイル）
  const FRAG_C = HEAD + `
    void main(){
      vec2 uv=vUv; float aspect=uRes.x/uRes.y;
      vec2 p=vec2(uv.x*aspect, uv.y);
      vec3 col=mix(uSkyBot,uSkyTop,clamp(uv.y,0.0,1.0));
      float sweep=sin((uv.x+uv.y)*2.2 - uTime*0.18*uSpeed)*0.5+0.5;
      col+=uSunCol*0.05*sweep*uSun;
      vec2 q=p*0.9 + uMouse*0.06 + uTime*0.012;
      float f=noise(q);
      col=mix(col,uCloudCol,smoothstep(0.5,0.82,f)*uCloud*0.5);
      vec2 sp=vec2(uSunPos.x*aspect,uSunPos.y);
      col+=uSunCol*exp(-distance(vec2(uv.x*aspect,uv.y),sp)*2.2)*uSun*0.55;
      col*=(1.0-uDark*0.45); col+=uFlash;
      col+=(hash(uv*uRes+uTime)-0.5)*(uGrain*0.6);
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // ---- 降水パーティクルのシェーダ (クリップ空間) ----
  // 落下は position.y を uTime で進め、mod(...,2.0) で循環させる＝画面外に出たら上へ戻す
  // (粒子を作り直さず使い回すので軽い)。雨は縦長の筋、雪は丸い点として描き分ける。
  const P_VERT = (snow) => `
    attribute float aSpeed; attribute float aSize;
    uniform float uTime;
    void main(){
      float spd = aSpeed * ${snow ? '0.22' : '1.0'};
      // uTime とともに phase を増やす → y=1.0-phase が 1→-1 へ減少＝上から下へ落下。
      // 2.0 で mod して循環（下端に着いたら上端へ戻す）。符号を - にすると上昇して見えるので注意。
      float fall = mod(position.y + uTime*spd, 2.0);
      float y = 1.0 - fall;
      float sway = ${snow ? '0.14' : '0.04'};
      float x = position.x + sway*sin(uTime*${snow ? '0.6' : '0.4'} + position.z*6.2831);
      gl_Position = vec4(x, y, 0.0, 1.0);
      gl_PointSize = aSize;
    }
  `;
  const P_FRAG_RAIN = `
    precision mediump float; uniform float uOpacity;
    void main(){
      vec2 c=gl_PointCoord-0.5;
      float streak=smoothstep(0.5,0.0,abs(c.x)*7.0);
      float taper=smoothstep(0.55,-0.1,c.y);
      float a=streak*taper*0.55*uOpacity;
      gl_FragColor=vec4(0.82,0.88,0.98,a);
    }
  `;
  const P_FRAG_SNOW = `
    precision mediump float; uniform float uOpacity;
    void main(){
      float d=length(gl_PointCoord-0.5);
      float a=smoothstep(0.5,0.08,d)*0.9*uOpacity;
      gl_FragColor=vec4(1.0,1.0,1.0,a);
    }
  `;

  // ---- engine ----
  let renderer, scene, camera, mesh, mats={}, curStyle='A';
  let rain, snow, clock;
  let dpr=1;
  const U = {
    uTime:{value:0}, uRes:{value:new THREE.Vector2(1,1)}, uMouse:{value:new THREE.Vector2(0,0)},
    uSkyTop:{value:new THREE.Color()}, uSkyBot:{value:new THREE.Color()},
    uCloudCol:{value:new THREE.Color()}, uSunCol:{value:new THREE.Color()},
    uCloud:{value:0.3}, uSpeed:{value:1}, uSun:{value:0.8}, uGrain:{value:0.02},
    uDark:{value:0}, uFlash:{value:0}, uSunPos:{value:new THREE.Vector2(0.78,0.82)}
  };
  // 天気遷移用: cur(現在値)を tgt(目標値)へ lerp で滑らかに寄せる。
  // SCAL=スカラー値, COLS=色, VEC=ベクトル(太陽位置) をそれぞれ補間対象にする。
  const cur = {}, tgt = {};
  const SCAL=['uCloud','uSpeed','uSun','uGrain','uDark'];
  const COLS=['uSkyTop','uSkyBot','uCloudCol','uSunCol'];
  const VEC=['uSunPos'];
  let curRainOp=0, tgtRainOp=0, curSnowOp=0, tgtSnowOp=0, curSunX=0.78, tgtSunX=0.78, curSunY=0.82, tgtSunY=0.82;
  let flashVal=0, mouseEnabled=true, mouseTarget=new THREE.Vector2(0,0);

  // n個の粒子をランダム配置で生成。aSpeed(落下速度)・aSize(粒の大きさ)を属性で持たせ、
  // 雨は細く速く・雪は大きく遅く。THREE.Points で一括描画する。
  function makeParticles(n, snowMode){
    const g=new THREE.BufferGeometry();
    const pos=new Float32Array(n*3), spd=new Float32Array(n), sz=new Float32Array(n);
    for(let i=0;i<n;i++){
      pos[i*3]= (Math.random()*2-1); pos[i*3+1]=(Math.random()*2); pos[i*3+2]=Math.random();
      spd[i]= snowMode? (0.6+Math.random()*0.8) : (1.6+Math.random()*1.6);
      sz[i]= snowMode? (2.5+Math.random()*5.0)*dpr : (7.0+Math.random()*9.0)*dpr;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(spd,1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz,1));
    const m=new THREE.ShaderMaterial({
      uniforms:{ uTime:U.uTime, uOpacity:{value:0} },
      vertexShader:P_VERT(snowMode),
      fragmentShader: snowMode? P_FRAG_SNOW : P_FRAG_RAIN,
      transparent:true, depthTest:false, depthWrite:false
    });
    const pts=new THREE.Points(g,m); pts.frustumCulled=false; pts.renderOrder=2; return pts;
  }

  const API = {
    init({canvas}){
      // 負荷対策: 高DPIでも描画解像度の倍率を最大2に制限（描くピクセル数は倍率の二乗で増えるため）
      dpr=Math.min(window.devicePixelRatio||1, 2);
      renderer=new THREE.WebGLRenderer({canvas, antialias:false, alpha:false});
      renderer.setPixelRatio(dpr);
      scene=new THREE.Scene(); camera=new THREE.Camera();
      const geo=new THREE.PlaneBufferGeometry(2,2);
      mats.A=new THREE.ShaderMaterial({uniforms:U, vertexShader:VERT, fragmentShader:FRAG_A});
      mats.C=new THREE.ShaderMaterial({uniforms:U, vertexShader:VERT, fragmentShader:FRAG_C});
      mesh=new THREE.Mesh(geo, mats[curStyle]); mesh.frustumCulled=false; mesh.renderOrder=0;
      scene.add(mesh);
      rain=makeParticles(1300,false); snow=makeParticles(700,true);
      scene.add(rain); scene.add(snow);
      clock=new THREE.Clock();
      window.addEventListener('mousemove',(e)=>{
        mouseTarget.set((e.clientX/window.innerWidth-0.5)*2,(0.5-e.clientY/window.innerHeight)*2);
      });
      resize(); window.addEventListener('resize',resize);
      loop();
    },
    // app.js から天気パラメータを受け取り、目標値(tgt)へセット。実際の反映は loop() が補間で行う。
    // 初回だけは即スナップショットして、最初のフレームから正しい絵を出す。
    apply(p){
      tgt.uCloud=p.cloud; tgt.uSpeed=p.speed; tgt.uSun=p.sun; tgt.uGrain=p.grain; tgt.uDark=p.dark||0;
      tgt.uSkyTop=p.skyTop; tgt.uSkyBot=p.skyBot; tgt.uCloudCol=p.cloudCol; tgt.uSunCol=p.sunCol;
      tgtSunX=p.sunPos[0]; tgtSunY=p.sunPos[1];
      tgtRainOp = p.precip==='rain'? (p.precipAmt||0.8):0;
      tgtSnowOp = p.precip==='snow'? (p.precipAmt||0.8):0;
      if(!inited){ // snapshot immediately so the very first frame is correct (independent of RAF)
        inited=true;
        SCAL.forEach(s=>U[s].value=tgt[s]);
        COLS.forEach(c=>U[c].value.set(tgt[c]));
        curSunX=tgtSunX; curSunY=tgtSunY; U.uSunPos.value.set(curSunX,curSunY);
        curRainOp=tgtRainOp; curSnowOp=tgtSnowOp;
        rain.material.uniforms.uOpacity.value=curRainOp;
        snow.material.uniforms.uOpacity.value=curSnowOp;
        if(renderer) renderer.render(scene,camera);
      }
    },
    setStyle(s){ if(mats[s]){ curStyle=s; mesh.material=mats[s]; } },
    setMouseEnabled(b){ mouseEnabled=b; if(!b) mouseTarget.set(0,0); },
    flash(){ flashVal=0.32; }
  };

  function resize(){
    const w=window.innerWidth,h=window.innerHeight;
    renderer.setSize(w,h,false);
    U.uRes.value.set(w*dpr,h*dpr);
  }
  function hexToRGB(h){ const c=new THREE.Color(h); return c; }

  function lerp(a,b,t){ return a+(b-a)*t; }

  let inited=false;
  // 毎フレーム: 時間を進め、各uniformを目標値へ lerp で近づけ、雨/雪の不透明度も補間してから描画。
  // k は経過時間 dt に応じた補間係数（フレームレートに依存せず一定の滑らかさになる）。
  function loop(){
    requestAnimationFrame(loop);
    const dt=Math.min(clock.getDelta(),0.05);
    U.uTime.value+=dt;
    const k=1-Math.pow(0.001, dt); // smoothing
    if(inited){
      SCAL.forEach(s=>{ U[s].value=lerp(U[s].value, tgt[s], k); });
      COLS.forEach(c=>{ const col=U[c].value, t=new THREE.Color(tgt[c]);
        col.r=lerp(col.r,t.r,k); col.g=lerp(col.g,t.g,k); col.b=lerp(col.b,t.b,k); });
      curSunX=lerp(curSunX,tgtSunX,k); curSunY=lerp(curSunY,tgtSunY,k);
      U.uSunPos.value.set(curSunX,curSunY);
      curRainOp=lerp(curRainOp,tgtRainOp,k); curSnowOp=lerp(curSnowOp,tgtSnowOp,k);
      rain.material.uniforms.uOpacity.value=curRainOp;
      snow.material.uniforms.uOpacity.value=curSnowOp;
    }
    // mouse smoothing
    const me = mouseEnabled? mouseTarget : new THREE.Vector2(0,0);
    U.uMouse.value.x=lerp(U.uMouse.value.x, me.x, k*0.6);
    U.uMouse.value.y=lerp(U.uMouse.value.y, me.y, k*0.6);
    // flash decay
    flashVal*=Math.pow(0.02, dt); U.uFlash.value=flashVal;
    renderer.render(scene,camera);
  }

  API._dbg = () => ({ renderer, scene, camera, U, inited, mats, curStyle });
  window.WeatherBG = API;
})();
