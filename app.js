'use strict';
const FOLDER='1uqlumXNGgQ5TfMLQBWoPluLpFNnNePn9', DB='remarket_photo_queue';
const $=id=>document.getElementById(id), setStatus=(s,err=false)=>{$('status').textContent=s;$('status').classList.toggle('error',err)};
const valid=s=>(/^\d{9}$/.test(s)&&!s.startsWith('9'))||/^9\d{9}$/.test(s);
const date=()=>{const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`};
let token='',email='',code='',mode='idle',stream=null,controls=null,reader=null,detector=null,scanTimer=null,last='',hits=0,capturing=false,uploading=false,completed=0;
let dbp=new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('photos'))r.result.createObjectStore('photos',{keyPath:'id',autoIncrement:true})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function store(op,value){const db=await dbp;return new Promise((resolve,reject)=>{const tx=db.transaction('photos','readwrite'),s=tx.objectStore('photos'),r=op==='add'?s.add(value):op==='all'?s.getAll():s.delete(value);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function count(){try{const q=await store('all');$('count').textContent=`완료 ${completed}장 / 대기 ${q.length}장`}catch(e){setStatus('사진 보관함 오류: '+e.message,true)}}
function ui(){const photo=mode==='photo';$('scanOverlay').classList.toggle('hidden',photo);$('photoOverlay').classList.toggle('hidden',!photo);$('shoot').disabled=capturing}
function stopReader(){if(scanTimer){clearTimeout(scanTimer);scanTimer=null}try{controls?.stop()}catch{}controls=null;reader=null;detector=null}
function stopCamera(){stopReader();for(const t of stream?.getTracks()||[])t.stop();stream=null;for(const t of $('video').srcObject?.getTracks?.()||[])t.stop();$('video').srcObject=null}
function gotCode(raw){if(mode!=='scan')return;const s=String(raw||'').trim();if(!valid(s))return;if(last===s)hits++;else{last=s;hits=1}if(hits<2)return;code=s;mode='photo';stopReader();$('number').textContent=s;ui();setStatus('번호 확인됨. 상품 사진을 촬영하세요.');}
async function loadZXing(){if(window.ZXingBrowser?.BrowserMultiFormatReader)return true;for(const url of ['https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js','https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js']){try{await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=resolve;script.onerror=reject;document.head.appendChild(script)});if(window.ZXingBrowser?.BrowserMultiFormatReader)return true}catch{}}return false}
async function beginScan(){
  stopReader();code='';last='';hits=0;mode='scan';
  $('number').textContent='바코드를 보여 주세요';ui();
  if(!stream){try{await openCamera()}catch(e){setStatus('카메라 실행 실패: '+e.message,true);return}}
  setStatus('바코드를 가로 안내선에 맞춰 주세요.');
  // iPhone Safari can expose BarcodeDetector yet return no usable results.
  // Run ZXing as a second decoder instead of trusting that API exclusively.
  if('BarcodeDetector' in window){
    try{
      detector=new BarcodeDetector({formats:['code_128','code_39','ean_13','ean_8','upc_a','upc_e']});
      const nativeDetector=detector;
      const poll=async()=>{
        if(mode!=='scan'||detector!==nativeDetector)return;
        try{if($('video').readyState>=2){
          const results=await nativeDetector.detect($('video'));
          for(const x of results)gotCode(x.rawValue);
        }}catch{}
        if(mode==='scan'&&detector===nativeDetector)scanTimer=setTimeout(poll,180);
      };poll();
    }catch{detector=null}
  }
  const available=await loadZXing();
  if(mode!=='scan')return;
  if(!available){
    if(!detector)setStatus('바코드 인식기 로딩 실패. 인터넷 연결을 확인해 주세요.',true);
    else setStatus('바코드를 비춰 주세요. 보조 인식기를 불러오지 못했습니다.',true);
    return;
  }
  try{
    reader=new ZXingBrowser.BrowserMultiFormatReader();
    controls=await reader.decodeFromVideoElement($('video'),result=>{if(result)gotCode(result.getText())});
  }catch(e){if(!detector)setStatus('바코드 인식 시작 실패: '+e.message,true)}
}
async function openCamera(){if(!navigator.mediaDevices?.getUserMedia)throw Error('Safari 카메라를 사용할 수 없습니다.');stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:1706}}});$('video').srcObject=stream;await $('video').play()}
function jpegFromCamera(){const v=$('video');if(!v.videoWidth||!v.videoHeight)throw Error('카메라 화면이 준비되지 않았습니다.');const c=$('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0,c.width,c.height);return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('사진 생성 실패')),'image/jpeg',0.9))}
$('shoot').onclick=async()=>{if(mode!=='photo'||capturing||!code)return;capturing=true;ui();try{const blob=await jpegFromCamera(),name=`${date()}_${code.slice(0,6)}_${code}.jpg`;await store('add',{name,blob,account:email||null});await count();setStatus('사진 저장됨. 자동 전송 중. 같은 상품을 계속 촬영할 수 있습니다.');void flush()}catch(e){setStatus('사진 저장 실패: '+e.message,true)}finally{capturing=false;ui()}};
$('next').onclick=()=>{void beginScan()};$('rescan').onclick=()=>{void beginScan()};
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{Authorization:'Bearer '+token,...opts.headers}});if(!r.ok)throw Error(`Drive ${r.status}: ${(await r.text()).slice(0,180)}`);return r}
async function upload(item){const escaped=item.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");const query=`name = '${escaped}' and '${FOLDER}' in parents and trashed = false`;const list=await api('https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({q:query,fields:'nextPageToken,files(id,name)',pageSize:'100',supportsAllDrives:'true',includeItemsFromAllDrives:'true'}));const existing=(await list.json()).files?.[0];const meta=existing?{name:item.name}:{name:item.name,parents:[FOLDER],mimeType:'image/jpeg'};const base='https://www.googleapis.com/upload/drive/v3/files';const url=(existing?`${base}/${existing.id}`:base)+'?uploadType=multipart&supportsAllDrives=true&fields=id,name';const boundary='remarket'+Date.now();const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,item.blob,`\r\n--${boundary}--`]);await api(url,{method:existing?'PATCH':'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})}
async function flush(){if(uploading)return;if(!token){setStatus('사진은 기기에 보관 중입니다. 구글 로그인 후 전송하세요.');return}uploading=true;try{const q=await store('all');for(const item of q){if(item.account&&item.account!==email){setStatus('대기 사진은 '+item.account+' 계정으로 로그인해야 전송할 수 있습니다.',true);break}try{await upload(item);await store('delete',item.id);completed++;await count();setStatus('드라이브 업로드 완료: '+item.name)}catch(e){setStatus('전송 실패, 사진은 기기에 보관됨: '+e.message,true);break}}}finally{uploading=false;await count()}}
$('retry').onclick=()=>void flush();$('settingsButton').onclick=()=>{$('settings').style.display=$('settings').style.display==='block'?'none':'block'};
try{$('clientId').value=localStorage.getItem('remarket_client_id')||''}catch{}
$('saveClient').onclick=()=>{try{localStorage.setItem('remarket_client_id',$('clientId').value.trim());setStatus('설정 저장됨')}catch(e){setStatus('설정 저장 실패: '+e.message,true)}};
$('login').onclick=()=>{const id=$('clientId').value.trim();if(!id){$('settings').style.display='block';setStatus('먼저 구글 클라이언트 ID를 입력해 주세요.',true);return}if(!window.google?.accounts?.oauth2){setStatus('구글 로그인 라이브러리 로딩 실패',true);return}google.accounts.oauth2.initTokenClient({client_id:id,scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',prompt:'select_account',callback:async r=>{if(r.error){setStatus('로그인 실패: '+r.error,true);return}token=r.access_token;try{const u=await(await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+token}})).json();email=u.email||'';$('account').textContent=email||'로그인됨';$('login').textContent='구글 로그인됨';setStatus('구글 연결됨');void flush()}catch(e){setStatus('계정 확인 실패: '+e.message,true)}}}).requestAccessToken()};
$('logout').onclick=()=>{if(token&&window.google?.accounts?.oauth2)google.accounts.oauth2.revoke(token,()=>{});token='';email='';$('account').textContent='로그인 전';$('login').textContent='구글 로그인';setStatus('연결 해제됨')};
window.addEventListener('pagehide',stopCamera);window.addEventListener('pageshow',()=>{if(!stream)void beginScan()});void count();void beginScan();
