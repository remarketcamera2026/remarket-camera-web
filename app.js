const FOLDER='1uqlumXNGgQ5TfMLQBWoPluLpFNnNePn9';
const $=id=>document.getElementById(id);
let token='',email='',code='',scanner=null,scanCount=0,last='',busy=false;
const status=s=>$('status').textContent=s;
const valid=s=>/^\d{9}$/.test(s)&&!s.startsWith('9') || /^9\d{9}$/.test(s);
const date=()=>{let d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`};
// OAuth client ID is public configuration, never store a client secret here.
const CLIENT_KEY='remarket_client_id';
try {
  $('clientId').value=localStorage.getItem(CLIENT_KEY)||'';
} catch (e) {
  status('브라우저 저장소를 읽을 수 없습니다. 설정을 입력한 뒤 저장을 시도해 주세요.');
}
$('saveClient').onclick=()=>{
  const id=$('clientId').value.trim();
  if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) {
    status('클라이언트 ID 형식이 올바르지 않습니다. .apps.googleusercontent.com으로 끝나는 ID를 입력하세요.');
    return;
  }
  try {
    localStorage.setItem(CLIENT_KEY,id);
    if(localStorage.getItem(CLIENT_KEY)!==id) throw new Error('저장 후 확인 실패');
    status('설정 저장 완료! 새로고침해도 ID가 유지됩니다. 이제 구글 로그인을 눌러 주세요.');
  } catch(e) {
    status('설정 저장 실패: '+(e?.message||e)+' / 브라우저의 사이트 데이터 저장 허용 여부를 확인하세요. 현재 화면에서는 입력한 ID로 로그인을 시도할 수 있습니다.');
  }
};
$('login').onclick=()=>{const id=$('clientId').value.trim();if(!id)return status('먼저 Google Cloud 웹 OAuth 클라이언트 ID를 입력해 주세요.');if(!window.google?.accounts?.oauth2)return status('구글 로그인 스크립트 로딩 실패. 인터넷 연결 확인.');google.accounts.oauth2.initTokenClient({client_id:id,scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',prompt:'select_account',callback:async r=>{if(r.error)return status('로그인 오류: '+r.error);token=r.access_token;try{let res=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+token}});let u=await res.json();email=u.email||'이메일 확인 불가';$('account').textContent=email;status('구글 연결됨.');await flush()}catch(e){status('계정 확인 실패: '+e.message)}}}).requestAccessToken()};
$('logout').onclick=()=>{if(token&&window.google?.accounts?.oauth2)google.accounts.oauth2.revoke(token,()=>{});token='';email='';$('account').textContent='로그인 전';status('연결 해제됨')};
function onCode(raw){let s=String(raw).trim();if(!valid(s)||code)return;if(s===last)scanCount++;else{last=s;scanCount=1}if(scanCount>=2){code=s;$('number').textContent=s;$('photo').disabled=false;status('번호 확인됨. 상품 사진을 촬영하세요.');stopScan()}}
async function startScan(){if(!window.ZXing?.BrowserMultiFormatReader)return status('바코드 라이브러리를 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.');stopScan();code='';last='';scanCount=0;$('number').textContent='스캔 중';$('photo').disabled=true;status('카메라 연결 중...');try{scanner=new ZXing.BrowserMultiFormatReader();await scanner.decodeFromVideoDevice(undefined,$('video'),(result)=>{if(result)onCode(result.getText())});if(!code)status('카메라가 켜졌습니다. 바코드를 비춰 주세요.')}catch(e){status('카메라 시작 실패: '+e.message+' (Safari 카메라 권한 확인)')}}
function stopScan(){try{scanner?.reset?.()}catch{};for(let t of $('video').srcObject?.getTracks?.()||[])t.stop();$('video').srcObject=null;scanner=null}
$('start').onclick=startScan;$('stop').onclick=stopScan;$('retry').onclick=()=>{code='';$('number').textContent='대기 중';$('photo').value='';$('photo').disabled=true;startScan()};
$('photo').onchange=()=>{const f=$('photo').files[0];if(f){$('preview').src=URL.createObjectURL(f);$('send').disabled=!code}};
const DB='remarket_photo_queue';let dbp=new Promise((resolve,reject)=>{let r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('photos',{keyPath:'id',autoIncrement:true});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function store(mode,value){let db=await dbp;return new Promise((resolve,reject)=>{let tx=db.transaction('photos','readwrite'),s=tx.objectStore('photos'),r=mode==='add'?s.add(value):mode==='all'?s.getAll():s.delete(value);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function updateCount(){let q=await store('all');$('count').textContent=`전송 대기 ${q.length}장`}
$('send').onclick=async()=>{if(!code||!$('photo').files[0]||busy)return;busy=true;try{let name=`${date()}_${code.slice(0,6)}_${code}.jpg`;let file=$('photo').files[0];let jpeg=await toJpeg(file);await store('add',{name,blob:jpeg,account:email||null});status('사진을 기기에 임시 저장했습니다.');$('photo').value='';$('preview').removeAttribute('src');$('send').disabled=true;code='';$('number').textContent='대기 중';await updateCount();await flush()}catch(e){status('저장 실패: '+e.message)}finally{busy=false}};
async function toJpeg(file){let bmp=await createImageBitmap(file);let canvas=document.createElement('canvas');canvas.width=bmp.width;canvas.height=bmp.height;canvas.getContext('2d').drawImage(bmp,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('JPEG 변환 실패')),'image/jpeg',.9))}
async function api(url,options={}){let r=await fetch(url,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});if(!r.ok)throw Error(`Drive ${r.status}: ${(await r.text()).slice(0,220)}`);return r}
async function upload(item){let q=`name = '${item.name.replace(/'/g,"\\'")}' and '${FOLDER}' in parents and trashed = false`;let find=await api('https://www.googleapis.com/drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id,name)&pageSize=1');let existing=(await find.json()).files?.[0];let url='https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';if(existing)url=`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,name`;let boundary='remarket_'+Date.now();let metadata=existing?{name:item.name}:{name:item.name,parents:[FOLDER],mimeType:'image/jpeg'};let body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,item.blob,`\r\n--${boundary}--`]);await api(url,{method:existing?'PATCH':'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})}
async function flush(){if(!token)return status('사진은 기기에 대기 중입니다. 구글 로그인 후 재전송하세요.');let q=await store('all');for(let item of q){if(item.account&&item.account!==email){status(`대기 사진 ${item.name}은 ${item.account} 계정으로 로그인해야 전송할 수 있습니다.`);break}try{await upload(item);await store('delete',item.id);status('드라이브 업로드 완료: '+item.name)}catch(e){status('전송 실패. 사진은 기기에 보관됨. '+e.message);break}}await updateCount()}
$('flush').onclick=flush;updateCount().catch(e=>status('기기 저장소 오류: '+e.message));
