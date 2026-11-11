import { EventEmitter } from 'node:events';
import { EluCodeError, isObject } from '../util.mjs';
import { A2A_VERSION, BINDING, createRpcHandler, rpcError } from './a2a.mjs';
import { frames, writeFrame } from './transport.mjs';

// One JSON-RPC 2.0 session per connection, both directions (docs/peer-network.md,
// "Binding"). The first frame each way is the elu.hello notification; without a valid
// one within helloMs the connection closes. admit(hello, session) then returns
// 'member', 'join' (only elu.join may follow) or a falsy value (closed).
export const HELLO_MS = 5000;
const HEX64 = /^[0-9a-f]{64}$/;
// Any 1.x A2A version is accepted; minor versions only add fields, which are ignored.
const validHello = value => isObject(value) && value.binding === BINDING && typeof value.a2aVersion === 'string' && /^1\.\d{1,4}$/.test(value.a2aVersion) && typeof value.name === 'string' && value.name.length <= 64
  && Array.isArray(value.teams) && value.teams.length <= 32 && value.teams.every(team => isObject(team) && HEX64.test(team.id ?? '') && Number.isSafeInteger(team.seq) && HEX64.test(team.head ?? ''));

export class Session extends EventEmitter {
  constructor(socket, { key, hello, admit, methods = {}, onError, helloMs = HELLO_MS, limit = 20, windowMs = 10000, log = () => {} }) {
    super();
    Object.assign(this, { socket, key, admit, log, limit, windowMs, state: 'hello', pending: new Map(), nextId: 1, hits: [], remoteHello: null });
    this.handle = createRpcHandler(methods, { onError });
    this.timer = setTimeout(() => this.close('no hello'), helloMs);
    frames(socket, frame => this.frame(frame), reason => this.close(reason));
    socket.on('close', () => this.closed());
    socket.on('error', () => {});
    this.send({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: A2A_VERSION, ...hello() } });
  }
  get admitted() { return this.state === 'member'; }
  send(value) { try { writeFrame(this.socket, value); } catch (error) { this.log(`send failed: ${error.message}`); } }
  close(reason) {
    if (this.state === 'closed') return;
    if (reason) this.log(`closed ${this.key.slice(0, 8)}: ${reason}`);
    this.closed(); this.socket.destroy();
  }
  closed() {
    if (this.state === 'closed') return;
    this.state = 'closed'; clearTimeout(this.timer);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new EluCodeError('The teammate disconnected.')); }
    this.pending.clear(); this.emit('close');
  }
  request(method, params, { timeoutMs = 30000 } = {}) {
    if (this.state === 'closed') return Promise.reject(new EluCodeError('The teammate is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new EluCodeError('The teammate did not answer in time.', { timeout: true })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { if (this.state !== 'closed') this.send({ jsonrpc: '2.0', method, params }); }
  // Marks a session admitted after a join or a roster change.
  promote() { if (this.state !== 'closed' && this.state !== 'member') { clearTimeout(this.timer); this.state = 'member'; this.emit('admitted'); } }
  frame(frame) {
    if (this.state === 'closed') return;
    if (!isObject(frame) || frame.jsonrpc !== '2.0') return this.close('not JSON-RPC 2.0');
    if (this.state === 'hello') {
      if (frame.method !== 'elu.hello' || Object.hasOwn(frame, 'id') || !validHello(frame.params)) return this.close(typeof frame.params?.a2aVersion === 'string' && !/^1\./.test(frame.params.a2aVersion) ? `unsupported A2A version ${JSON.stringify(frame.params.a2aVersion.slice(0, 16))}` : 'no valid hello');
      clearTimeout(this.timer); this.remoteHello = frame.params;
      let decision; try { decision = this.admit(frame.params, this); } catch (error) { this.log(`admission failed: ${error.message}`); }
      this.log(`admission ${this.key.slice(0, 8)}: ${decision || 'refused'}`);
      if (decision === 'member') { this.state = 'member'; this.emit('admitted'); return; }
      if (decision === 'join') { this.state = 'join'; this.timer = setTimeout(() => this.close('no join'), 30000); return; }
      return this.close('not a teammate');
    }
    if (Object.hasOwn(frame, 'method')) {
      if (frame.method === 'elu.hello') return this.close('repeated hello');
      // A machine that only came to join may send elu.join once, and nothing else.
      if (this.state === 'join' && (frame.method !== 'elu.join' || this.joinTried)) return this.close('not a teammate');
      if (this.state === 'join') this.joinTried = true;
      const now = Date.now(); this.hits = this.hits.filter(at => now - at < this.windowMs); this.hits.push(now);
      if (this.hits.length > this.limit * 2) return this.close('too many requests');
      if (this.hits.length > this.limit) {
        if (Object.hasOwn(frame, 'id')) this.send(rpcError(frame.id ?? null, -32000, 'Too many requests. Try again shortly.'));
        return;
      }
      this.handle(frame, this).then(response => {
        if (response) this.send(response);
        // The join handler sets joinAccepted; the joiner is admitted once its reply is out.
        if (this.state === 'join') { if (this.joinAccepted) this.promote(); else this.close('join finished without admission'); }
      }, error => this.log(`handler failed: ${error.message}`));
      return;
    }
    if (!Object.hasOwn(frame, 'id')) return this.close('frame without method or id');
    const waiting = this.pending.get(frame.id); if (!waiting) return;
    this.pending.delete(frame.id); clearTimeout(waiting.timer);
    if (isObject(frame.error)) waiting.reject(new EluCodeError(typeof frame.error.message === 'string' ? frame.error.message.slice(0, 300) : 'The teammate refused.', { rpc: { code: frame.error.code, data: frame.error.data } }));
    else waiting.resolve(frame.result);
  }
}
