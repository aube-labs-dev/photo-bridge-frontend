import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  PeerHandle,
  PeerCallbacks,
  createPeer,
  createSendChannel,
  sendFile,
  downloadBlob,
} from '../lib/webrtc';

type Status = 'disconnected' | 'connecting' | 'waiting' | 'connected';

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

  // --- WebRTC/소켓 상태는 전부 ref (stale closure 방지) ---
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<PeerHandle | null>(null);
  const remoteIdRef = useRef<string | null>(null);
  const roomIdRef = useRef('');

  const addLog = useCallback((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
    setLog((prev) => [...prev.slice(-200), msg]);
  }, []);

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

  // 상대와의 Peer를 1개 보장
  const ensurePeer = useCallback(
    (remoteId: string, polite: boolean): PeerHandle => {
      if (peerRef.current) return peerRef.current;
      remoteIdRef.current = remoteId;
      const handle = createPeer(socketRef.current!, remoteId, polite, makeCallbacks());
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
    setStatus(socketRef.current?.connected ? 'waiting' : 'disconnected');
  }, []);

  // 소켓 1회 연결 + 시그널링 핸들러 (ref만 사용하므로 재구독 불필요)
  useEffect(() => {
    const socket = io(window.location.origin, {
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      addLog(`[Socket] connected: ${socket.id}`);
      if (roomIdRef.current) {
        setStatus('waiting');
        socket.emit('create_or_join_room', roomIdRef.current);
      }
    });

    socket.on('disconnect', () => {
      addLog('[Socket] disconnected');
      teardownPeer();
      setStatus('disconnected');
    });

    socket.on('connect_error', (e: Error) =>
      addLog(`[Socket] connect_error: ${e.message}`),
    );

    socket.on('room_joined', (data: { totalClients: number }) => {
      addLog(`[Room] joined. total=${data.totalClients}`);
      setStatus(data.totalClients > 1 ? 'connecting' : 'waiting');
    });

    socket.on('room_full', () => {
      setNotice('이 방은 이미 2명이 사용 중이에요. 다른 방 번호를 쓰세요.');
      setStatus('disconnected');
      setJoined(false);
    });

    // 내가 신규 입장자(impolite) → 내가 offer 시작 + DataChannel 생성
    socket.on(
      'start_negotiation',
      (data: { peerId: string; polite: boolean }) => {
        addLog(`[Neg] start_negotiation peer=${data.peerId} polite=${data.polite}`);
        setStatus('connecting');
        const handle = ensurePeer(data.peerId, data.polite);
        createSendChannel(handle, makeCallbacks()); // onnegotiationneeded 트리거
      },
    );

    // 기존 입장자(polite) → 상대 등장 통지 (offer 대기)
    socket.on('peer_joined', (data: { peerId: string; polite: boolean }) => {
      addLog(`[Neg] peer_joined peer=${data.peerId} polite=${data.polite}`);
      setStatus('connecting');
      ensurePeer(data.peerId, data.polite);
    });

    socket.on('peer_left', () => {
      addLog('[Room] peer left');
      teardownPeer();
      setNotice('상대가 나갔어요.');
    });

    // --- Perfect Negotiation 시그널 처리 ---
    socket.on(
      'offer',
      async (data: { senderId: string; sdp: RTCSessionDescriptionInit }) => {
        const handle = ensurePeer(data.senderId, peerRef.current?.polite ?? true);
        const pc = handle.pc;
        const offerCollision =
          handle.makingOffer || pc.signalingState !== 'stable';
        handle.ignoreOffer = !handle.polite && offerCollision;
        if (handle.ignoreOffer) {
          addLog('[Neg] ignoring offer (impolite collision)');
          return;
        }
        await pc.setRemoteDescription(data.sdp);
        await pc.setLocalDescription();
        socket.emit('answer', {
          targetId: data.senderId,
          sdp: pc.localDescription,
        });
        addLog('[Neg] answered offer');
      },
    );

    socket.on(
      'answer',
      async (data: { senderId: string; sdp: RTCSessionDescriptionInit }) => {
        const handle = peerRef.current;
        if (!handle) return;
        try {
          await handle.pc.setRemoteDescription(data.sdp);
          addLog('[Neg] applied answer');
        } catch (e) {
          addLog(`[Neg] answer error: ${String(e)}`);
        }
      },
    );

    socket.on(
      'ice_candidate',
      async (data: { senderId: string; candidate: RTCIceCandidateInit }) => {
        const handle = peerRef.current;
        if (!handle || !data.candidate) return;
        try {
          await handle.pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!handle.ignoreOffer) {
            addLog(`[Neg] addIceCandidate error: ${String(e)}`);
          }
        }
      },
    );

    return () => {
      socket.disconnect();
      if (peerRef.current) {
        peerRef.current.pc.close();
        peerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL ?room=xxxx 자동 입장 (공유 링크 / 실기기 테스트용)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    if (r && r.trim()) {
      const id = r.trim();
      setRoomId(id);
      roomIdRef.current = id;
      setJoined(true);
      const trySend = () => {
        if (socketRef.current?.connected) {
          setStatus('waiting');
          socketRef.current.emit('create_or_join_room', id);
        } else {
          setTimeout(trySend, 300);
        }
      };
      trySend();
    }
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
    if (socketRef.current?.connected) {
      setStatus('waiting');
      socketRef.current.emit('create_or_join_room', id);
    } else {
      setStatus('connecting');
    }
  };

  const handleLeave = () => {
    teardownPeer();
    roomIdRef.current = '';
    setJoined(false);
    setStatus(socketRef.current?.connected ? 'disconnected' : 'disconnected');
    // 서버는 방을 떠나도 소켓 유지 → 재입장 가능하도록 소켓 재연결
    socketRef.current?.disconnect();
    socketRef.current?.connect();
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

        <button
          style={styles.logToggle}
          onClick={() => setShowLog((v) => !v)}
        >
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
        <div
          style={{ ...styles.progFill, width: `${pct}%`, background: color }}
        />
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
    fontFamily:
      '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
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
