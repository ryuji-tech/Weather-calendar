/* =========================================================================
   app.js — アプリのロジック層
   役割:
     ・天気定義(WX)の保持と、WMO天気コード → 天気キーの変換
     ・Open-Meteo API 連携（現在天気の取得 / 都市名の地名検索）
     ・カレンダーの描画とメモ(localStorage)管理
     ・操作ドック(天気プレビュー / ライブ取得)の配線
   データの流れ:
     都市検索 → Geocoding API → 緯度経度を確定 → Forecast API → weather_code
       → codeToWx() で天気キー化 → setWeather() → WeatherBG(背景) ＋ サマリ更新
   背景の実描画は js/weather-bg.js (WeatherBG) が担当。本ファイルは値を渡すだけ。
   ========================================================================= */
(function () {
  // ---------- 天気定義 ----------
  // 各天気キーに、背景シェーダへ渡すパラメータ一式を持たせる。
  //   skyTop/skyBot     : 空グラデの上端 / 下端の色
  //   cloudCol / cloud  : 雲の色 / 雲量(0〜1)
  //   speed             : 雲が流れる速さ
  //   sun/sunPos/sunCol : 太陽グローの 強さ / 位置 / 色
  //   grain             : 画面に乗せる微細ノイズ量（色段差=バンディング防止）
  //   dark              : 全体の暗さ（雨・雷で上げる）
  //   precip/precipAmt  : 降水の種類(rain/snow/none) / 量
  // 白いカレンダー面が常に読めるよう、色は意図的に濃いめ・太陽グローは控えめにしている。
  const WX = {
    clear:  { label:'快晴', skyTop:'#175bac', skyBot:'#5e9bd6', cloudCol:'#dfeaf6', cloud:0.16, speed:0.7, sun:0.30, sunPos:[0.84,0.82], sunCol:'#ffe6b8', grain:0.015, dark:0,    precip:'none' },
    partly: { label:'晴れ時々曇り', skyTop:'#27619f', skyBot:'#7ba7d2', cloudCol:'#e6edf5', cloud:0.48, speed:0.85, sun:0.24, sunPos:[0.8,0.8],  sunCol:'#f6e6c8', grain:0.015, dark:0,    precip:'none' },
    cloudy: { label:'曇り', skyTop:'#6f7986', skyBot:'#9aa4b1', cloudCol:'#cdd4dd', cloud:0.85, speed:0.65, sun:0.08, sunPos:[0.7,0.78],  sunCol:'#e6e9ee', grain:0.02, dark:0.05, precip:'none' },
    fog:    { label:'霧', skyTop:'#8e95a0', skyBot:'#aeb6c0', cloudCol:'#d4d9e0', cloud:0.92, speed:0.32, sun:0.1,  sunPos:[0.6,0.7],   sunCol:'#e4e7ec', grain:0.03, dark:0.04, precip:'none' },
    rain:   { label:'雨', skyTop:'#36424f', skyBot:'#647585', cloudCol:'#94a0ac', cloud:0.9,  speed:1.25, sun:0.04, sunPos:[0.5,0.7],   sunCol:'#c4ccd4', grain:0.03, dark:0.16, precip:'rain', precipAmt:0.8 },
    thunder:{ label:'雷雨', skyTop:'#1a212e', skyBot:'#363e4c', cloudCol:'#5a6373', cloud:0.95, speed:1.5, sun:0.0,  sunPos:[0.5,0.6],   sunCol:'#a6aebb', grain:0.035, dark:0.34, precip:'rain', precipAmt:0.9 },
    snow:   { label:'雪', skyTop:'#52617a', skyBot:'#8496ad', cloudCol:'#b6c2d2', cloud:0.78, speed:0.55, sun:0.1,  sunPos:[0.7,0.8],   sunCol:'#d6def0', grain:0.02, dark:0.06, precip:'snow', precipAmt:0.95 }
  };
  const ICON = { clear:'☀', partly:'⛅', cloudy:'☁', fog:'🌫', rain:'🌧', thunder:'⛈', snow:'❄' };

  // Open-Meteo が返す WMO 天気コード(0〜99)を、7つの表現パターンに集約する。
  // 例: 51〜67/80〜82=雨, 71〜77/85,86=雪, 95以上=雷雨。コードが多いので塊で扱う。
  function codeToWx(c){
    if(c===0) return 'clear';
    if(c===1||c===2) return 'partly';
    if(c===3) return 'cloudy';
    if(c===45||c===48) return 'fog';
    if((c>=51&&c<=57)||(c>=61&&c<=67)||(c>=80&&c<=82)) return 'rain';
    if((c>=71&&c<=77)||c===85||c===86) return 'snow';
    if(c>=95) return 'thunder';
    return 'cloudy';
  }

  // ---------- state ----------
  let curWxKey='clear', live=null, lightTimer=null;
  let place={name:'東京', country:'日本', lat:35.6762, lon:139.6503, tz:'Asia/Tokyo'};
  let viewDate=new Date(); // month being viewed

  // ---------- 背景レイヤー ----------
  // アクセシビリティ配慮: OSの「視差効果を減らす(prefers-reduced-motion)」がONなら
  // three.js を起動せず、静的なCSSグラデ背景に切り替える（動きに弱い人への配慮＋負荷ゼロ）。
  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!REDUCE){
    WeatherBG.init({canvas: document.getElementById('bg')});
  } else {
    document.getElementById('bg').style.display='none';
  }
  function setWeather(key){
    curWxKey=key;
    if(REDUCE){
      const w=WX[key];
      document.body.style.background=`linear-gradient(180deg, ${w.skyTop} 0%, ${w.skyBot} 100%)`;
    } else {
      WeatherBG.apply(WX[key]);
    }
    document.body.dataset.wx=key;
    updateSummary();
    syncChips();
    clearInterval(lightTimer); lightTimer=null;
    if(!REDUCE && key==='thunder'){ lightTimer=setInterval(()=>{ if(Math.random()<0.42) WeatherBG.flash(); }, 6000); }
  }

  // ---------- summary header ----------
  function updateSummary(){
    const w=WX[curWxKey];
    document.getElementById('placeName').textContent=place.name;
    document.getElementById('wxIcon').textContent=ICON[curWxKey];
    document.getElementById('wxLabel').textContent=w.label;
    const t=live && live.key===curWxKey ? live.temp : sampleTemp(curWxKey);
    document.getElementById('temp').innerHTML=Math.round(t)+'<span class="deg">°</span>';
    const extra=document.getElementById('extra');
    if(live && live.key===curWxKey){
      extra.innerHTML = `体感 ${Math.round(live.feels)}° &nbsp;·&nbsp; 湿度 ${live.hum}% &nbsp;·&nbsp; 風 ${live.wind}m/s`;
    } else {
      extra.innerHTML = `<span class="preview">プレビュー表示中</span>`;
    }
    tickClock();
  }
  function sampleTemp(k){ return ({clear:26,partly:22,cloudy:18,fog:14,rain:16,thunder:21,snow:0})[k]; }

  function tickClock(){
    let now=new Date();
    try{ now=new Date(new Date().toLocaleString('en-US',{timeZone:place.tz})); }catch(e){}
    const days=['日','月','火','水','木','金','土'];
    const ds=`${now.getMonth()+1}月${now.getDate()}日(${days[now.getDay()]})`;
    const ts=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
    document.getElementById('clock').innerHTML=`<span class="t">${ts}</span><span class="d">${ds}</span>`;
  }
  setInterval(tickClock, 1000*20);

  // ---------- Open-Meteo: 現在天気の取得 ----------
  // Forecast API。current= で 気温/湿度/体感/天気コード/風速 を一括取得。
  // timezone=auto で観測地点のタイムゾーンに合わせる。風速は km/h→m/s に換算。
  // 失敗時(オフライン等)は live=null にしてプレビュー表示へフォールバックし、画面を壊さない。
  async function fetchWeather(){
    setStatus('取得中…');
    try{
      const u=`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`+
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`+
        `&timezone=auto`;
      const r=await fetch(u); const j=await r.json();
      const c=j.current; const key=codeToWx(c.weather_code);
      place.tz=j.timezone||place.tz;
      live={ key, temp:c.temperature_2m, feels:c.apparent_temperature, hum:c.relative_humidity_2m, wind:Math.round(c.wind_speed_10m/3.6*10)/10 };
      setStatus('');
      setWeather(key);
    }catch(e){
      setStatus('オフライン — プレビューを表示');
      live=null; setWeather(curWxKey);
    }
  }
  function setStatus(s){ document.getElementById('status').textContent=s; }

  // ---------- Open-Meteo: 地名検索 (Geocoding) ----------
  // 入力文字列から都市候補を取得（language=ja で日本語表記、count=6 で上位6件）。
  // 候補クリックで緯度経度を確定し、その地点の天気取得 fetchWeather() へ進む。
  async function searchCity(q){
    const box=document.getElementById('results'); box.innerHTML='';
    if(!q.trim()){ box.classList.remove('show'); return; }
    try{
      const u=`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=ja&format=json`;
      const r=await fetch(u); const j=await r.json();
      if(!j.results||!j.results.length){ box.innerHTML='<div class="nores">該当なし</div>'; box.classList.add('show'); return; }
      j.results.forEach(c=>{
        const d=document.createElement('div'); d.className='res';
        const region=[c.admin1,c.country].filter(Boolean).join(', ');
        d.innerHTML=`<span class="rn">${c.name}</span><span class="rr">${region}</span>`;
        d.onclick=()=>{
          place={name:c.name, country:c.country, lat:c.latitude, lon:c.longitude, tz:c.timezone||place.tz};
          box.classList.remove('show'); document.getElementById('search').value='';
          fetchWeather();
        };
        box.appendChild(d);
      });
      box.classList.add('show');
    }catch(e){ box.innerHTML='<div class="nores">検索できません（オフライン）</div>'; box.classList.add('show'); }
  }

  // ---------- カレンダー ----------
  // メモは localStorage に { 'YYYY-MM-DD': '本文' } 形式で保存（端末内のみ・共有なし）。
  const NOTE_KEY='wxcal_notes_v1';
  let notes={}; try{ notes=JSON.parse(localStorage.getItem(NOTE_KEY)||'{}'); }catch(e){ notes={}; }
  function saveNotes(){ localStorage.setItem(NOTE_KEY, JSON.stringify(notes)); }

  function ymd(y,m,d){ return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

  function renderCalendar(){
    const y=viewDate.getFullYear(), m=viewDate.getMonth();
    document.getElementById('calTitle').textContent=`${y}年 ${m+1}月`;
    const grid=document.getElementById('grid'); grid.innerHTML='';
    const first=new Date(y,m,1).getDay();
    const days=new Date(y,m+1,0).getDate();
    const prevDays=new Date(y,m,0).getDate();
    const today=new Date(); const isThisMonth = today.getFullYear()===y && today.getMonth()===m;
    // 月初の曜日(first)と日数から、前月末→当月→翌月頭 を並べて常に6週(42マス)を作る。
    const cells=[];
    for(let i=0;i<first;i++) cells.push({d:prevDays-first+1+i, out:true, ny:y, nm:m-1});
    for(let d=1;d<=days;d++) cells.push({d, out:false, ny:y, nm:m});
    while(cells.length%7!==0 || cells.length<42){ const last=cells[cells.length-1]; cells.push({d:cells.length-(first+days)+1, out:true, ny:y, nm:m+1}); if(cells.length>=42) break; }

    cells.forEach(c=>{
      const cell=document.createElement('div');
      cell.className='cell'+(c.out?' out':'');
      const realM=((c.nm%12)+12)%12; const realY=c.ny + (c.nm<0?-1:(c.nm>11?1:0));
      const key=ymd(realY, realM, c.d);
      if(!c.out && isThisMonth && c.d===today.getDate()) cell.classList.add('today');
      const num=document.createElement('div'); num.className='num'; num.textContent=c.d;
      // メモはマス内で直接編集(contentEditable)。入力のたびに localStorage へ即保存。
      const note=document.createElement('div'); note.className='note'; note.contentEditable='true';
      note.dataset.key=key; note.textContent=notes[key]||'';
      note.setAttribute('spellcheck','false');
      note.addEventListener('input',()=>{ const v=note.textContent.trim(); if(v) notes[key]=note.textContent; else delete notes[key]; saveNotes(); cell.classList.toggle('has', !!v); });
      note.addEventListener('focus',()=>cell.classList.add('editing'));
      note.addEventListener('blur',()=>cell.classList.remove('editing'));
      if(notes[key]) cell.classList.add('has');
      cell.appendChild(num); cell.appendChild(note);
      grid.appendChild(cell);
    });
  }
  document.getElementById('prevM').onclick=()=>{ viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()-1,1); renderCalendar(); };
  document.getElementById('nextM').onclick=()=>{ viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()+1,1); renderCalendar(); };
  document.getElementById('todayBtn').onclick=()=>{ viewDate=new Date(); renderCalendar(); };

  // ---------- controls ----------
  function syncChips(){
    document.querySelectorAll('.chip[data-wx]').forEach(b=>b.classList.toggle('on', b.dataset.wx===curWxKey));
  }
  document.querySelectorAll('.chip[data-wx]').forEach(b=>{
    b.onclick=()=>{ live=null; setWeather(b.dataset.wx); };
  });
  if(!REDUCE){ WeatherBG.setStyle('A'); } // Atmosphere — fixed visual direction
  document.getElementById('liveBtn').onclick=fetchWeather;
  if(!REDUCE){ WeatherBG.setMouseEnabled(false); } // mouse-follow off — lower cognitive load

  // search wiring
  const search=document.getElementById('search');
  let deb; search.addEventListener('input',()=>{ clearTimeout(deb); deb=setTimeout(()=>searchCity(search.value),280); });
  search.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const f=document.querySelector('.res'); if(f) f.click(); } });
  document.addEventListener('click',e=>{ if(!e.target.closest('.searchwrap')) document.getElementById('results').classList.remove('show'); });

  // dock collapse
  document.getElementById('dockToggle').onclick=()=>document.querySelector('.dock').classList.toggle('min');

  // ---------- boot ----------
  setWeather('clear');
  renderCalendar();
  fetchWeather();
})();
