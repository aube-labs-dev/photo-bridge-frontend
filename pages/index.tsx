import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PeerHandle,
  PeerCallbacks,
  createPeer,
  createSendChannel,
  sendFile,
  downloadBlob,
  shareFile,
  shareFiles,
  sendFlowControl,
  sendAllDone,
  canShareFile,
} from '../lib/webrtc';
import { Signaling } from '../lib/signaling';

type Status = 'disconnected' | 'connecting' | 'waiting' | 'connected';

// 시그널링 Worker 베이스 (환경변수로 주입, 기본은 동일 호스트의 /ws 가정)
function signalingBase(): string {
  const envBase =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_SIGNALING_URL
      : undefined;
  if (envBase) return envBase;
  // 동일 오리진 fallback (로컬 하니스/프록시)
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}`;
  }
  return '';
}

// 한 번에 보낼 수 있는 최대 장수 (배치 저장으로 대량 전송 지원)
const MAX_FILES = 300;
// 수신 갤러리 배치 크기. 이 수를 채우면 전송을 잠시 멈추고 저장을 요청한다.
// (저장 위치 선택 = 공유 시트 = 사용자 제스처 필요. iOS는 자동 사진앱 저장 불가하므로
//  배치마다 사용자가 '저장하고 계속'을 눌러 사진앱 등으로 저장하게 한다.)
const MAX_RECV = 100;

export default function HomePage() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState<Status>('disconnected');
  const [sendPct, setSendPct] = useState<number | null>(null);
  const [recvPct, setRecvPct] = useState<number | null>(null);
  const [recvName, setRecvName] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [notice, setNotice] = useState('');
  // 받은 사진들 (미리보기 갤러리 + 저장 선택)
  const [recvImages, setRecvImages] = useState<
    { id: number; url: string; blob: Blob; name: string }[]
  >([]);
  // 배치 저장 대기: 갤러리가 MAX_RECV장을 채워 전송이 일시정지된 상태
  const [needSave, setNeedSave] = useState(false);
  // 저장 완료 표시된 사진 id 집합 (개별/전체 저장 후 체크 뱃지)
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  // 보내기 진행 (배치)
  const [sendBatch, setSendBatch] = useState<{
    idx: number;
    total: number;
    pct: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const recvIdRef = useRef(0);
  // 방 QR 코드 canvas
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // --- WebRTC/시그널링 상태는 전부 ref (stale closure 방지) ---
  const sigRef = useRef<Signaling | null>(null);
  const peerRef = useRef<PeerHandle | null>(null);
  const remoteIdRef = useRef<string | null>(null);
  const roomIdRef = useRef('');
  const iceServersRef = useRef<RTCIceServer[] | undefined>(undefined);

  const addLog = useCallback((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
    setLog((prev) => [...prev.slice(-200), msg]);
  }, []);

  // TURN credential 미리 로드 (Worker /turn-credentials)
  useEffect(() => {
    const base = signalingBase();
    if (!base) return;
    const httpBase = base.replace(/^ws/, 'http');
    fetch(`${httpBase}/turn-credentials`)
      .then((r) => r.json())
      .then((d) => {
        if (d && Array.isArray(d.iceServers)) {
          iceServersRef.current = d.iceServers;
          addLog(`[ICE] servers loaded: ${d.iceServers.length}`);
        }
      })
      .catch(() => {
        /* STUN 기본값 사용 */
      });
  }, [addLog]);

  const makeCallbacks = useCallback(
    (): PeerCallbacks => ({
      onLog: addLog,
      onConnectionState: (st) => {
        if (st === 'connected') {
          setStatus('connected');
          setNotice(''); // 재연결 완료 시 '상대가 나갔어요' 등 이전 안내 제거
        } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          setStatus('waiting');
        }
      },
      onRecvProgress: (received, total, fileName) => {
        setRecvName(fileName);
        setRecvPct(total > 0 ? Math.round((received / total) * 100) : 0);
      },
      onRecvComplete: (blob, fileName) => {
        const url = URL.createObjectURL(blob);
        const id = ++recvIdRef.current;
        setRecvImages((prev) => {
          const next = [...prev, { id, url, blob, name: fileName }];
          // 배치가 가득 차면: 송신측에 멈춰달라 요청 + 저장 UI 표시 (버리지 않음)
          if (next.length >= MAX_RECV) {
            const handle = peerRef.current;
            if (handle) sendFlowControl(handle, true);
            setNeedSave(true);
          }
          return next;
        });
        setRecvPct(null);
      },
      onFlowControl: () => {
        /* 송신측 콜백 — 수신측에서는 사용 안 함 (대기는 sendFile 내부 처리) */
      },
      onAllDone: () => {
        // 송신 완료: '나머지 계속 받는 중' 류의 안내를 정리
        setNotice('');
      },
    }),
    [addLog],
  );

  const ensurePeer = useCallback(
    (remoteId: string, polite: boolean): PeerHandle => {
      if (peerRef.current) return peerRef.current;
      remoteIdRef.current = remoteId;
      const handle = createPeer(
        sigRef.current!,
        remoteId,
        polite,
        makeCallbacks(),
        iceServersRef.current,
      );
      peerRef.current = handle;
      return handle;
    },
    [makeCallbacks],
  );

  const teardownPeer = useCallback(() => {
    if (peerRef.current) {
      try {
        peerRef.current.dc?.close();
        peerRef.current.pc.close();
      } catch {
        /* noop */
      }
    }
    peerRef.current = null;
    remoteIdRef.current = null;
  }, []);

  // 시그널링 핸들러 등록 (sig 연결마다)
  const wireSignaling = useCallback(
    (sig: Signaling) => {
      sig.on('connect', () => {
        addLog('[Sig] connected');
        setStatus('waiting');
      });
      sig.on('disconnect', () => {
        addLog('[Sig] disconnected');
        teardownPeer();
        if (joined) setStatus('connecting');
      });
      sig.on('connect_error', (e: any) =>
        addLog(`[Sig] error: ${e?.message}`),
      );

      sig.on('room_joined', (d: any) => {
        addLog(`[Room] joined. total=${d.totalClients}`);
        setStatus(d.totalClients > 1 ? 'connecting' : 'waiting');
      });

      sig.on('room_full', () => {
        setNotice('이 방은 이미 2명이 사용 중이에요. 다른 방 번호를 쓰세요.');
        setStatus('disconnected');
        setJoined(false);
        sig.disconnect();
      });

      // 신규 입장자(impolite) → offer 시작 + DataChannel 생성
      sig.on('start_negotiation', (d: any) => {
        addLog(`[Neg] start peer=${d.peerId} polite=${d.polite}`);
        setStatus('connecting');
        setNotice(''); // 상대 재등장 → 이전 '나갔어요' 안내 제거
        const handle = ensurePeer(d.peerId, d.polite);
        createSendChannel(handle, makeCallbacks());
      });

      // 기존 입장자(polite) → 상대 등장 (offer 대기)
      sig.on('peer_joined', (d: any) => {
        addLog(`[Neg] peer_joined peer=${d.peerId} polite=${d.polite}`);
        setStatus('connecting');
        setNotice(''); // 상대 재등장 → 이전 '나갔어요' 안내 제거
        ensurePeer(d.peerId, d.polite);
      });

      sig.on('peer_left', () => {
        addLog('[Room] peer left');
        teardownPeer();
        setNotice('상대가 나갔어요.');
        setStatus('waiting');
      });

      sig.on('offer', async (d: any) => {
        const handle = ensurePeer(d.senderId, peerRef.current?.polite ?? true);
        const pc = handle.pc;
        const collision = handle.makingOffer || pc.signalingState !== 'stable';
        handle.ignoreOffer = !handle.polite && collision;
        if (handle.ignoreOffer) {
          addLog('[Neg] ignore offer (impolite collision)');
          return;
        }
        await pc.setRemoteDescription(d.sdp);
        await pc.setLocalDescription();
        sig.emit('answer', { targetId: d.senderId, sdp: pc.localDescription });
        addLog('[Neg] answered');
      });

      sig.on('answer', async (d: any) => {
        const handle = peerRef.current;
        if (!handle) return;
        try {
          await handle.pc.setRemoteDescription(d.sdp);
          addLog('[Neg] applied answer');
        } catch (e) {
          addLog(`[Neg] answer err: ${String(e)}`);
        }
      });

      sig.on('ice_candidate', async (d: any) => {
        const handle = peerRef.current;
        if (!handle || !d.candidate) return;
        try {
          await handle.pc.addIceCandidate(d.candidate);
        } catch (e) {
          if (!handle.ignoreOffer) addLog(`[Neg] ice err: ${String(e)}`);
        }
      });
    },
    [addLog, ensurePeer, makeCallbacks, teardownPeer, joined],
  );

  // 방 입장: 새 WS 연결(URL에 room 포함)
  const connectRoom = useCallback(
    (id: string) => {
      // 기존 연결 정리
      sigRef.current?.disconnect();
      teardownPeer();
      // 새 방 입장 → 이전 방에서 받은 사진/저장상태/안내 초기화
      // (connectRoom은 사용자가 방에 입장할 때만 호출됨. iOS 복귀 등 자동 재연결은
      //  signaling 내부에서 처리되어 여기로 오지 않으므로 갤러리를 비워도 안전하다.)
      setRecvImages((prev) => {
        prev.forEach((img) => URL.revokeObjectURL(img.url));
        return [];
      });
      setSavedIds(new Set());
      setNeedSave(false);
      setNotice('');
      const base = signalingBase();
      // 탭별 고유 키(ck): iOS 백그라운드 복귀 등 재접속 시 서버가 같은 ck의
      // 좀비 소켓을 교체하도록 해 room_full 오거부를 방지한다.
      let ck = '';
      try {
        ck = sessionStorage.getItem('pb_ck') || '';
        if (!ck) {
          ck =
            (crypto as any)?.randomUUID?.() ||
            `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          sessionStorage.setItem('pb_ck', ck);
        }
      } catch {
        ck = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const sig = new Signaling(
        `${base}/ws?room=${encodeURIComponent(id)}&ck=${encodeURIComponent(ck)}`,
      );
      sigRef.current = sig;
      wireSignaling(sig);
      setStatus('connecting');
      sig.connect();
    },
    [teardownPeer, wireSignaling],
  );

  // 방 QR 코드 생성 (대기 중일 때 canvas에 방 링크 QR)
  useEffect(() => {
    if (!joined || status === 'connected') return;
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    const link = `${window.location.origin}/?room=${roomIdRef.current}`;
    let cancelled = false;
    import('qrcode').then((QR) => {
      if (cancelled || !qrCanvasRef.current) return;
      const draw = (QR as any).toCanvas || (QR as any).default?.toCanvas;
      draw(qrCanvasRef.current, link, {
        width: 180,
        margin: 1,
        color: { dark: '#1f2937', light: '#ffffff' },
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [joined, status]);

  // URL ?room=xxxx 자동 입장
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    if (r && r.trim()) {
      const id = r.trim();
      setRoomId(id);
      roomIdRef.current = id;
      setJoined(true);
      connectRoom(id);
    }
    return () => {
      sigRef.current?.disconnect();
      if (peerRef.current) peerRef.current.pc.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = () => {
    const id = roomId.trim();
    if (!id) {
      setNotice('방 번호를 입력하세요.');
      return;
    }
    roomIdRef.current = id;
    setJoined(true);
    setNotice('');
    // 브라우저 URL을 현재 방으로 갱신 → 새로고침해도 이 방으로 복귀
    try {
      window.history.replaceState(null, '', `/?room=${encodeURIComponent(id)}`);
    } catch {
      /* noop */
    }
    connectRoom(id);
  };

  const handleLeave = () => {
    sigRef.current?.disconnect();
    teardownPeer();
    roomIdRef.current = '';
    setJoined(false);
    setStatus('disconnected');
    // URL의 ?room= 제거 → 새로고침해도 이전 방으로 자동 입장하지 않음
    try {
      window.history.replaceState(null, '', '/');
    } catch {
      /* noop */
    }
    // 받은 사진/저장상태/안내 초기화 (나가면 깨끗하게)
    setRecvImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.url));
      return [];
    });
    setSavedIds(new Set());
    setNeedSave(false);
    setNotice('');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const handle = peerRef.current;
    if (!handle || !handle.dc || handle.dc.readyState !== 'open') {
      setNotice('상대와 연결되면 보낼 수 있어요.');
      return;
    }
    if (files.length > MAX_FILES) {
      setNotice(
        `한 번에 최대 ${MAX_FILES}장까지 보낼 수 있어요. (선택: ${files.length}장) 나눠서 보내주세요.`,
      );
      return;
    }
    const total = files.length;
    try {
      for (let i = 0; i < total; i++) {
        setSendBatch({ idx: i + 1, total, pct: 0 });
        await sendFile(
          handle,
          files[i],
          (sent, t) =>
            setSendBatch({
              idx: i + 1,
              total,
              pct: t > 0 ? Math.round((sent / t) * 100) : 0,
            }),
          addLog,
        );
      }
      setNotice(
        total === 1 ? '사진을 보냈어요.' : `사진 ${total}장을 보냈어요.`,
      );
      // 수신측에 전송 완료 알림 (수신측 '계속 받는 중' notice 정리)
      if (handle) sendAllDone(handle);
      setTimeout(() => setSendBatch(null), 1200);
    } catch (err) {
      setNotice(`보내기 실패: ${String(err)}`);
      setSendBatch(null);
    }
  };

  // 받은 사진 1장 저장. iOS=공유 시트(사진/파일 앱 선택), 그 외=다운로드(Downloads→갤러리)
  const saveImage = async (img: {
    id: number;
    blob: Blob;
    name: string;
  }) => {
    if (saveViaShare) {
      const shared = await shareFile(img.blob, img.name);
      if (!shared) downloadBlob(img.blob, img.name);
    } else {
      downloadBlob(img.blob, img.name);
    }
    markSaved([img.id]);
  };

  // 저장 완료로 표시 (체크 뱃지)
  const markSaved = (ids: number[]) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };

  // 받은 사진 전체 저장. iOS=한 번의 공유 시트로 사진/파일 앱 선택,
  // Android/데스크톱=순차 다운로드(Downloads→갤러리 자동 반영)
  const saveAllImages = async () => {
    if (recvImages.length === 0) return;
    addLog(`[UI] 전체 저장 클릭: ${recvImages.length}장`);
    const allIds = recvImages.map((img) => img.id);
    if (saveViaShare) {
      const items = recvImages.map((img) => ({ blob: img.blob, name: img.name }));
      const shared = await shareFiles(items, addLog);
      if (shared) {
        markSaved(allIds);
        return; // 공유 시트에서 사용자가 저장 위치 선택
      }
      // iOS인데 공유 실패 → 개별 저장 안내(무반응 방지)
      setNotice(
        '저장 창을 열지 못했어요. 각 사진의 ‘저장 / 공유’ 버튼으로 한 장씩 저장해 주세요.',
      );
      return;
    }
    // Android/데스크톱: 다운로드 (Android는 Downloads→갤러리 자동, 데스크톱은 다운로드 폴더)
    for (const img of recvImages) {
      downloadBlob(img.blob, img.name);
      await new Promise((r) => setTimeout(r, 250));
    }
    markSaved(allIds);
    setNotice(`${recvImages.length}장 저장했어요. (사진/다운로드 앱에서 확인)`);
  };

  const clearReceived = () => {
    recvImages.forEach((img) => URL.revokeObjectURL(img.url));
    setRecvImages([]);
    setSavedIds(new Set());
  };

  // 배치 저장 후 계속: 현재 갤러리를 저장 → 비우고 → 송신측에 재개 신호
  const saveBatchAndContinue = async () => {
    if (recvImages.length > 0) {
      if (saveViaShare) {
        // iOS: 공유 시트로 사진 앱 저장
        const items = recvImages.map((img) => ({
          blob: img.blob,
          name: img.name,
        }));
        await shareFiles(items, addLog);
      } else {
        // Android/데스크톱: 순차 다운로드(Android는 Downloads→갤러리 자동)
        for (const img of recvImages) {
          downloadBlob(img.blob, img.name);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    // 갤러리 비우고 메모리 해제
    recvImages.forEach((img) => URL.revokeObjectURL(img.url));
    setRecvImages([]);
    setSavedIds(new Set());
    setNeedSave(false);
    // 송신측에 "계속 보내" 신호
    const handle = peerRef.current;
    if (handle) sendFlowControl(handle, false);
    setNotice('저장했어요. 나머지를 계속 받는 중…');
  };

  const supportsShare =
    typeof window !== 'undefined' && canShareFile('x.png', 'image/png');

  // iOS/iPadOS 여부: 공유 시트가 '사진 앱 저장'을 제공하는 유일한 플랫폼.
  // Android 공유 시트에는 저장 항목이 없고(앱 전송용), 다운로드가 Downloads→갤러리로
  // 자동 반영되므로 저장은 다운로드 방식을 써야 한다.
  const isIOS =
    typeof navigator !== 'undefined' &&
    (/iP(hone|ad|od)/.test(navigator.platform || '') ||
      /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
      // iPadOS 13+ 는 Mac으로 위장 → 터치 지원으로 구분
      (/Macintosh/.test(navigator.userAgent || '') &&
        typeof document !== 'undefined' &&
        'ontouchend' in document));

  // 저장 시 공유 시트를 쓸지(=iOS) 여부. iOS만 공유 시트로 사진 앱 저장 가능.
  const saveViaShare = isIOS && supportsShare;

  // 방 링크 복사 (상대에게 공유)
  const copyRoomLink = async () => {
    const link = `${window.location.origin}/?room=${roomIdRef.current}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice(link);
    }
  };

  // 방 링크 공유 (네이티브 공유 시트)
  const shareRoomLink = async () => {
    const link = `${window.location.origin}/?room=${roomIdRef.current}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Photo Bridge',
          text: '사진 주고받기 — 이 링크로 들어와요',
          url: link,
        });
      } else {
        copyRoomLink();
      }
    } catch {
      /* 사용자 취소 */
    }
  };

  const canSend =
    status === 'connected' && peerRef.current?.dc?.readyState === 'open';

  const statusLabel: Record<Status, string> = {
    disconnected: '연결 안 됨',
    connecting: '연결 중…',
    waiting: '상대 기다리는 중…',
    connected: '연결됨 ✓',
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>📷 Photo Bridge</h1>
        <p style={styles.sub}>같은 방 번호를 입력하면 사진을 직접 주고받아요.</p>

        <div style={styles.statusRow}>
          <span
            style={{
              ...styles.dot,
              background:
                status === 'connected'
                  ? '#22c55e'
                  : status === 'disconnected'
                    ? '#ef4444'
                    : '#f59e0b',
            }}
          />
          <span>{statusLabel[status]}</span>
        </div>

        {!joined ? (
          <div style={styles.joinRow}>
            <input
              style={styles.input}
              type="text"
              inputMode="numeric"
              placeholder="방 번호 (예: 1234)"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <button style={styles.btnPrimary} onClick={handleJoin}>
              입장
            </button>
          </div>
        ) : (
          <div style={styles.joinedBox}>
            <div style={styles.roomBadge}>방 {roomIdRef.current}</div>
            <button style={styles.btnGhost} onClick={handleLeave}>
              나가기
            </button>
          </div>
        )}

        {/* 상대 대기 중: 방 공유 안내 */}
        {joined && status !== 'connected' && (
          <div style={styles.shareBox}>
            <p style={styles.shareHint}>
              상대가 아래 QR을 스캔하거나, 링크(방 번호 <b>{roomIdRef.current}</b>)로
              같은 방에 들어오면 연결돼요.
            </p>
            <div style={styles.qrWrap}>
              <canvas ref={qrCanvasRef} style={styles.qrCanvas} />
            </div>
            <div style={styles.shareBtnRow}>
              <button style={styles.btnShare} onClick={shareRoomLink}>
                링크 공유
              </button>
              <button style={styles.btnShareGhost} onClick={copyRoomLink}>
                {copied ? '복사됨 ✓' : '링크 복사'}
              </button>
            </div>
          </div>
        )}

        <div style={styles.sendBox}>
          <label
            style={{
              ...styles.fileLabel,
              opacity: canSend ? 1 : 0.5,
              pointerEvents: canSend ? 'auto' : 'none',
            }}
          >
            사진 보내기 (여러 장 가능)
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </label>
          {!canSend && joined && (
            <p style={styles.hint}>상대가 들어오면 전송할 수 있어요.</p>
          )}
        </div>

        {sendBatch && (
          <Progress
            label={
              sendBatch.total > 1
                ? `보내는 중 (${sendBatch.idx}/${sendBatch.total})`
                : '보내는 중'
            }
            pct={sendBatch.pct}
            color="#3b82f6"
          />
        )}
        {recvPct !== null && (
          <Progress label={`받는 중: ${recvName}`} pct={recvPct} color="#22c55e" />
        )}

        {/* 배치 저장 대기: 100장 채워 전송 일시정지됨 */}
        {needSave && (
          <div style={styles.saveBatchBox}>
            <p style={styles.saveBatchText}>
              사진 {recvImages.length}장을 받았어요. 저장할 공간을 비우기 위해
              전송을 잠시 멈췄어요. 아래 버튼으로 저장하면 나머지를 이어서
              받아요.
            </p>
            <button style={styles.btnSaveBatch} onClick={saveBatchAndContinue}>
              저장하고 계속 받기
            </button>
          </div>
        )}

        {/* 받은 사진 갤러리 */}
        {recvImages.length > 0 && (
          <div style={styles.gallery}>
            <div style={styles.galleryHead}>
              <span style={styles.galleryTitle}>
                받은 사진 {recvImages.length}장
                {savedIds.size > 0 && (
                  <span style={styles.savedCount}>
                    {' '}· {savedIds.size}장 저장됨 ✓
                  </span>
                )}
              </span>
              <div style={styles.galleryActions}>
                {recvImages.length > 1 && !needSave && (
                  <button style={styles.btnTiny} onClick={saveAllImages}>
                    {recvImages.every((img) => savedIds.has(img.id))
                      ? '다시 전체 저장'
                      : '전체 저장'}
                  </button>
                )}
                {!needSave && (
                  <button style={styles.btnTinyGhost} onClick={clearReceived}>
                    지우기
                  </button>
                )}
              </div>
            </div>
            <div style={styles.grid}>
              {recvImages.map((img) => {
                const saved = savedIds.has(img.id);
                return (
                  <div key={img.id} style={styles.thumbWrap}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.name}
                      loading="lazy"
                      style={styles.thumb}
                    />
                    {saved && (
                      <div style={styles.savedBadge} aria-label="저장 완료">
                        ✓
                      </div>
                    )}
                    <button
                      style={saved ? styles.saveBtnDone : styles.saveBtn}
                      onClick={() => saveImage(img)}
                    >
                      {saved ? '저장됨 ✓' : saveViaShare ? '저장 / 공유' : '저장'}
                    </button>
                  </div>
                );
              })}
            </div>
            {saveViaShare ? (
              <p style={styles.gHint}>
                저장 버튼을 누르면 ‘사진’ 앱, ‘파일’ 앱 등 저장 위치를 고를 수
                있어요.
              </p>
            ) : (
              <p style={styles.gHint}>
                저장하면 다운로드 폴더에 담기고, 사진·갤러리 앱에서도 볼 수
                있어요.
              </p>
            )}
          </div>
        )}

        {notice && <div style={styles.notice}>{notice}</div>}

        <button style={styles.logToggle} onClick={() => setShowLog((v) => !v)}>
          {showLog ? '로그 숨기기' : '로그 보기'}
        </button>
        {showLog && (
          <pre style={styles.logBox}>
            {log.map((m, i) => (
              <div key={i}>{m}</div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

function Progress({
  label,
  pct,
  color,
}: {
  label: string;
  pct: number;
  color: string;
}) {
  return (
    <div style={styles.progWrap}>
      <div style={styles.progLabel}>
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div style={styles.progTrack}>
        <div style={{ ...styles.progFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(160deg,#eff6ff,#e0e7ff)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '24px 16px',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: '#fff',
    borderRadius: 20,
    boxShadow: '0 10px 40px rgba(0,0,0,0.08)',
    padding: 24,
  },
  title: { fontSize: 26, margin: '0 0 4px' },
  sub: { color: '#6b7280', fontSize: 14, margin: '0 0 16px' },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    marginBottom: 16,
  },
  dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
  joinRow: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    padding: '12px 14px',
    fontSize: 16,
    border: '1px solid #d1d5db',
    borderRadius: 12,
    outline: 'none',
  },
  btnPrimary: {
    padding: '12px 18px',
    fontSize: 16,
    fontWeight: 600,
    color: '#fff',
    background: '#3b82f6',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer',
  },
  joinedBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  roomBadge: {
    background: '#eff6ff',
    color: '#1d4ed8',
    padding: '8px 14px',
    borderRadius: 10,
    fontWeight: 600,
  },
  btnGhost: {
    padding: '8px 14px',
    background: 'transparent',
    border: '1px solid #d1d5db',
    borderRadius: 10,
    cursor: 'pointer',
    color: '#6b7280',
  },
  sendBox: { marginTop: 20 },
  fileLabel: {
    display: 'block',
    textAlign: 'center',
    padding: '16px',
    background: '#3b82f6',
    color: '#fff',
    fontWeight: 600,
    borderRadius: 14,
    cursor: 'pointer',
  },
  hint: { color: '#9ca3af', fontSize: 13, textAlign: 'center', marginTop: 8 },
  progWrap: { marginTop: 16 },
  progLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 13,
    color: '#4b5563',
    marginBottom: 4,
  },
  progTrack: {
    height: 8,
    background: '#e5e7eb',
    borderRadius: 999,
    overflow: 'hidden',
  },
  progFill: { height: '100%', transition: 'width 0.15s' },
  notice: {
    marginTop: 16,
    padding: '10px 14px',
    background: '#fef9c3',
    borderRadius: 10,
    fontSize: 14,
    color: '#854d0e',
  },
  logToggle: {
    marginTop: 20,
    background: 'none',
    border: 'none',
    color: '#9ca3af',
    fontSize: 13,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  logBox: {
    marginTop: 8,
    maxHeight: 200,
    overflowY: 'auto',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: 10,
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  shareBox: {
    marginTop: 14,
    padding: '12px 14px',
    background: '#f8fafc',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
  },
  shareHint: { fontSize: 13, color: '#475569', margin: '0 0 10px', lineHeight: 1.5 },
  shareBtnRow: { display: 'flex', gap: 8 },
  saveBatchBox: {
    background: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  saveBatchText: {
    fontSize: 14,
    color: '#92400e',
    margin: '0 0 12px',
    lineHeight: 1.5,
  },
  btnSaveBatch: {
    width: '100%',
    padding: '14px',
    fontSize: 16,
    fontWeight: 700,
    color: '#fff',
    background: '#f59e0b',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
  },
  qrWrap: {
    display: 'flex',
    justifyContent: 'center',
    margin: '4px 0 12px',
  },
  qrCanvas: {
    width: 180,
    height: 180,
    borderRadius: 12,
    border: '1px solid #e5e7eb',
    background: '#fff',
    padding: 8,
  },
  btnShare: {
    flex: 1,
    padding: '10px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  btnShareGhost: {
    flex: 1,
    padding: '10px',
    background: '#fff',
    color: '#3b82f6',
    border: '1px solid #bfdbfe',
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  gallery: {
    marginTop: 18,
    padding: '14px',
    background: '#f8fafc',
    border: '1px solid #e5e7eb',
    borderRadius: 14,
  },
  galleryHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  galleryTitle: { fontWeight: 700, fontSize: 15, color: '#1f2937' },
  galleryActions: { display: 'flex', gap: 6 },
  btnTiny: {
    padding: '6px 10px',
    background: '#22c55e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnTinyGhost: {
    padding: '6px 10px',
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    fontSize: 12,
    cursor: 'pointer',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 10,
  },
  thumbWrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: '#fff',
    borderRadius: 10,
    padding: 6,
    border: '1px solid #eef2f7',
  },
  thumb: {
    width: '100%',
    height: 120,
    objectFit: 'cover',
    borderRadius: 8,
    background: '#f1f5f9',
  },
  saveBtn: {
    padding: '8px',
    background: '#eff6ff',
    color: '#1d4ed8',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  saveBtnDone: {
    padding: '8px',
    background: '#dcfce7',
    color: '#15803d',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  savedBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 26,
    height: 26,
    borderRadius: '50%',
    background: '#22c55e',
    color: '#fff',
    fontSize: 16,
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
  },
  savedCount: { fontSize: 13, fontWeight: 600, color: '#15803d' },
  gHint: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 10,
    marginBottom: 0,
    lineHeight: 1.5,
  },
};
