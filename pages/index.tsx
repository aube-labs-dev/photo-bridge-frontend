import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PeerHandle,
  PeerCallbacks,
  createPeer,
  createSendChannel,
  sendFile,
  downloadBlob,
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
        if (st === 'connected') setStatus('connected');
        else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          setStatus('waiting');
        }
      },
      onRecvProgress: (received, total, fileName) => {
        setRecvName(fileName);
        setRecvPct(total > 0 ? Math.round((received / total) * 100) : 0);
      },
      onRecvComplete: (blob, fileName) => {
        downloadBlob(blob, fileName);
        setRecvPct(100);
        setNotice(`받기 완료: ${fileName}`);
        setTimeout(() => setRecvPct(null), 1500);
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
        const handle = ensurePeer(d.peerId, d.polite);
        createSendChannel(handle, makeCallbacks());
      });

      // 기존 입장자(polite) → 상대 등장 (offer 대기)
      sig.on('peer_joined', (d: any) => {
        addLog(`[Neg] peer_joined peer=${d.peerId} polite=${d.polite}`);
        setStatus('connecting');
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
      const base = signalingBase();
      const sig = new Signaling(`${base}/ws?room=${encodeURIComponent(id)}`);
      sigRef.current = sig;
      wireSignaling(sig);
      setStatus('connecting');
      sig.connect();
    },
    [teardownPeer, wireSignaling],
  );

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
    connectRoom(id);
  };

  const handleLeave = () => {
    sigRef.current?.disconnect();
    teardownPeer();
    roomIdRef.current = '';
    setJoined(false);
    setStatus('disconnected');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const handle = peerRef.current;
    if (!handle || !handle.dc || handle.dc.readyState !== 'open') {
      setNotice('상대와 연결되면 보낼 수 있어요.');
      return;
    }
    try {
      setSendPct(0);
      await sendFile(
        handle,
        file,
        (sent, total) => setSendPct(Math.round((sent / total) * 100)),
        addLog,
      );
      setNotice(`보내기 완료: ${file.name}`);
      setTimeout(() => setSendPct(null), 1500);
    } catch (err) {
      setNotice(`보내기 실패: ${String(err)}`);
      setSendPct(null);
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

        <div style={styles.sendBox}>
          <label
            style={{
              ...styles.fileLabel,
              opacity: canSend ? 1 : 0.5,
              pointerEvents: canSend ? 'auto' : 'none',
            }}
          >
            사진 보내기
            <input
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </label>
          {!canSend && joined && (
            <p style={styles.hint}>상대가 들어오면 전송할 수 있어요.</p>
          )}
        </div>

        {sendPct !== null && (
          <Progress label="보내는 중" pct={sendPct} color="#3b82f6" />
        )}
        {recvPct !== null && (
          <Progress label={`받는 중: ${recvName}`} pct={recvPct} color="#22c55e" />
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
};
