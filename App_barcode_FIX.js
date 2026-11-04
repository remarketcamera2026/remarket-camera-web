import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';

const FOLDER_ID = '1uqlumXNGgQ5TfMLQBWoPluLpFNnNePn9';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const QUEUE_PATH = `${FileSystem.documentDirectory}remarket_pending.json`;
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export function localDateStamp(now = new Date()) {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

// 구글 로그인 모듈은 버튼을 누를 때만 불러옵니다.
function googleAuth() {
  const auth = require('@react-native-google-signin/google-signin');
  auth.GoogleSignin.configure({ scopes: [SCOPE] });
  return auth;
}

async function readQueue() {
  try { return JSON.parse(await FileSystem.readAsStringAsync(QUEUE_PATH)); }
  catch { return []; }
}
async function writeQueue(queue) {
  await FileSystem.writeAsStringAsync(QUEUE_PATH, JSON.stringify(queue));
}
async function accessToken() {
  const { GoogleSignin } = googleAuth();
  const user = await GoogleSignin.getCurrentUser();
  if (!user) throw new Error('먼저 구글 계정으로 로그인해 주세요.');
  try { return (await GoogleSignin.getTokens()).accessToken; }
  catch {
    await GoogleSignin.signInSilently();
    return (await GoogleSignin.getTokens()).accessToken;
  }
}
async function driveRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { message: raw }; }
  if (!response.ok) throw new Error(`Drive 오류 ${response.status}: ${data?.error?.message || data?.message || '알 수 없는 오류'}`);
  return data;
}
async function findOwnFile(name, token) {
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and trashed = false and '${FOLDER_ID}' in parents`;
  const url = `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name)')}&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`;
  const result = await driveRequest(url, token);
  return result.files?.[0] || null;
}
async function uploadPhoto(item) {
  const token = await accessToken();
  // drive.file scope can manage files created by this app. A pre-existing shared folder
  // may still require explicit access; report permissions errors instead of silently saving.
  const existing = await findOwnFile(item.name, token);
  const metadata = existing ? { name: item.name } : { name: item.name, parents: [FOLDER_ID], mimeType: 'image/jpeg' };
  const url = existing
    ? `${UPLOAD_API}/${existing.id}?uploadType=resumable&supportsAllDrives=true&fields=id,name`
    : `${UPLOAD_API}?uploadType=resumable&supportsAllDrives=true&fields=id,name`;
  const begin = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'image/jpeg' },
    body: JSON.stringify(metadata),
  });
  if (!begin.ok) throw new Error(`Drive 업로드 준비 실패 (${begin.status}): ${await begin.text()}`);
  const session = begin.headers.get('location');
  if (!session) throw new Error('Drive 업로드 세션 주소를 받지 못했습니다.');
  const localResponse = await fetch(item.uri);
  const blob = await localResponse.blob();
  const uploaded = await fetch(session, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (!uploaded.ok) throw new Error(`Drive 파일 전송 실패 (${uploaded.status}): ${await uploaded.text()}`);
  const result = await uploaded.json();
  if (!result.id) throw new Error('업로드 응답에서 파일 ID를 확인하지 못했습니다.');
  return existing ? '교체' : '업로드';
}

