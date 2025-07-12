import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// 파일 청크 전송을 위한 상수
const CHUNK_SIZE = 16 * 1024; // 16KB

interface WebRTCSignalingData {
  senderId: string;
  targetId?: string; // offer/answer/candidate는 특정 상대방을 지칭할 수 있음
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidate;
  newClient?: string;
  roomId?: string;
}

export default function HomePage() {
  const [roomId, setRoomId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [peerConnections, setPeerConnections] = useState<Map<string, RTCPeerConnection>>(new Map());
  const [dataChannels, setDataChannels] = useState<Map<string, RTCDataChannel>>(new Map());
  const [fileReceivers, setFileReceivers] = useState<Map<string, {
    buffer: Uint8Array[],
    receivedSize: number,
    totalSize: number,
    fileName: string,
    fileType: string
  }>>(new Map());

  const socketRef = useRef<Socket | null>(null);
  const localSocketIdRef = useRef<string | null>(null);

  // STUN 서버 정보 (공개 구글 STUN 서버 사용)
  const iceServers = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };

  const addMessage = useCallback((msg: string) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const setupDataChannel = useCallback((channel: RTCDataChannel, remoteSocketId: string) => {
    channel.onopen = () => {
      addMessage(`[DataChannel] Data channel ${channel.label} opened with ${remoteSocketId}`);
    };
    channel.onclose = () => {
      addMessage(`[DataChannel] Data channel ${channel.label} closed with ${remoteSocketId}`);
      setDataChannels((prev) => {
        const newMap = new Map(prev);
        newMap.delete(remoteSocketId);
        return newMap;
      });
    };
    channel.onerror = (error) => {
      // error.error?.message는 DOMException이 아닐 경우 undefined일 수 있으므로 안전하게 접근
      const errorMessage = error.error instanceof DOMException ? error.error.message : 'Unknown DataChannel error';
      addMessage(`[DataChannel] Data channel error with ${remoteSocketId}: ${errorMessage}`);
    };
    channel.onmessage = async (event) => {
      const msg = event.data;
      if (typeof msg === 'string') {
        try {
          const json = JSON.parse(msg);
          if (json.type === 'file_info') {
            // 파일 전송 시작
            addMessage(`[File] Receiving file info from ${remoteSocketId}: ${json.fileName} (${json.totalSize} bytes)`);
            setFileReceivers((prev) => new Map(prev).set(remoteSocketId, {
              buffer: [],
              receivedSize: 0,
              totalSize: json.totalSize,
              fileName: json.fileName,
              fileType: json.fileType,
            }));
          } else if (json.type === 'file_end') {
            // 파일 전송 완료, 다운로드
            addMessage(`[File] File transfer complete from ${remoteSocketId}: ${json.fileName}`);
            const receiver = fileReceivers.get(remoteSocketId);
            if (receiver) {
              const fileBlob = new Blob(receiver.buffer, { type: receiver.fileType });
              const url = URL.createObjectURL(fileBlob);
              const a = document.createElement('a');
              a.href = url;
              a.download = receiver.fileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              setFileReceivers((prev) => {
                const newMap = new Map(prev);
                newMap.delete(remoteSocketId);
                return newMap;
              });
            }
          }
        } catch (e) {
          addMessage(`[DataChannel] Text message from ${remoteSocketId}: ${msg}`);
        }
      } else if (msg instanceof Blob) {
        // Blob 또는 ArrayBuffer 형태의 청크 데이터
        const receiver = fileReceivers.get(remoteSocketId);
        if (receiver) {
          const arrayBuffer = await msg.arrayBuffer(); // Blob을 ArrayBuffer로 변환
          receiver.buffer.push(new Uint8Array(arrayBuffer));
          receiver.receivedSize += arrayBuffer.byteLength;
          addMessage(`[File] Received chunk from ${remoteSocketId}: ${receiver.receivedSize}/${receiver.totalSize} bytes`);
        }
      } else if (msg instanceof ArrayBuffer) {
         // ArrayBuffer 형태의 청크 데이터
         const receiver = fileReceivers.get(remoteSocketId);
         if (receiver) {
           receiver.buffer.push(new Uint8Array(msg));
           receiver.receivedSize += msg.byteLength;
           addMessage(`[File] Received chunk from ${remoteSocketId}: ${receiver.receivedSize}/${receiver.totalSize} bytes`);
         }
      }
    };
  }, [addMessage, fileReceivers]);

  const createPeerConnection = useCallback((remoteSocketId: string) => {
    if (peerConnections.has(remoteSocketId)) {
      addMessage(`[WebRTC] PeerConnection already exists for ${remoteSocketId}`);
      return peerConnections.get(remoteSocketId)!;
    }

    addMessage(`[WebRTC] Creating RTCPeerConnection for ${remoteSocketId}`);
    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addMessage(`[WebRTC] Sending ICE candidate to ${remoteSocketId}`);
        socketRef.current?.emit('ice_candidate', {
          roomId: roomId,
          targetId: remoteSocketId,
          candidate: event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      addMessage(`[WebRTC] ICE connection state changed: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      addMessage(`[WebRTC] Connection state changed: ${pc.connectionState}`);
    };

    pc.ondatachannel = (event) => {
      addMessage(`[WebRTC] Data channel created by remote peer: ${event.channel.label}`);
      const receiveChannel = event.channel;
      setDataChannels((prev) => new Map(prev).set(remoteSocketId, receiveChannel));
      setupDataChannel(receiveChannel, remoteSocketId);
    };

    setPeerConnections((prev) => new Map(prev).set(remoteSocketId, pc));
    return pc;
  }, [roomId, peerConnections, addMessage, setupDataChannel]); // setupDataChannel 의존성 추가

  const connectSocket = useCallback(() => {
    // Nginx 프록시를 통해 접속하므로, 도메인만 지정하고 path를 맞춰줌
    const socket = io(window.location.origin, {
      path: '/socket.io/', // Nest.js Gateway에 설정된 path와 동일해야 함
      transports: ['websocket'], // WebSocket만 사용하도록 강제 (선택 사항)
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      addMessage(`[Socket.IO] Connected with ID: ${socket.id}`);
      localSocketIdRef.current = socket.id!; // 수정: 비 null 단언 연산자 사용
      setIsConnected(true);
      // 연결 후 바로 방에 참여 시도
      if (roomId) {
        socket.emit('create_or_join_room', roomId);
      }
    });

    socket.on('disconnect', () => {
      addMessage('[Socket.IO] Disconnected');
      setIsConnected(false);
      localSocketIdRef.current = null;
      peerConnections.forEach(pc => pc.close()); // 모든 PeerConnection 닫기
      setPeerConnections(new Map());
      setDataChannels(new Map());
      setFileReceivers(new Map());
    });

    socket.on('connect_error', (error) => {
      addMessage(`[Socket.IO] Connection Error: ${error.message}`);
    });

    socket.on('room_joined', (data: { clientId: string; roomId: string; totalClients: number }) => {
      addMessage(`[Room] Client ${data.clientId} joined room ${data.roomId}. Total: ${data.totalClients}`);
    });

    socket.on('ready_to_connect', (room: string) => {
      addMessage(`[WebRTC] Ready to connect in room: ${room}. Waiting for offer or send offer.`);
      // 이 시점에서 방에 이미 다른 클라이언트가 있다는 의미.
      // 즉시 offer를 보낼 필요는 없지만, 새로운 피어를 발견했다는 신호로 볼 수 있음.
    });

    socket.on('offer_needed', async (data: { newClient: string }) => {
      addMessage(`[WebRTC] Offer needed for new client: ${data.newClient}`);
      const pc = createPeerConnection(data.newClient);
      const dataChannel = pc.createDataChannel('file_transfer');
      setDataChannels((prev) => new Map(prev).set(data.newClient, dataChannel));
      setupDataChannel(dataChannel, data.newClient); // 데이터 채널 생성 시에도 setup 호출

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addMessage(`[WebRTC] Sending offer to ${data.newClient}`);
      socket.emit('offer', { roomId: roomId, targetId: data.newClient, sdp: offer });
    });

    socket.on('offer', async (data: WebRTCSignalingData) => {
      addMessage(`[WebRTC] Received offer from ${data.senderId}`);
      const pc = createPeerConnection(data.senderId);
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp!)); // 수정: 비 null 단언 연산자 사용
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addMessage(`[WebRTC] Sending answer to ${data.senderId}`);
      socket.emit('answer', { roomId: roomId, targetId: data.senderId, sdp: answer });
    });

    socket.on('answer', async (data: WebRTCSignalingData) => {
      addMessage(`[WebRTC] Received answer from ${data.senderId}`);
      const pc = peerConnections.get(data.senderId);
      if (pc && pc.localDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp!)); // 수정: 비 null 단언 연산자 사용
      }
    });

    socket.on('ice_candidate', async (data: WebRTCSignalingData) => {
      addMessage(`[WebRTC] Received ICE candidate from ${data.senderId}`);
      const pc = peerConnections.get(data.senderId);
      if (pc) {
        try {
          // RTCIceCandidate는 생성자에 null이 아닌 값만 받음
          if (data.candidate) { // candidate가 undefined가 아닐 때만 추가
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } else {
            addMessage(`[WebRTC Warning] Received null/undefined ICE candidate from ${data.senderId}`);
          }
        } catch (e: any) { // 명시적으로 any 타입 지정
          console.error('[WebRTC] Error adding received ICE candidate:', e);
          addMessage(`[WebRTC Error] Failed to add ICE candidate: ${e.message || e}`);
        }
      }
    });
  }, [roomId, addMessage, createPeerConnection, peerConnections, setupDataChannel]);

  useEffect(() => {
    // 컴포넌트 마운트 시 소켓 연결 시도
    connectSocket();

    // 컴포넌트 언마운트 시 소켓 연결 해제
    return () => {
      socketRef.current?.disconnect();
      peerConnections.forEach(pc => pc.close());
    };
  }, [connectSocket, peerConnections]); // peerConnections 의존성 추가

  const handleRoomJoin = () => {
    if (socketRef.current && socketRef.current.connected && roomId) {
      addMessage(`[Socket.IO] Attempting to join room: ${roomId}`);
      socketRef.current.emit('create_or_join_room', roomId);
    } else {
      addMessage('[Error] Socket not connected or Room ID is empty.');
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      addMessage('[File] No file selected.');
      return;
    }

    // 현재 연결된 모든 peer에게 파일 전송
    for (const [remoteId, channel] of dataChannels.entries()) {
      if (channel.readyState === 'open') {
        addMessage(`[File] Preparing to send file "${file.name}" to ${remoteId}`);

        // 1. 파일 정보 전송
        channel.send(JSON.stringify({
          type: 'file_info',
          fileName: file.name,
          fileType: file.type,
          totalSize: file.size,
        }));

        // 2. 파일 청크 전송
        let offset = 0;
        const fileReader = new FileReader();

        fileReader.onload = async (e) => {
          const chunk = e.target?.result as ArrayBuffer; // ArrayBuffer로 읽기
          if (chunk) {
            channel.send(chunk);
            offset += chunk.byteLength;
            addMessage(`[File] Sent ${offset}/${file.size} bytes to ${remoteId}`);
          }

          if (offset < file.size) {
            readNextChunk();
          } else {
            // 3. 파일 전송 완료 신호
            channel.send(JSON.stringify({ type: 'file_end', fileName: file.name }));
            addMessage(`[File] File "${file.name}" sent completely to ${remoteId}`);
          }
        };

        fileReader.onerror = (e) => {
          const fileReaderError = e.target?.error;
          const errorMessage = fileReaderError instanceof DOMException ? fileReaderError.message : 'Unknown error occurred during file reading.';
          addMessage(`[File Error] FileReader error: ${errorMessage}`);
        };

        const readNextChunk = () => {
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          fileReader.readAsArrayBuffer(slice);
        };

        readNextChunk(); // 첫 번째 청크 읽기 시작

      } else {
        addMessage(`[Error] DataChannel to ${remoteId} is not open. State: ${channel.readyState}`);
      }
    }
    if (dataChannels.size === 0) {
      addMessage('[Error] No open data channels to send file.');
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>사진 전송 모바일 웹</h1>
      <p>현재 상태: {isConnected ? '연결됨' : '연결 끊김'}</p>
      <p>내 Socket ID: {localSocketIdRef.current || 'N/A'}</p>

      <div>
        <input
          type="text"
          placeholder="방 ID 입력"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ padding: '8px', marginRight: '5px' }}
        />
        <button onClick={handleRoomJoin} disabled={!roomId || !isConnected}>
          방 생성/참여
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <h2>파일 전송</h2>
        <input
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          disabled={dataChannels.size === 0}
        />
        {dataChannels.size === 0 && <p style={{ color: 'red' }}>연결된 상대방이 없으면 파일을 전송할 수 없습니다.</p>}
      </div>

      <div style={{ marginTop: '20px' }}>
        <h2>로그</h2>
        <div
          style={{
            border: '1px solid #ccc',
            padding: '10px',
            height: '300px',
            overflowY: 'scroll',
            backgroundColor: '#f9f9f9',
          }}
        >
          {messages.map((msg, index) => (
            <p key={index} style={{ margin: '0', fontSize: '0.9em', lineHeight: '1.4' }}>
              {msg}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}