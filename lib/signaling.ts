// 네이티브 WebSocket 기반 시그널링 클라이언트.
// Socket.IO의 on/emit 인터페이스를 흉내내 기존 코드 변경을 최소화한다.
// 메시지 프레이밍: JSON { type, ...payload }

type Handler = (data: any) => void;

export class Signaling {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Handler[]> = new Map();
  private _connected = false;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this._connected = true;
      this.fire('connect', undefined);
    };

    ws.onclose = () => {
      this._connected = false;
      this.fire('disconnect', undefined);
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.open(), 1000);
      }
    };

    ws.onerror = () => {
      this.fire('connect_error', { message: 'websocket error' });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') {
        this.fire(msg.type, msg);
      }
    };
  }

  // Socket.IO 호환: emit(event, payload) → { type: event, ...payload }
  emit(event: string, payload?: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let frame: any;
    if (payload && typeof payload === 'object') {
      frame = { type: event, ...payload };
    } else {
      // create_or_join_room 처럼 문자열 페이로드
      frame = { type: event, value: payload };
    }
    this.ws.send(JSON.stringify(frame));
  }

  on(event: string, handler: Handler): void {
    const arr = this.handlers.get(event) || [];
    arr.push(handler);
    this.handlers.set(event, arr);
  }

  private fire(event: string, data: any): void {
    const arr = this.handlers.get(event);
    if (arr) arr.forEach((h) => h(data));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._connected = false;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