export default function App() {
  const cameraRef = useRef(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [barcode, setBarcode] = useState('');
  const captureBusy = useRef(false);
  const scanBusy = useRef(false);
  const scanCandidate = useRef({ value: "", count: 0, lastSeen: 0 });
  const [scanLocked, setScanLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [loggedIn, setLoggedIn] = useState(false);
  const [pending, setPending] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const queueLock = useRef(Promise.resolve());
  const uploadingRef = useRef(false);
  const loggedInRef = useRef(false);
  const pendingRef = useRef([]);

  // Keep queue mutations serialized, even when taking photos during uploads.
  const updateQueue = async (change) => {
    const task = queueLock.current.then(async () => {
      const current = await readQueue();
      const next = change(current);
      await writeQueue(next);
      pendingRef.current = next;
      setPending(next);
      return next;
    });
    queueLock.current = task.catch(() => {});
    return task;
  };

  const processQueue = async () => {
    if (uploadingRef.current || !loggedInRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    setUploadError('');
    try {
      // One network upload at a time; new captures may enter the queue concurrently.
      while (true) {
        await queueLock.current;
        const item = pendingRef.current[0];
        if (!item) break;
        try {
          await uploadPhoto(item);
          await updateQueue((q) => q.filter((x) => x.uri !== item.uri));
          await FileSystem.deleteAsync(item.uri, { idempotent: true });
          setSavedCount((n) => n + 1);
        } catch (error) {
          setUploadError(`${item.name}: ${String(error?.message || error)}`);
          break; // Avoid a tight retry loop on network or permission errors.
        }
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  useEffect(() => {
    let active = true;
    readQueue().then((q) => {
      if (active) { pendingRef.current = q; setPending(q); }
    });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loggedInRef.current) processQueue();
    });
    return () => { active = false; listener.remove(); };
  }, []);

  const signIn = async () => {
    try {
      const { GoogleSignin } = googleAuth();
      await GoogleSignin.hasPlayServices();
      const user = await GoogleSignin.getCurrentUser();
      if (!user) await GoogleSignin.signIn();
      loggedInRef.current = true;
      setLoggedIn(true);
      processQueue();
    } catch (error) {
      Alert.alert('구글 로그인 실패', String(error?.message || error));
    }
  };

  const retryPending = () => {
    if (!loggedInRef.current) {
      Alert.alert('로그인 필요', '구글 로그인 버튼을 먼저 눌러 주세요.');
      return;
    }
    processQueue();
  };

  if (!cameraPermission) return <View style={styles.center}><Text>권한 확인 중...</Text></View>;
  if (!cameraPermission.granted) return (
    <SafeAreaView style={styles.center}>
      <Text style={styles.title}>리마켓 바코드카메라</Text>
      <Text style={styles.help}>카메라 권한을 허용해 주세요.</Text>
      <TouchableOpacity style={styles.permissionButton} onPress={requestCameraPermission}>
        <Text style={styles.permissionButtonText}>권한 허용</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  const onBarcodeScanned = ({ data }) => {
    if (scanBusy.current || !data) return;
    // Reject rather than silently alter a decoded value: removing letters could
    // accidentally turn a misread barcode into a plausible product number.
    const clean = String(data).trim();
    if (!/^\d+$/.test(clean)) return;
    // Regular product codes: 9 digits. Codes beginning with 9: 10 digits.
    const validLength = clean.startsWith('9') ? clean.length === 10 : clean.length === 9;
    if (!validLength) {
      scanCandidate.current = { value: '', count: 0, lastSeen: 0 };
      return;
    }

    const now = Date.now();
    const previous = scanCandidate.current;
    const count = previous.value === clean && now - previous.lastSeen <= 900
      ? previous.count + 1 : 1;
    scanCandidate.current = { value: clean, count, lastSeen: now };
    if (count < 2) return;

    scanBusy.current = true;
    setBarcode(clean);
    setScanLocked(true);
  };
  const resetForNext = () => {
    scanCandidate.current = { value: '', count: 0, lastSeen: 0 };
    setBarcode(''); scanBusy.current = false; setScanLocked(false);
  };

  const savePhoto = async () => {
    if (!loggedInRef.current) { Alert.alert('구글 로그인 필요', '먼저 구글 계정으로 로그인해 주세요.'); return; }
    if (!barcode || !cameraRef.current || captureBusy.current) return;
    captureBusy.current = true;
    setSaving(true);
    const name = `${localDateStamp()}_${barcode.slice(0, 6)}_${barcode}.jpg`;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9, shutterSound: false });
      if (!photo?.uri) throw new Error('촬영한 사진을 찾지 못했습니다.');
      // Unique local staging path prevents overwriting a file being uploaded.
      const uri = `${FileSystem.documentDirectory}remarket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      await FileSystem.copyAsync({ from: photo.uri, to: uri });
      try {
        await updateQueue((q) => q.concat([{ name, uri }]));
      } catch (error) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        throw error;
      }
      // Capture is complete: do not wait for Drive. The queue worker handles it.
      resetForNext();
      processQueue();
    } catch (error) {
      Alert.alert('사진 저장 실패', String(error?.message || error));
    } finally {
      captureBusy.current = false;
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerText}>리마켓 바코드카메라</Text>
        <Text style={styles.counter}>완료 {savedCount}장 / 대기 {pending.length}장</Text>
      </View>
      <View style={{ padding: 10, backgroundColor: '#222', flexDirection: 'row', justifyContent: 'space-around' }}>
        <TouchableOpacity onPress={signIn} disabled={saving}>
          <Text style={{ color: '#fff', fontWeight: 'bold' }}>{loggedIn ? '구글 로그인됨' : '구글 로그인'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={retryPending} disabled={uploading || !pending.length}>
          <Text style={{ color: pending.length ? '#fff' : '#888', fontWeight: 'bold' }}>{uploading ? '전송 중...' : `재전송 ${pending.length}장`}</Text>
        </TouchableOpacity>
      </View>
      {!!uploadError && <Text style={{ color: '#ffb3b3', backgroundColor: '#3a1010', padding: 6 }} numberOfLines={2}>전송 실패 (재전송 가능): {uploadError}</Text>}
      <View style={styles.cameraFrame}>
        <CameraView
          ref={cameraRef} style={StyleSheet.absoluteFill} facing="back"
          ratio={Platform.OS === 'android' ? '4:3' : undefined}
          onBarcodeScanned={scanLocked ? undefined : onBarcodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['code128','code39','ean13','ean8','upc_a','upc_e'] }}
        />
        {!barcode ? (
          <View pointerEvents="none" style={styles.scanGuideWrap}>
            <View style={styles.scanGuide} />
            <Text style={styles.scanGuideText}>바코드를 이 안에 맞춰 주세요</Text>
          </View>
        ) : (
          <>
            <View pointerEvents="none" style={styles.photoGuide}>
              <Text style={styles.photoGuideText}>이 화면 전체가 저장되는 사진 범위입니다</Text>
            </View>
            <TouchableOpacity style={styles.rescanButton} onPress={resetForNext} disabled={saving}>
              <Text style={styles.rescanText}>바코드 다시 읽기</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.captureButton} onPress={savePhoto} disabled={saving}>
              <Text style={styles.captureButtonText}>{saving ? '사진 저장 중...' : '상품 사진 촬영'}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      <View style={styles.bottomPanel}>
        <Text style={styles.label}>제품번호</Text>
        <Text style={styles.barcodeText}>{barcode || '바코드를 보여 주세요'}</Text>
        {!barcode && <Text style={styles.helpLight}>바코드가 인식되면 촬영 버튼이 나타납니다.</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },

  header: {
    height: 58,
    paddingHorizontal: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#000',
  },

  headerText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
  },

  counter: {
    color: '#fff',
    fontSize: 14,
  },

  cameraFrame: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#000',
    overflow: 'hidden',
  },

  scanGuideWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },

  scanGuide: {
    width: '82%',
    height: 120,
    borderWidth: 3,
    borderColor: '#fff',
    borderRadius: 14,
  },

  scanGuideText: {
    marginTop: 12,
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },

  photoGuide: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    alignItems: 'center',
  },

  photoGuideText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },

  rescanButton: {
    position: 'absolute',
    bottom: 96,
    right: 14,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderWidth: 1,
    borderColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },

  rescanText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },

  captureButton: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 18,
    backgroundColor: '#fff',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },

  captureButtonText: {
    color: '#111',
    fontSize: 18,
    fontWeight: '800',
  },

  bottomPanel: {
    flex: 1,
    backgroundColor: '#111',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
  },

  label: {
    color: '#bbb',
    fontSize: 14,
    marginBottom: 4,
  },

  barcodeText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10,
  },

  helpLight: {
    color: '#bbb',
    fontSize: 14,
    textAlign: 'center',
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },

  title: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 14,
  },

  help: {
    fontSize: 16,
    color: '#444',
    textAlign: 'center',
    marginBottom: 20,
  },

  permissionButton: {
    backgroundColor: '#111',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
  },

  permissionButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
});
