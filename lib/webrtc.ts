// Photo Bridge — WebRTC P2P 파일전송 코어 (프레임워크 비의존, useRef에서 사용)
// 핵심: 상태는 호출측 ref에 저장하고, 이 모듈은 순수 로직만 제공한다.
import type { Signaling } from './signaling';

export const CHUNK_SIZE = 16 * 1024; // 16KB
const BUFFER_THRESHOLD = 256 * 1024; // 역압 임계 256KB

export interface IceConfig {
  iceServers: RTCIceServer[];
}

export function buildIceConfig(): IceConfig {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  // 선택적 TURN (환경변수 주입)
  const turnUrl =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_TURN_URL : undefined;
  const turnUser =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_TURN_USER : undefined;
  const turnCred =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_TURN_CRED : undefined;
  if (turnUrl) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }
  return { iceServers: servers };
}

export interface FileMeta {
  fileName: string;
  fileType: string;
  totalSize: number;
}

interface FileReceiver {
  buffer: Uint8Array[];
  receivedSize: number;
  meta: FileMeta;
}

export interface PeerHandle {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  receiver: FileReceiver | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
  sendPaused: boolean; // 수신측 백프레셔(flow_pause) 수신 시 true → 송신 루프 대기
}

export interface PeerCallbacks {
  onLog: (msg: string) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onRecvProgress: (received: number, total: number, fileName: string) => void;
  onRecvComplete: (blob: Blob, fileName: string) => void;
  // 백프레셔: 상대(수신측)가 보낸 흐름 제어 신호. 송신측에서 전송 일시정지/재개에 사용.
  onFlowControl?: (paused: boolean) => void;
  // 송신측이 모든 파일 전송을 끝냈을 때 (수신측 notice 정리)
  onAllDone?: () => void;
}

// Perfect Negotiation 기반 Peer 생성. handle.dc 는 송신자(impolite)가 생성하거나
// 수신측에서 ondatachannel 로 채워진다.
export function createPeer(
  socket: Signaling,
  remoteId: string,
  polite: boolean,
  cb: PeerCallbacks,
  iceServers?: RTCIceServer[],
): PeerHandle {
  const pc = new RTCPeerConnection(
    iceServers ? { iceServers } : buildIceConfig(),
  );
  const handle: PeerHandle = {
    pc,
    dc: null,
    receiver: null,
    makingOffer: false,
    ignoreOffer: false,
    polite,
    sendPaused: false,
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      cb.onLog(`[ICE] local cand: ${candidate.type} ${candidate.protocol}`);
      socket.emit('ice_candidate', { targetId: remoteId, candidate });
    } else {
      cb.onLog('[ICE] gathering complete');
    }
  };

  pc.onconnectionstatechange = () => {
    cb.onLog(`[WebRTC] connection: ${pc.connectionState}`);
    cb.onConnectionState(pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    cb.onLog(`[WebRTC] ice: ${pc.iceConnectionState}`);
  };

  // Perfect Negotiation: 협상 필요 시 offer 생성
  pc.onnegotiationneeded = async () => {
    try {
      handle.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('offer', { targetId: remoteId, sdp: pc.localDescription });
      cb.onLog('[WebRTC] sent offer (negotiationneeded)');
    } catch (err) {
      cb.onLog(`[WebRTC] negotiationneeded error: ${String(err)}`);
    } finally {
      handle.makingOffer = false;
    }
  };

  // 수신측: 상대가 만든 DataChannel 수신
  pc.ondatachannel = (event) => {
    cb.onLog(`[WebRTC] datachannel received: ${event.channel.label}`);
    handle.dc = event.channel;
    setupDataChannel(handle, cb);
  };

  return handle;
}

// impolite(송신 시작자)가 DataChannel을 선제 생성할 때 호출
export function createSendChannel(handle: PeerHandle, cb: PeerCallbacks): void {
  const dc = handle.pc.createDataChannel('file_transfer');
  handle.dc = dc;
  setupDataChannel(handle, cb);
}

function setupDataChannel(handle: PeerHandle, cb: PeerCallbacks): void {
  const dc = handle.dc!;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

  dc.onopen = () => cb.onLog(`[DataChannel] open (${dc.label})`);
  dc.onclose = () => cb.onLog(`[DataChannel] close (${dc.label})`);
  dc.onerror = (e: Event) => {
    const err = (e as RTCErrorEvent).error;
    cb.onLog(`[DataChannel] error: ${err ? err.message : 'unknown'}`);
  };

  dc.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === 'string') {
      try {
        const json = JSON.parse(data);
        if (json.type === 'file_info') {
          handle.receiver = {
            buffer: [],
            receivedSize: 0,
            meta: {
              fileName: json.fileName,
              fileType: json.fileType,
              totalSize: json.totalSize,
            },
          };
          cb.onLog(
            `[File] incoming: ${json.fileName} (${json.totalSize} bytes)`,
          );
          cb.onRecvProgress(0, json.totalSize, json.fileName);
        } else if (json.type === 'file_end') {
          const r = handle.receiver;
          if (r) {
            const blob = new Blob(r.buffer as BlobPart[], {
              type: r.meta.fileType || 'application/octet-stream',
            });
            cb.onLog(`[File] complete: ${r.meta.fileName}`);
            cb.onRecvComplete(blob, r.meta.fileName);
            handle.receiver = null;
          }
        } else if (json.type === 'flow_pause') {
          // 수신측이 배치 저장을 위해 잠시 멈춰달라고 요청
          handle.sendPaused = true;
          cb.onLog('[Flow] pause (수신측 배치 저장 대기)');
          cb.onFlowControl?.(true);
        } else if (json.type === 'flow_resume') {
          handle.sendPaused = false;
          cb.onLog('[Flow] resume (수신측 저장 완료)');
          cb.onFlowControl?.(false);
        } else if (json.type === 'all_done') {
          // 송신측이 모든 파일 전송을 끝냈음 (notice 정리용)
          cb.onLog('[Flow] all_done (송신 완료)');
          cb.onAllDone?.();
        }
      } catch {
        cb.onLog(`[DataChannel] text: ${data}`);
      }
      return;
    }
    // 바이너리 청크 (arraybuffer 고정)
    const r = handle.receiver;
    if (!r) return;
    const chunk =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(0);
    r.buffer.push(chunk);
    r.receivedSize += chunk.byteLength;
    cb.onRecvProgress(r.receivedSize, r.meta.totalSize, r.meta.fileName);
  };
}

// 역압을 적용한 파일 송신. onProgress(sent, total)
// 수신측 백프레셔(handle.sendPaused)가 걸려 있으면 전송 시작 전 대기한다.
export async function sendFile(
  handle: PeerHandle,
  file: File,
  onProgress: (sent: number, total: number) => void,
  onLog: (msg: string) => void,
): Promise<void> {
  const dc = handle.dc;
  if (!dc || dc.readyState !== 'open') {
    throw new Error(`DataChannel not open (state: ${dc?.readyState})`);
  }

  // 백프레셔: 수신측이 배치 저장 중이면 재개될 때까지 대기 (파일 경계에서만 멈춤)
  while (handle.sendPaused) {
    await new Promise((r) => setTimeout(r, 200));
    if (dc.readyState !== 'open') {
      throw new Error('DataChannel closed while paused');
    }
  }

  // 1. 메타 전송
  dc.send(
    JSON.stringify({
      type: 'file_info',
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      totalSize: file.size,
    }),
  );

  // 2. 청크 전송 (역압 적용)
  let offset = 0;
  while (offset < file.size) {
    // 버퍼 과다 시 비우길 대기
    if (dc.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          dc.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', handler);
      });
    }
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    dc.send(buf);
    offset += buf.byteLength;
    onProgress(offset, file.size);
  }

  // 3. 완료 신호
  dc.send(JSON.stringify({ type: 'file_end', fileName: file.name }));
  onLog(`[File] sent complete: ${file.name}`);
}

// 수신 Blob 다운로드 (모바일 브라우저 공통)
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 이 브라우저가 파일 공유(네이티브 공유 시트)를 지원하는지
export function canShareFile(fileName: string, type: string): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.canShare) return false;
    const f = new File([new Blob()], fileName, {
      type: type || 'application/octet-stream',
    });
    return navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

// 여러 파일을 한 번의 네이티브 공유 시트로 저장(사진 앱 / 파일 앱 등).
// 반드시 사용자 탭(제스처) 핸들러 안에서 호출해야 iOS에서 동작한다.
// 반환: true=공유 시트 띄움, false=미지원/취소(→ 개별 downloadBlob 폴백 권장)
export async function shareFiles(
  files: { blob: Blob; name: string }[],
  onLog?: (msg: string) => void,
): Promise<boolean> {
  const log = onLog || (() => {});
  try {
    if (files.length === 0) {
      log('[Share] skip: 0 files');
      return false;
    }
    const fileObjs = files.map(
      (f) =>
        new File([f.blob], f.name, {
          type: f.blob.type || 'application/octet-stream',
        }),
    );
    const totalKB = Math.round(
      fileObjs.reduce((s, f) => s + f.size, 0) / 1024,
    );
    const can = !!(navigator.canShare && navigator.canShare({ files: fileObjs }));
    log(`[Share] files=${fileObjs.length} total=${totalKB}KB canShare=${can}`);
    if (can) {
      await navigator.share({ files: fileObjs });
      log('[Share] share() resolved (성공/저장)');
      return true;
    }
    log('[Share] canShare=false → 폴백 필요');
    return false;
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError') {
      log('[Share] 사용자 취소(AbortError)');
      return true;
    }
    log(`[Share] 실패: ${e?.name} ${e?.message}`);
    return false;
  }
}

// 단일 파일 네이티브 공유 시트로 저장 위치 선택(사진 앱 / 파일 앱 등).
// 반드시 사용자 탭(제스처) 핸들러 안에서 호출해야 iOS에서 동작한다.
// 반환: true=공유 시트 띄움, false=미지원/취소(→ downloadBlob 폴백 권장)
export async function shareFile(
  blob: Blob,
  fileName: string,
): Promise<boolean> {
  try {
    const file = new File([blob], fileName, {
      type: blob.type || 'application/octet-stream',
    });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return true;
    }
    return false;
  } catch (err) {
    // AbortError(사용자 취소)는 정상 — 폴백 안 함
    if ((err as Error)?.name === 'AbortError') return true;
    return false;
  }
}

// 수신측 → 송신측 흐름 제어 신호 전송 (백프레셔)
// paused=true: "배치 저장할 테니 멈춰" / false: "저장 끝났으니 계속 보내"
export function sendFlowControl(handle: PeerHandle, paused: boolean): void {
  const dc = handle.dc;
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify({ type: paused ? 'flow_pause' : 'flow_resume' }));
}

// 송신측 → 수신측: 모든 파일 전송 완료 신호 (수신측 '계속 받는 중' notice 정리)
export function sendAllDone(handle: PeerHandle): void {
  const dc = handle.dc;
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify({ type: 'all_done' }));
}

